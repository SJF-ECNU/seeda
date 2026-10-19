"""Sequential multi-domain Seeda research run using official Harbor verifiers."""
import asyncio,datetime,json,os,signal,sys,time,tomllib
from pathlib import Path
ROOT=Path(__file__).resolve().parent
sys.path[:0]=[str(ROOT/'runtime'),str(ROOT)]
from runtime import Runtime,save
from meter import Meter
from wb_harbor import prepare_task,run_trial,container_id
NODE='/Users/shjf/.nvm/versions/node/v24.18.0/bin/node'
SEED=json.loads((ROOT/'config.json').read_text())['seed_source']
class Experiment:
 def __init__(self,ident):
  self.directory=ROOT/'runs'/ident;self.directory.mkdir(parents=True,exist_ok=False)
  self.state={'status':'running','started_at':time.time(),'stages':[],'scores':[],'source_initial':SEED,'version':None,'usd':None}
  self.meter=Meter(os.environ.get('DEEPSEEK_BASE_URL','https://api.deepseek.com'),os.environ['DEEPSEEK_API_KEY'],'deepseek-flash',log_path=self.directory/'model-attempts.jsonl').start()
  self.judge=Meter('https://dashscope.aliyuncs.com/compatible-mode/v1',os.environ['DASHSCOPE_API_KEY'],'qwen3-vl-plus',log_path=self.directory/'judge-attempts.jsonl',upstream_timeout=1200).start()
  self.runtime=Runtime(self.meter,NODE,SEED,self.directory,'deepseek-flash',root=ROOT/'runtime')
  self.cancelled=False
 def persist(self):
  self.state.update(meter=self.meter.snapshot(),judge_meter=self.judge.snapshot());save(self.directory/'state.json',self.state)
 def cancel(self):self.cancelled=True;self.runtime.cancel()
 async def task(self,domain,item,label,fixed=False,version=None):
  task=Path(item['instruction_path']).parent
  config=tomllib.loads((task/'task.toml').read_text());timeout=config['agent']['timeout_sec']*2
  prepared=prepare_task(task,self.directory/'controls'/label)
  env={}
  if domain in ('web','office'):
   url=self.judge.register(label,None,None,'judge').replace('127.0.0.1','host.docker.internal')
   env={'WORKBUDDY_VERIFIER_LLM_BASE_URL':url,'WORKBUDDY_VERIFIER_LLM_API_KEY':'judge-route','WORKBUDDY_VERIFIER_LLM_MODEL':'qwen3-vl-plus','WEB_BENCH_LLM_JUDGE_MODE':'full'}
  async def agent(instruction,environment,context):
   cid=await container_id(environment)
   prefix=('Complete the task using your fixed Agent version. Self-version mutation is disabled. Finish with real validation evidence and limitations.' if fixed else (ROOT/'prompt.txt').read_text())
   if not fixed and self.state['scores']:
    previous=self.state['scores'][-1]
    prefix+='\nPrevious completed work external acceptance summary (numeric feedback only; hidden checks are unavailable): '+json.dumps({k:previous[k] for k in ('domain','task','rewards')},ensure_ascii=False)
   prompt=prefix+'\nTask container workspace: /workspace. Security input may be /app/challenge; final outputs follow the task exactly. Native self-evaluation validates Agent behavior only, without official task scoring access. Agent phase is offline. Effective task time allowance including self-change: '+str(timeout)+' seconds.\n\n'+instruction
   worker=asyncio.create_task(asyncio.to_thread(self.runtime.run_stage,label,'solve' if fixed else 'work',prompt,ROOT/'p'/self.directory.name/label,source=(version or {}).get('runtime_path'),version=version,container=cid,docker_socket=str(Path.home()/'.docker/run/docker.sock'),timeout_seconds=timeout))
   try:
    result=await asyncio.shield(worker)
   except asyncio.CancelledError:
    self.runtime.cancel()
    try:await asyncio.wait_for(asyncio.shield(worker),30)
    except Exception:pass
    raise
   self.state['stages'].append(result)
   if not fixed:self.state['version']=result.get('version_after') or result.get('version_before')
   self.persist()
  result=await run_trial(prepared,self.directory/'trials'/label,agent,verifier_env=env)
  self.state['scores'].append({'label':label,'domain':domain,'task':item['id'],'valid':result['valid'],'rewards':result['rewards'],'path':str(self.directory/'trials'/label/'audit.json')});self.persist()
  if not result['valid'] or self.meter.snapshot()['stop_reason'] or self.judge.snapshot()['stop_reason']:raise RuntimeError('execution_or_verifier_infrastructure_failure')
  if self.cancelled:raise asyncio.CancelledError()
 async def run(self):
  sel=json.loads((ROOT/'selection-proposal.json').read_text());save(self.directory/'selection.json',sel)
  try:
   for index in range(2):
    for domain in ('code','web','office','security'):
     if self.cancelled:raise asyncio.CancelledError()
     await self.task(domain,sel['subsets'][domain]['work'][index],f'work_{index+1}_{domain}',version=self.state['version'])
   self.state['status']='final_audit';self.persist();final=self.state['version']
   for arm,version in [('initial',None),('final',final)]:
    for domain in ('code','web','office','security'):
     await self.task(domain,sel['subsets'][domain]['heldout'][0],f'heldout_{arm}_{domain}',fixed=True,version=version)
   self.state['status']='completed'
  except BaseException as error:
   self.state.update(status='cancelled' if self.cancelled or isinstance(error,asyncio.CancelledError) else 'infrastructure_error',error_type=type(error).__name__,error=str(error));raise
  finally:
   self.runtime.close();self.meter.close();self.judge.close();self.state.update(ended_at=time.time(),wall_seconds=time.time()-self.state['started_at']);self.persist();save(self.directory/'stop-receipt.json',{'status':self.state['status'],'ended_at':self.state['ended_at'],'meter':self.meter.snapshot(),'judge_meter':self.judge.snapshot(),'usd':None})
async def run_owned(e):
 task=asyncio.create_task(e.run())
 def cancel(*_):
  e.cancel()
  task.cancel()
 for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,cancel)
 await task

def main():
 import argparse
 p=argparse.ArgumentParser();p.add_argument('--id',required=True);a=p.parse_args();e=Experiment(a.id)
 asyncio.run(run_owned(e))
if __name__=='__main__':main()

"""Small autonomous behavior probe through the real stage, outside the formal benchmark."""
import json,os,shutil,subprocess,time
from pathlib import Path
from unittest.mock import patch
import runner
PREP=runner.ROOT/'preparation/layered-verification-1018-011745'
TASK='''这是独立公开的小型可靠验证任务，不是 Terminal-Bench 正式题。/app/reliability-case/program.py 应读取 input.txt，将所有字符转为大写并写入 output.txt，正常退出且不得修改 input.txt。旧检查声称“output 与 expected 一样，因此成功”，但运行报告矛盾，之前已经做过重复尝试。先复现并记录问题，再最小修复，可靠验证最后交付 program.py 和 report.json（事实、归因假设、实际检查、仍未验证项）。输入只有当前公开文件；不读取其他任务、评分器或参考答案。请保留试验与有效方案，不用大量探索。可选的当前版本技能在 /tmp/seeda-agent-skills/，按需读取。Bash 已绑定本任务容器；不能调用 management 或修改自身。'''

def run(arm,version):
 e=runner.Experiment('layered-real-'+arm+'-'+time.strftime('%m%d-%H%M%S'));e.state['purpose']='preparation-only autonomous behavior microprobe; not benchmark score';result={'arm':arm,'run':str(e.directory),'version':version,'status':'failed'};cid=None
 try:
  cid=e.container('multi-source-data-merger')
  setup=e.directory/'probe-input';setup.mkdir();(setup/'input.txt').write_text('alpha\nBeta\n');(setup/'expected.txt').write_text('ALPHA\nBETA\n')
  (setup/'program.py').write_text("from pathlib import Path\np=Path('input.txt')\nPath('output.txt').write_text(p.read_text().upper())\np.write_text('polluted\\n')\nraise SystemExit(7)\n")
  (setup/'old-check.txt').write_text('Output equals expected, therefore success. This statement has not checked exit code or input integrity.\n')
  files={p.name:p.read_text() for p in setup.iterdir()}
  runner.cmd(['docker','exec',cid,'python3','-c',"import json,sys;from pathlib import Path;p=Path('/app/reliability-case');p.mkdir();[(p/n).write_text(v) for n,v in json.loads(sys.argv[1]).items()]",json.dumps(files)])
  runner.cmd(['docker','exec',cid,'sh','-c','test -w /app/reliability-case/program.py && test -w /app/reliability-case/input.txt && printf writable > /app/reliability-case/setup-write-proof && test -s /app/reliability-case/setup-write-proof'])
  runner.cmd(['docker','cp',version['runtime_path']+'/.agents/skills',cid+':/tmp/seeda-agent-skills'])
  stage=e.run_stage('behavior-'+arm,'solve',TASK,None,None,e.p/'agent',version['runtime_path'],version,cid)
  e.state['probe_stage']=stage
  dest=e.directory/'artifacts';runner.cmd(['docker','cp',cid+':/app/.',str(dest)])
  # Independent public-requirement check on untouched inputs in a new directory.
  runner.cmd(['docker','exec',cid,'mkdir','/app/external-check'])
  runner.cmd(['docker','exec',cid,'python3','-c',"from pathlib import Path;Path('/app/external-check/input.txt').write_text('alpha\\nBeta\\n')"])
  runner.cmd(['docker','exec',cid,'cp','/app/reliability-case/program.py','/app/external-check/program.py'])
  check=subprocess.run(['docker','exec','-w','/app/external-check',cid,'python3','program.py'],capture_output=True,text=True)
  output=runner.cmd(['docker','exec',cid,'cat','/app/external-check/output.txt']);original=runner.cmd(['docker','exec',cid,'cat','/app/external-check/input.txt'])
  valid=check.returncode==0 and output=='ALPHA\nBETA' and original=='alpha\nBeta'
  session=Path(stage['metrics']['path']).read_text();helper_used='verify.py run' in session or 'verify.py\", \"run' in session
  results=[]
  for f in dest.rglob('result.json'):
   try:
    v=json.loads(f.read_text())
    if 'command' in v and 'checks' in v:results.append({'path':str(f),'status':v['status'],'target_exit':v['command']['exit_code'],'checks':[x['exit_code'] for x in v['checks']]})
   except (ValueError,KeyError):pass
  result.update(status='completed',stage_status=stage['execution_status'],actual_version=stage['version_before']['id'],independent_check={'valid':valid,'exit_code':check.returncode,'output':output,'input':original},helper_used=helper_used,verification_attempts=results,answer=stage['answer'],metrics=stage['metrics'],wall_seconds=time.time()-e.started)
  e.state['status']='completed'
 finally:
  if cid:e.remove(cid)
  e.meter.close();e.sleepguard.terminate();e.state.update(finished=time.time(),wall_seconds=time.time()-e.started);e.persist()
  result['meter']=e.meter.snapshot();runner.save(e.directory/'verification.json',result);runner.save(PREP/(e.run_id+'.json'),result)
 print(json.dumps({k:v for k,v in result.items() if k not in ['answer','metrics','meter','version','verification_attempts']},ensure_ascii=False),flush=True)
 return result
if __name__=='__main__':
 sources=sorted(runner.ROOT.glob('runs/layered-complete-*/state.json'))
 s=json.loads(sources[-1].read_text());assert s['learning'][0]['outcome']=='promoted'
 reports=[run('old',s['initial']),run('candidate',s['learning'][0]['candidate'])]
 runner.save(PREP/'real-model-comparison.json',reports)

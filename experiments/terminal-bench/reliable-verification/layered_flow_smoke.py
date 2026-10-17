"""Formal execution path with deterministic model actions, not autonomous improvement evidence."""
import json,os,shlex,shutil,subprocess,tarfile,threading,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
import runner,scoring

MARKER='RELIABLE_VERIFICATION_BEHAVIOR'
REPO=Path('/Users/shjf/work/seeda')
PREP=runner.ROOT/'preparation/layered-verification-1018-011745'
STRATEGY=(REPO/'.agents/self/INSTRUCTIONS.md').read_text()

def probe(helper):
 # All files and subprocesses are real. The model fixture chooses these actions deterministically.
 code='''import json,subprocess,sys
from pathlib import Path
h=HELPER
p=Path('behavior-probe');p.mkdir();s=p/'source';s.mkdir()
(s/'input.txt').write_text('clean\\n');(s/'expected.txt').write_text('clean\\n')
def call(*args):
 r=subprocess.run([sys.executable,h,*map(str,args)],capture_output=True,text=True)
 return r.returncode,json.loads(r.stdout)
assert call('init',p/'records',s,'input.txt','expected.txt')[0]==0
spec={'hypothesis':'Matching bytes are insufficient when the target fails','candidate_source':str(s.resolve()),'candidates':['program.py'],'command':[sys.executable,'program.py'],'checks':[['cmp','output.txt','expected.txt']],'artifacts':['output.txt'],'timeout_seconds':5}
def attempt(code):
 (s/'program.py').write_text(code);(p/'spec.json').write_text(json.dumps(spec))
 return call('run',p/'records',p/'spec.json')
base="from pathlib import Path\\nPath('output.txt').write_text(Path('input.txt').read_text())\\n"
a,failed=attempt(base+'raise SystemExit(7)\\n');assert a==1 and failed['command']['exit_code']==7 and failed['checks'][0]['exit_code']==0
assert not any(json.loads(f.read_text())['status']=='passed' for f in (p/'records/attempts').glob('*/result.json'))
(p/'no-valid-candidate.txt').write_text('No valid candidate yet: target exit failed; do not claim success or revert to nonexistent good version.')
a,good=attempt(base+"Path('input.txt').write_text('polluted')\\n");assert a==0
(s/'input.txt').write_text('also polluted')
a,regression=attempt("from pathlib import Path\\nassert Path('input.txt').read_text()=='clean\\n'\\nPath('output.txt').write_text('wrong')\\n")
# The assertion code above intentionally uses a repr-safe replacement below.
assert a==1 and regression['command']['exit_code']==0 and regression['checks'][0]['exit_code']==1
assert (Path(good['attempt'])/'work/output.txt').read_text()=='clean\\n'
assert (p/'records/inputs/input.txt').read_text()=='clean\\n'
(s/'program.py').write_text((Path(good['attempt'])/'candidate/program.py').read_text())
a,restored=call('run',p/'records',p/'spec.json');assert a==0
proof={'behavior':'checked_exit_preserved_input_restored_good','failed_target':failed,'good':good,'regression':regression,'restored':restored,'no_valid_candidate_recorded':True}
Path('behavior-proof.json').write_text(json.dumps(proof));print(json.dumps(proof))
'''.replace('HELPER',repr(helper))
 # Avoid embedding an actual newline inside the generated candidate's string literal.
 code=code.replace("=='clean\\n'\\nPath", "=="+repr('clean\n').replace('\\','\\\\')+"\\nPath")
 return "python3 - <<'PY'\n"+code+'\nPY'

def shell_probe():
 return r"""set -eu
mkdir behavior-probe
cd behavior-probe
mkdir inputs candidates attempts
printf 'clean\n' > inputs/input.txt
cp inputs/input.txt inputs/expected.txt
printf 'cat input.txt > output.txt\nexit 7\n' > candidates/program.sh
run_attempt() {
 number=$1
 mkdir "attempts/$number"
 cp inputs/* candidates/program.sh "attempts/$number/"
 cp candidates/program.sh "attempts/$number/saved-program.sh"
 (
 cd "attempts/$number"
 set +e
 bash program.sh > command.log 2>&1
 target_rc=$?
 cmp output.txt expected.txt > check.log 2>&1
 check_rc=$?
 printf '{"exit_code":%s,"check_exit_code":%s}\n' "$target_rc" "$check_rc" > result.json
 test "$target_rc" -eq 0 && test "$check_rc" -eq 0
 )
}
if run_attempt 1; then exit 91; fi
printf 'No valid candidate: exit failed despite matching output\n' > no-valid-candidate.txt
printf 'cat input.txt > output.txt\nprintf polluted > input.txt\n' > candidates/program.sh
run_attempt 2
printf 'cmp input.txt expected.txt || exit 88\nprintf wrong > output.txt\n' > candidates/program.sh
if run_attempt 3; then exit 92; fi
cmp inputs/input.txt inputs/expected.txt
cmp attempts/2/output.txt inputs/expected.txt
cp attempts/2/saved-program.sh candidates/program.sh
run_attempt 4
cd ..
printf '%s\n' '{"behavior":"checked_exit_preserved_input_restored_good","fallback":"bash","failed_target":{"command":{"exit_code":7}},"good":{"status":"passed"},"regression":{"status":"failed"},"restored":{"status":"passed"},"no_valid_candidate_recorded":true}' > behavior-proof.json
cat behavior-proof.json
"""

class Fixture(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  b=json.loads(self.rfile.read(int(self.headers['Content-Length'])));s=self.server;s.calls+=1
  messages=b['messages'];last=max(i for i,m in enumerate(messages) if m['role']=='user');task=messages[last]['content'];tail=messages[last:]
  results=[]
  for m in tail:
   if m['role']=='tool':
    try:results.append(json.loads(m['content']))
    except ValueError:results.append(m['content'])
  kind='decision' if '同一次学习的最终决定阶段' in task else 'learn' if '独立机制学习阶段' in task else 'native' if task=='RELIABILITY_NATIVE' else 'solve'
  evolved=any(MARKER in str(m.get('content')) for m in messages if m['role']=='system')
  heldout=kind=='solve' and ('regex' in task.lower() or 'wal' in task.lower())
  call=None;content='INCOMPLETE: mechanism fixture; no benchmark solution attempted.'
  if kind=='learn':
   facts=json.JSONDecoder().raw_decode(task.split('事实：\n')[1])[0]
   assert facts['feedback']['valid'] and facts['feedback']['reward']==0 and facts['feedback']['diagnosis']['specific_cause']=='unknown'
   assert facts['public_task_requirements'] and 'tests' not in facts['feedback']
   s.feedback_seen=True
   if facts['previous_learning']:content=json.dumps({'decision':'no_change','reason':'One mechanism fixture sufficient'})
   elif not results:call=['management',{'operation':'draft'}]
   elif len(results)==1:call=['bash',{'command':"cat >> "+shlex.quote(results[0]['path']+'/.agents/self/INSTRUCTIONS.md')+" <<'RULES'\n"+MARKER+'\n'+STRATEGY+'\nRULES'}]
   elif len(results)==2:call=['management',{'operation':'submit','draft':results[0]['id'],'reason':'Check real exits and preserve clean input and good candidates'}]
   elif len(results)==3:call=['management',{'operation':'evaluate','version':results[2]['id'],'task':'RELIABILITY_NATIVE'}]
   else:content=json.dumps({'decision':'candidate','reason':'Observable failure and regression handling exercised','candidate_version':results[2]['id'],'evaluation_id':results[3]['evaluation']})
  elif kind=='decision':
   facts=json.JSONDecoder().raw_decode(task.split('候选与验证：\n')[1])[0]
   if not results:call=['management',{'operation':'promote','evaluation':facts['evaluation'],'version':facts['candidate']['id'],'reason':'Mechanism fixture, equal official scores','acceptReason':'No capability gain claim; behavior evidence independently checked'}]
   else:content=json.dumps({'decision':'accept','reason':'Fixture switch'})
  elif kind=='native':
   if not results:call=['runtime_records',{}]
   elif len(results)==1:
    sources=results[0]['runs'][-1]['instructions'];own=next(x['path'] for x in sources if x['kind']=='self_instructions')
    helper=own.split('/.agents/self/')[0]+'/.agents/skills/reliable-verification/scripts/verify.py'
    call=['bash',{'command':probe(helper)}]
   else:
    assert results[-1].get('exit_code')==0,results[-1]
    content='Observed failure exit 7 despite matching bytes; no-good branch recorded; fresh input and prior good candidate recovered.'
  elif heldout and len(results)<2:
   call=['management',{'operation':'draft'} if not results else {'operation':'promote','version':'forbidden','evaluation':'forbidden','reason':'boundary','acceptReason':'boundary'}]
  elif len(results)==(2 if heldout else 0):
   if s.case=='execution':subprocess.run(['docker','stop','--time','0',next(iter(s.experiment.containers))],check=True,capture_output=True)
   call=['bash',{'command':("if command -v python3 >/dev/null; then\n"+probe('/tmp/seeda-agent-skills/reliable-verification/scripts/verify.py')+"\nelse\n"+shell_probe()+"\nfi") if evolved else "printf '{\"behavior\":\"unverified_output_only\"}' > /app/behavior-proof.json"}]
  elif s.case!='execution':
   assert results[-1].get('exit_code')==0,results[-1]
  s.requests.append({'kind':kind,'evolved':evolved,'heldout':heldout,'tool':call[0] if call else None})
  delta={'tool_calls':[{'index':0,'id':'layer-'+str(s.calls),'type':'function','function':{'name':call[0],'arguments':json.dumps(call[1])}}]} if call else {'content':content}
  data=('data: '+json.dumps({'choices':[{'delta':delta,'finish_reason':'tool_calls' if call else 'stop'}],'usage':{'prompt_tokens':20,'completion_tokens':10,'total_tokens':30,'prompt_cache_hit_tokens':0,'prompt_cache_miss_tokens':20}})+'\n\ndata: [DONE]\n\n').encode()
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)

def verify(case):
 seed=PREP/'seed-v2'
 if not seed.exists():
  shutil.copytree(runner.CFG['seed_source'],seed,ignore=shutil.ignore_patterns('.git','node_modules'))
  shutil.copytree(REPO/'.agents/skills/reliable-verification',seed/'.agents/skills/reliable-verification')
 config=dict(runner.CFG,seed_source=str(seed))
 server=ThreadingHTTPServer(('127.0.0.1',0),Fixture);server.case=case;server.calls=0;server.requests=[];server.feedback_seen=False
 threading.Thread(target=server.serve_forever,daemon=True).start()
 env={'DEEPSEEK_BASE_URL':f'http://127.0.0.1:{server.server_port}','DEEPSEEK_API_KEY':'local-fixture'}
 with patch.dict(os.environ,env),patch.object(runner,'CFG',config):e=runner.Experiment('layered-'+case+'-'+time.strftime('%m%d-%H%M%S'))
 server.experiment=e;e.state['purpose']='preparation-only deterministic mechanism verification';proofs=[];original=runner.retain_container;original_score=scoring.score_image
 def retain(cid,directory):
  evidence=original(cid,directory);assert evidence['archive_exit_code']==0 and evidence['stopped']
  with tarfile.open(Path(directory)/'app.tar') as archive:
   member=next((n for n in archive.getnames() if n.endswith('/behavior-proof.json')),None)
   if member:proofs.append({'directory':str(directory),**json.load(archive.extractfile(member))})
  return evidence
 def bad_score(*args,**kwargs):return original_score(*args,**kwargs,fault='startup')
 report={'case':case,'run':str(e.directory),'provider_calls':0,'status':'failed'}
 try:
  with patch.object(runner,'CFG',config),patch.object(runner,'retain_container',retain),patch.object(scoring,'score_image',bad_score if case=='scoring' else original_score):status=e.run()
  assert e.state['meter']['attempts']==server.calls
  if case=='complete':
   assert status=='completed',e.state.get('stop_reason');assert server.feedback_seen
   assert len(e.state['scores'])==13 and all(x['valid'] for x in e.state['scores'])
   learned=e.state['learning'][0];assert learned['outcome']=='promoted'
   candidate=learned['candidate'];assert any(x['state']=='completed' and x['to_version']==candidate['id'] for x in learned['decision_stage']['switches'])
   next_task=e.state['development'][1]['execution'];assert all(x['implementationVersion']==candidate['id'] for x in next_task['metrics']['requests'])
   assert any(x['loaded'] and x['kind']=='self_instructions' and x['path'].startswith(candidate['runtime_path']) for i in next_task['metrics']['instructions'] for x in i['sources'])
   assert next_task['skill_source'].startswith(candidate['runtime_path'])
   native=json.loads(Path(learned['native_evaluations'][0]['evidence_path']).read_text());proof=json.loads((Path(native['cwd'])/'behavior-proof.json').read_text());assert proof['restored']['status']=='passed'
   assert json.loads(next((Path(learned['learning']['evidence_directory'])/'native-evaluate').glob('*/process-exit.json')).read_text())['exit_code']==0
   assert any(x['behavior']=='unverified_output_only' for x in proofs)
   changed=[x for x in proofs if x['behavior']=='checked_exit_preserved_input_restored_good'];assert len(changed)==7,len(changed)
   for x in changed:assert x['failed_target']['command']['exit_code']==7 and x['good']['status']=='passed' and x['regression']['status']=='failed' and x['restored']['status']=='passed'
   for row in e.state['heldout']:
    ex=row['execution'];assert ex['version_before']['id']==ex['version_after']['id'];assert len(ex['management'])==2 and all('disabled in solve' in x.get('error','') for x in ex['management'])
   assert all(x['process_exit_code']==0 for x in e.state['stages'])
   report.update(feedback_seen=True,switch_completed=True,next_task_loaded=True,behavior_artifacts_verified=len(changed),native_behavior=proof,heldout_denials=16)
  else:
   assert status=='abnormal_stop' and not e.state['learning'] and not e.state['heldout'],e.state.get('stop_reason')
   if case=='execution':assert not e.state['scores'] and 'execution_environment_failed' in e.state['stop_reason']
   else:assert len(e.state['scores'])==1 and not e.state['scores'][0]['valid']
  report.update(status='passed',run_status=status,stop_reason=e.state.get('stop_reason'),official_scores=len(e.state['scores']),fixture_calls=server.calls,usage=e.state['meter'],wall_seconds=e.state['wall_seconds'],proofs=proofs)
 finally:
  server.shutdown();server.server_close();runner.save(e.directory/'fixture-requests.json',server.requests);runner.save(e.directory/'verification.json',report);runner.save(PREP/(case+'-'+e.run_id+'.json'),report)
 return report
if __name__=='__main__':
 import sys
 for case in sys.argv[1:] or ['complete','execution','scoring']:
  r=verify(case);print(json.dumps({k:v for k,v in r.items() if k not in ['usage','proofs','native_behavior']},ensure_ascii=False),flush=True)

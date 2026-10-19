"""A serial, repeatable native evaluation host bridge, preserving Seeda's native candidate sandbox."""
import json,secrets,subprocess,threading,sqlite3,stat,os,sys,time,traceback
from contextlib import closing
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from contextlib import nullcontext
from candidate_environment import CandidateEnvironment
def snapshot_profile(runtime, destination):
 paths = ['/dev/urandom','/dev/random','/dev/null','/System/Library','/usr/lib','/usr/share','/usr/bin','/bin','/Library/Developer/CommandLineTools','/Applications/Xcode.app/Contents/Developer',str(Path(__file__).with_name('native_snapshot.py')),str(Path(__file__).with_name('python_support'))]
 # Deliberately do not resolve Agent-controlled paths into sandbox permissions.
 return '(version 1)(deny default)(allow process-exec)(allow process-fork)(allow sysctl-read)(allow file-read-metadata)(allow mach-lookup (global-name "com.apple.system.logger"))' + '(allow file-read* (literal "/") '+ ' '.join('(subpath '+json.dumps(p)+')' for p in paths+[str(runtime)]) + ')' + '(allow file-read* file-write* (subpath '+json.dumps(str(destination))+'))(allow file-write-data (literal "/dev/null"))'

def read_regular(path):
 # Parents are external control directories. Candidate may only change the final
 # session file inside its sandbox, never the parent evaluation/control paths.
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'r') as stream:
  if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):raise RuntimeError('Native evidence is not a regular file')
  return stream.read()

class NativeBroker:
 def __init__(self,node,root,runtime,workspace,source,base_url,model,evidence,env,host_path=None,thinking=True,dynamic_source=False,dependencies=None,task_container=None,docker_socket=None):
  self.task_container=task_container;self.docker_socket=docker_socket
  self.dependency_manifest_required=dependencies is not None
  self.dependencies=Path(dependencies) if dependencies else Path(root)/'dependencies'
  self.dynamic_source=dynamic_source;self.thinking=thinking;self.host_path=host_path;self.node=node;self.root=Path(root);self.runtime=str(runtime);self.workspace=str(workspace);self.source=source;self.base_url=base_url;self.model=model;self.evidence=Path(evidence);self.env=env;self.used=False;self.closed=False;self.attempts=0;self.lock=threading.Lock();self.process=None;self.token=secrets.token_urlsafe(24)
 def start(self):
  broker=self
  class Handler(BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def do_POST(self):
    if self.path!='/evaluate/'+broker.token:self.send_error(404);return
    reserved=False
    try:
     n=int(self.headers.get('Content-Length',0))
     if not 0<n<64000:raise ValueError('Invalid size')
     data=json.loads(self.rfile.read(n))
     if not isinstance(data,dict):raise ValueError('Invalid native evaluation arguments')
     version=data.get('version');task=data.get('task')
     if set(data)-{'version','task','sandbox'} or data.get('sandbox','process')!='process' or not isinstance(version,str) or not version.strip() or Path(version).name!=version or version in ('.','..') or not isinstance(task,str) or not task.strip():raise ValueError('Invalid native evaluation arguments')
     with broker.lock:
      if broker.closed or broker.used:self.send_error(409,'A native evaluation has started or is pending');return
      broker.used=True;reserved=True;broker.attempts+=1
     evidence=broker.evidence/str(broker.attempts);evidence.mkdir(parents=True,exist_ok=False)
     control=evidence/'control';control.mkdir();(control/'workspace').mkdir()
     with (evidence/'snapshot.log').open('w') as output:
      broker.process=subprocess.Popen(['/usr/bin/sandbox-exec','-p',snapshot_profile(broker.runtime,control),'/Library/Developer/CommandLineTools/usr/bin/python3',str(Path(__file__).with_name('native_snapshot.py')),broker.runtime,str(control),'' if broker.dynamic_source else broker.source or '',version],env=broker.env,stdout=output,stderr=subprocess.STDOUT)
      snapshot_code=broker.process.wait()
     (evidence/'snapshot-exit.json').write_text(json.dumps({'exit_code':snapshot_code}))
     if snapshot_code==2:
      rejection=json.loads(read_regular(control/'candidate-rejection.json'))
      if not isinstance(rejection,dict) or rejection.get('kind')!='candidate_input_rejected' or not isinstance(rejection.get('error'),str) or not isinstance(rejection.get('traceback'),str):raise RuntimeError('Invalid candidate rejection receipt')
      with broker.lock:broker.used=False
      body=json.dumps({'error':rejection['error'],'kind':'candidate_input_rejected','evaluation_started':False}).encode()
      self.send_response(400);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers()
      try:self.wfile.write(body)
      except OSError:pass
      return
     if snapshot_code!=0:raise RuntimeError('Native input snapshot failed')
     metadata=json.loads((control/'versions.json').read_text());broker.source=metadata['source']
     task += '\n\nThis process-sandbox evaluation checks candidate Agent code and behavior only. It has no official project container or scoring access. Do not claim official project validation. Do not read operator, reference, or held-out material.'
     spec={'runtimeRoot':str(control),'workspace':str(control/'workspace'),'importedVersions':metadata,'sourceVersionId':broker.source,'candidateVersionId':version,'task':task,'baseUrl':broker.base_url,'model':broker.model,'thinking':broker.thinking,'resultPath':str(evidence/'result.json'),'evaluationBudget':None}
     if broker.host_path:spec['hostPath']=broker.host_path
     capability = CandidateEnvironment(broker.task_container,broker.docker_socket,evidence) if broker.task_container else nullcontext(None)
     with capability as isolated:
      if isolated:
       spec['candidateExecution']={'kind':'docker','container':isolated.cid,'cwd':'/workspace'}
       spec['dockerHost']=isolated.scope.url
       spec['task'] += '\nBash uses a separate offline task-image container at /workspace with dev privileges, no host mounts and no official scoring. Write command fixtures there. This is NOT the live project.'
      (evidence/'input.json').write_text(json.dumps(spec))
      with (evidence/'process.log').open('w') as output:
       broker.process=subprocess.Popen([broker.node,'--experimental-strip-types',str(broker.root/'stage.ts'),'--native-evaluate',str(evidence/'input.json')],env=broker.env,stdout=output,stderr=subprocess.STDOUT)
       code=broker.process.wait()
     (evidence/'process-exit.json').write_text(json.dumps({'exit_code':code}))
     if not (evidence/'result.json').exists():raise RuntimeError('Native evaluation host failed without result; see external evidence')
     value=json.loads((evidence/'result.json').read_text())
     if not isinstance(value,dict) or not isinstance(value.get('evaluation_started'),bool) or value.get('status') not in ['completed','failed','cancelled'] or code!=(0 if value['status']=='completed' else 1):raise RuntimeError('Native evaluation process/result mismatch')
     if value.get('infrastructure_failure'):raise RuntimeError('Native evaluation host exception')
     if value.get('evaluation_started'):
      identity=value.get('evaluation')
      if not isinstance(identity,str) or Path(identity).name!=identity:raise RuntimeError('Invalid native evaluation identity')
      files={'result.json':read_regular(control/'evaluations'/identity/'result.json')}
      session=control/'evaluations'/identity/'sandbox/session.jsonl'
      try:files['sandbox/session.jsonl']=read_regular(session)
      except FileNotFoundError:pass
      value['import_record']={'id':identity,'source_version':broker.source,'candidate_version':version,'status':value['status'],'files':files}
      value['external_control']=str(control)
     # Concurrent calls remain excluded; completed evaluations never consume an allowance.
     with broker.lock:broker.used=False
     body=json.dumps(value).encode();self.send_response(200)
    except Exception as error:
     if reserved and 'evidence' in locals():
      (evidence/'host-error.json').write_text(json.dumps({'error':str(error),'traceback':traceback.format_exc()}))
     if reserved:
      with broker.lock:broker.closed=True
     body=json.dumps({'error':'Native evaluation unavailable or invalid; host evidence retained'}).encode();self.send_response(500 if reserved else 400)
    self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers()
    try:self.wfile.write(body)
    except OSError:pass
  self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler);self.server.daemon_threads=True;self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.url=f'http://127.0.0.1:{self.server.server_port}/evaluate/{self.token}';return self
 def close(self):
  with self.lock:self.closed=True
  if self.process and self.process.poll() is None:
   self.process.terminate()
   try:self.process.wait(timeout=15)
   except subprocess.TimeoutExpired:self.process.kill();self.process.wait(timeout=5)
  self.server.shutdown();self.server.server_close();self.thread.join(timeout=2)

"""Separate offline task-image container, without host mounts or scoring artifacts."""
import json,subprocess,uuid
from pathlib import Path
from docker_scope import DockerScope
class CandidateEnvironment:
 def __init__(self,source,socket_path,evidence):
  self.source=source;self.socket_path=socket_path;self.evidence=Path(evidence);self.cid=None;self.scope=None
 def docker(self,*args):
  p=subprocess.run(['docker',*args],capture_output=True,text=True,timeout=60)
  if p.returncode:raise RuntimeError('Candidate Docker '+args[0]+' failed: '+p.stderr[-1000:])
  return p.stdout.strip()
 def __enter__(self):
  try:
   image=json.loads(self.docker('inspect',self.source))[0]['Image']
   self.cid=self.docker('create','--name','wb-native-'+uuid.uuid4().hex[:12],'--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','256','--memory','4g','--cpus','2','--label','seeda.scope=workbuddy-native',image,'sleep','infinity')
   self.docker('start',self.cid)
   self.docker('exec','--user','root',self.cid,'sh','-ec','rm -rf /tests /solution /scorer /logs/verifier; mkdir -p /workspace /logs/artifacts; chmod -R a+rwX /workspace /logs/artifacts')
   raw=json.loads(self.docker('inspect',self.cid))[0]
   assert raw['HostConfig']['NetworkMode']=='none' and not raw['Mounts'] and not raw['HostConfig']['Privileged']
   self.scope=DockerScope(self.socket_path,self.cid,self.evidence/'capability-docker.jsonl',user='65534:65534').start()
   (self.evidence/'capability-environment.json').write_text(json.dumps({'container':self.cid,'source_image':image,'network':'none','mounts':raw['Mounts'],'user':'65534:65534','memory':raw['HostConfig']['Memory'],'cpus':raw['HostConfig']['NanoCpus']},indent=2))
   return self
  except BaseException:
   self.__exit__(None,None,None);raise
 def __exit__(self,*args):
  if self.scope:self.scope.close()
  if self.cid:
   p=subprocess.run(['docker','stop','-t','1',self.cid],capture_output=True,text=True,timeout=30)
   (self.evidence/'capability-stop.json').write_text(json.dumps({'container':self.cid,'exit_code':p.returncode,'state':self.docker('inspect','--format','{{.State.Status}}',self.cid)}))
   if p.returncode:raise RuntimeError('Candidate capability cleanup failed')

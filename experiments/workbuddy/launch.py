"""Detached owned launcher; credentials inherited, never serialized."""
import argparse,json,os,shutil,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parent
def save(p,d):p.write_text(json.dumps(d,indent=2)+'\n')
def main():
 p=argparse.ArgumentParser();p.add_argument('--id',required=True);p.add_argument('--child',action='store_true');a=p.parse_args();assert Path(a.id).name==a.id
 receipt=ROOT/'preparation'/('launch-source-'+a.id)
 if not a.child:
  assert not (ROOT/'runs'/a.id).exists();receipt.mkdir()
  for pattern in ('*.py','prompt.txt','selection-proposal.json','config.json'):
   for f in ROOT.glob(pattern):shutil.copy2(f,receipt/f.name)
  shutil.copytree(ROOT/'runtime',receipt/'runtime',ignore=shutil.ignore_patterns('__pycache__'))
  with (ROOT/('active-'+a.id+'.log')).open('xb') as log:
   c=subprocess.Popen([sys.executable,__file__,'--child','--id',a.id],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  save(receipt/'launcher.json',{'pid':c.pid,'at':time.time()});print(json.dumps({'id':a.id,'launcher_pid':c.pid}));return
 started=time.time();c=subprocess.Popen([sys.executable,'-u',str(ROOT/'run_workbuddy.py'),'--id',a.id],cwd=ROOT);keep=subprocess.Popen(['/usr/bin/caffeinate','-i','-w',str(c.pid)])
 save(receipt/'process.json',{'pid':c.pid,'launcher_pid':os.getpid(),'caffeinate_pid':keep.pid,'started_at':started,'exit_code':None});code=c.wait();save(receipt/'process.json',{'pid':c.pid,'launcher_pid':os.getpid(),'started_at':started,'ended_at':time.time(),'exit_code':code})
if __name__=='__main__':main()

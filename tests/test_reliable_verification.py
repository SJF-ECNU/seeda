"""Real subprocess and filesystem tests for the optional verification skill."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT=Path(__file__).resolve().parents[1]/'.agents/skills/reliable-verification/scripts/verify.py'

class VerificationTest(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.source=self.root/'source';self.source.mkdir();self.records=self.root/'records'
  (self.source/'input.txt').write_text('original\n');(self.source/'expected.txt').write_text('original\n')
  self.cli('init',self.records,self.source,'input.txt','expected.txt')
 def tearDown(self):self.temp.cleanup()
 def cli(self,*args,code=0):
  result=subprocess.run([sys.executable,str(SCRIPT),*map(str,args)],capture_output=True,text=True)
  self.assertEqual(result.returncode,code,result.stdout+result.stderr);return json.loads(result.stdout)
 def run_program(self,program,code=0,**extra):
  (self.source/'program.py').write_text(program)
  spec={'hypothesis':'Output and exit must both be valid','candidate_source':str(self.source),'candidates':['program.py'],'command':[sys.executable,'program.py'],'checks':[['cmp','output.txt','expected.txt']],'artifacts':['output.txt'],'timeout_seconds':1,**extra}
  (self.root/'spec.json').write_text(json.dumps(spec));return self.cli('run',self.records,self.root/'spec.json',code=code)
 def test_matching_bytes_do_not_mask_failed_target(self):
  result=self.run_program("from pathlib import Path\nPath('output.txt').write_text(Path('input.txt').read_text())\nraise SystemExit(7)\n",code=1)
  self.assertEqual(result['command']['exit_code'],7);self.assertEqual(result['checks'][0]['exit_code'],0);self.assertEqual(result['status'],'failed')
 def test_new_input_copy_and_previous_good_candidate_survive_regression(self):
  good="from pathlib import Path\nPath('output.txt').write_text(Path('input.txt').read_text())\nPath('input.txt').write_text('polluted')\n"
  first=self.run_program(good);second=self.run_program("from pathlib import Path\nassert Path('input.txt').read_text() == 'original\\n'\nPath('output.txt').write_text('wrong')\n",code=1)
  self.assertEqual((Path(first['attempt'])/'candidate/program.py').read_text(),good)
  self.assertEqual((self.records/'inputs/input.txt').read_text(),'original\n')
  self.assertEqual(json.loads((Path(first['attempt'])/'result.json').read_text())['status'],'passed');self.assertEqual(second['checks'][0]['exit_code'],1)
  self.cli('init',self.records,self.source,'input.txt',code=2)
 def test_timeout_and_missing_artifact_fail(self):
  r=self.run_program('import time\ntime.sleep(30)\n',code=1,timeout_seconds=.05)
  self.assertTrue(r['command']['timed_out']);self.assertFalse(r['artifacts']['output.txt'])
 def test_launch_error_is_not_success(self):
  r=self.run_program('',code=1,command=['/definitely/not/a/program']);self.assertIsNone(r['command']['exit_code']);self.assertIn('error',r['command'])
 def test_check_failure_and_no_checks_cannot_pass(self):
  self.run_program("from pathlib import Path\nPath('output.txt').write_text('original\\n')\n",code=1,checks=[[sys.executable,'-c','raise SystemExit(9)']])
  self.run_program('',code=2,checks=[])
 def test_paths_and_input_overlap_rejected(self):
  self.run_program('',code=2,candidates=['input.txt'])
  self.run_program('',code=2,artifacts=['../escape'])
  (self.source/'link.py').symlink_to(self.source/'program.py');self.run_program('',code=2,candidates=['link.py'])

if __name__=='__main__':unittest.main()

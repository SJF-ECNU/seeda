import json,tempfile,unittest
from pathlib import Path
from report import report

class AccountingReceiptTest(unittest.TestCase):
 def test_stopped_snapshot_uses_final_usage_and_time_and_not_free_preparation(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);old=p/'old';stop=old/'stopped-by-user';stop.mkdir(parents=True)
   (old/'state.json').write_text(json.dumps({'status':'running','meter':{'usage':{'total_tokens':1}}}))
   (stop/'receipt.json').write_text(json.dumps({'status':'stopped_by_user'}))
   (stop/'known-cost-at-stop.json').write_text(json.dumps({'known_usage':{'total_tokens':184844842},'run_wall_seconds_to_stop':5865.424,'cancelled_in_flight_unknown':[1]}))
   run=p/'new';run.mkdir();(run/'state.json').write_text(json.dumps({'status':'completed','prior_runs':[str(old)],'config':{'preparation_evidence':['paid-probe.json']}}))
   report(run);rollup=json.loads((run/'cost-rollup.json').read_text());prior=rollup['previous_runs'][0]
   self.assertEqual(prior['status'],'stopped');self.assertEqual(prior['observed_usage']['total_tokens'],184844842);self.assertEqual(prior['run_wall_seconds'],5865.424)
   self.assertEqual(prior['recorded_stop_cost']['cancelled_in_flight_unknown'],[1]);self.assertIsNone(rollup['preparation']['provider_calls']);self.assertEqual(rollup['preparation']['evidence'],['paid-probe.json'])
 def test_older_receipt_shape_remains_supported(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);old=p/'old';stop=old/'stopped-by-user';stop.mkdir(parents=True)
   (stop/'receipt.json').write_text('{}');(stop/'known-cost-at-stop.json').write_text(json.dumps({'meter':{'usage':{'total_tokens':7}},'wall_seconds_to_stop':5}))
   run=p/'new';run.mkdir();(run/'state.json').write_text(json.dumps({'status':'completed','prior_runs':[str(old)]}));report(run)
   row=json.loads((run/'cost-rollup.json').read_text())['previous_runs'][0];self.assertEqual(row['observed_usage']['total_tokens'],7);self.assertEqual(row['run_wall_seconds'],5)
if __name__=='__main__':unittest.main()

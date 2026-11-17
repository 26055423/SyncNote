"""Frozen-validation integrity, temporal boundaries, and no-refit guarantees."""
import copy
import datetime as dt
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from tools import breakout_validation as v

def epoch(year):
 return int(dt.datetime(year,1,1,tzinfo=dt.timezone.utc).timestamp())

def sample(start, count=120, source='srv:Training', label=None):
 events = []
 for i in range(count):
  t = start+i*21600
  x = [.1,0.,.5,.2,3.,0.,0.]
  events.append({'decision':t,'end':t+21600,'direction':1 if i%2 else -1,'x':x,'outcomes':{'main':label or v.research.LABELS[i%3]},'updates':{'main':x+[.2,-.1,1.]}})
 return {'schema':'syncnote-breakout-events.v1','data':{'source':source,'symbol':'XAUUSD','time_basis':'UTC','as_of':v.research.stamp(start+count*21600+1)},'events':events}

class ValidationTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.training = sample(epoch(2019))
  cls.bundle = v.freeze(cls.training,epoch(2022))

 def test_freeze_records_source_sample_and_time(self):
  self.assertEqual(self.bundle['training_sample_sha256'],v.digest(self.training))
  self.assertEqual(self.bundle['forward']['train'],120)
  self.assertLess(self.bundle['forward']['last_label_end'],self.bundle['frozen_at']-21600)
  v.verify(self.bundle)

 def test_backdated_freeze_rejected(self):
  with self.assertRaises(ValueError):
   v.freeze(self.training,epoch(2018))

 def test_tampered_artifact_rejected(self):
  altered = copy.deepcopy(self.bundle)
  altered['forward']['average'][0] += .01
  with self.assertRaises(ValueError):
   v.verify(altered)

 def test_code_change_rejected(self):
  with patch.object(v,'code_hashes',return_value={}):
   with self.assertRaises(ValueError):
    v.verify(self.bundle)

 def test_old_history_is_not_future_validation(self):
  result = v.evaluate(self.bundle,self.training)
  self.assertEqual(result['n'],0)
  self.assertEqual(result['status'],'insufficient_new_sample')
  self.assertEqual(result['intervals'],{})
  self.assertEqual(result['exclusions']['already_observed_or_embargo'],120)

 def test_evaluation_never_refits_or_mutates_bundle(self):
  future = sample(epoch(2022)+21600)
  original = copy.deepcopy(self.bundle)
  with patch.object(v.research,'fit',side_effect=AssertionError('Evaluation must not fit')):
   result = v.evaluate(self.bundle,future)
  self.assertEqual(result['n'],120)
  self.assertEqual(result['intervals'],{})
  self.assertEqual(self.bundle,original)
  self.assertEqual(result['metrics']['distance']['n'],120)

 def test_embargo_uses_original_event_start(self):
  future = sample(epoch(2022)+21600-600,count=1)
  result = v.evaluate(self.bundle,future)
  self.assertEqual(result['n'],0)

 def test_transfer_requires_other_broker_and_earlier_model(self):
  with self.assertRaises(ValueError):
   v.evaluate(self.bundle,self.training,'transfer')
  target = sample(epoch(2021),source='srv:Other')
  result = v.evaluate(self.bundle,target,'transfer')
  self.assertEqual(result['n'],120)
  self.assertLess(self.bundle['annual']['2021']['last_label_end'],epoch(2021)-21600)
  early = sample(epoch(2020),source='srv:Other')
  self.assertEqual(v.evaluate(self.bundle,early,'transfer')['n'],0)

 def test_symbol_mismatch_and_unfinished_data_rejected(self):
  target = sample(epoch(2022)+21600)
  target['data']['symbol'] = 'NAS100'
  with self.assertRaises(ValueError):
   v.evaluate(self.bundle,target)
  unfinished = sample(epoch(2022)+21600)
  unfinished['events'][-1]['end'] += 1
  with self.assertRaises(ValueError):
   v.check_sample(unfinished)

 def test_immutable_artifact_file(self):
  with tempfile.TemporaryDirectory() as folder:
   path = Path(folder)/'fixed.json'
   v.write_new(path,{'a':1})
   with self.assertRaises(FileExistsError):
    v.write_new(path,{'a':2})
   self.assertEqual(path.read_text(),'{\n  "a": 1\n}')

 def test_pending_report_does_not_claim_replication(self):
  report = v.evaluate(self.bundle,self.training)
  output = v.render(report)
  self.assertIn('尚无足够新样本',output)
  self.assertIn('0；跨度',output)

 def test_event_count_alone_does_not_unlock_intervals(self):
  future = sample(epoch(2022)+21600,count=240)
  with patch.object(v.stability,'bootstrap',side_effect=AssertionError('Too short for intervals')):
   result = v.evaluate(self.bundle,future)
  self.assertEqual(result['n'],240)
  self.assertEqual(result['intervals'],{})

 def test_fixed_sample_gate_and_paired_comparators(self):
  future = sample(epoch(2022)+21600,count=200)
  for i,event in enumerate(future['events']):
   event['decision'] = epoch(2022)+21600+i*86400
   event['end'] = event['decision']+21600
  future['data']['as_of'] = v.research.stamp(future['events'][-1]['end']+1)
  calls = []
  def check(rows,comparator,unit,repetitions,seed):
   calls.append((rows,comparator,unit,repetitions,seed))
   return {'n':len(rows)}
  with patch.object(v.stability,'bootstrap',check):
   result = v.evaluate(self.bundle,future)
  self.assertEqual(result['status'],'ready_for_fixed_sample_comparison')
  self.assertEqual(result['span_days'],199)
  self.assertEqual(len(calls),4)
  self.assertTrue(all(c[1]=='distance' and c[3]==2000 for c in calls))
  first = calls[0][0][0]['probabilities']
  expected = result['predictions'][0]['probabilities']
  self.assertEqual(first['full'],expected['only_position'])
  self.assertEqual(first['distance'],expected['distance'])

 def test_overlapping_training_labels_are_rejected(self):
  future = v.stability.stage_events(sample(epoch(2022)+21600,count=1)['events'],'main',v.PRIMARY)[0]
  fitted = copy.deepcopy(self.bundle['forward'])
  fitted['last_label_end'] = future['decision']-100
  with self.assertRaises(ValueError):
   v.forecast(future,fitted,self.bundle)

if __name__=='__main__':
 unittest.main()

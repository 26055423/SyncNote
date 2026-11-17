"""Paired ablation/bootstrap invariants on synthetic observations."""
import copy
import datetime as dt
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from tools import breakout_stability as s

class StabilityTests(unittest.TestCase):
 def row(self,t=1704067200,direction=1,p=None):
  return {'decision':t,'end':t+21600,'direction':direction,'label':'continue','year':dt.datetime.fromtimestamp(t,dt.timezone.utc).year,'probabilities':{'full':p or [.8,.1,.1],'average':[.4,.3,.3]}}

 def test_blocks_and_quantiles(self):
  monday = int(dt.datetime(2024,1,1,tzinfo=dt.timezone.utc).timestamp())
  self.assertEqual(s.calendar_block(monday+6*86400,'week'),'2024-01-01')
  self.assertEqual(s.calendar_block(monday+7*86400,'week'),'2024-01-08')
  self.assertEqual(s.calendar_block(monday,'month'),'2024-01')
  self.assertEqual(s.quantile([1,2,3,4],.5),2.5)

 def test_constant_paired_gain_has_exact_interval(self):
  rows = [self.row(1704067200+i*86400) for i in range(40)]
  result = s.bootstrap(rows,'average','week',100)
  expected = s.loss('continue',[.4,.3,.3],'brier')-s.loss('continue',[.8,.1,.1],'brier')
  self.assertAlmostEqual(result['metrics']['brier']['gain'],expected)
  for endpoint in result['metrics']['brier']['ci95']:
   self.assertAlmostEqual(endpoint,expected)
  self.assertEqual(result['blocks'],6)

 def test_identical_predictions_have_zero_gain(self):
  rows = [self.row(1704067200+i*86400,p=[.4,.3,.3]) for i in range(40)]
  result = s.bootstrap(rows,'average','month',100)
  self.assertEqual(result['metrics']['brier'],{'gain':0.,'ci95':[0.,0.]})
  self.assertEqual(result['metrics']['log_loss'],{'gain':0.,'ci95':[0.,0.]})

 def test_deterministic_stratified_resampling(self):
  rows = [self.row(1704067200+i*86400,p=[.6+(i%2)*.2,.2-(i%2)*.1,.2-(i%2)*.1]) for i in range(400)]
  a = s.bootstrap(rows,'average','month',100)
  b = s.bootstrap(rows,'average','month',100)
  self.assertEqual(a,b)
  self.assertEqual(set(a['blocks_by_year']),{'2024','2025'})
  self.assertEqual(a['n'],400)

 def test_stage_selection_keeps_labels_and_directions(self):
  event = {'decision':0,'end':21600,'direction':-1,'x':list(range(7)),'outcomes':{'main':'fail'},'updates':{'main':list(range(10))}}
  original = copy.deepcopy(event)
  initial = s.stage_events([event],'main','initial')
  update = s.stage_events([event],'main','after_15m')
  self.assertEqual(initial[0]['label'],update[0]['label'])
  self.assertEqual(update[0]['decision'],900)
  self.assertEqual(update[0]['direction'],-1)
  self.assertEqual(event,original)
  self.assertEqual(s.stage_events([dict(event,outcomes={'main':'ambiguous'})],'main','initial'),[])

 def test_ablation_columns_and_sample_are_fixed(self):
  events = []
  for year in (2020,2021,2022):
   start = int(dt.datetime(year,1,1,tzinfo=dt.timezone.utc).timestamp())
   events += [{'decision':start+i*21600,'end':start+i*21600+21600,'direction':1,'x':list(range(7)),'label':'fail'} for i in range(120)]
  seen = []
  def fake_fit(train):
   seen.append(train)
   d = len(train[0]['x'])
   return ([0.]*d,[1.]*d,[[0.]*(d+1) for _ in range(3)])
  with patch.object(s.research,'fit',fake_fit):
   rows,folds = s.walk_forward(events,{'full':tuple(range(7)),'no_speed':(0,2,3,4,5,6)})
  self.assertEqual(len(rows),120)
  self.assertEqual([e['decision'] for e in seen[0]],[e['decision'] for e in seen[1]])
  self.assertEqual(seen[1][0]['x'],[0,2,3,4,5,6])
  self.assertTrue(all(e['end']<rows[0]['decision']-21600 for e in seen[0]))
  self.assertTrue(all(set(r['probabilities'])=={'full','no_speed','average','trend','distance'} for r in rows))

 def test_distance_baseline_uses_position_and_preserves_mass(self):
  low = s.distance_prior(-.4,1.,.5,.02)
  high = s.distance_prior(.8,1.,.5,.02)
  self.assertGreater(high[0],low[0])
  self.assertAlmostEqual(sum(high),1)
  self.assertEqual(high[2],.02)
  self.assertAlmostEqual(s.distance_prior(0,1.,.5,0)[0],1/3)

 def test_insufficient_sample_still_generates_report(self):
  report = s.stability({'events':[],'data':{'symbol':'X'}},100)
  output = s.render(report)
  self.assertIn('0 个样本外事件',output)
  self.assertEqual(s.bootstrap([],'average','week',100),None)

if __name__=='__main__':
 unittest.main()

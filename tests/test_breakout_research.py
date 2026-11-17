"""Research invariants: causal features, minute ordering, purged evaluation."""
import math
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from tools import breakout_research as r

class BreakoutResearchTests(unittest.TestCase):
 def test_touch_direction_and_ambiguity(self):
  self.assertEqual(r.first_touch([[0,100,101.1,99.9,100]],100,1,1),('continue',60))
  self.assertEqual(r.first_touch([[0,100,100.1,98.9,99]],100,-1,1),('continue',60))
  self.assertEqual(r.first_touch([[0,100,101.1,99.4,100]],100,1,1),('ambiguous',60))
  self.assertEqual(r.first_touch([[0,100,100.3,99.4,100]],100,1,1),('fail',60))
  self.assertEqual(r.first_touch([[0,100,100.3,99.9,100]],100,1,1),('unresolved',60))

 def test_prior_and_stable_probabilities(self):
  self.assertAlmostEqual(sum(r.probabilities([10000,-10000,0])),1)
  self.assertEqual(r.prior([]),[1/3]*3)
  self.assertEqual(r.metrics([]),None)

 def test_report_is_standalone_and_escapes_symbols(self):
  empty = {'pooled':{'model':None,'average':None,'trend':None}}
  result = {k:empty for k in ('initial','survivors_initial','after_15m')}
  report = {'data':{'symbol':'<script>alert(1)</script>'},'results':{'main':result}}
  output = r.render(report)
  self.assertNotIn('<script>',output)
  self.assertIn('&lt;script&gt;',output)
  self.assertIn('var(--panel)',output)

 def test_classifier_learns_separable_signal(self):
  events = [{'x':[float(i%2)*2-1],'label':'continue' if i%2 else 'fail'} for i in range(200)]
  model = r.fit(events)
  self.assertGreater(r.predict(model,[1])[0],.8)
  self.assertGreater(r.predict(model,[-1])[1],.8)
  self.assertTrue(all(math.isfinite(x) for x in r.predict(model,[100])))

 def test_year_split_purges_label_windows(self):
  events = []
  for year in (2020,2021,2022):
   start = int(r.dt.datetime(year,1,1,tzinfo=r.dt.timezone.utc).timestamp())
   events += [{'decision':start+i*21600,'end':start+i*21600+21600,'x':[0.]*7,'label':'fail'} for i in range(120)]
  cutoff = int(r.dt.datetime(2022,1,1,tzinfo=r.dt.timezone.utc).timestamp())
  events.append({'decision':cutoff-100,'end':cutoff+100,'x':[0.]*7,'label':'continue'})
  seen = []
  def fake_fit(train):
   seen.extend(train)
   return ([0.]*7,[1.]*7,[[0.]*8 for _ in range(3)])
  with patch.object(r,'fit',fake_fit):
   result = r.evaluate(events)
  self.assertEqual(result['pooled']['model']['n'],120)
  self.assertTrue(all(e['end']<cutoff-21600 for e in seen))

 def fixture(self):
  db = sqlite3.connect(':memory:')
  db.row_factory = sqlite3.Row
  db.execute('CREATE TABLE bars(source,symbol,tf,t,o,h,l,c)')
  decision = 30*86400+300
  def add(tf,rows):
   db.executemany('INSERT INTO bars VALUES(?,?,?,?,?,?,?,?)',[('srv:Test','X',tf,*row) for row in rows])
  for tf,step in [('H1',3600),('H4',14400),('D1',86400)]:
   add(tf,[[t,100,101,99,100] for t in range(0,decision+86400,step)])
  m5 = [[t,100,100.4,99.8,100] for t in range(decision-20*300,decision+21600,300)]
  m5[20-1] = [decision-300,100,101.3,99.8,101.2]
  add('M5',m5)
  add('M1',[[t,101.2,101.4,101.,101.2] for t in range(decision,decision+21600,60)])
  return db,decision

 def test_future_bars_cannot_change_initial_features(self):
  db,decision = self.fixture()
  events,_ = r.extract(db,'srv:Test','X',Path(__file__).resolve().parents[1],now=decision+21600)
  self.assertEqual(len(events),1)
  original = events[0]['x']
  db.execute("UPDATE bars SET h=1000,c=999 WHERE tf IN ('H4','D1') AND t>=?",(decision-300,))
  db.execute("UPDATE bars SET h=110,c=109 WHERE tf='M5' AND t>=?",(decision,))
  changed,_ = r.extract(db,'srv:Test','X',Path(__file__).resolve().parents[1],now=decision+21600)
  self.assertEqual(changed[0]['x'],original)
  db.close()

 def test_missing_minute_excludes_window(self):
  db,decision = self.fixture()
  db.execute("DELETE FROM bars WHERE tf='M1' AND t=?",(decision+60,))
  events,info = r.extract(db,'srv:Test','X',Path(__file__).resolve().parents[1],now=decision+21600)
  self.assertEqual(events,[])
  self.assertEqual(info['exclusions']['missing_outcome'],1)
  db.close()

 def test_confirmation_candle_already_touched_target(self):
  db,decision = self.fixture()
  db.execute("UPDATE bars SET h=104 WHERE tf='M5' AND t=?",(decision-300,))
  events,_ = r.extract(db,'srv:Test','X',Path(__file__).resolve().parents[1],now=decision+21600)
  self.assertEqual(events[0]['outcomes']['main'],'already_resolved')
  db.close()

 def test_cli_database_connection_rejects_writes(self):
  with tempfile.TemporaryDirectory() as folder:
   path = Path(folder)/'bars.sqlite3'
   db = sqlite3.connect(path)
   db.execute('CREATE TABLE evidence(value)')
   db.commit()
   db.close()
   def attempt(db,*args):
    db.execute('INSERT INTO evidence VALUES(1)')
   with patch.object(sys,'argv',['research','--database',str(path)]),patch.object(r,'research',attempt):
    with self.assertRaises(sqlite3.OperationalError):
     r.main()
   db = sqlite3.connect(path)
   self.assertEqual(db.execute('SELECT count(*) FROM evidence').fetchone()[0],0)
   db.close()

if __name__ == '__main__':
 unittest.main()

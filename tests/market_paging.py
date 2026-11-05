"""Count-based market-track pagination uses real SQLite rows, not calendar windows."""
import sqlite3,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import bars

class MarketPaging(unittest.TestCase):
 def setUp(self):
  self.db=sqlite3.connect(':memory:');self.addCleanup(self.db.close);self.db.row_factory=sqlite3.Row
  bars.initialize(self.db)
  self.source='srv:Paging-A';self.shift=10800;self.now=1700000200
  bars.set_source_offset(self.db,self.source,self.shift,0)
  bars.ensure_feed(self.db,'Paging-A','account-one',0)
  bars.ensure_feed(self.db,'Paging-A','account-two',0)
  self.times=[1600000000,1600000060,1600000120,1700000000,1700000060]
  for stamp in self.times:self.insert(self.source,stamp)
  self.insert('srv:Paging-B',1699999999,value=900)
  self.insert('srv:Paging-B',1500000000,value=901)
  self.insert(self.source,1699999998,symbol='EURUSD',value=902)
  self.insert(self.source,1699999997,tf='M5',value=903)

 def insert(self,source,utc,symbol='XAUUSD',tf='M1',value=100,shift=None):
  shift=self.shift if shift is None else shift
  self.db.execute('INSERT INTO bars VALUES(?,?,?,?,?,?,?,?,?,?)',(source,symbol,tf,utc+shift,value,value+1,value-1,value,1,0))

 def page(self,limit=2,before=None):
  return bars.latest_utc(self.db,self.source,'XAUUSD','1m',limit,self.now,before)

 def test_pages_cross_a_multi_year_gap_and_end_on_actual_last_page(self):
  first=self.page()
  self.assertEqual([row[0] for row in first['bars']],self.times[-2:])
  self.assertEqual(first['source'],self.source)
  self.assertEqual(first['count'],2)
  self.assertTrue(first['has_more'])
  self.assertEqual(first['next_before'],1700000000)
  self.assertEqual(first['earliest'],1600000000)
  second=self.page(before=first['next_before'])
  self.assertEqual([row[0] for row in second['bars']],self.times[1:3])
  self.assertTrue(second['has_more'])
  last=self.page(before=second['next_before'])
  self.assertEqual([row[0] for row in last['bars']],[self.times[0]])
  self.assertFalse(last['has_more'])
  self.assertIsNone(last['next_before'])
  empty=self.page(before=self.times[0])
  self.assertEqual(empty['bars'],[])
  self.assertFalse(empty['has_more'])
  self.assertEqual(empty['earliest'],self.times[0])
  self.assertIsNone(empty['next_before'])

 def test_before_is_strict_and_all_cursor_metadata_is_utc_once(self):
  page=self.page(limit=1,before=self.times[-1])
  self.assertEqual([row[0] for row in page['bars']],[self.times[-2]])
  self.assertEqual(page['from_server'],self.times[-2])
  self.assertEqual(page['to_server'],self.times[-2])
  self.assertEqual(page['next_before'],self.times[-2])
  self.assertEqual(page['earliest'],self.times[0])
  self.assertEqual(page['offset_sec'],self.shift)
  self.assertEqual(page['now'],self.now)
  self.assertEqual(page['time_basis'],'utc')
  raw=bars.latest(self.db,self.source,'XAUUSD','M1',1,self.now+self.shift,self.times[-1]+self.shift)
  self.assertEqual(raw['bars'][0][0],self.times[-2]+self.shift)

 def test_track_symbol_and_timeframe_are_never_filled_from_another_source(self):
  page=self.page(limit=20)
  self.assertEqual([row[0] for row in page['bars']],self.times)
  self.assertTrue(all(row[1]==100 for row in page['bars']))
  self.assertFalse(page['has_more'])
  self.assertEqual(self.db.execute('SELECT count(*) FROM feeds WHERE source=?',(self.source,)).fetchone()[0],2)
  missing=bars.latest_utc(self.db,'srv:Missing','XAUUSD','M1',2,self.now)
  self.assertEqual(missing['bars'],[])
  self.assertIsNone(missing['earliest'])
  self.assertFalse(missing['has_more'])

 def test_closed_filter_uses_broker_wall_now_and_excludes_forming_or_future_rows(self):
  self.insert(self.source,self.now-30)
  self.insert(self.source,self.now+60)
  self.assertEqual([row[0] for row in self.page(limit=20)['bars']],self.times)
  negative='srv:Negative-Offset'
  bars.set_source_offset(self.db,negative,-18000,0)
  self.insert(negative,self.now-120,shift=-18000)
  self.insert(negative,self.now-30,shift=-18000)
  page=bars.latest_utc(self.db,negative,'XAUUSD','M1',2,self.now)
  self.assertEqual([row[0] for row in page['bars']],[self.now-120])
  self.assertFalse(page['has_more'])

if __name__=='__main__':unittest.main()

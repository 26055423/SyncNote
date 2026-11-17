"""Broker-wall closure checks and conservative coverage use real SQLite state."""
import sqlite3,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import bars,live

class BarsIngest(unittest.TestCase):
 def setUp(self):
  self.db=sqlite3.connect(':memory:');self.addCleanup(self.db.close);self.db.row_factory=sqlite3.Row
  bars.initialize(self.db)
  self.now=1800000037

 def row(self,stamp):return [stamp,100,101,99,100.5,3]

 def test_seven_native_periods_close_on_wall_time_and_keep_their_utc_openings(self):
  for shift in (10800,-18000):
   source='srv:Seven-'+str(shift)
   bars.ensure_feed(self.db,source[4:],'1',self.now)
   bars.set_source_offset(self.db,source,shift,self.now)
   for tf,period in bars.TF_SECONDS.items():
    with self.subTest(tf=tf,shift=shift):
     forming=(self.now+shift)//period*period
     result=bars.ingest(self.db,source,'fixture','XAUUSD',{tf:{
      'bars':[self.row(forming-period),self.row(forming)],'complete':False,
      'from_server':forming-period,'to_server':forming}},self.now)
     self.assertEqual(result['series'][tf]['accepted'],1)
     self.assertEqual(result['series'][tf]['dropped'],1)
     self.assertEqual(bars.latest_utc(self.db,source,'XAUUSD',tf,10,self.now)['bars'][0][0],forming-period-shift)
   tracks=bars.tracks_utc(self.db,'XAUUSD',source,self.now-2*86400,self.now)
   track=next(item for item in tracks['tracks'] if item['source']==source)
   self.assertEqual(set(track['series']),set(bars.TF_SECONDS))
   self.assertTrue(all(item['bars']==1 for item in track['series'].values()))

 def test_forming_cache_accepts_all_seven_native_periods_without_utc_rebucketing(self):
  shift=10800
  series={tf:self.row((self.now+shift)//period*period) for tf,period in bars.TF_SECONDS.items()}
  cache=live.FormingBars()
  self.assertTrue(cache.put(('user','account','token'),'XAUUSD',(self.now+shift)*1000,series,shift,self.now))
  actual=cache.read(('user','account','token'),'XAUUSD',self.now)
  self.assertEqual(set(actual),set(bars.TF_SECONDS))
  for tf in series:self.assertEqual(actual[tf][0][0],series[tf][0]-shift)

 def test_positive_and_negative_offsets_close_bars_on_broker_clock_but_audit_utc(self):
  for shift in (10800,-18000):
   with self.subTest(shift=shift):
    source='srv:Ingest-'+str(shift);bars.set_source_offset(self.db,source,shift,self.now)
    forming=(self.now+shift)//60*60
    result=bars.ingest(self.db,source,'fixture','XAUUSD',{'M1':{
     'bars':[self.row(forming-120),self.row(forming-60),self.row(forming),self.row(forming+60)],
     'complete':False,'from_server':forming-120,'to_server':forming+60}},self.now)
    self.assertEqual(result['series']['M1']['accepted'],2)
    self.assertEqual(result['series']['M1']['dropped'],2)
    stored=self.db.execute('SELECT t,updated FROM bars WHERE source=? ORDER BY t',(source,)).fetchall()
    self.assertEqual([row['t'] for row in stored],[forming-120,forming-60])
    self.assertTrue(all(row['updated']==self.now for row in stored))
    audit=self.db.execute('SELECT updated,state FROM bar_attempt WHERE source=?',(source,)).fetchone()
    self.assertEqual(audit['updated'],self.now)
    self.assertEqual(audit['state'],'partial')
    coverage=self.db.execute('SELECT from_t,to_t,updated FROM bar_coverage WHERE source=?',(source,)).fetchall()
    self.assertEqual([(row['from_t'],row['to_t']) for row in coverage],[(forming-120,forming-60)])
    self.assertTrue(all(row['updated']==self.now for row in coverage))
    self.assertEqual([row[0] for row in bars.latest_utc(self.db,source,'XAUUSD','M1',10,self.now)['bars']],
                     [forming-120-shift,forming-60-shift])

 def test_complete_range_does_not_cover_a_currently_forming_bar(self):
  for shift in (10800,-18000):
   source='srv:Complete-'+str(shift);bars.set_source_offset(self.db,source,shift,self.now)
   forming=(self.now+shift)//900*900
   result=bars.ingest(self.db,source,'fixture','XAUUSD',{'M15':{
    'bars':[self.row(forming-900),self.row(forming)],'complete':True,
    'from_server':forming-900,'to_server':forming}},self.now)
   self.assertEqual(result['series']['M15']['accepted'],1)
   self.assertEqual(self.db.execute('SELECT max(to_t) FROM bar_coverage WHERE source=?',(source,)).fetchone()[0],
                    self.now+shift-900)
   self.assertTrue(any(begin<=forming<=end for begin,end in bars.missing(self.db,source,'XAUUSD','M15',forming-900,forming)))

 def test_partial_rows_do_not_claim_a_missing_prefix_or_internal_gap(self):
  source='srv:Partial';start=1700000000
  bars.ingest(self.db,source,'fixture','XAUUSD',{'M1':{
   'bars':[self.row(start+120),self.row(start+180),self.row(start+360)],
   'complete':False,'from_server':start,'to_server':start+600}},self.now)
  coverage=self.db.execute('SELECT from_t,to_t FROM bar_coverage ORDER BY from_t').fetchall()
  self.assertEqual([tuple(row) for row in coverage],[(start+120,start+180),(start+360,start+360)])
  missing=bars.missing(self.db,source,'XAUUSD','M1',start,start+600)
  for stamp in (start,start+60,start+240,start+300,start+420):
   self.assertTrue(any(begin<=stamp<=end for begin,end in missing),stamp)

 def test_empty_or_invalid_unproven_responses_never_prove_market_closure(self):
  source='srv:Unproven';start=1700000000
  invalid=self.row(start+120);invalid[2]=50
  result=bars.ingest(self.db,source,'fixture','XAUUSD',{'M1':{
   'bars':[invalid],'complete':False,'from_server':start,'to_server':start+600}},self.now)
  self.assertEqual(result['series']['M1']['state'],'pending')
  self.assertEqual(self.db.execute('SELECT count(*) FROM bar_coverage').fetchone()[0],0)
  self.assertEqual(bars.missing(self.db,source,'XAUUSD','M1',start,start+600),[(start,start+600)])
  result=bars.ingest(self.db,source,'fixture','XAUUSD',{'M1':{
   'bars':[],'complete':False,'from_server':start,'to_server':start+600}},self.now)
  self.assertFalse(result['series']['M1']['complete'])
  self.assertEqual(result['series']['M1']['state'],'pending')
  self.assertEqual(self.db.execute('SELECT count(*) FROM bar_coverage').fetchone()[0],0)

if __name__=='__main__':unittest.main()

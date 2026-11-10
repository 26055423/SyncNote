"""Offline review charts read their broker track using UTC ranges and counted pages."""
import hashlib,json,os,sqlite3,sys,tempfile,threading,time,unittest,urllib.error,urllib.parse,urllib.request
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import bars

TIMES=[1699959600,1699959660,1700218800,1700218860,1700823600]
SOURCE='srv:Review-Paging-A'
SHIFT=10800

def insert(db,source,utc,shift=SHIFT,symbol='XAUUSD',tf='M1',value=100):
 db.execute('INSERT INTO bars VALUES(?,?,?,?,?,?,?,?,?,?)',(source,symbol,tf,utc+shift,value,value+1,value-1,value,1,0))

def seed_bars(db):
 bars.set_source_offset(db,SOURCE,SHIFT,0)
 bars.ensure_feed(db,'Review-Paging-A','fixture-account',0)
 for stamp in TIMES:insert(db,SOURCE,stamp)
 insert(db,'srv:Review-Paging-B',TIMES[1]+1,value=900)
 insert(db,SOURCE,TIMES[1]+2,symbol='EURUSD',value=901)
 insert(db,SOURCE,TIMES[1]+3,tf='M5',value=902)

class ReviewBarQueries(unittest.TestCase):
 def setUp(self):
  self.db=sqlite3.connect(':memory:');self.addCleanup(self.db.close);self.db.row_factory=sqlite3.Row
  bars.initialize(self.db);seed_bars(self.db);self.now=1701000000

 def test_narrow_range_shifts_query_and_coverage_boundaries_once(self):
  start,end=TIMES[0]-10,TIMES[0]+90
  bars.mark_coverage(self.db,SOURCE,'XAUUSD','M1',TIMES[0]+SHIFT,TIMES[0]+60+SHIFT,'have',0)
  result=bars.read_utc(self.db,SOURCE,'XAUUSD','1m',start,end,self.now)
  self.assertEqual([row[0] for row in result['bars']],TIMES[:2])
  self.assertEqual(result['covered'],[{'from':TIMES[0],'to':TIMES[0]+60,'state':'have'}])
  self.assertEqual(result['missing'],[{'from':start,'to':TIMES[0]-1},{'from':TIMES[0]+61,'to':end}])
  self.assertEqual((result['from_server'],result['to_server'],result['now']),(start,end,self.now))
  self.assertEqual(result['time_basis'],'utc')

 def test_range_and_forward_pages_filter_forming_bars_for_both_offset_signs(self):
  for shift in (SHIFT,-18000,0):
   source='srv:Clock-'+str(shift);bars.set_source_offset(self.db,source,shift,0)
   for t in (self.now-60,self.now-30,self.now+60):insert(self.db,source,t,shift)
   result=bars.read_utc(self.db,source,'XAUUSD','M1',self.now-120,self.now+120,self.now)
   page=bars.following_utc(self.db,source,'XAUUSD','M1',self.now-120,10,self.now)
   self.assertEqual([row[0] for row in result['bars']],[self.now-60])
   self.assertEqual(page['bars'],result['bars'])

 def test_forward_pages_cross_weekend_and_larger_gap_without_mixing_tracks(self):
  cursor=TIMES[0]-1;result=[]
  for expected in (TIMES[:2],TIMES[2:4],TIMES[4:]):
   page=bars.following_utc(self.db,SOURCE,'XAUUSD','M1',cursor,2,self.now)
   self.assertEqual([row[0] for row in page['bars']],expected)
   self.assertTrue(all(row[1]==100 for row in page['bars']))
   result.extend(row[0] for row in page['bars'])
   self.assertEqual(page['next_after'],expected[-1] if page['has_more'] else None)
   cursor=expected[-1]
  self.assertEqual(result,TIMES)
  empty=bars.following_utc(self.db,SOURCE,'XAUUSD','M1',TIMES[-1],2,self.now)
  self.assertEqual(empty['bars'],[]);self.assertFalse(empty['has_more']);self.assertIsNone(empty['next_after'])

 def test_forward_page_caps_at_twenty_thousand_real_rows(self):
  source='srv:Large';start=1500000000
  self.db.executemany('INSERT INTO bars VALUES(?,?,?,?,?,?,?,?,?,?)',
   ((source,'XAUUSD','M1',start+i*60,1,1,1,1,1,0) for i in range(20002)))
  result=bars.following_utc(self.db,source,'XAUUSD','M1',start-1,99999,self.now)
  self.assertEqual(result['count'],20000);self.assertTrue(result['has_more'])
  self.assertEqual(result['next_after'],start+19999*60)

 def test_tracks_query_each_source_clock_and_keep_m1_blocks_with_all_timeframes(self):
  start,end=TIMES[0]-10,TIMES[0]+90
  bars.mark_coverage(self.db,SOURCE,'XAUUSD','M1',TIMES[0]+SHIFT,TIMES[0]+60+SHIFT,'have',0)
  negative='srv:Review-Negative';shift=-18000
  bars.ensure_feed(self.db,'Review-Negative','negative-account',0)
  bars.set_source_offset(self.db,negative,shift,0)
  insert(self.db,negative,TIMES[0]+30,shift)
  bars.mark_coverage(self.db,negative,'XAUUSD','M1',TIMES[0]+30+shift,TIMES[0]+80+shift,'have',0)
  result=bars.tracks_utc(self.db,'XAUUSD',negative,start,end)
  self.assertEqual((result['from'],result['to'],result['time_basis']),(start,end,'utc'))
  self.assertEqual(result['tracks'][0]['source'],negative)
  tracks={track['source']:track for track in result['tracks']}
  self.assertEqual(tracks[SOURCE]['blocks'],[[TIMES[0],TIMES[0]+60]])
  self.assertEqual(tracks[negative]['blocks'],[[TIMES[0]+30,TIMES[0]+80]])
  self.assertEqual(tracks[SOURCE]['series']['M1']['bars'],2)
  self.assertEqual(tracks[negative]['series']['M1']['bars'],1)
  self.assertEqual(tracks[SOURCE]['series']['H1']['segments'],0)
  wall=bars.tracks(self.db,'XAUUSD',SOURCE,start+SHIFT,end+SHIFT)
  self.assertEqual(wall['tracks'][0]['blocks'],[[TIMES[0]+SHIFT,TIMES[0]+60+SHIFT]])
  without_m1=bars.tracks_utc(self.db,'XAUUSD',SOURCE,start,end,('M5',))
  self.assertEqual(without_m1['tracks'][0]['blocks'],[])
  self.assertEqual(without_m1['tracks'][0]['coverage'],0)

class ReviewBarHTTP(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.folder=tempfile.TemporaryDirectory(prefix='syncnote-review-bars-',ignore_cleanup_errors=True)
  with patch.dict(os.environ,{'DATA_DIR':cls.folder.name,'EA_HUB_ENABLE':'0','COOKIE_SECURE':'0'}):
   import app_server
   app_server.initialize_database()
  cls.app=app_server
  with app_server.connect() as db:
   for person in ('owner','recipient','outsider'):
    db.execute('INSERT INTO users(id,username,nickname,password,created,onboarding_step,share_reviews) VALUES(?,?,?,?,?,4,0)',(person,person,person,'fixture-only',time.time()))
    db.execute('INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)',(hashlib.sha256(person.encode()).hexdigest(),person,time.time()+3600))
   trade={'ticket':'review-one','symbol':'XAUUSD','server':'Review-Paging-A','closed':TIMES[0],'time_basis':'utc'}
   db.execute('INSERT INTO trades VALUES(?,?,?)',('owner','review-one',json.dumps(trade)))
   import chart
   chart.share(db,'owner','review-one',['recipient'],'fixture',{'anchor_ms':TIMES[0]*1000,'timeframe':'1m'})
   cls.share=db.execute('SELECT id FROM review_shares').fetchone()[0]
   seed_bars(db)
   bars.mark_coverage(db,SOURCE,'XAUUSD','M1',TIMES[0]+SHIFT,TIMES[0]+60+SHIFT,'have',0)
  class QuietHandler(app_server.Handler):
   def log_message(self,*args):pass
  cls.server=app_server.ThreadingHTTPServer(('127.0.0.1',0),QuietHandler)
  cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
  cls.base='http://127.0.0.1:'+str(cls.server.server_port)

 @classmethod
 def tearDownClass(cls):
  cls.server.shutdown();cls.server.server_close();cls.thread.join();cls.folder.cleanup()

 def get(self,params,person='owner',path='/api/chart/bars'):
  request=urllib.request.Request(self.base+path+'?'+urllib.parse.urlencode(params),headers={'Cookie':'tongpin_session='+person})
  try:
   with urllib.request.urlopen(request,timeout=10) as response:return response.status,json.load(response)
  except urllib.error.HTTPError as error:return error.code,json.load(error)

 def chart(self,**params):
  return self.get({'ticket':'review-one','tf':'M1',**params})

 def test_latest_before_and_after_read_all_synced_bars_without_ea(self):
  status,latest=self.chart(limit=2)
  self.assertEqual(status,200);self.assertEqual([r[0] for r in latest['bars']],TIMES[-2:])
  status,prior=self.chart(limit=2,before=latest['next_before'])
  self.assertEqual(status,200);self.assertEqual([r[0] for r in prior['bars']],TIMES[1:3])
  status,following=self.chart(limit=2,after=TIMES[0])
  self.assertEqual(status,200);self.assertEqual([r[0] for r in following['bars']],TIMES[1:3])
  self.assertEqual(following['next_after'],TIMES[2]);self.assertTrue(following['has_more'])
  self.assertEqual(following['feed']['source'],SOURCE)

 def test_chart_and_market_ranges_share_utc_contract(self):
  query={'tf':'M1','from':TIMES[0]-10,'to':TIMES[0]+90}
  chart_status,chart=self.get({'ticket':'review-one',**query})
  market_status,market=self.get({'source':SOURCE,'symbol':'XAUUSD',**query},path='/api/market/bars')
  self.assertEqual((chart_status,market_status),(200,200))
  self.assertEqual([row[0] for row in chart['bars']],TIMES[:2])
  for field in ('bars','covered','missing','from_server','to_server','time_basis'):
   self.assertEqual(chart[field],market[field])
  self.assertEqual(chart['covered'][0]['from'],TIMES[0])
  self.assertEqual(market['last_bar'],TIMES[-1])

 def test_paging_does_not_bypass_review_permissions_or_share_recipient(self):
  params={'ticket':'review-one','person':'owner','tf':'M1','limit':2,'after':TIMES[0]}
  self.assertEqual(self.get(params,'outsider')[0],403)
  self.assertEqual(self.get(params,'recipient')[0],403)
  status,shared=self.get({'share':self.share,'tf':'M1','limit':2,'after':TIMES[0]},'recipient')
  self.assertEqual(status,200);self.assertEqual([r[0] for r in shared['bars']],TIMES[1:3])
  self.assertEqual(self.get({'share':self.share,'tf':'M1','limit':2},'outsider')[0],404)

 def test_client_cannot_override_trade_source_symbol_or_owner_with_share(self):
  status,result=self.get({'share':self.share,'person':'outsider','ticket':'other','source':'srv:Review-Paging-B','symbol':'EURUSD','tf':'M1','limit':20},'recipient')
  self.assertEqual(status,200);self.assertEqual(result['source'],SOURCE)
  self.assertEqual([r[0] for r in result['bars']],TIMES)
  self.assertTrue(all(r[1]==100 for r in result['bars']))

 def test_invalid_cursor_combinations_and_timeframes_return_400(self):
  for params in ({'after':TIMES[0]},{'before':TIMES[0]},{'limit':2,'before':TIMES[0],'after':TIMES[1]},
                 {'limit':0},{'limit':'bad'},{'limit':2,'after':'bad'},{'limit':2,'after':0},
                 {'limit':2,'after':32535216000},{'limit':2,'tf':'invalid'},
                 {'from':TIMES[0],'to':TIMES[1],'tf':'invalid'}):
   with self.subTest(params=params):self.assertEqual(self.chart(**params)[0],400)

 def test_tracks_with_nonzero_offset_return_utc_blocks_instead_of_500(self):
  start,end=TIMES[0]-10,TIMES[0]+90
  status,result=self.get({'ticket':'review-one','from':start,'to':end},path='/api/chart/tracks')
  self.assertEqual(status,200)
  self.assertEqual((result['from'],result['to'],result['time_basis']),(start,end,'utc'))
  self.assertEqual(result['active_source'],SOURCE)
  self.assertEqual(result['tracks'][0]['blocks'],[[TIMES[0],TIMES[0]+60]])
  self.assertEqual(result['tracks'][0]['series']['M1']['bars'],2)

if __name__=='__main__':unittest.main()

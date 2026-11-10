"""Both history screens use persisted rows and the history ACK clock, not hub depth."""
import hashlib,json,os,sqlite3,sys,tempfile,threading,time,unittest,urllib.request
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))

class HistoryView(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.folder=tempfile.TemporaryDirectory(prefix='syncnote-history-view-',ignore_cleanup_errors=True)
  with patch.dict(os.environ,{'DATA_DIR':cls.folder.name,'EA_HUB_ENABLE':'0','COOKIE_SECURE':'0'}):
   import app_server
  cls.app=app_server
  cls.token='synthetic-history-view-session'
  with app_server.connect() as db:
   db.execute('INSERT INTO users(id,username,nickname,password,created,onboarding_step) VALUES(?,?,?,?,?,4)',('fixture','fixture','Synthetic history','fixture-only',time.time()))
   db.execute('INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)',(hashlib.sha256(cls.token.encode()).hexdigest(),'fixture',time.time()+3600))
  class QuietHandler(app_server.Handler):
   def log_message(self,*args):pass
  cls.server=app_server.ThreadingHTTPServer(('127.0.0.1',0),QuietHandler)
  cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
  cls.base='http://127.0.0.1:'+str(cls.server.server_port)

 @classmethod
 def tearDownClass(cls):
  cls.server.shutdown();cls.server.server_close();cls.thread.join();cls.folder.cleanup()

 def setUp(self):
  with self.app.connect() as db:
   for table in ('trade_notes','chart_states','trade_reviews','mt5_history_batches','snapshots','trades'):
    db.execute('DELETE FROM '+table)

 def get(self,path):
  request=urllib.request.Request(self.base+path,headers={'Cookie':'tongpin_session='+self.token})
  with urllib.request.urlopen(request,timeout=10) as response:return json.load(response)

 def seed(self,count=1):
  with self.app.connect() as db:
   for i in range(count):
    row={'ticket':str(i+1),'symbol':'XAUUSD','side':'buy','volume':0.01,'open':100,'close':101,
         'profit':1,'closed':1700000000+i,'time_basis':'utc','time_verified':True}
    db.execute('INSERT INTO trades VALUES(?,?,?)',('fixture',row['ticket'],json.dumps(row)))

 def ack(self,stamp):
  with self.app.connect() as db:db.execute('INSERT INTO mt5_history_batches VALUES(?,?,?,?,?,?)',('fixture','fixture-account','fixture-batch','fixture-hash','{}',stamp))

 def test_hub_tail_cannot_hide_full_history_from_either_screen(self):
  self.seed(620)
  with self.app.connect() as db:
   for i,status in enumerate(('invalidated','context_unavailable','context_unverified')):
    db.execute('INSERT INTO trades VALUES(?,?,?)',('fixture','invalid-'+str(i),json.dumps({'ticket':'invalid-'+str(i),'history_status':status})))
  tail={'history':[{'ticket':'memory-only-'+str(i)} for i in range(500)],'positions':[],'equity':123}
  with patch.object(self.app.HUB,'live',return_value=tail):
   calendar=self.get('/api/state')['snapshots']['fixture']['data']
   board=self.get('/api/state?view=board')['snapshots']['fixture']['data']
  self.assertEqual(calendar['history'],board['history'])
  self.assertEqual(calendar['history'],self.get('/api/history')['history'])
  self.assertEqual(len(calendar['history']),620)
  self.assertEqual(calendar['equity'],123)
  self.assertEqual(tail['history'][0]['ticket'],'memory-only-0','building a view must not mutate hub memory')

 def test_account_snapshot_and_history_ack_keep_separate_clocks(self):
  self.seed();now=time.time();self.ack(now)
  with self.app.connect() as db:db.execute('INSERT INTO snapshots VALUES(?,?,?)',('fixture',json.dumps({'balance':50,'history':[{'ticket':'stale'}]}),now-86400))
  value=self.get('/api/state')['snapshots']['fixture']
  self.assertEqual(value['history_synced_at'],now)
  self.assertEqual(value['updated'],now-86400)
  self.assertEqual(value['data']['balance'],50)
  self.assertEqual(value['data']['history'][0]['ticket'],'1')

 def test_confirmed_empty_history_is_distinct_from_never_connected(self):
  self.assertNotIn('fixture',self.get('/api/state')['snapshots'])
  now=time.time();self.ack(now)
  value=self.get('/api/state')['snapshots']['fixture']
  self.assertEqual(value['data']['history'],[])
  self.assertEqual(value['data']['source'],'history-only')
  self.assertFalse(value['data']['online'])
  self.assertEqual(value['history_synced_at'],now)

 def test_review_status_matches_notes_or_actual_drawings_only(self):
  self.seed(3)
  with self.app.connect() as db:
   db.execute('INSERT INTO trade_notes VALUES(?,?,?,?,?)',('fixture','1','has a note','[]',time.time()))
   db.execute('INSERT INTO trade_notes VALUES(?,?,?,?,?)',('fixture','2','   ','["tag only"]',time.time()))
   db.execute('INSERT INTO chart_states VALUES(?,?,?,?)',('fixture','3',json.dumps({'charts':[{'drawings':{'drawings':[{'id':'fixture-mark'}]}}]}),time.time()))
  value=self.get('/api/state')
  self.assertEqual(value['reviewed'],['1','3'])
  self.assertEqual(value['members'][0]['reviewed'],['1','3'])

 def test_old_webbridge_clock_does_not_remove_imported_trades_from_calendar_dates(self):
  with self.app.connect() as db:
   db.execute('INSERT OR REPLACE INTO broker_clocks VALUES(?,?,?,?,?)',('fixture','WebBridge',0,1700000000,1700000010))
   row={'ticket':'imported','source':'syncnote-history.v1','server':'EasyTradingOnlineLtd-Server',
        'closed_server':1793835921,'closed':1793825121,'history_offset_seconds':10800,
        'time_basis':'utc','time_estimated':True,'history_status':'complete'}
   db.execute('INSERT INTO trades VALUES(?,?,?)',('fixture','imported',json.dumps(row)))
  value=self.get('/api/state')['snapshots']['fixture']['data']['history'][0]
  self.assertEqual(value['closed'],1793825121)

if __name__=='__main__':unittest.main()

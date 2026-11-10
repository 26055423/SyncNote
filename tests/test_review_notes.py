"""Unified note identity, legacy compatibility, frozen replay and sharing permissions."""
import hashlib,json,os,sys,tempfile,threading,time,unittest,urllib.error,urllib.request,urllib.parse
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import bars,chart,groups,journal,review_notes,journal_templates

class ReviewNotes(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.folder=tempfile.TemporaryDirectory(prefix='syncnote-notes-')
  with patch.dict(os.environ,{'DATA_DIR':cls.folder.name,'EA_HUB_ENABLE':'0','COOKIE_SECURE':'0'}):
   import app_server
   app_server.initialize_database()
  cls.app=app_server
  with cls.app.connect() as db:
   for uid in ('a','b','other','late'):
    db.execute('INSERT INTO users(id,username,nickname,password,created,onboarding_step) VALUES(?,?,?,?,?,4)',(uid,uid,uid,'synthetic',time.time()))
    db.execute('INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)',(hashlib.sha256(uid.encode()).hexdigest(),uid,time.time()+3600))
   db.execute("INSERT INTO friend_edges(a,b,status,requested_by,created) VALUES('a','b','accepted','a',1)")
   for uid in ('a','b'):
    db.execute('INSERT INTO trades VALUES(?,?,?)',(uid,'t',json.dumps({'ticket':'t','symbol':'XAUUSD','server':'Notes','closed':1700000600,'closed_server':1700000600,'time_basis':'utc'})))
   bars.set_source_offset(db,'srv:Notes',10800,0)
   bars.ensure_feed(db,'Notes','fixture',0)
   for tf,period in bars.TF_SECONDS.items():
    for i in range(50):
     t=1700000000+i*period
     db.execute('INSERT INTO bars VALUES(?,?,?,?,?,?,?,?,?,?)',('srv:Notes','XAUUSD',tf,t+10800,100,102,98,101,1,0))
  class Quiet(cls.app.Handler):
   def log_message(self,*args):pass
  cls.server=cls.app.ThreadingHTTPServer(('127.0.0.1',0),Quiet)
  cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
  cls.base='http://127.0.0.1:'+str(cls.server.server_port)

 @classmethod
 def tearDownClass(cls):
  cls.server.shutdown();cls.server.server_close();cls.thread.join();cls.folder.cleanup()

 def request(self,path,data=None,uid='a',status=200):
  req=urllib.request.Request(self.base+path,data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json','Cookie':'tongpin_session='+uid})
  try:response=urllib.request.urlopen(req,timeout=10)
  except urllib.error.HTTPError as e:response=e
  with response:
   result=json.load(response);self.assertEqual(response.status,status,result);return result

 def scene(self,**extra):
  return {'symbol':'XAUUSD','source':'srv:Notes','anchor_ms':1700000600000,'timeframe':'1','layout':'1','replay_ms':None,'range':{'from':1700000000000,'to':1700001200000},**extra}

 def create(self,**extra):
  return self.request('/api/notes',{'scene':self.scene(),'body':'独立笔记','tags':[],'sections':[],**extra})['note']

 def test_two_notes_same_moment_have_independent_identity_and_optional_order(self):
  a=self.create();b=self.create(ticket='t',body='另一种解释')
  self.assertNotEqual(a['id'],b['id']);self.assertIsNone(a['ticket']);self.assertEqual(b['ticket'],'t')
  self.request('/api/notes',{'id':b['id'],'ticket':None})
  entry=self.request('/api/chart/entry?note='+a['id'])
  self.assertEqual(entry['scene'],a['scene']);self.assertNotIn('ticket',entry['review']['trade'])
  self.assertFalse(entry['read_only']);self.assertEqual(entry['note']['body'],'独立笔记')
  self.assertTrue(any(row['id']==a['id'] for row in self.request('/api/notes?q='+urllib.parse.quote('独立'))['items']))

 def test_note_and_drawings_cannot_be_read_or_changed_by_other_user(self):
  note=self.create()
  for path in ('/api/chart/entry?note=','/api/chart/bars?tf=M1&limit=5&note='):
   self.request(path+note['id'],uid='b',status=404)
  self.request('/api/notes',{'id':note['id'],'body':'stolen'},uid='b',status=404)
  self.request('/api/reviews/share',{'note_id':note['id'],'recipients':['a']},uid='b',status=404)
  self.request('/api/reviews/share',{'note_id':note['id'],'recipients':['other']},status=403)

 def test_ticket_link_and_legacy_updates_keep_same_note_and_all_old_content(self):
  old=self.request('/api/journal',{'ticket':'t','body':'原笔记','tags':[],'sections':[{'id':'s','title':'结构','body':'保留正文','checked':True}]})
  entry=self.request('/api/chart/entry?ticket=t');ident=entry['note_id']
  self.request('/api/notes',{'id':ident,'body':'新版修改'})
  self.assertEqual(self.request('/api/journal')['notes']['t']['body'],'新版修改')
  self.request('/api/journal',{'ticket':'t','body':'旧客户端修改','tags':[]})
  note=self.request('/api/chart/entry?note='+ident)['note']
  self.assertEqual(note['body'],'旧客户端修改');self.assertEqual(note['sections'],old['note']['sections'])
  self.assertEqual(self.request('/api/chart/entry?ticket=t')['note_id'],ident)
  self.request('/api/chart/state',{'ticket':'t','state':{'version':1,'charts':[{'id':'c1'}]}})
  self.request('/api/notes',{'id':ident,'document':None})
  self.assertIsNone(self.request('/api/chart/entry?ticket=t')['chart'])
  self.request('/api/notes',{'id':ident,'ticket':None})
  detached=self.request('/api/chart/entry?ticket=t')
  self.assertEqual(detached['note_id'],ident);self.assertNotIn('ticket',detached['review']['trade'])

 def test_share_freezes_unsaved_prose_empty_document_and_replay_cutoff(self):
  cutoff=1700000600000;note=self.create()
  self.request('/api/reviews/share',{'note_id':note['id'],'recipients':['b'],'note':{'body':'分享时的草稿','tags':[],'sections':[]},'snapshot':self.scene(replay_ms=cutoff,replay_cursor_ms=cutoff-60000,document=None)})
  with self.app.connect() as db:sid=db.execute('SELECT max(id) FROM review_shares').fetchone()[0]
  self.request('/api/notes',{'id':note['id'],'body':'后来修改'})
  entry=self.request('/api/chart/entry?share='+str(sid),uid='b')
  self.assertEqual(entry['note']['body'],'分享时的草稿');self.assertIsNone(entry['chart']['document']);self.assertTrue(entry['read_only'])
  self.assertEqual(entry['scene']['replay_ms'],cutoff)
  self.assertEqual(entry['scene']['replay_cursor_ms'],cutoff-60000)
  for suffix in ('&limit=100','&limit=100&after=1700000300','&from=1699999000&to=1700010000'):
   rows=self.request('/api/chart/bars?share='+str(sid)+'&tf=M1'+suffix,uid='b')['bars']
   self.assertTrue(rows);self.assertTrue(all((r[0]+60)*1000<=cutoff for r in rows))
  rows=self.request('/api/chart/bars?note='+note['id']+'&tf=M1&limit=100')['bars']
  self.assertGreater(rows[-1][0]*1000,cutoff)
  self.request('/api/chart/entry?share='+str(sid),uid='other',status=404)

 def test_share_response_is_sent_after_commit_and_is_immediately_readable(self):
  note=self.create();observed=[]
  with self.app.connect() as db:before=db.execute('SELECT count(*) FROM review_snapshots').fetchone()[0]
  reply=self.app.Handler.reply
  def inspect(handler,value,*args,**kwargs):
   if handler.path=='/api/reviews/share' and value.get('ok'):
    with self.app.connect() as db:observed.append(db.execute('SELECT count(*) FROM review_snapshots').fetchone()[0])
   return reply(handler,value,*args,**kwargs)
  with patch.object(self.app.Handler,'reply',inspect):
   self.request('/api/reviews/share',{'note_id':note['id'],'recipients':['b']})
  self.assertEqual(observed,[before+1])
  for bad in ({'replay_ms':'bad','replay_cursor_ms':1},{'replay_ms':True},{'replay_ms':1700000000000,'replay_cursor_ms':1700000100000}):
   self.request('/api/notes',{'scene':self.scene(**bad)},status=400)

 def test_group_note_without_order_late_member_gets_original_and_recall_revokes(self):
  note=self.create()
  with self.app.connect() as db:
   group=groups.create(db,'a','笔记群')
   groups.join(db,'b',group['code'])
  result=self.request('/api/groups/share',{'group':group['id'],'note_id':note['id'],'message':'图形案例'})
  self.request('/api/notes',{'id':note['id'],'body':'后来改了'})
  with self.app.connect() as db:
   groups.join(db,'late',group['code'])
   sid=groups.open_trade(db,group['id'],'late',result['id'])['share']
  self.assertEqual(self.request('/api/chart/entry?share='+str(sid),uid='late')['note']['body'],'独立笔记')
  with self.app.connect() as db:db.execute('UPDATE group_messages SET recalled=1 WHERE id=?',(result['id'],))
  self.request('/api/chart/entry?share='+str(sid),uid='late',status=404)

 def test_checklist_is_explicit_and_personal_words_never_become_public(self):
  note=self.create(sections=[{'id':'s','title':'私密策略标题','group':'结构','checklist':False,'body':'判断','checked':False}])
  self.assertFalse(note['sections'][0]['checklist'])
  with self.app.connect() as db:
   stats=journal_templates.stats(db,'a')
   self.assertNotIn('私密策略标题',[item['title'] for item in stats['titles']])
  self.assertNotIn('私密策略标题',[item['title'] for item in self.request('/api/journal/chapters')['chapters']])
  self.assertIn('私密策略标题',[item['title'] for item in self.request('/api/journal/library')['chapters']])

if __name__=='__main__':unittest.main()

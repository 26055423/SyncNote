"""Isolated integration checks. All accounts/trades are generated fixtures."""
import hashlib,http.cookiejar,io,json,os,secrets,sqlite3,subprocess,sys,tempfile,time,urllib.request,urllib.error,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
count=0

def ensure(value,message):
 global count
 assert value,message
 count+=1

class Client:
 def __init__(self,base):
  self.base=base;self.opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
 def request(self,path,data=None,status=200,origin=None,extra=None):
  headers={'Content-Type':'application/json','Origin':origin or self.base}
  if extra:headers.update(extra)
  req=urllib.request.Request(self.base+path,headers=headers,data=json.dumps(data).encode() if data is not None else None)
  try:r=self.opener.open(req,timeout=15)
  except urllib.error.HTTPError as error:r=error
  with r:
   body=r.read();ensure(r.status==status,'unexpected HTTP status: '+path+' -> '+repr(body[:160]))
   return json.loads(body) if 'application/json' in r.headers.get('Content-Type','') else body

def main():
 with tempfile.TemporaryDirectory(prefix='syncnote-synthetic-',ignore_cleanup_errors=True) as folder:
  password=secrets.token_urlsafe(24)
  env={**os.environ,'DATA_DIR':folder,'COOKIE_SECURE':'0','ADMIN_USERNAME':'admin','PYTHONDONTWRITEBYTECODE':'1','TRUSTED_PROXY_CIDRS':'','TRUSTED_PROXY_HOSTS':'','EA_HUB_ENABLE':'0'}
  env['SMOKE_PASSWORD']=password
  runner="import os;from bootstrap_admin import create_admin;create_admin(os.environ.pop('SMOKE_PASSWORD'));import app_server as a;from http.server import ThreadingHTTPServer;s=ThreadingHTTPServer(('127.0.0.1',0),a.Handler);print(s.server_port,flush=True);s.serve_forever()"
  proc=subprocess.Popen([sys.executable,'-u','-c',runner],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
  try:
   line=proc.stdout.readline().strip();ensure(line.isdigit(),'server startup');base='http://127.0.0.1:'+line
   anon=Client(base);admin=Client(base);alice=Client(base);bob=Client(base)
   db=Path(folder)/'board.sqlite3'
   with sqlite3.connect(db) as conn:ensure(conn.execute('SELECT COUNT(*) FROM users').fetchone()[0]==1,'only freshly initialized admin')
   ensure(anon.request('/api/health')['ok'],'health')
   # 空串必须等价于“没配置”：否则所有客户端都会塌缩成代理自己的地址，限流桶变成全局共享。
   import client_address
   os.environ['TRUSTED_PROXY_CIDRS']=''
   ensure(client_address.resolve_client_ip('127.0.0.1',{'X-Auth-Client':'203.0.113.9'})=='203.0.113.9','empty proxy config falls back to the loopback default')
   os.environ['TRUSTED_PROXY_CIDRS']='203.0.113.0/24'
   ensure(client_address.resolve_client_ip('127.0.0.1',{'X-Auth-Client':'203.0.113.9'})=='127.0.0.1','untrusted peer cannot spoof a client ip')
   os.environ.pop('TRUSTED_PROXY_CIDRS',None)
   for path in ('/api/state','/api/profile','/api/history','/api/invite'):anon.request(path,status=401)
   for path in ('/login','/register','/style.css','/app.js','/downloads/SyncNoteSync.mq5','/local-ea','/local-ea.css'):ensure(len(anon.request(path))>0,'static content '+path)
   with zipfile.ZipFile(io.BytesIO(anon.request('/downloads/syncnote-local.zip'))) as archive:
    manifest=json.loads(archive.read('SyncNoteLocal/SOURCE_MANIFEST.json'))
    ensure('SyncNoteLocal.mq5' in manifest['files'],'EA source entry is packaged')
    ensure(all(name.endswith(('.mq5','.mqh','.md','.json')) for name in archive.namelist()),'source download contains no executable or credential files')
    ensure(all(hashlib.sha256(archive.read('SyncNoteLocal/'+name)).hexdigest()==digest for name,digest in manifest['files'].items()),'EA source manifest matches package')
   admin.request('/api/login',{'username':'admin','password':password})
   ensure(admin.request('/api/me')['user']['role']=='admin','independent owner')
   anon.request('/api/mt5/assistant',{'platform':'mac'},status=401)
   admin.request('/api/mt5/assistant',{'platform':'mac'},status=501)
   admin.request('/api/profile',{},status=403,origin='https://untrusted.invalid')
   admin.request('/api/admin/sudo',{'password':password})
   def new_code(days=7):
    return admin.request('/api/admin/invites',{'count':1,'expires_days':days})['codes'][0]
   def register(client,name,invitation=None):
    invitation=invitation or new_code();challenge=anon.request('/api/login-challenge');token=challenge['challenge_id']
    with sqlite3.connect(db) as conn:answer_hash=conn.execute('SELECT answer FROM login_challenges WHERE id=?',(token,)).fetchone()[0]
    answer=next(str(i) for i in range(9) if hashlib.sha256((token+str(i)).encode()).hexdigest()==answer_hash)
    return client.request('/api/register',{'username':name,'nickname':name,'password':password,'invite_code':invitation,'challenge_id':token,'challenge_answer':answer})['user']
   a=register(alice,'aa');b=register(bob,'bb');ensure(a['id']!=b['id'],'separate user IDs')
   ensure(alice.request('/api/me')['user']['username']=='aa','session A');ensure(bob.request('/api/me')['user']['username']=='bb','session B')
   alice.request('/api/profile',{'nickname':'Synthetic Alpha','avatar':'avatar1','bio':'fixture-only'})
   ensure(bob.request('/api/profile')['user']['nickname']=='bb','profile ownership')
   alice.request('/api/admin/users',status=403);alice.request('/api/invite',status=403)
   alice.request('/api/admin/invites',status=404);alice.request('/api/admin/sudo',{'password':password},status=404)
   used=new_code();cc=Client(base);register(cc,'cc',used)
   reused=Client(base);challenge=anon.request('/api/login-challenge');rt=challenge['challenge_id']
   with sqlite3.connect(db) as conn:rh=conn.execute('SELECT answer FROM login_challenges WHERE id=?',(rt,)).fetchone()[0]
   ra=next(str(i) for i in range(9) if hashlib.sha256((rt+str(i)).encode()).hexdigest()==rh)
   reused.request('/api/register',{'username':'dd','nickname':'dd','password':password,'invite_code':used,'challenge_id':rt,'challenge_answer':ra},status=403)
   resp=admin.request('/api/admin/invites')
   ensure(any(row['state']=='used' for row in resp['invites']),'invite marked used')
   admin.request('/api/admin/invites/revoke',{'id':0},status=404)
   ensure(len(admin.request('/api/admin/users')['users'])==4,'new accounts only')
   alice.request('/api/journal',{'person':b['id'],'ticket':'fixture','text':'cross-user attempt'},status=404)
   # ---- 好友：申请 → 通过 → 互相可见；删除后失效 ----
   bob.request('/api/history?person='+a['id'],status=403)
   bob.request('/api/settings',{'allow_follow':True,'share_data':True,'share_reviews':True})
   alice.request('/api/history?person='+b['id'],status=403)
   ensure(alice.request('/api/friends/request',{'target':b['id']})['status']=='pending','好友申请是待通过状态')
   alice.request('/api/history?person='+b['id'],status=403)
   incoming=bob.request('/api/profile')['incoming']
   ensure([row['id'] for row in incoming]==[a['id']],'对方能在好友申请里看到我')
   bob.request('/api/friends/accept',{'target':a['id']})
   ensure(alice.request('/api/history?person='+b['id'])['history'] is not None,'通过后 A 能看 B')
   ensure(bob.request('/api/history?person='+a['id'])['history'] is not None,'通过后 B 也能看 A（双向）')
   # ---- 好友私信：离线也能发、上线补收、已读 ----
   alice.request('/api/dm',{'to':b['id'],'text':'在吗？看下这单'})
   inbox=bob.request('/api/dm?with='+a['id'])
   ensure([m['text'] for m in inbox['messages']]==['在吗？看下这单'],'好友能收到私信')
   with sqlite3.connect(db) as conn: conn.execute('INSERT OR IGNORE INTO trades(person,ticket,payload) VALUES(?,?,?)',(a['id'],'fixture-dm','{"ticket":"fixture-dm","symbol":"XAUUSD"}'))
   alice.request('/api/reviews/share',{'ticket':'fixture-dm','recipients':[b['id']],'message':'看这单'})
   dm=[m for m in bob.request('/api/dm?with='+a['id'])['messages'] if m['kind']=='share']
   ensure(bob.request('/api/dm/threads')['unread']==0,'打开私信同时把收到的复盘分享标成已读')
   ensure(dm and dm[0]['message' if False else 'text']=='看这单','复盘分享出现在私信里')
   bob.request('/api/reviews/share/seen',{'id':dm[0]['share']})
   ensure(all(t['unread']==0 for t in bob.request('/api/dm/threads')['threads']),'打开会话后未读清零')
   bob.request('/api/dm',{'to':a['id'],'text':'看了，没问题'})
   thread=alice.request('/api/dm?with='+b['id'])['messages']
   texts=[m for m in thread if m['kind']=='text']
   ensure(len(texts)==2 and texts[-1]['text']=='看了，没问题','双向对话按时间排序')
   # Discord 式引用和表情：会话隔离、幂等、当前用户状态。
   mid=texts[0]['id']
   reply=bob.request('/api/dm',{'to':a['id'],'text':'引用回复','reply_to':mid})
   quoted=[m for m in alice.request('/api/dm?with='+b['id'])['messages'] if m['id']==reply['id']][0]
   ensure(quoted['reply']['id']==mid and quoted['reply']['text']==texts[0]['text'],'私信引用返回原消息预览')
   ensure(quoted['name']=='bb' and quoted['person']==b['id'],'私信提供作者资料')
   for _ in range(2):bob.request('/api/dm/reaction',{'to':a['id'],'id':mid,'emoji':'👍','active':True})
   reaction=alice.request('/api/dm/reaction',{'to':b['id'],'id':mid,'emoji':'👍','active':True})['reactions'][0]
   ensure(reaction=={'emoji':'👍','count':2,'mine':True},'私信表情按用户幂等并聚合')
   bob.request('/api/dm/reaction',{'to':a['id'],'id':mid,'emoji':'👍','active':False})
   reaction=[m for m in bob.request('/api/dm?with='+a['id'])['messages'] if m['id']==mid][0]['reactions'][0]
   ensure(reaction['count']==1 and not reaction['mine'],'取消回应只删除自己的表情')
   bob.request('/api/dm/reaction',{'to':a['id'],'id':mid,'emoji':'invalid','active':True},status=400)
   bob.request('/api/dm/reaction',{'to':a['id'],'id':mid,'emoji':'👍','active':1},status=400)
   bob.request('/api/dm',{'to':a['id'],'text':'bad','reply_to':True},status=400)
   cc.request('/api/dm/reaction',{'to':a['id'],'id':mid,'emoji':'👍','active':True},status=403)
   with sqlite3.connect(db) as conn:
    stranger=conn.execute("SELECT id FROM users WHERE username='cc'").fetchone()[0]
    wrong_mid=conn.execute('INSERT INTO direct_messages(sender,recipient,text,created) VALUES(?,?,?,?)',(stranger,a['id'],'private fixture',time.time())).lastrowid
   bob.request('/api/dm',{'to':a['id'],'text':'cross','reply_to':wrong_mid},status=404)
   bob.request('/api/dm/reaction',{'to':a['id'],'id':wrong_mid,'emoji':'👍','active':True},status=404)
   ensure(all(t['peer']['id']!=stranger for t in alice.request('/api/dm/threads')['threads']),'会话列表过滤非好友历史')
   ensure(isinstance(bob.request('/api/dm/threads')['threads'][0]['peer']['online'],bool),'在线状态来自网站心跳')
   cc.request('/api/dm?with='+a['id'],status=403)
   cc.request('/api/dm',{'to':a['id'],'text':'陌生人'},status=403)
   bob.request('/api/messages',{'text':'friend-only hello'})
   ensure(any(m['text']=='friend-only hello' for m in alice.request('/api/state')['messages']),'好友之间能看到留言')
   bob.request('/api/friends/remove',{'target':a['id']})
   ensure(not bob.request('/api/dm/threads')['threads'],'删除好友后会话列表不再暴露消息')
   ensure(not alice.request('/api/dm/threads')['threads'],'被删除方的会话列表也隐藏失效关系')
   ensure(all(not row['can_chat'] for row in alice.request('/api/profile')['friends'] if row['id']==b['id']),'新会话入口不会把单方保留的好友关系当作可聊天')
   alice.request('/api/history?person='+b['id'],status=403)
   # ---- 微信式：删除 / 拉黑 / 权限（不让看、不看） ----
   alice.request('/api/friends/request',{'target':b['id']})
   bob.request('/api/friends/accept',{'target':a['id']})
   ensure(alice.request('/api/history?person='+b['id'])['history'] is not None,'删除/拉黑前好友可见')
   alice.request('/api/friends/hide',{'target':b['id'],'on':True})
   bob.request('/api/history?person='+a['id'],status=403)
   alice.request('/api/friends/hide',{'target':b['id'],'on':False})
   ensure(bob.request('/api/history?person='+a['id'])['history'] is not None,'取消隐藏后恢复可见')
   alice.request('/api/friends/block',{'target':b['id']})
   ensure([r['id'] for r in alice.request('/api/profile')['blocked']]==[b['id']],'拉黑后出现在黑名单')
   ensure([r['relation'] for r in bob.request('/api/users?q=aa')['users'] if r['id']==a['id']]==['blocked_me'],'被拉黑方看到 blocked_me')
   alice.request('/api/history?person='+b['id'],status=403)
   bob.request('/api/history?person='+a['id'],status=403)
   bob.request('/api/friends/request',{'target':a['id']},status=403)
   alice.request('/api/friends/unblock',{'target':b['id']})
   ensure(alice.request('/api/profile')['blocked']==[],'解除拉黑后黑名单清空')
   ensure(alice.request('/api/history?person='+b['id'])['history'] is not None,'解除拉黑后恢复好友可见')
   alice.request('/api/friends/remove',{'target':b['id']})
   alice.request('/api/history?person='+b['id'],status=403)
   bob.request('/api/history?person='+a['id'],status=403)
   # 复盘图表页：静态资源、画线存档、作业分享与只读边界。
   page=anon.request('/chart');ensure('交易台'.encode() in page,'chart page served')
   with anon.opener.open(base+'/chart',timeout=15) as response:
    csp=response.headers.get('Content-Security-Policy','')
    ensure("connect-src 'self' ws://127.0.0.1:18765;" in csp,'chart allows only the designated local EA endpoint')
   import re as _re
   asset=_re.search(rb'/chart/assets/[^"\']+\.js',page)
   ensure(asset is not None,'chart bundle referenced')
   ensure(len(anon.request(asset.group(0).decode()))>0,'chart bundle served')
   anon.request('/api/chart/entry?ticket=fixture',status=401)
   with sqlite3.connect(db) as conn:
    conn.execute('INSERT INTO trades VALUES(?,?,?)',(a['id'],'fixture-1',json.dumps({'ticket':'fixture-1','symbol':'XAUUSD','side':'buy','volume':0.1,'open':2650.0,'close':2660.0,'profit':100.0,'closed':1700000000,'closed_server':1700000000,'opened_server':1699990000,'time_basis':'utc'})))
    conn.commit()
   entry=alice.request('/api/chart/entry?ticket=fixture-1')
   ensure(entry['mode']=='owner' and entry['review']['trade']['symbol']=='XAUUSD','owner chart entry')
   ensure(entry['chart'] is None,'no saved drawings yet')
   alice.request('/api/chart/state',{'ticket':'fixture-1','state':{'version':2,'charts':[{'id':'c1'}]}},status=400)
   state={'version':1,'layout':'4','charts':[{'id':'c1','symbol':'review:XAUUSD','timeframe':'15','drawings':{'version':1,'drawings':[{'id':'d1','type':'trendline'}]}}]}
   ensure(alice.request('/api/chart/state',{'ticket':'fixture-1','state':state})['ok'],'drawings saved')
   ensure(alice.request('/api/chart/entry?ticket=fixture-1')['chart']['document']['layout']=='4','drawings loaded back')
   alice.request('/api/journal',{'ticket':'fixture-1','body':'等回调确认再入场','tags':['入场时机']})
   ensure(alice.request('/api/reviews/share',{'ticket':'fixture-1','recipients':[b['id']],'message':'看这段结构'})['sent']==1,'share sent')
   alice.request('/api/reviews/share',{'ticket':'fixture-1','recipients':[a['id']]},status=400)
   box=bob.request('/api/reviews/inbox');ensure(box['unseen']==1 and box['items'][0]['owner']['id']==a['id'],'inbox shows assignment')
   shared=bob.request('/api/chart/entry?share='+str(box['items'][0]['id']))
   ensure(shared['mode']=='shared' and shared['read_only'],'shared chart is read only')
   ensure(shared['note']['body']=='等回调确认再入场','shared note visible')
   ensure(shared['chart']['document']['charts'][0]['drawings']['drawings'][0]['type']=='trendline','shared drawings visible')
   bob.request('/api/chart/state',{'ticket':'fixture-1','state':state},status=404)
   ensure(bob.request('/api/reviews/share/seen',{'id':box['items'][0]['id']})['ok'],'assignment marked seen')
   ensure(bob.request('/api/reviews/inbox')['unseen']==0,'unseen cleared')
   bob.request('/api/chart/entry?person='+a['id']+'&ticket=fixture-1',status=403)
   alice.request('/api/chart/entry?share=999999',status=404)
   # 一条消息带一份复盘切片：分享人那一刻的激活周期、窗口中点时间、画线坐标。
   slice_doc={'version':1,'layout':'2','charts':[{'id':'c1','symbol':'review:XAUUSD','timeframe':'5','drawings':{'version':1,'drawings':[{'id':'s1','type':'rectangle'}]}}]}
   slice_payload={'anchor_ms':1700000000000,'timeframe':'5','layout':'2','document':slice_doc}
   posted=alice.request('/api/reviews/share',{'ticket':'fixture-1','recipients':[b['id']],'message':'看这一刻','snapshot':slice_payload})
   ensure(posted['sent']==1 and posted['has_snapshot'],'share stores the chart slice')
   item=[row for row in bob.request('/api/reviews/inbox')['items'] if row['ticket']=='fixture-1'][0]
   ensure(item['anchor_ms']==1700000000000 and item['timeframe']=='5','inbox exposes the slice anchor')
   sliced=bob.request('/api/chart/entry?share='+str(item['id']))
   ensure(sliced['mode']=='shared' and sliced['read_only'],'shared slice stays read only')
   ensure(sliced['share']['anchor_ms']==1700000000000,'shared entry keeps the sharer anchor')
   ensure(sliced['share']['layout']=='2','shared entry keeps the sharer layout')
   ensure(sliced['chart']['document']['layout']=='2' and sliced['chart']['document']['charts'][0]['drawings']['drawings'][0]['id']=='s1','shared entry replays the slice drawings instead of the saved state')
   alice.request('/api/reviews/share',{'ticket':'fixture-1','recipients':[b['id']],'snapshot':{'timeframe':'5'}},status=400)
   alice.request('/api/reviews/share',{'ticket':'fixture-1','recipients':[b['id']],'snapshot':{'anchor_ms':'now'}},status=400)
   alice.request('/api/reviews/share',{'ticket':'fixture-1','recipients':[b['id']],'snapshot':{'anchor_ms':1700000000000,'document':{'version':9}}},status=400)
   # 对外链接需要这笔交易已经有 K 线：写一份最小的复盘载荷。
   review_payload={'opened_server':1700000000,'time_basis':'server','charts':{'M5':[[1700000000,1.0,2.0,0.5,1.5,10],[1700000300,1.5,2.5,1.0,2.0,12]]}}
   with sqlite3.connect(db) as conn:
    conn.execute("INSERT OR REPLACE INTO trade_reviews(person,ticket,status,payload,updated) VALUES(?,?,'ready',?,?)",(a['id'],'fixture-1',json.dumps(review_payload),time.time()))
    conn.commit()
   # 对外链接：token 即凭证，不带登录也能读；撤销后立刻 404；范围只有这一笔。
   link=alice.request('/api/share-links',{'ticket':'fixture-1'})
   ensure(link['token'] and link['url']=='/s/'+link['token'],'share link created')
   public=anon.request('/api/public/review?token='+link['token'])
   ensure(public['trade']['ticket']=='fixture-1','public share keeps only that ticket')
   ensure(public['note']['body']=='等回调确认再入场','public share carries the note')
   ensure(bool(public['charts']),'public share carries charts')
   ensure('owner' not in public and 'person' not in public['trade'],'public share leaks no account fields')
   again=alice.request('/api/share-links',{'ticket':'fixture-1'})
   ensure(again['token']==link['token'],'second request reuses the link')
   bob.request('/api/share-links',{'ticket':'fixture-1'},status=404)
   ensure(alice.request('/api/share-links',{'ticket':'fixture-1','revoke':True})['revoked'],'share link revoked')
   anon.request('/api/public/review?token='+link['token'],status=404)
   anon.request('/s/'+link['token'],status=200)
   alice_token=alice.request('/api/mt5/token',{})['token']
   bob_token=bob.request('/api/mt5/token',{})['token']
   people=admin.request('/api/admin/users')['users']
   ensure(any(row.get('locked')==0 for row in people),'users start unlocked')
   bob_id=[row['id'] for row in people if row['username']=='bb'][0]
   admin.request('/api/admin/users/lock',{'id':bob_id,'locked':True})
   ensure([row for row in admin.request('/api/admin/users')['users'] if row['id']==bob_id][0]['locked']==1,'lock persisted')
   bob.request('/api/me',status=401)
   # 锁定必须同时拦住认证本身和 EA 上报，而不只是拦住已有会话。
   bob.request('/api/login',{'username':'bb','password':password},status=403)
   bearer={'Authorization':'Bearer '+bob_token}
   bob.request('/api/mt5/status',status=403,extra=bearer)
   bob.request('/api/mt5/live',{'bars':{'1m':[[1700000000,1,2,0.5,1.5]]}},status=403,extra=bearer)
   bob.request('/api/snapshot',{'snapshot':{'balance':1.0,'equity':1.0,'currency':'USD','positions':[],'history':[]},'events':[]},status=403,extra=bearer)
   admin.request('/api/admin/users/lock',{'id':bob_id,'locked':False})
   alice.request('/api/admin/users/lock',{'id':bob_id,'locked':True},status=404)
   admin.request('/api/admin/users/lock',{'id':'nope','locked':True},status=404)
   # ---- 只读历史通道：SyncNote（EA 直传）与 SyncTrade（浏览器代传）共用同一套入库逻辑 ----
   history_bearer={'Authorization':'Bearer '+alice_token}
   server_name='Synthetic-Demo';mt5_account='90012345'
   history_key=hashlib.sha256((server_name+'\n'+mt5_account).encode()).hexdigest()
   window_from=1700000000;window_to=window_from+3600;anchor_ms=window_from*1000+1000
   def raw_deal(ticket,offset_ms,entry,price,ttype,profit=0.0):
    return {'deal_ticket':str(ticket),'order_ticket':'5001','position_id':'5001','time_msc_server':anchor_ms+offset_ms,
            'type':ttype,'entry':entry,'symbol':'XAUUSD','volume':0.1,'price':price,'profit':profit,
            'commission':0.0,'swap':0.0,'fee':0.0,'magic':'0','reason':0,'comment':'','external_id':'',
            'position_first_deal_ticket':'501','position_first_time_msc_server':anchor_ms,'position_context_status':'available'}
   history_deals=[raw_deal(501,0,0,2400.0,0),raw_deal(502,60000,1,2410.0,1,100.0)]
   def history_body(batch,deals=None,**extra):
    body={'schema':'syncnote-history.v1','account_key':history_key,'account':mt5_account,'server':server_name,
          'currency':'USD','batch_id':batch,'server_offset_sec':10800,
          'clock':{'server':window_to,'utc':window_to-10800},'time_basis':'broker_server',
          'range':{'from_server':window_from,'to_server':window_to},'deals':history_deals if deals is None else deals,
          'checkpoint':{'through_server':window_to,'last_deal_ticket':'502','window_complete':True,'next_cursor':''}}
    body.update(extra);return body
   ack=alice.request('/api/mt5/history-sync',history_body('batch-0001'),extra=history_bearer)
   ensure(ack['ok'] and ack['summary_status']=='complete','history batch accepted without warnings')
   ensure(ack['closed_trades_updated']==1,'closed trade is derived server-side from raw deals')
   job=alice.request('/api/mt5/history-job',extra=history_bearer)['review_job']
   ensure(bool(job) and job['ticket'].startswith('deal:'),'derived trade queues a review chart job')
   replay=alice.request('/api/mt5/history-sync',history_body('batch-0001'),extra=history_bearer)
   ensure(replay['changed']==ack['changed'] and replay['closed_trades_updated']==ack['closed_trades_updated'],'replaying an acknowledged batch is idempotent')
   patched=[raw_deal(501,0,0,2401.0,0),raw_deal(502,60000,1,2410.0,1,100.0)]
   alice.request('/api/mt5/history-sync',history_body('batch-0001',patched),status=409,extra=history_bearer)
   alice.request('/api/mt5/history-sync',history_body('batch-0002',balance=1.0),status=400,extra=history_bearer)
   tampered=history_body('batch-0003');tampered['account_key']='0'*64
   alice.request('/api/mt5/history-sync',tampered,status=400,extra=history_bearer)
   anon.request('/api/mt5/history-sync',history_body('batch-0004'),status=401)
   ensure(any(str(row.get('ticket','')).startswith('deal:') for row in alice.request('/api/history')['history']),'imported trades show up in the site history')

   # ---- 群：建群 / 邀请码加入 / 群聊 / 把一笔交易发进群 ----
   member=Client(base);register(member,'gg')
   outsider=Client(base);register(outsider,'hh')
   g=alice.request('/api/groups/create',{'name':'验收群'})
   ensure(bool(g['code']) and g['role']=='owner','群主拿到邀请码')
   member.request('/api/groups/join',{'code':g['code']})
   ensure(alice.request('/api/groups/messages?group='+g['id'])['messages']==[],'新群没有消息')
   alice.request('/api/groups/notice',{'group':g['id'],'notice':'本周只做伦敦盘'})
   ensure(alice.request('/api/groups')['groups'][0]['notice']=='本周只做伦敦盘','群主能改群公告')
   member.request('/api/groups/notice',{'group':g['id'],'notice':'越权'},status=403)
   names=[m['nickname'] for m in member.request('/api/groups/members?group='+g['id'])['members']]
   ensure(len(names)==2 and 'gg' in names,'成员列表包含群主和自己')
   myid=member.request('/api/me')['user']['id']
   alice.request('/api/groups/kick',{'group':g['id'],'target':myid})
   member.request('/api/groups/messages?group='+g['id'],status=403)
   member.request('/api/groups/join',{'code':g['code']})
   ensure(len(member.request('/api/groups/members?group='+g['id'])['members'])==2,'被移除后能重新加入')
   # 群资料 / @ / 撤回
   alice.request('/api/groups/rename',{'group':g['id'],'name':'改名后的群'})
   ensure(alice.request('/api/groups')['groups'][0]['name']=='改名后的群','群主能改群名')
   alice.request('/api/groups/rename',{'group':g['id'],'avatar':'avatar3'})
   ensure(alice.request('/api/groups')['groups'][0]['avatar']=='avatar3','群主能换群头像')
   alice.request('/api/groups/rename',{'group':g['id'],'avatar':'nope'},status=400)
   member.request('/api/groups/rename',{'group':g['id'],'name':'越权改名'},status=403)
   alice.request('/api/groups/message',{'group':g['id'],'text':'@gg 看一下这单'})
   msgs=member.request('/api/groups/messages?group='+g['id'])['messages']
   ensure(any(m.get('mentions') for m in msgs if m['kind']=='text'),'@昵称 能解析成成员')
   mid=[m for m in msgs if m['kind']=='text'][-1]['id']
   alice.request('/api/groups/recall',{'group':g['id'],'id':mid})
   ensure(any(m['kind']=='recalled' for m in member.request('/api/groups/messages?group='+g['id'])['messages']),'撤回后显示为已撤回')
   member.request('/api/groups/recall',{'group':g['id'],'id':mid},status=403)
   # 撤回按钮能力必须与执行权限一致：群主不受作者和 2 分钟窗口限制。
   owner_old=alice.request('/api/groups/message',{'group':g['id'],'text':'群主旧消息'})['id']
   member_old=member.request('/api/groups/message',{'group':g['id'],'text':'成员旧消息'})['id']
   member_recent=member.request('/api/groups/message',{'group':g['id'],'text':'成员新消息'})['id']
   with sqlite3.connect(db) as conn:
    conn.execute('UPDATE group_messages SET created=? WHERE id IN (?,?)',(time.time()-300,owner_old,member_old))
   owner_view={m['id']:m for m in alice.request('/api/groups/messages?group='+g['id'])['messages']}
   member_view={m['id']:m for m in member.request('/api/groups/messages?group='+g['id'])['messages']}
   ensure(owner_view[owner_old]['recallable'] and owner_view[member_old]['recallable'],'群主可撤回自己及其他成员的旧消息')
   ensure(not member_view[member_old]['recallable'],'普通作者超过 2 分钟不显示撤回')
   ensure(not member_view[owner_old]['recallable'],'普通成员不显示他人消息撤回')
   ensure(member_view[member_recent]['recallable'],'普通作者 2 分钟内仍显示撤回')
   member.request('/api/groups/recall',{'group':g['id'],'id':member_old},status=403)
   member.request('/api/groups/recall',{'group':g['id'],'id':owner_old},status=403)
   alice.request('/api/groups/recall',{'group':g['id'],'id':member_old})
   alice.request('/api/groups/recall',{'group':g['id'],'id':owner_old})
   owner_view={m['id']:m for m in alice.request('/api/groups/messages?group='+g['id'])['messages']}
   member_view={m['id']:m for m in member.request('/api/groups/messages?group='+g['id'])['messages']}
   ensure(all(not owner_view[i]['recallable'] and not member_view[i]['recallable'] for i in (mid,member_old,owner_old)),'已撤回消息对群主和普通成员都不再提供撤回按钮')
   alice.request('/api/groups/message',{'group':g['id'],'text':'大家好'})
   ensure(any(m['text']=='大家好' for m in member.request('/api/groups/messages?group='+g['id'])['messages']),'群聊成员可见')
   reply_mid=alice.request('/api/groups/message',{'group':g['id'],'text':'引用目标'})['id']
   reply=member.request('/api/groups/message',{'group':g['id'],'text':'群引用回复','reply_to':reply_mid})
   quoted=[m for m in member.request('/api/groups/messages?group='+g['id'])['messages'] if m['id']==reply['id']][0]
   ensure(quoted['reply']['text']=='引用目标','群消息返回引用预览')
   for _ in range(2):member.request('/api/groups/reaction',{'group':g['id'],'id':reply_mid,'emoji':'❤️','active':True})
   response=alice.request('/api/groups/reaction',{'group':g['id'],'id':reply_mid,'emoji':'❤️','active':True})
   ensure(response['reactions']==[{'emoji':'❤️','count':2,'mine':True}],'群表情回应聚合且重试幂等')
   member.request('/api/groups/reaction',{'group':g['id'],'id':reply_mid,'emoji':'❤️','active':False})
   outsider.request('/api/groups/reaction',{'group':g['id'],'id':reply_mid,'emoji':'❤️','active':True},status=403)
   outsider.request('/api/groups/message',{'group':g['id'],'text':'越权引用','reply_to':reply_mid},status=403)
   other=alice.request('/api/groups/create',{'name':'隔离测试群'})
   foreign_mid=alice.request('/api/groups/message',{'group':other['id'],'text':'跨群私密消息'})['id']
   alice.request('/api/groups/message',{'group':g['id'],'text':'跨群引用','reply_to':foreign_mid},status=404)
   alice.request('/api/groups/reaction',{'group':g['id'],'id':foreign_mid,'emoji':'👍','active':True},status=404)
   alice.request('/api/groups/leave',{'group':other['id']})
   alice.request('/api/groups/recall',{'group':g['id'],'id':reply_mid})
   recalled=member.request('/api/groups/messages?group='+g['id'])['messages']
   ensure([m for m in recalled if m['id']==reply['id']][0]['reply']['text']=='消息已撤回','引用不泄露已撤回原文')
   ensure([m for m in recalled if m['id']==reply_mid][0]['text']=='','撤回响应移除原文')
   member.request('/api/groups/reaction',{'group':g['id'],'id':reply_mid,'emoji':'👍','active':True},status=404)
   member.request('/api/groups/message',{'group':g['id'],'text':'引用撤回','reply_to':reply_mid},status=404)
   ensure(all(isinstance(m['online'],bool) for m in member.request('/api/groups/members?group='+g['id'])['members']),'群成员在线状态来自网站心跳')
   outsider.request('/api/groups/messages?group='+g['id'],status=403)
   myid=alice.request('/api/me')['user']['id']
   with sqlite3.connect(db) as conn: ticket=conn.execute('SELECT ticket FROM trades WHERE person=? ORDER BY rowid DESC LIMIT 1',(myid,)).fetchone()[0]
   member.request('/api/history?person='+a['id'],status=403)
   alice.request('/api/groups/share',{'group':g['id'],'ticket':ticket,'message':'x'*501},status=400)
   alice.request('/api/groups/share',{'group':g['id'],'ticket':ticket,'message':None},status=400)
   share=alice.request('/api/groups/share',{'group':g['id'],'ticket':ticket,'message':'一起看这段结构','snapshot':{'anchor_ms':1700000000000,'timeframe':'15m','layout':'1'}})
   ensure(share['sent']>=1,'发进群时给成员各写一条 share')
   card=[m for m in member.request('/api/groups/messages?group='+g['id'])['messages'] if m['kind']=='trade'][0]
   ensure(card['share'],'成员拿到这条交易的 share id')
   ensure(card['text']=='一起看这段结构','群分享卡片保留留言')
   entry=member.request('/api/chart/entry?share='+str(card['share']))
   ensure(entry['owner']['id']==a['id'],'非好友也能打开群里分享的这一笔')
   ensure(entry['share']['message']=='一起看这段结构','群成员打开分享时保留留言')
   ensure(entry['share']['anchor_ms']==1700000000000 and entry['share']['timeframe']=='15m','群分享保留图表切片')
   ensure(bool(entry['review']['trade']),'这单的复盘数据完整')
   member.request('/api/history?person='+a['id'],status=403)
   outsider.request('/api/chart/entry?share='+str(card['share']),status=404)
   opened=member.request('/api/groups/open',{'group':g['id'],'id':card['id']})
   ensure(opened['share']==card['share'],'重复打开复用同一条 share')
   outsider.request('/api/groups/join',{'code':g['code']})
   late=outsider.request('/api/groups/open',{'group':g['id'],'id':card['id']})
   late_entry=outsider.request('/api/chart/entry?share='+str(late['share']))
   ensure(late_entry['share']['anchor_ms']==1700000000000,'后加入成员打开原消息仍保留切片')
   ensure(late_entry['share']['message']=='一起看这段结构','后加入群成员也能看到原分享留言')
   outsider.request('/api/groups/leave',{'group':g['id']})
   member.request('/api/groups/share',{'group':g['id'],'ticket':ticket},status=403)
   alice.request('/api/groups/leave',{'group':g['id']})
   member.request('/api/groups/leave',{'group':g['id']})
   member.request('/api/groups/messages?group='+g['id'],status=404)
   ensure(alice.request('/api/profile')['mt5']['mode']=='history','profile reports history-only mode')
   imported=history_body('batch-0005');imported['website_user_id']=a['id']
   ensure(alice.request('/api/mt5/history-import',imported)['ok'],'browser-proxied import uses the same ingest')
   wrong_owner=history_body('batch-0006');wrong_owner['website_user_id']='somebody-else'
   alice.request('/api/mt5/history-import',wrong_owner,status=409)
   # ---- K 线轨道：按 source 累积、只落已收盘、覆盖与缺口、同券商复用 ----
   import bars as _bars
   _now=int(time.time())
   traded_ticket=job['ticket']
   conn=sqlite3.connect(db);conn.row_factory=sqlite3.Row
   _bars.initialize(conn)
   fetched=alice.request('/api/chart/bars?person='+a['id']+'&ticket='+traded_ticket+'&tf=M1&from='+str(window_from)+'&to='+str(window_to))
   ensure(fetched['source']=='srv:'+server_name,'bars endpoint resolves the broker source')
   ensure(fetched['bars']==[] and len(fetched['missing'])==1,'empty source reports the whole range as missing')
   ensure(alice.request('/api/chart/tracks?person='+a['id']+'&ticket='+traded_ticket+'&from='+str(window_from)+'&to='+str(window_to))['tracks'][0]['active'],'active track is listed first')
   feed=_bars.bind_feed(conn,a['id'],mt5_account,server_name,_now)
   ensure(feed['source']=='srv:'+server_name,'feed binds the broker source')
   sample=[[window_from+60*i,2400.0,2401.0,2399.0,2400.5,7.0] for i in range(5)]
   first=_bars.ingest(conn,feed['source'],feed['account_key'],'XAUUSD',{'M1':{'bars':sample,'complete':True,'from_server':window_from,'to_server':window_from+240}},_now)
   ensure(first['series']['M1']['accepted']==5 and first['series']['M1']['state']=='have','closed bars are stored')
   _bars.ingest(conn,feed['source'],feed['account_key'],'XAUUSD',{'M1':{'bars':sample,'complete':True,'from_server':window_from,'to_server':window_from+240}},_now)
   ensure(conn.execute('SELECT count(*) FROM bars WHERE source=?',(feed['source'],)).fetchone()[0]==5,'replaying bars is idempotent')
   forming_wall=int(_now)+_bars.source_offset(conn,feed['source'])
   unclosed=_bars.ingest(conn,feed['source'],feed['account_key'],'XAUUSD',{'M5':{'bars':[[forming_wall,2400.0,2401.0,2399.0,2400.5,1.0]],'complete':True,'from_server':forming_wall,'to_server':forming_wall}},_now)
   ensure(unclosed['series']['M5']['accepted']==0 and unclosed['series']['M5']['state']=='pending','forming bars are rejected and not covered')
   ensure(conn.execute("SELECT count(*) FROM bar_coverage WHERE tf='M5'").fetchone()[0]==0,'forming bar range stays missing')
   after=_bars.read(conn,feed['source'],'XAUUSD','M1',window_from,window_to,_now)
   ensure(len(after['bars'])==5 and after['missing'][0]['from']==window_from+241,'covered head shrinks the missing gap')
   conn.commit();conn.close()
   legacy=alice.request('/api/chart/bars?person='+a['id']+'&ticket=fixture-1&tf=M1&from='+str(window_from)+'&to='+str(window_to))
   ensure(legacy['source']=='srv:'+server_name,'trades without a server fall back to their owner feed')
   market=alice.request('/api/market/bars?symbol=XAUUSD&tf=M1&from='+str(window_from)+'&to='+str(window_to))
   ensure(market['source']=='srv:'+server_name and market['feed']['account']==mt5_account,'market bars use the owner feed')
   # 出库统一按 UTC：没记过偏移的源当作 0，记过的话每根 bar 都要被平移。
   probe=sqlite3.connect(':memory:');probe.row_factory=sqlite3.Row;_bars.initialize(probe)
   _bars.set_source_offset(probe,'srv:probe',3600,0)
   ensure(_bars.source_offset(probe,'srv:probe')==3600,'source offset round-trips')
   shifted=_bars.to_utc({'bars':[[1000,1,1,1,1,0]],'missing':[{'from':1000,'to':2000}]},3600)
   ensure(shifted['bars'][0][0]==-2600 and shifted['missing'][0]['from']==-2600,'to_utc shifts bars and gaps')
   ensure(_bars.source_offset(probe,'srv:unknown')==0,'unknown source defaults to a zero offset')
   catalog=alice.request('/api/data/sources')
   ensure(any(row['kind']=='personal' for row in catalog['sources']),'data catalog marks the personal track as personal')
   ensure(all('tfs' in row and 'last_bar' in row for row in catalog['sources']),'data catalog carries coverage per timeframe')
   anon.request('/api/data/sources',status=401)
   prefs_js=anon.request('/profile-prefs.js')
   ensure(b'chart-prefs' not in prefs_js and b'sn-ui.v1' in prefs_js,'profile prefs script is served')
   limited=alice.request('/api/market/bars?symbol=XAUUSD&tf=M1&limit=100')
   ensure(limited.get('count') is not None and len(limited['bars'])<=100,'market bars honours the latest-N limit')
   newest=alice.request('/api/market/bars?symbol=XAUUSD&tf=M1&limit=2')
   ensure(newest['count']==2 and newest['has_more'] and newest['next_before']==newest['bars'][0][0],'market count paging exposes a real next cursor')
   earlier=alice.request('/api/market/bars?symbol=XAUUSD&tf=M1&limit=2&before='+str(newest['next_before'])+'&source='+feed['source'])
   ensure(earlier['source']==newest['source'] and len(earlier['bars'])==2 and earlier['bars'][-1][0]<newest['bars'][0][0],'market count paging stays on one source with a strict UTC boundary')
   final=alice.request('/api/market/bars?symbol=XAUUSD&tf=M1&limit=2&before='+str(earlier['next_before'])+'&source='+feed['source'])
   ensure(final['count']==1 and not final['has_more'] and final['next_before'] is None,'market count paging identifies the actual final page')
   public_page=admin.request('/api/market/bars?symbol=XAUUSD&tf=M1&limit=2')
   ensure(public_page['public'] and public_page['feed']['account']=='' and public_page['count']==2,'unbound user can read a public server track without leaking an account')
   public_earlier=admin.request('/api/market/bars?symbol=XAUUSD&tf=M1&limit=2&before='+str(public_page['next_before'])+'&source='+public_page['source'])
   ensure(public_earlier['source']==public_page['source'] and public_earlier['bars'][-1][0]<public_page['bars'][0][0],'public track count paging pins the selected source')
   with sqlite3.connect(db) as offset_db:
    offset_db.row_factory=sqlite3.Row;original_offset=_bars.source_offset(offset_db,feed['source']);_bars.set_source_offset(offset_db,feed['source'],3600)
   shifted_page=alice.request('/api/market/bars?symbol=XAUUSD&tf=M1&limit=2&source='+feed['source'])
   ensure(shifted_page['bars'][0][0]==newest['bars'][0][0]-3600 and shifted_page['next_before']==shifted_page['bars'][0][0],'market page and cursor convert broker walls to UTC exactly once')
   shifted_earlier=alice.request('/api/market/bars?symbol=XAUUSD&tf=M1&limit=2&before='+str(shifted_page['next_before'])+'&source='+feed['source'])
   ensure([row[0] for row in shifted_earlier['bars']]==[row[0]-3600 for row in earlier['bars']],'market UTC before cursor converts back to the broker wall query')
   with sqlite3.connect(db) as offset_db:_bars.set_source_offset(offset_db,feed['source'],original_offset)
   alice.request('/api/market/bars?symbol=XAUUSD&tf=M1&limit=invalid',status=400)
   alice.request('/api/market/bars?symbol=XAUUSD&tf=M1&limit=2&before=invalid',status=400)
   alice.request('/api/market/bars?symbol=XAUUSD&tf=M1&before=123',status=400)
   anon.request('/api/market/bars?tf=M1&from=1&to=2',status=401)
   # 回填使用券商墙钟判断闭盘；少返回的前缀/内部缺口不伪记完整覆盖。
   upload_now=int(time.time());wall_now=upload_now+original_offset
   recent_start=(wall_now//60-15)*60
   recent_rows=[[recent_start+i*60,2400.0,2401.0,2399.0,2400.5,7.0] for i in (8,9,12)]
   recent_rows.append([wall_now+3600,2400.0,2401.0,2399.0,2400.5,7.0])
   backfill={'website_user_id':a['id'],'account':mt5_account,'server':server_name,'account_key':history_key,
             'symbol':'XAUUSD','tf':'M1','from_server':recent_start,'to_server':recent_start+15*60,
             'bars':recent_rows,'complete':True}
   uploaded=alice.request('/api/market/backfill',backfill)
   ensure((uploaded['account_key'],uploaded['account'],uploaded['server'],uploaded['source'],uploaded['symbol'])==
          (history_key,mt5_account,server_name,'srv:'+server_name,'XAUUSD'),'backfill ACK echoes the authenticated account, source and symbol')
   ensure(uploaded['summary']['accepted']==3 and uploaded['summary']['dropped']==1,'broker-wall recent bars accepted while future bar stays unclosed')
   ensure(uploaded['summary']['complete'] is False,'unproven backfill range never trusts a caller complete flag')
   with sqlite3.connect(db) as verify_db:
    verify_db.row_factory=sqlite3.Row
    stored=verify_db.execute('SELECT t,updated FROM bars WHERE source=? AND symbol=? AND tf=? AND t>=? ORDER BY t',
                            (feed['source'],'XAUUSD','M1',recent_start)).fetchall()
    ensure([row['t'] for row in stored]==[row[0] for row in recent_rows[:3]],'only real closed backfill rows are stored')
    ensure(all(abs(row['updated']-time.time())<30 for row in stored),'backfill audit time stays UTC instead of broker wall time')
    recent_missing=_bars.missing(verify_db,feed['source'],'XAUUSD','M1',recent_start,recent_start+15*60)
    ensure(all(any(begin<=stamp<=end for begin,end in recent_missing) for stamp in (recent_start,recent_start+11*60)),
           'missing returned prefix and internal gap remain eligible for later backfill')
   empty_backfill={**backfill,'from_server':recent_start-3600,'to_server':recent_start-3000,'bars':[]}
   empty_result=alice.request('/api/market/backfill',empty_backfill)
   ensure(empty_result['summary']['state']=='pending' and not empty_result['summary']['complete'],'an empty unproven backfill is not declared a known market closure')
   direct_result=anon.request('/api/market/backfill',empty_backfill,extra=history_bearer)
   ensure(direct_result['account_key']==history_key and direct_result['summary']==empty_result['summary'],'SyncNote Bearer backfill uses the same conservative ingest and exact ACK')
   # ---- 两个源码包：同一套打包器，SyncNote 必须在打包时就被证明没有 DLL / 交易 / socket ----
   for path,product in (('/downloads/syncnote.zip','SyncNote'),('/downloads/synctrade.zip','SyncTrade')):
    with zipfile.ZipFile(io.BytesIO(anon.request(path))) as archive:
     manifest=json.loads(archive.read(product+'/SOURCE_MANIFEST.json'))
     ensure(manifest['product']==product and manifest['entry']==product+'.mq5','packaged '+product+' manifest')
     ensure(all(hashlib.sha256(archive.read(product+'/'+name)).hexdigest()==digest for name,digest in manifest['files'].items()),product+' manifest matches package')
     ensure(any(name.endswith('SYNCNOTE_PROTOCOL.md') for name in archive.namelist()),product+' ships the history protocol')
   with zipfile.ZipFile(io.BytesIO(anon.request('/downloads/syncnote.zip'))) as archive:
    note_source=b''.join(archive.read(name) for name in archive.namelist() if name.endswith(('.mq5','.mqh')))
    ensure(not any(token in note_source for token in (b'#import',b'OrderSend',b'CTrade',b'SocketCreate')),'SyncNote package stays free of DLL, trading and socket imports')
   alice.request('/api/logout',{});alice.request('/api/me',status=401)
   print(json.dumps({'passed':True,'checks':count,'production_data_used':False,'database':'temporary-generated-only'}))
  finally:
   proc.terminate()
   try:proc.wait(timeout=5)
   except subprocess.TimeoutExpired:proc.kill();proc.wait()

if __name__=='__main__':main()

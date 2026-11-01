"""Isolated integration checks. All accounts/trades are generated fixtures."""
import hashlib,http.cookiejar,io,json,os,secrets,sqlite3,subprocess,sys,tempfile,urllib.request,urllib.error,zipfile
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
   body=r.read();ensure(r.status==status,'unexpected HTTP status: '+path)
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
   used=new_code();register(Client(base),'cc',used)
   reused=Client(base);challenge=anon.request('/api/login-challenge');rt=challenge['challenge_id']
   with sqlite3.connect(db) as conn:rh=conn.execute('SELECT answer FROM login_challenges WHERE id=?',(rt,)).fetchone()[0]
   ra=next(str(i) for i in range(9) if hashlib.sha256((rt+str(i)).encode()).hexdigest()==rh)
   reused.request('/api/register',{'username':'dd','nickname':'dd','password':password,'invite_code':used,'challenge_id':rt,'challenge_answer':ra},status=403)
   resp=admin.request('/api/admin/invites')
   ensure(any(row['state']=='used' for row in resp['invites']),'invite marked used')
   admin.request('/api/admin/invites/revoke',{'id':0},status=404)
   ensure(len(admin.request('/api/admin/users')['users'])==4,'new accounts only')
   alice.request('/api/journal',{'person':b['id'],'ticket':'fixture','text':'cross-user attempt'},status=404)
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
   ensure(alice.request('/api/profile')['mt5']['mode']=='history','profile reports history-only mode')
   imported=history_body('batch-0005');imported['website_user_id']=a['id']
   ensure(alice.request('/api/mt5/history-import',imported)['ok'],'browser-proxied import uses the same ingest')
   wrong_owner=history_body('batch-0006');wrong_owner['website_user_id']='somebody-else'
   alice.request('/api/mt5/history-import',wrong_owner,status=409)
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

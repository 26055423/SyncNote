"""Isolated integration checks. All accounts/trades are generated fixtures."""
import hashlib,http.cookiejar,io,json,os,secrets,sqlite3,subprocess,sys,tempfile,urllib.request,urllib.error,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
count=0

def ensure(value,message):
 global count
 assert value,message
 count+=1

class Client:
 def __init__(self,base):
  self.base=base;self.opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
 def request(self,path,data=None,status=200,origin=None):
  headers={'Content-Type':'application/json','Origin':origin or self.base}
  req=urllib.request.Request(self.base+path,headers=headers,data=json.dumps(data).encode() if data is not None else None)
  try:r=self.opener.open(req,timeout=15)
  except urllib.error.HTTPError as error:r=error
  with r:
   body=r.read();ensure(r.status==status,'unexpected HTTP status: '+path)
   return json.loads(body) if 'application/json' in r.headers.get('Content-Type','') else body

def main():
 with tempfile.TemporaryDirectory(prefix='tongpin-synthetic-',ignore_cleanup_errors=True) as folder:
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
   for path in ('/api/state','/api/profile','/api/history','/api/invite'):anon.request(path,status=401)
   for path in ('/login','/register','/style.css','/app.js','/downloads/TongpinSync.mq5','/local-ea','/local-ea.css'):ensure(len(anon.request(path))>0,'static content '+path)
   with zipfile.ZipFile(io.BytesIO(anon.request('/downloads/tongpin-local.zip'))) as archive:
    manifest=json.loads(archive.read('TongpinLocal/SOURCE_MANIFEST.json'))
    ensure('TongpinLocal.mq5' in manifest['files'],'EA source entry is packaged')
    ensure(all(name.endswith(('.mq5','.mqh','.md','.json')) for name in archive.namelist()),'source download contains no executable or credential files')
    ensure(all(hashlib.sha256(archive.read('TongpinLocal/'+name)).hexdigest()==digest for name,digest in manifest['files'].items()),'EA source manifest matches package')
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
   for client in (alice,bob):
    client.request('/api/mt5/token',{})
   alice.request('/api/logout',{});alice.request('/api/me',status=401)
   print(json.dumps({'passed':True,'checks':count,'production_data_used':False,'database':'temporary-generated-only'}))
  finally:
   proc.terminate()
   try:proc.wait(timeout=5)
   except subprocess.TimeoutExpired:proc.kill();proc.wait()

if __name__=='__main__':main()

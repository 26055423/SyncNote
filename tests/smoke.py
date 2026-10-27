"""Isolated integration checks. All accounts/trades are generated fixtures."""
import hashlib,http.cookiejar,json,os,secrets,sqlite3,subprocess,sys,tempfile,urllib.request,urllib.error
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
 with tempfile.TemporaryDirectory(prefix='tongpin-synthetic-') as folder:
  password=secrets.token_urlsafe(24)
  env={**os.environ,'DATA_DIR':folder,'COOKIE_SECURE':'0','ADMIN_USERNAME':'admin','PYTHONDONTWRITEBYTECODE':'1','TRUSTED_PROXY_CIDRS':'','TRUSTED_PROXY_HOSTS':''}
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
   for path in ('/login','/register','/style.css','/app.js','/downloads/TongpinSync.mq5'):ensure(len(anon.request(path))>0,'static content '+path)
   admin.request('/api/login',{'username':'admin','password':password})
   ensure(admin.request('/api/me')['user']['role']=='admin','independent owner')
   anon.request('/api/mt5/assistant',{'platform':'mac'},status=401)
   admin.request('/api/mt5/assistant',{'platform':'mac'},status=501)
   admin.request('/api/profile',{},status=403,origin='https://untrusted.invalid')
   def register(client,name):
    invitation=admin.request('/api/invite')['code'];challenge=anon.request('/api/login-challenge');token=challenge['challenge_id']
    with sqlite3.connect(db) as conn:answer_hash=conn.execute('SELECT answer FROM login_challenges WHERE id=?',(token,)).fetchone()[0]
    answer=next(str(i) for i in range(9) if hashlib.sha256((token+str(i)).encode()).hexdigest()==answer_hash)
    return client.request('/api/register',{'username':name,'nickname':name,'password':password,'invite_code':invitation,'challenge_id':token,'challenge_answer':answer})['user']
   a=register(alice,'aa');b=register(bob,'bb');ensure(a['id']!=b['id'],'separate user IDs')
   ensure(alice.request('/api/me')['user']['username']=='aa','session A');ensure(bob.request('/api/me')['user']['username']=='bb','session B')
   alice.request('/api/profile',{'nickname':'Synthetic Alpha','avatar':'avatar1','bio':'fixture-only'})
   ensure(bob.request('/api/profile')['user']['nickname']=='bb','profile ownership')
   alice.request('/api/admin/users',status=403);alice.request('/api/invite',status=403)
   ensure(len(admin.request('/api/admin/users')['users'])==3,'new accounts only')
   alice.request('/api/journal',{'person':b['id'],'ticket':'fixture','text':'cross-user attempt'},status=404)
   for client in (alice,bob):
    client.request('/api/mt5/token',{})
   alice.request('/api/logout',{});alice.request('/api/me',status=401)
   print(json.dumps({'passed':True,'checks':count,'production_data_used':False,'database':'temporary-generated-only'}))
  finally:
   proc.terminate()
   try:proc.wait(timeout=5)
   except subprocess.TimeoutExpired:proc.kill();proc.wait()

if __name__=='__main__':main()

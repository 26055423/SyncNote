"""Shared authentication protection. No credentials in logs."""
import ipaddress
import os
DEVICE_COOKIE="__Host-tongpin_device" if os.environ.get("COOKIE_SECURE","0")=="1" else "tongpin_device"
def device_cookie(token):
 return DEVICE_COOKIE+"="+token+"; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"+("; Secure" if os.environ.get("COOKIE_SECURE","0")=="1" else "")
import base64,hashlib,hmac,secrets,time,struct,json,zlib
from urllib.parse import quote

def initialize(db):
 db.executescript('''CREATE TABLE IF NOT EXISTS login_failures(account TEXT PRIMARY KEY,failed_at REAL NOT NULL);CREATE TABLE IF NOT EXISTS login_pending(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,network_hash TEXT NOT NULL,agent_hash TEXT NOT NULL,expires REAL NOT NULL,attempts INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS login_challenges(id TEXT PRIMARY KEY,answer TEXT NOT NULL,expires REAL NOT NULL);CREATE TABLE IF NOT EXISTS trusted_devices(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,network_hash TEXT NOT NULL,agent_hash TEXT NOT NULL,expires REAL NOT NULL);CREATE TABLE IF NOT EXISTS security_config(key TEXT PRIMARY KEY);CREATE TABLE IF NOT EXISTS mfa_recovery(user_id TEXT NOT NULL,code_hash TEXT NOT NULL,PRIMARY KEY(user_id,code_hash));CREATE TABLE IF NOT EXISTS account_mfa(user_id TEXT PRIMARY KEY,secret TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,last_step INTEGER NOT NULL DEFAULT -1);CREATE TABLE IF NOT EXISTS security_limits(key TEXT PRIMARY KEY,started REAL NOT NULL,count INTEGER NOT NULL);''')
def limit(db,key,max_count,window):
 now=time.time();row=db.execute('SELECT started,count FROM security_limits WHERE key=?',(key,)).fetchone()
 if not row or now-row[0]>=window:db.execute('INSERT OR REPLACE INTO security_limits VALUES(?,?,1)',(key,now));allowed=True
 else:db.execute('UPDATE security_limits SET count=count+1 WHERE key=?',(key,));allowed=row[1]<max_count
 db.execute('DELETE FROM security_limits WHERE started<?',(now-86400,));db.commit();return allowed

def challenge(db):
 db.execute('DELETE FROM login_challenges WHERE expires<?',(time.time(),))
 token=secrets.token_urlsafe(24);odd=secrets.randbelow(9);answer=str(odd)
 db.execute('INSERT INTO login_challenges VALUES(?,?,?)',(token,hashlib.sha256((token+answer).encode()).hexdigest(),time.time()+300))
 from challenge_image import render_challenge
 return render_challenge(token,odd)

def verify_challenge(db,data):
 token=str(data.get('challenge_id',''))[:100];answer=str(data.get('challenge_answer','')).strip().upper()[:12]
 row=db.execute('SELECT answer,expires FROM login_challenges WHERE id=?',(token,)).fetchone();db.execute('DELETE FROM login_challenges WHERE id=?',(token,));db.commit()
 return bool(row and row[1]>time.time() and hmac.compare_digest(row[0],hashlib.sha256((token+answer).encode()).hexdigest()))
def totp(secret,step):
 key=base64.b32decode(secret+'='*((8-len(secret)%8)%8));digest=hmac.new(key,struct.pack('>Q',step),hashlib.sha1).digest();i=digest[-1]&15
 return str((struct.unpack('>I',digest[i:i+4])[0]&0x7fffffff)%1000000).zfill(6)
def verify_otp(db,uid,code):
 row=db.execute('SELECT secret,enabled,last_step FROM account_mfa WHERE user_id=?',(uid,)).fetchone()
 if not row or not row[1]:return True
 if len(str(code))>6:
  digest=hashlib.sha256((uid+str(code)).encode()).hexdigest()
  row=db.execute('DELETE FROM mfa_recovery WHERE user_id=? AND code_hash=?',(uid,digest))
  return row.rowcount==1
 step=int(time.time()/30)
 for n in (step-1,step,step+1):
  if n>row[2] and hmac.compare_digest(totp(row[0],n),str(code)):
   db.execute('UPDATE account_mfa SET last_step=? WHERE user_id=?',(n,uid));return True
 return False

def device_fingerprint(ip,agent):
 try:network=str(ipaddress.ip_network(ip+('/24' if ':' not in ip else '/64'),strict=False))
 except ValueError:network=ip
 return hashlib.sha256(network.encode()).hexdigest(),hashlib.sha256(agent.encode()).hexdigest()
def trusted(db,uid,token,ip,agent):
 if not token:return False
 network,agent_hash=device_fingerprint(ip,agent)
 row=db.execute('SELECT 1 FROM trusted_devices WHERE token_hash=? AND user_id=? AND network_hash=? AND agent_hash=? AND expires>?',(hashlib.sha256(token.encode()).hexdigest(),uid,network,agent_hash,time.time())).fetchone()
 return bool(row)
def trust(db,uid,ip,agent):
 token=secrets.token_urlsafe(32);network,agent_hash=device_fingerprint(ip,agent)
 db.execute('DELETE FROM trusted_devices WHERE expires<?',(time.time(),))
 db.execute('INSERT INTO trusted_devices VALUES(?,?,?,?,?)',(hashlib.sha256(token.encode()).hexdigest(),uid,network,agent_hash,time.time()+2592000));return token

def progressive_login(handler,db,data,path,pw_ok):
 now=time.time();ip=handler.client_ip();agent=handler.headers.get('User-Agent','')
 if path=='/api/login/verify':
  ticket=str(data.get('mfa_ticket',''))[:100];key=hashlib.sha256(ticket.encode()).hexdigest()
  row=db.execute('SELECT * FROM login_pending WHERE token_hash=?',(key,)).fetchone()
  network,agent_hash=device_fingerprint(ip,agent)
  if not row or row['expires']<now or row['attempts']>=5 or row['network_hash']!=network or row['agent_hash']!=agent_hash:return 401,{'error':'验证已过期，请重新登录'},None
  uid=row['user_id'];db.execute('UPDATE login_pending SET attempts=attempts+1 WHERE token_hash=?',(key,))
  if not verify_otp(db,uid,data.get('otp','')):return 401,{'error':'动态码不正确或已使用'},None
  db.execute('DELETE FROM login_pending WHERE token_hash=?',(key,));u=db.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone();cookies=[handler.session(db,uid)]
  if True:  # Fresh MFA establishes the standalone 30-day device trust.
   token=trust(db,uid,ip,agent);cookies.append(device_cookie(token))
  return 200,{'ok':True,'user':{k:u[k] for k in ('id','username','nickname','avatar','bio','onboarding_step')}},cookies
 account=str(data.get('username','')).strip().lower()[:64]
 if not limit(db,'account:'+account,10,600) or not limit(db,'ip:'+ip,150,600):return 429,{'error':'尝试过于频繁，请10分钟后重试'},None
 db.execute('DELETE FROM login_failures WHERE failed_at<?',(now-600,))
 failed=db.execute('SELECT failed_at FROM login_failures WHERE account=?',(account,)).fetchone()
 needs_challenge=bool(failed and now-failed[0]<600)
 if needs_challenge and not verify_challenge(db,data):return 400,{'error':'请完成图案验证','challenge_required':True},None
 u=db.execute('SELECT * FROM users WHERE username=?',(account,)).fetchone()
 if not u:pw_ok(data.get('password'),'0'*32+':'+'0'*64)
 if not u or not pw_ok(data.get('password'),u['password']):
  db.execute('INSERT OR REPLACE INTO login_failures VALUES(?,?)',(account,now));return 401,{'error':'账号或密码不正确','challenge_required':True},None
 db.execute('DELETE FROM login_failures WHERE account=?',(account,));uid=u['id']
 from http.cookies import SimpleCookie
 browser=SimpleCookie();browser.load(handler.headers.get('Cookie',''));device=browser.get(DEVICE_COOKIE)
 mfa=db.execute('SELECT enabled FROM account_mfa WHERE user_id=?',(uid,)).fetchone()
 if mfa and mfa[0] and not trusted(db,uid,device.value if device else '',ip,agent):
  token=secrets.token_urlsafe(32);network,agent_hash=device_fingerprint(ip,agent)
  db.execute('DELETE FROM login_pending WHERE expires<?',(now,));db.execute('INSERT INTO login_pending VALUES(?,?,?,?,?,0)',(hashlib.sha256(token.encode()).hexdigest(),uid,network,agent_hash,now+300))
  return 202,{'requires_mfa':True,'mfa_ticket':token},None
 cap=None
 if mfa and mfa[0] and device:
  row=db.execute('SELECT expires FROM trusted_devices WHERE token_hash=? AND user_id=?',(hashlib.sha256(device.value.encode()).hexdigest(),uid)).fetchone()
  if row:cap=row[0]
 return 200,{'ok':True,'user':{k:u[k] for k in ('id','username','nickname','avatar','bio','onboarding_step')}},handler.session(db,uid,cap=cap)

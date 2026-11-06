"""Short-lived HTTPS pairing for the read-only SyncNote EA.

An eight-digit code only requests a pairing. The EA's secret and a separate
confirmation on its chart are required before a history credential is issued.
"""
import hashlib
import re
import secrets
import time
import auth_security
import sync_history

TTL=600

class PairError(Exception):
 def __init__(self,text,code=400):self.text,self.code=text,code

def digest(value):return hashlib.sha256(value.encode()).hexdigest()

def token_for(secret):return digest('syncnote-device-token.v1\n'+secret)

def initialize(db):
 db.executescript('''CREATE TABLE IF NOT EXISTS mt5_device_pairs(
 secret_hash TEXT PRIMARY KEY,code_hash TEXT UNIQUE,expires REAL NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',user_id TEXT REFERENCES users(id),
 claim_id TEXT,nickname TEXT,account_key TEXT,token_hash TEXT);
 CREATE INDEX IF NOT EXISTS idx_mt5_device_pairs_expiry ON mt5_device_pairs(expires);''')

def limited(db,ip,kind,maximum,window=600):
 if not auth_security.limit(db,'mt5-device:'+kind+':'+ip,maximum,window):
  raise PairError('配对尝试过于频繁，请稍后重试',429)

def start(db,ip):
 limited(db,ip,'start',30)
 now=time.time();db.execute('BEGIN IMMEDIATE')
 db.execute('DELETE FROM mt5_device_pairs WHERE expires<?',(now-86400,))
 secret=secrets.token_urlsafe(36)
 for _ in range(10):
  code=str(secrets.randbelow(100000000)).zfill(8)
  if not db.execute('SELECT 1 FROM mt5_device_pairs WHERE code_hash=?',(digest(code),)).fetchone():break
 else:raise PairError('暂时无法生成配对码，请稍后重试',503)
 db.execute('INSERT INTO mt5_device_pairs(secret_hash,code_hash,expires) VALUES(?,?,?)',(digest(secret),digest(code),now+TTL))
 return {'ok':True,'code':code,'device_secret':secret,'expires_in':TTL}

def owner(db,uid):
 row=db.execute('SELECT id,username,nickname,locked FROM users WHERE id=?',(uid,)).fetchone()
 if not row or row['locked']:raise PairError('账号已被停用，请联系管理员',403)
 return row

def claim(db,ip,user,data):
 limited(db,ip,'claim-ip',30)
 limited(db,user['id'],'claim-user',5)
 code=data.get('code')
 if not isinstance(code,str) or not re.fullmatch('[0-9]{8}',code):raise PairError('请输入 EA 图表上的 8 位配对码')
 db.execute('BEGIN IMMEDIATE');user=owner(db,user['id'])
 row=db.execute('SELECT * FROM mt5_device_pairs WHERE code_hash=?',(digest(code),)).fetchone()
 if not row or row['expires']<=time.time() or row['status']!='pending':raise PairError('配对码无效、已被使用或已过期',409)
 claim_id=secrets.token_urlsafe(24)
 db.execute("UPDATE mt5_device_pairs SET status='claimed',code_hash=NULL,user_id=?,claim_id=?,nickname=? WHERE secret_hash=?",(user['id'],claim_id,user['nickname'],row['secret_hash']))
 return {'ok':True,'status':'claimed'}

def device(db,data):
 secret=data.get('device_secret')
 if not isinstance(secret,str) or not 32<=len(secret)<=128:raise PairError('设备配对凭据无效',401)
 row=db.execute('SELECT * FROM mt5_device_pairs WHERE secret_hash=?',(digest(secret),)).fetchone()
 if not row:raise PairError('设备配对凭据无效',401)
 if row['expires']<=time.time():raise PairError('配对已过期，请在 EA 中获取新配对码',410)
 if row['user_id']:owner(db,row['user_id'])
 if row['status']=='approved':
  link=db.execute('SELECT token_hash,account_key FROM mt5_links WHERE user_id=?',(row['user_id'],)).fetchone()
  if not link or link['token_hash']!=row['token_hash'] or link['account_key']!=row['account_key']:raise PairError('此设备授权已撤销，请重新配对',410)
 return secret,row

def poll(db,ip,data):
 limited(db,ip,'poll',2400)
 _,row=device(db,data)
 result={'ok':True,'status':row['status']}
 if row['status']=='claimed':
  user=owner(db,row['user_id'])
  result.update(claim_id=row['claim_id'],nickname=row['nickname'],username=user['username'])
 return result

def confirm(db,ip,data):
 limited(db,ip,'confirm',120)
 db.execute('BEGIN IMMEDIATE');secret,row=device(db,data)
 claim_id=data.get('claim_id')
 if not isinstance(claim_id,str) or claim_id!=row['claim_id'] or row['status'] not in ('claimed','approved','rejected'):raise PairError('本次配对请求已失效',409)
 allow=data.get('allow')
 if not isinstance(allow,bool):raise PairError('请明确允许或拒绝此次配对')
 if row['status']=='rejected':
  if allow:raise PairError('本次配对已拒绝，请生成新配对码',409)
  return {'ok':True,'status':'rejected'}
 if not allow:
  if row['status']=='approved':raise PairError('配对已完成，请在网页解除连接',409)
  db.execute("UPDATE mt5_device_pairs SET status='rejected' WHERE secret_hash=?",(row['secret_hash'],))
  return {'ok':True,'status':'rejected'}
 _,_,key=sync_history.identity(data)
 link=db.execute('SELECT * FROM mt5_links WHERE user_id=?',(row['user_id'],)).fetchone()
 if link and link['account_key'] and link['account_key']!=key:raise PairError('该同频账号已绑定其他 MT5 账户，请使用与当前 MT5 账户对应的同频账号',409)
 if row['status']=='approved' and row['account_key']!=key:raise PairError('本次配对账户不匹配',409)
 token=token_for(secret);token_hash=digest(token)
 if row['status']=='claimed':
  db.execute('INSERT INTO mt5_links(user_id,token_hash,account_key,updated) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,account_key=excluded.account_key,updated=excluded.updated',(row['user_id'],token_hash,key,time.time()))
  db.execute("UPDATE mt5_device_pairs SET status='approved',account_key=?,token_hash=? WHERE secret_hash=?",(key,token_hash,row['secret_hash']))
 return {'ok':True,'status':'approved','token':token}

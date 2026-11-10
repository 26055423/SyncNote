"""Admin HTTP endpoints."""
import time,sqlite3
from http.cookies import SimpleCookie
import auth_security,observability
from accounts import is_admin,pw_ok,digest,new_invite_code,invite_hash
from app_config import ADMIN_USERNAME
from http_errors import Error

def get_admin_users(self,db,u,q):
 uid=u['id']
 self.require_admin(u,db)
 rows=db.execute('SELECT u.id,u.username,u.nickname,u.created,u.locked,s.updated AS synced,(SELECT COUNT(*) FROM trade_reviews r WHERE r.person=u.id AND r.status=\'ready\') AS reviews FROM users u LEFT JOIN snapshots s ON s.person=u.id ORDER BY u.created').fetchall()
 return self.reply({'users':[dict(r,role='admin' if r['username']==ADMIN_USERNAME else 'user') for r in rows]})

def get_invite(self,db,u,q):
 uid=u['id']
 self.require_admin(u,db)
 return self.reply(dict(db.execute('SELECT code,updated FROM registration_invite WHERE id=1').fetchone()))

def get_admin_invites(self,db,u,q):
 uid=u['id']
 self.require_admin(u,db)
 rows=db.execute('SELECT i.*,u.nickname AS used_name FROM invites i LEFT JOIN users u ON u.id=i.used_by ORDER BY i.id DESC LIMIT 500').fetchall()
 now=time.time()
 items=[]
 for r in rows:
  state='used' if r['used_by'] else 'revoked' if r['revoked'] else 'expired' if r['expires'] and r['expires']<now else 'unused'
  items.append({'id':r['id'],'batch':r['batch'],'note':r['note'],'created':r['created'],'expires':r['expires'] or 0,'state':state,'used_by':r['used_by'],'used_name':r['used_name'],'used_at':r['used_at'],'code':r['code_plain'] or ''})
 return self.reply({'invites':items,'sudo_until':self.sudo_until(db)})

def post_admin_sudo(self,db,u,data):
 uid=u['id']
 if not is_admin(u):raise Error('页面不存在',404)
 if not auth_security.limit(db,'sudo:'+self.client_ip(),10,300):raise Error('尝试过于频繁，请稍后再试',429)
 if not pw_ok(data.get('password'),u['password']):raise Error('密码不正确',403)
 until=time.time()+900
 cookies=SimpleCookie()
 try:cookies.load(self.headers.get('Cookie',''))
 except Exception:raise Error('请重新登录',401)
 token=cookies.get('tongpin_session')
 if not token:raise Error('请重新登录',401)
 db.execute('UPDATE sessions SET sudo_until=? WHERE hash=?',(until,digest(token.value)))
 return self.reply({'ok':True,'sudo_until':until})

def post_admin_invites(self,db,u,data):
 uid=u['id']
 self.require_admin(u,db)
 try:count=int(data.get('count',20))
 except (TypeError,ValueError):count=20
 count=max(1,min(100,count))
 try:days=int(data.get('expires_days',7))
 except (TypeError,ValueError):days=7
 days=max(0,min(365,days))
 note=str(data.get('note','')).strip()[:60]
 batch=str(data.get('batch','')).strip()[:32] or time.strftime('%Y-%m-%d')
 now=time.time();expires=now+days*86400 if days else 0
 codes=[]
 for _ in range(count):
  for attempt in range(6):
   code=new_invite_code()
   try:
    db.execute('INSERT INTO invites(code_hash,code_plain,batch,note,created,expires) VALUES(?,?,?,?,?,?)',(invite_hash(code),code,batch,note,now,expires))
    codes.append(code);break
   except sqlite3.IntegrityError:
    continue
 return self.reply({'ok':True,'codes':codes,'batch':batch,'note':note,'expires':expires})

def post_admin_users_lock(self,db,u,data):
 uid=u['id']
 self.require_admin(u,db)
 try:ident=str(data.get('id','')).strip()
 except (TypeError,ValueError):raise Error('参数不正确',400)
 if not ident:raise Error('参数不正确',400)
 target=db.execute('SELECT id,username FROM users WHERE id=?',(ident,)).fetchone()
 if not target:raise Error('用户不存在',404)
 if target['username']==ADMIN_USERNAME:raise Error('不能锁定管理员自己',409)
 locked=1 if data.get('locked') else 0
 db.execute('UPDATE users SET locked=? WHERE id=?',(locked,target['id']))
 if locked:db.execute('DELETE FROM sessions WHERE user_id=?',(target['id'],))
 return self.reply({'ok':True,'id':target['id'],'locked':bool(locked)})

def post_admin_invites_revoke(self,db,u,data):
 uid=u['id']
 self.require_admin(u,db)
 try:ident=int(data.get('id',0))
 except (TypeError,ValueError):raise Error('参数不正确',400)
 row=db.execute('SELECT id,used_by FROM invites WHERE id=?',(ident,)).fetchone()
 if not row:raise Error('邀请码不存在',404)
 if row['used_by']:raise Error('这个邀请码已经被使用，无法作废',409)
 db.execute("UPDATE invites SET revoked=1,code_plain='' WHERE id=?",(ident,))
 return self.reply({'ok':True})

def get_metrics(self,db,u,q):
 self.require_admin(u,db)
 return self.reply(observability.snapshot())

GET={'/api/admin/users':get_admin_users,'/api/invite':get_invite,'/api/admin/invites':get_admin_invites,'/api/admin/metrics':get_metrics}
POST={'/api/admin/sudo':post_admin_sudo,'/api/admin/invites':post_admin_invites,'/api/admin/users/lock':post_admin_users_lock,'/api/admin/invites/revoke':post_admin_invites_revoke}

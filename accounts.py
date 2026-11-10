"""Account and invitation policy, independent of HTTP startup."""
import hashlib,hmac,secrets
from app_config import ADMIN_USERNAME
from http_errors import Error
INVITE_ALPHABET='ABCDEFGHJKMNPQRSTVWXYZ23456789'

def digest(s):return hashlib.sha256(s.encode()).hexdigest()

def pw_hash(p):
 if not isinstance(p,str) or not 8<=len(p)<=128:raise Error('密码需为 8–128 个字符')
 salt=secrets.token_hex(16);return salt+':'+hashlib.pbkdf2_hmac('sha256',p.encode(),salt.encode(),310000).hex()

def pw_ok(p,stored):
 if not isinstance(p,str) or len(p)>128:return False
 salt,expected=stored.split(':');return hmac.compare_digest(expected,hashlib.pbkdf2_hmac('sha256',p.encode(),salt.encode(),310000).hex())

def invite_normalize(code):
 return ''.join(ch for ch in str(code or '').upper() if ch.isalnum())

def invite_hash(code):
 return digest(invite_normalize(code))

def new_invite_code():
 return '-'.join(''.join(secrets.choice(INVITE_ALPHABET) for _ in range(4)) for _ in range(3))

def is_admin(u):
 return bool(u) and u['username']==ADMIN_USERNAME

def public(u):return {**{k:u[k] for k in ('id','username','nickname','avatar','bio','allow_follow','share_data','share_reviews','auto_history_sync','onboarding_step')},'role':'admin' if u['username']==ADMIN_USERNAME else 'user'}

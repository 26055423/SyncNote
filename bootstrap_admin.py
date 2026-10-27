"""Create the first owner in this installation only. No bundled password."""
import getpass,os,re,secrets,time

def create_admin(password):
 import app_server as app
 name=app.ADMIN_USERNAME
 if not re.fullmatch(r'[a-z0-9_]{2,24}',name):raise ValueError('ADMIN_USERNAME需为2到24位字母、数字或下划线')
 hashed=app.pw_hash(password)
 with app.connect() as db:
  db.execute('BEGIN IMMEDIATE')
  if db.execute('SELECT 1 FROM users').fetchone():raise ValueError('已有账户；初始化命令不会覆盖账户或密码')
  db.execute('INSERT INTO users(id,username,nickname,password,created,share_data,onboarding_step) VALUES(?,?,?,?,?,0,4)',(secrets.token_hex(12),name,name,hashed,time.time()))
 return name

if __name__=='__main__':
 first=getpass.getpass('设置本实例管理员密码：');second=getpass.getpass('再次输入：')
 if first!=second:raise SystemExit('两次密码不一致')
 try:print('已创建本实例管理员：'+create_admin(first))
 except (ValueError,Exception) as error:raise SystemExit(str(error))

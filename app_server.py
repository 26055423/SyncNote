"""Authenticated social board. No third-party runtime dependencies."""
import ipaddress
import client_address
import auth_security
import chart
import ea_hub
import journal
import market
from trade_time import utc_trade, record_clock
from datetime import datetime, timezone
import hashlib, hmac, json, math, os, re, secrets, sqlite3, time, io, zipfile, struct
from pathlib import Path
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
ADMIN_USERNAME=os.environ.get('ADMIN_USERNAME','admin').strip().lower()
ROOT=Path(__file__).parent
DATA=Path(os.environ.get('DATA_DIR',str(ROOT/'data'))); DATA.mkdir(parents=True,exist_ok=True)
DB=DATA/'board.sqlite3'
AVATAR_VERSIONS={p.stem:hashlib.sha256(p.read_bytes()).hexdigest()[:16] for p in (ROOT/'web'/'avatars').glob('avatar*.svg')}
PUBLIC_ORIGIN=os.environ.get('PUBLIC_ORIGIN','').rstrip('/')
SECURE=os.environ.get('COOKIE_SECURE','0')=='1'
def connect():
    db=sqlite3.connect(DB,timeout=20);db.row_factory=sqlite3.Row;db.execute('PRAGMA foreign_keys=ON');return db
def hub_trade(user_id,item,offset):
    """EA 直连 hub 时平仓：落交易记录，并从 hub 缓存的 K 线拼复盘图。"""
    with connect() as db:
        trade={k:v for k,v in item.items() if k not in ('time_basis','time_verified')}
        trade['time_basis']='utc';trade['time_verified']=True
        db.execute('INSERT INTO trades VALUES(?,?,?) ON CONFLICT(person,ticket) DO UPDATE SET payload=excluded.payload',(user_id,str(item['ticket']),json.dumps(trade,allow_nan=False,ensure_ascii=False)))
        row=db.execute('SELECT status FROM trade_reviews WHERE person=? AND ticket=?',(user_id,str(item['ticket']))).fetchone()
        if not row:
            db.execute("INSERT OR IGNORE INTO trade_reviews VALUES(?,?,'pending',NULL,?)",(user_id,str(item['ticket']),time.time()))
            row=db.execute('SELECT status FROM trade_reviews WHERE person=? AND ticket=?',(user_id,str(item['ticket']))).fetchone()
        if row and row['status']=='pending':
            built=HUB.review_charts(user_id,item['opened_server'],item['closed_server'])
            if built and any(built['charts'].values()):
                payload={'charts':built['charts'],'errors':built['errors'],'opened_server':item['opened_server'],'closed_server':item['closed_server'],'time_basis':'utc','source':'EA hub'}
                db.execute("UPDATE trade_reviews SET status='ready',payload=?,updated=? WHERE person=? AND ticket=?",(json.dumps(payload,ensure_ascii=False,allow_nan=False),time.time(),user_id,str(item['ticket'])))
HUB=ea_hub.Hub(connect,on_trade=hub_trade)
with connect() as db:
    db.executescript('''
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,nickname TEXT NOT NULL,avatar TEXT NOT NULL DEFAULT '',bio TEXT NOT NULL DEFAULT '',password TEXT NOT NULL,allow_follow INTEGER NOT NULL DEFAULT 1,share_data INTEGER NOT NULL DEFAULT 0,created REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS follows(follower TEXT NOT NULL REFERENCES users(id),target TEXT NOT NULL REFERENCES users(id),created REAL NOT NULL,PRIMARY KEY(follower,target),CHECK(follower<>target));
    CREATE TABLE IF NOT EXISTS mt5_links(user_id TEXT PRIMARY KEY REFERENCES users(id),token_hash TEXT UNIQUE,account_key TEXT,updated REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS snapshots(person TEXT PRIMARY KEY,payload TEXT NOT NULL,updated REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS trades(person TEXT NOT NULL,ticket TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(person,ticket));
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,person TEXT NOT NULL,event_key TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,created REAL NOT NULL,UNIQUE(person,event_key));
    CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,person TEXT NOT NULL,text TEXT NOT NULL,created REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS mt5_bindings(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),platform TEXT NOT NULL,expires REAL NOT NULL,used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS presence(user_id TEXT PRIMARY KEY,updated REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS social_notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,recipient TEXT NOT NULL,actor TEXT NOT NULL,created REAL NOT NULL,seen INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS registration_invite(id INTEGER PRIMARY KEY CHECK(id=1),code TEXT NOT NULL,updated REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS broker_clocks(person TEXT PRIMARY KEY,broker TEXT NOT NULL,offset INTEGER,observed_from REAL NOT NULL,observed_to REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_limits(key TEXT PRIMARY KEY,window REAL NOT NULL,attempts INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_follows_target ON follows(target);
    CREATE INDEX IF NOT EXISTS idx_events_person ON events(person,id);
    CREATE INDEX IF NOT EXISTS idx_messages_person ON messages(person,id);
    PRAGMA user_version=2;
    ''')
with connect() as db:
    db.execute('INSERT OR IGNORE INTO registration_invite VALUES(1,?,?)',(secrets.token_hex(6).upper(),time.time()))
    if 'onboarding_step' not in [r[1] for r in db.execute('PRAGMA table_info(users)')]:db.execute('ALTER TABLE users ADD COLUMN onboarding_step INTEGER NOT NULL DEFAULT 4')
with connect() as db:
    if 'share_reviews' not in [r[1] for r in db.execute('PRAGMA table_info(users)')]:db.execute('ALTER TABLE users ADD COLUMN share_reviews INTEGER NOT NULL DEFAULT 0')
    auth_security.initialize(db)
    journal.initialize(db)
    market.initialize(db)
    chart.initialize(db)
    if os.environ.get('EA_HUB_ENABLE','1')!='0':HUB.start()
    if not db.execute("SELECT 1 FROM security_config WHERE key='sessions-30days'").fetchone():
        db.execute('UPDATE sessions SET expires=? WHERE expires>?',(time.time()+2592000,time.time()))
        db.execute("INSERT INTO security_config VALUES('sessions-30days')")
class Error(Exception):
    def __init__(self,text,code=400):self.text,self.code=text,code
def digest(s):return hashlib.sha256(s.encode()).hexdigest()
def pw_hash(p):
    if not isinstance(p,str) or not 8<=len(p)<=128:raise Error('密码需为 8–128 个字符')
    salt=secrets.token_hex(16);return salt+':'+hashlib.pbkdf2_hmac('sha256',p.encode(),salt.encode(),310000).hex()
def pw_ok(p,stored):
    if not isinstance(p,str) or len(p)>128:return False
    salt,expected=stored.split(':');return hmac.compare_digest(expected,hashlib.pbkdf2_hmac('sha256',p.encode(),salt.encode(),310000).hex())
def public(u):return {**{k:u[k] for k in ('id','username','nickname','avatar','bio','allow_follow','share_data','share_reviews','onboarding_step')},'role':'admin' if u['username']==ADMIN_USERNAME else 'user'}
def visible(db,uid,target):
    return uid==target or bool(db.execute('SELECT 1 FROM follows JOIN users ON users.id=follows.target WHERE follower=? AND target=? AND share_data=1',(uid,target)).fetchone())
def numeric(v):
    if isinstance(v,bool) or not isinstance(v,(float,int)) or not math.isfinite(v):raise Error('数值格式不正确')
def validate(data):
    s=data.get('snapshot')
    if not isinstance(s,dict):raise Error('缺少账户快照')
    for f in ('balance','equity'):numeric(s.get(f))
    if not isinstance(s.get('currency','USD'),str) or not 1<=len(s.get('currency','USD'))<=8:raise Error('币种不正确')
    if 'online' in s and not isinstance(s['online'],bool):raise Error('在线状态不正确')
    ps,hs,es=s.get('positions',[]),s.get('history',[]),data.get('events',[])
    for rows,n in ((ps,500),(hs,500),(es,100)):
        if not isinstance(rows,list) or len(rows)>n:raise Error('同步数据格式不正确')
    seen=set()
    for p in ps+hs:
        if not isinstance(p,dict) or p.get('side') not in ('buy','sell') or not isinstance(p.get('symbol'),str) or not 1<=len(p['symbol'])<=80 or not isinstance(p.get('ticket'),(str,int)) or not 1<=len(str(p['ticket']))<=100:raise Error('交易字段不完整')
        for f in ('volume','open','profit'):numeric(p.get(f))
        if p['volume']<=0:raise Error('手数需大于零')
        for f in ('sl','tp','sl_profit','tp_profit','current'):
            if p.get(f) is not None:numeric(p[f])
    for p in ps:
        if str(p['ticket']) in seen:raise Error('持仓编号重复')
        seen.add(str(p['ticket']))
    for p in hs:
        for f in ('close','closed'):numeric(p.get(f))
        if not 0<=p['closed']<=time.time()+86400:raise Error('平仓时间不正确')
    for e in es:
        if not isinstance(e,dict) or e.get('kind') not in ('open','close','modify','pending') or not isinstance(e.get('key'),str) or not 1<=len(e['key'])<=160 or not isinstance(e.get('text'),str) or not 1<=len(e['text'])<=500:raise Error('事件字段不正确')
    s['positions']=ps;return s,hs,es
def decode_request(raw,path):
    text=raw.decode('utf-8')
    try:return json.loads(text)
    except json.JSONDecodeError:
        if path!='/api/snapshot':raise
        # Legacy EA cast datetime directly to a bare calendar string.
        pattern=r'("closed"\s*:\s*)(\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2})(?=\s*[,}])'
        def fix(m):return m[1]+str(int(datetime.strptime(m[2],'%Y.%m.%d %H:%M:%S').replace(tzinfo=timezone.utc).timestamp()))
        repaired,count=re.subn(pattern,fix,text)
        if not count:raise
        return json.loads(repaired)
def assistant_zip(platform,binding):
    base=ROOT/'web'/'assistant';config=json.dumps(binding,ensure_ascii=False).encode()
    if platform=='windows':
        binary=(base/'TongpinConnect.exe').read_bytes();ea=(ROOT/'web'/'TongpinSync.ex5').read_bytes()
        return binary+config+ea+struct.pack('<II8s',len(config),len(ea),b'TONGPIN4')
    image=(base/'TongpinConnect-template.dmg').read_bytes()
    marker=b'TONGPIN_BINDING_SLOT_V1'+b' '*(4096-len(b'TONGPIN_BINDING_SLOT_V1'))
    if image.count(marker)!=1 or len(config)>4096:raise Error('安装镜像暂时不可用，请稍后重试',503)
    return image.replace(marker,config+b' '*(4096-len(config)),1)

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*_):pass
    def reply(self,value,code=200,cookie=None):
        body=json.dumps(value,ensure_ascii=False,allow_nan=False).encode();self.send_response(code)
        for k,v in [('Content-Type','application/json; charset=utf-8'),('Cache-Control','no-store'),('Content-Length',str(len(body))),('X-Content-Type-Options','nosniff')]:self.send_header(k,v)
        if cookie:
            for value in (cookie if isinstance(cookie,list) else [cookie]):self.send_header('Set-Cookie',value)
        self.end_headers();self.wfile.write(body)
    def cookie(self,token='',age=0):return f'tongpin_session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={age}'+('; Secure' if SECURE else '')
    def user(self,db):
        c=SimpleCookie()
        try:c.load(self.headers.get('Cookie',''))
        except Exception:raise Error('请先登录',401)
        token=c.get('tongpin_session')
        u=db.execute('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE hash=? AND expires>?',(digest(token.value),time.time())).fetchone() if token else None
        if not u:raise Error('请先登录',401)
        return u
    def client_ip(self):
        return client_address.resolve_client_ip(self.client_address[0],self.headers,proxy_cidrs=os.environ.get('TRUSTED_PROXY_CIDRS',''),proxy_hosts=os.environ.get('TRUSTED_PROXY_HOSTS',''))
    def session(self,db,uid,cap=None):
        token=secrets.token_urlsafe(32);now=time.time();expires=min(now+2592000,cap) if cap is not None else now+2592000
        if expires<=now:raise Error('登录已到期，请重新登录',401)
        db.execute('DELETE FROM sessions WHERE expires<?',(now,));db.execute('INSERT INTO sessions VALUES(?,?,?)',(digest(token),uid,expires));return self.cookie(token,max(1,int(expires-now)))
    def do_GET(self):
        try:
            path=urlparse(self.path).path;q=parse_qs(urlparse(self.path).query)
            if path=='/api/login-challenge':
                with connect() as db:
                    if not auth_security.limit(db,'challenge:'+self.client_ip(),60,60):raise Error('请求过于频繁',429)
                    return self.reply(auth_security.challenge(db))
            if path=='/api/health':return self.reply({'ok':True,'version':'0.2','authentication':True})
            if path=='/api/mt5/status':
                auth=self.headers.get('Authorization','');token=auth[7:] if auth.startswith('Bearer ') else ''
                with connect() as db:
                    link=db.execute('SELECT user_id FROM mt5_links WHERE token_hash=?',(digest(token),)).fetchone() if token else None
                    if not link:raise Error('连接凭证已失效，请从网站重新下载助手',401)
                    snap=db.execute('SELECT * FROM snapshots WHERE person=?',(link['user_id'],)).fetchone()
                    online=bool(snap and time.time()-snap['updated']<=45 and json.loads(snap['payload']).get('online',True))
                    return self.reply({'online':online,'last_sync':snap['updated'] if snap else None})
            if path.startswith('/api/'):
                with connect() as db:
                    u=self.user(db);uid=u['id']
                    if path=='/api/chart/entry':
                        ticket=str(q.get('ticket',[''])[0]);target=q.get('person',[uid])[0];share=q.get('share',[''])[0]
                        row=None
                        if share:
                            if not share.isdigit():raise Error('作业不存在，或不是发给你的',404)
                            row=chart.share_row(db,uid,int(share));target=row['owner'];ticket=row['ticket']
                        owner=db.execute('SELECT * FROM users WHERE id=?',(target,)).fetchone()
                        if not owner:raise Error('用户不存在',404)
                        if not row and target!=uid and not (visible(db,uid,target) and owner['share_reviews']):raise Error('对方未分享复盘，或你没有交易数据权限',403)
                        review=journal.review(db,target,ticket,db.execute('SELECT * FROM broker_clocks WHERE person=?',(target,)).fetchone(),utc_trade)
                        note=journal.notes(db,target)['notes'].get(str(ticket)) if (target==uid or row or owner['share_reviews']) else None
                        return self.reply({'mode':'shared' if row else 'owner' if target==uid else 'viewer','owner':{'id':owner['id'],'name':owner['nickname'],'avatar':owner['avatar']},'read_only':target!=uid,'share':{'id':row['id'],'message':row['message'],'created':row['created'],'seen':bool(row['seen'])} if row else None,'review':review,'note':note,'chart':chart.state(db,target,str(ticket))})
                    if path=='/api/reviews/inbox':return self.reply(chart.inbox(db,uid))
                    if path=='/api/journal':
                        target=q.get('person',[uid])[0];owner=db.execute('SELECT * FROM users WHERE id=?',(target,)).fetchone();can=bool(owner and visible(db,uid,target) and (target==uid or owner['share_reviews']))
                        return self.reply({**(journal.notes(db,target) if can else {'categories':journal.DEFAULT_TAGS,'notes':{}}),'can_view':can,'editable':target==uid})
                    if path=='/api/trade-review':
                        target=q.get('person',[uid])[0];owner=db.execute('SELECT * FROM users WHERE id=?',(target,)).fetchone()
                        if not owner or not visible(db,uid,target) or (target!=uid and not owner['share_reviews']):raise Error('对方未分享复盘，或你没有交易数据权限',403)
                        return self.reply(journal.review(db,target,q.get('ticket',[''])[0],db.execute('SELECT * FROM broker_clocks WHERE person=?',(target,)).fetchone(),utc_trade))
                    if path=='/api/sessions':
                        cookies=SimpleCookie();cookies.load(self.headers.get('Cookie',''));current=digest(cookies['tongpin_session'].value)
                        rows=db.execute('SELECT hash,expires FROM sessions WHERE user_id=? AND expires>?',(uid,time.time())).fetchall()
                        mfa=db.execute('SELECT enabled FROM account_mfa WHERE user_id=?',(uid,)).fetchone()
                        return self.reply({'sessions':[{'id':r['hash'],'expires':r['expires'],'current':r['hash']==current} for r in rows],'mfa_enabled':bool(mfa and mfa[0])})
                    if path=='/api/admin/users':
                        if u['username']!=ADMIN_USERNAME:raise Error('仅管理员可访问',403)
                        rows=db.execute('SELECT id,username,nickname,created FROM users ORDER BY created').fetchall()
                        return self.reply({'users':[dict(r,role='admin' if r['username']==ADMIN_USERNAME else 'user') for r in rows]})
                    if path=='/api/invite':
                        if u['username']!=ADMIN_USERNAME:raise Error('只有管理员可以查看邀请码',403)
                        return self.reply(dict(db.execute('SELECT code,updated FROM registration_invite WHERE id=1').fetchone()))
                    if path=='/api/me':return self.reply({'user':public(u)})
                    if path=='/api/profile':
                        following=[public(r) for r in db.execute('SELECT users.* FROM follows JOIN users ON users.id=follows.target WHERE follower=? ORDER BY follows.created DESC',(uid,))]
                        followers=[public(r) for r in db.execute('SELECT users.* FROM follows JOIN users ON users.id=follows.follower WHERE target=? ORDER BY follows.created DESC',(uid,))]
                        link=db.execute('SELECT * FROM mt5_links WHERE user_id=?',(uid,)).fetchone();snap=db.execute('SELECT * FROM snapshots WHERE person=?',(uid,)).fetchone()
                        online=bool(link and link['token_hash'] and snap and time.time()-snap['updated']<=45 and json.loads(snap['payload']).get('online',True))
                        return self.reply({'user':public(u),'following':following,'followers':followers,'mt5':{'configured':bool(link and link['token_hash']),'bound':bool(link and link['account_key']),'online':online,'last_sync':snap['updated'] if snap else None}})
                    if path=='/api/users':
                        text=q.get('q',[''])[0].strip().lower()
                        if not 2<=len(text)<=40:raise Error('请输入至少 2 个字符查找用户')
                        pattern='%'+text.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')+'%'
                        rows=db.execute("SELECT * FROM users WHERE id<>? AND (username LIKE ? ESCAPE '\\' OR nickname LIKE ? ESCAPE '\\') LIMIT 20",(uid,pattern,pattern)).fetchall();targets={r[0] for r in db.execute('SELECT target FROM follows WHERE follower=?',(uid,))}
                        return self.reply({'users':[{**public(r),'followed':r['id'] in targets} for r in rows]})
                    if path=='/api/history':
                        target=q.get('person',[uid])[0]
                        if not visible(db,uid,target):raise Error('对方未开放交易数据，或你尚未关注对方',403)
                        return self.reply({'history':[utc_trade(json.loads(r[0]),db.execute('SELECT * FROM broker_clocks WHERE person=?',(target,)).fetchone()) for r in db.execute('SELECT payload FROM trades WHERE person=?',(target,))]})
                    if path=='/api/state':
                        db.execute('INSERT INTO presence VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET updated=excluded.updated',(uid,time.time()))
                        following=list(db.execute('SELECT users.* FROM follows JOIN users ON users.id=follows.target WHERE follower=? ORDER BY follows.created',(uid,)))
                        members=[];snapshots={};allowed=[]
                        for r in [u]+following:
                            can=r['id']==uid or bool(r['share_data']);members.append({'id':r['id'],'name':r['nickname'],'username':r['username'],'avatar':r['avatar'],'can_view':can})
                            if not can:continue
                            allowed.append(r['id']);snap=db.execute('SELECT * FROM snapshots WHERE person=?',(r['id'],)).fetchone()
                            live=HUB.live(r['id'])
                            if live:
                                # EA 直连服务器时，内存里的实时状态优先于落库快照。
                                live['history']=live.get('history') or [utc_trade(json.loads(t[0]),db.execute('SELECT * FROM broker_clocks WHERE person=?',(r['id'],)).fetchone()) for t in db.execute('SELECT payload FROM trades WHERE person=?',(r['id'],))]
                                snapshots[r['id']]={'data':live,'updated':time.time()}
                            elif snap:
                                payload=json.loads(snap['payload']);payload['history']=[utc_trade(json.loads(t[0]),db.execute('SELECT * FROM broker_clocks WHERE person=?',(r['id'],)).fetchone()) for t in db.execute('SELECT payload FROM trades WHERE person=?',(r['id'],))];snapshots[r['id']]={'data':payload,'updated':snap['updated']}
                        marks=','.join('?' for _ in allowed);events=[dict(r) for r in db.execute(f'SELECT * FROM events WHERE person IN ({marks}) ORDER BY id DESC LIMIT 100',allowed)]
                        mutual=[r[0] for r in db.execute('SELECT a.target FROM follows a JOIN follows b ON b.follower=a.target AND b.target=a.follower WHERE a.follower=?',(uid,))];chat=[uid]+mutual;cm=','.join('?' for _ in chat)
                        messages=[dict(r) for r in db.execute(f'SELECT * FROM messages WHERE person IN ({cm}) ORDER BY id DESC LIMIT 100',chat)][::-1];names={r['id']:r['nickname'] for r in [u]+following}
                        for m in messages:m['name']=names.get(m['person'],'')
                        return self.reply({'user':public(u),'members':members,'snapshots':snapshots,'events':events,'messages':messages,'now':time.time(),'online_users':[r[0] for r in db.execute('SELECT user_id FROM presence WHERE updated>? AND user_id IN (SELECT target FROM follows WHERE follower=?)',(time.time()-45,uid))],'notifications':[dict(r) for r in db.execute('SELECT n.id,n.actor,u.nickname FROM social_notifications n JOIN users u ON u.id=n.actor WHERE n.recipient=? AND n.seen=0 ORDER BY n.id DESC',(uid,))]})
                    raise Error('接口不存在',404)
            assets={'/':'index.html','/history':'history.html','/login':'auth.html','/register':'auth.html','/profile':'profile.html','/welcome':'welcome.html','/downloads/TongpinSync.mq5':'TongpinSync.mq5'}
            for f in ('api.js','app.js','history.js','auth.js','login-security.js','login-security.css','registration.js','profile.js','style.css','favicon.svg','welcome.js','avatars.js','assistant.js','journal-ui.js'):assets['/'+f]=f
            if re.fullmatch(r'/avatars/avatar(?:[1-9]|1[0-2])\.svg',path):assets[path]=path.lstrip('/')
            if path in ('/chart','/chart/'):
                page=ROOT/'web'/'chart'/'index.html'
                if not page.is_file():raise Error('图表页尚未构建，请先执行 web/chart-src 的 npm run build',503)
                body=page.read_bytes()
                self.send_response(200)
                # Vela 会在页面里注入 <style> 元素，这张页面单独放开内联样式；
                # 静态资源从 jsDelivr 取（国内到新加坡直连太慢），脚本仍只允许同源 + 这个 CDN。
                for k,v in [('Content-Type','text/html; charset=utf-8'),('Cache-Control','no-store'),('Content-Length',str(len(body))),('X-Content-Type-Options','nosniff'),('Content-Security-Policy',"default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: blob:; font-src 'self' data: https://cdn.jsdelivr.net; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")]:self.send_header(k,v)
                self.end_headers();self.wfile.write(body);return
            if path.startswith('/chart/assets/'):
                base=(ROOT/'web'/'chart').resolve();file=(base/path[len('/chart/'):]).resolve()
                if base not in file.parents or not file.is_file():raise Error('页面不存在',404)
                body=file.read_bytes();suffix=file.suffix.lower()
                mime='application/javascript' if suffix=='.js' else 'text/css' if suffix=='.css' else 'font/woff2' if suffix=='.woff2' else 'image/svg+xml' if suffix=='.svg' else 'application/octet-stream'
                etag='"'+hashlib.sha256(body).hexdigest()[:32]+'"'
                self.send_response(304 if self.headers.get('If-None-Match')==etag else 200)
                for k,v in [('ETag',etag),('Cache-Control','public, max-age=31536000, immutable'),('X-Content-Type-Options','nosniff')]:self.send_header(k,v)
                if self.headers.get('If-None-Match')!=etag:self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(body)))
                self.end_headers()
                if self.headers.get('If-None-Match')!=etag:self.wfile.write(body)
                return
            if path in ('/guides/navigator.png','/guides/expert.png','/guides/webrequest.png','/guides/assistant.png','/guides/mac-security.png'):assets[path]=path.lstrip('/')
            if path not in assets:raise Error('页面不存在',404)
            f=assets[path];body=(ROOT/'web'/f).read_bytes();mime='text/html' if f.endswith('.html') else 'application/javascript' if f.endswith('.js') else 'text/css' if f.endswith('.css') else 'image/svg+xml' if f.endswith('.svg') else 'image/png' if f.endswith('.png') else 'text/plain'
            cache='no-store';etag=None
            if f=='avatars.js':body=('window.avatarVersions='+json.dumps(AVATAR_VERSIONS)+';\n').encode()+body
            if path.startswith('/avatars/'):
                version=AVATAR_VERSIONS[Path(f).stem];etag='"'+hashlib.sha256(body).hexdigest()+'"'
                cache='public, max-age=31536000, immutable' if q.get('v',[''])[0]==version else 'public, max-age=0, must-revalidate'
                if self.headers.get('If-None-Match')==etag:
                    self.send_response(304);self.send_header('Cache-Control',cache);self.send_header('ETag',etag);self.end_headers();return
            self.send_response(200)
            if etag:self.send_header('ETag',etag)
            for k,v in [('Content-Type',mime+'; charset=utf-8'),('Cache-Control',cache),('Content-Length',str(len(body))),('X-Content-Type-Options','nosniff'),('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")]:self.send_header(k,v)
            self.end_headers();self.wfile.write(body)
        except journal.JournalError as e:self.reply({'error':e.text},e.code)
        except chart.ChartError as e:self.reply({'error':e.text},e.code)
        except Error as e:self.reply({'error':e.text},e.code)
        except Exception:self.reply({'error':'服务暂时不可用'},500)
    def do_POST(self):
        try:
            origin=self.headers.get('Origin');host=self.headers.get('Host','')
            if self.headers.get('Sec-Fetch-Site')=='cross-site' or (origin and origin.rstrip('/') not in {PUBLIC_ORIGIN,'http://'+host,'https://'+host}):raise Error('请求来源不正确',403)
            if 'application/json' not in self.headers.get('Content-Type',''):raise Error('请使用 JSON 请求',415)
            length=int(self.headers.get('Content-Length','0'))
            if not 1<=length<=(1048576 if urlparse(self.path).path=='/api/chart/state' else 2097152 if urlparse(self.path).path=='/api/mt5/review' else 524288):raise Error('请求大小不正确')
            data=decode_request(self.rfile.read(length),urlparse(self.path).path)
            if not isinstance(data,dict):raise Error('数据格式不正确')
            path=urlparse(self.path).path;now=time.time();cookie=None;trusted_cookie=None
            with connect() as db:
                if path in ('/api/login','/api/login/verify'):
                    status,result,login_cookie=auth_security.progressive_login(self,db,data,path,pw_ok)
                    return self.reply(result,status,cookie=login_cookie)
                if path == '/api/register':
                    account=str(data.get('username','')).strip().lower()[:64]
                    if not auth_security.limit(db,'account:'+account,10,600) or not auth_security.limit(db,'ip:'+self.client_ip(),150,600):raise Error('尝试过于频繁，请10分钟后重试',429)
                    db.commit()  # Persist registration limits even when validation fails.
                    if not auth_security.verify_challenge(db,data):raise Error('验证码不正确或已过期，请刷新',400)
                    username=str(data.get('username','')).strip().lower()
                    if not re.fullmatch('[a-z0-9_]{2,24}',username):raise Error('用户名需为 2–24 位字母、数字或下划线')
                    if path=='/api/register':
                        db.execute('BEGIN IMMEDIATE')
                        invite=data.get('invite_code','')
                        expected=db.execute('SELECT code FROM registration_invite WHERE id=1').fetchone()[0]
                        if not db.execute("SELECT 1 FROM users WHERE username=?",(ADMIN_USERNAME,)).fetchone() or not isinstance(invite,str) or not hmac.compare_digest(invite.strip().upper(),expected):raise Error('邀请码不正确或已失效，请向管理员获取最新邀请码',403)
                        nickname=str(data.get('nickname','')).strip()
                        if not 1<=len(nickname)<=30:raise Error('昵称需为 1–30 个字符')
                        pw=pw_hash(data.get('password'));uid=secrets.token_hex(12)
                        if db.execute('SELECT 1 FROM users WHERE username=?',(username,)).fetchone():raise Error('该用户名已注册',409)
                        db.execute('INSERT INTO users(id,username,nickname,password,created,share_data,onboarding_step) VALUES(?,?,?,?,?,1,0)',(uid,username,nickname,pw,now))
                        db.execute('UPDATE registration_invite SET code=?,updated=? WHERE id=1',(secrets.token_hex(6).upper(),now))
                    else:
                        u=db.execute('SELECT * FROM users WHERE username=?',(username,)).fetchone()
                        if not u or not pw_ok(data.get('password'),u['password']):raise Error('用户名或密码不正确',401)
                        uid=u['id']
                        browser_cookies=SimpleCookie();browser_cookies.load(self.headers.get('Cookie',''))
                        device=browser_cookies.get(auth_security.DEVICE_COOKIE)
                        already_trusted=auth_security.trusted(db,uid,device.value if device else '',self.client_ip(),self.headers.get('User-Agent',''))
                        if not already_trusted and not auth_security.verify_otp(db,uid,data.get('otp','')):raise Error('请输入有效的验证器动态码',401)
                        mfa=db.execute('SELECT enabled FROM account_mfa WHERE user_id=?',(uid,)).fetchone()
                        if mfa and mfa[0] and not already_trusted and data.get('remember_device') is True:
                            device_token=auth_security.trust(db,uid,self.client_ip(),self.headers.get('User-Agent',''))
                            trusted_cookie=auth_security.device_cookie(device_token) 
                        db.execute('DELETE FROM security_limits WHERE key=?',('account:'+account,))
                    cookie=self.session(db,uid)
                    if trusted_cookie:cookie=[cookie,trusted_cookie]
                    result={'ok':True,'user':public(db.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone())}
                elif path=='/api/mt5/assistant':
                    self.user(db)
                    raise Error('独立源码版请下载MQ5源码手动安装采集程序',501)
                    u=self.user(db);platform=data.get('platform')
                    if platform not in ('mac','windows'):raise Error('请选择 Mac 或 Windows')
                    code=secrets.token_urlsafe(36);expires=now+1800
                    binding={'website':PUBLIC_ORIGIN or 'https://your-domain.example','code':code,'username':u['username'],'expires':expires}
                    body=assistant_zip(platform,binding)
                    db.execute('DELETE FROM mt5_bindings WHERE expires<?',(now,))
                    db.execute('INSERT INTO mt5_bindings VALUES(?,?,?,?,0)',(digest(code),u['id'],platform,expires));db.commit()
                    self.send_response(200)
                    extension='dmg' if platform=='mac' else 'exe'
                    mimetype='application/x-apple-diskimage' if platform=='mac' else 'application/vnd.microsoft.portable-executable'
                    for k,v in [('Content-Type',mimetype),('Content-Length',str(len(body))),('Cache-Control','no-store'),('Content-Disposition','attachment; filename="TongpinConnect.'+extension+'"; filename*=UTF-8\'\'%E5%90%8C%E9%A2%91%E8%BF%9E%E6%8E%A5%E5%8A%A9%E6%89%8B.'+extension),('X-Content-Type-Options','nosniff')]:self.send_header(k,v)
                    self.end_headers();self.wfile.write(body);return
                elif path=='/api/mt5/redeem':
                    code=data.get('code');platform=data.get('platform')
                    if not isinstance(code,str) or not 20<=len(code)<=100:raise Error('绑定码无效',401)
                    db.execute('BEGIN IMMEDIATE')
                    ticket=db.execute('SELECT * FROM mt5_bindings WHERE hash=?',(digest(code),)).fetchone()
                    if not ticket or ticket['used'] or ticket['expires']<now or ticket['platform']!=platform:raise Error('连接包已过期或使用，请回网站重新下载',401)
                    token=secrets.token_urlsafe(36)
                    db.execute('INSERT INTO mt5_links(user_id,token_hash,updated) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,updated=excluded.updated',(ticket['user_id'],digest(token),now))
                    db.execute('UPDATE mt5_bindings SET used=1 WHERE hash=?',(digest(code),))
                    result={'ok':True,'token':token}
                elif path=='/api/mt5/review':
                    auth=self.headers.get('Authorization','');token=auth[7:] if auth.startswith('Bearer ') else '';link=db.execute('SELECT * FROM mt5_links WHERE token_hash=?',(digest(token),)).fetchone() if token else None
                    if not link:raise Error('连接码无效或已撤销',401)
                    result=journal.receive(db,link['user_id'],data)
                elif path=='/api/snapshot':
                    auth=self.headers.get('Authorization','');token=auth[7:] if auth.startswith('Bearer ') else '';link=db.execute('SELECT * FROM mt5_links WHERE token_hash=?',(digest(token),)).fetchone() if token else None
                    if not link:raise Error('连接码无效或已撤销',401)
                    s,hs,es=validate(data);uid=link['user_id'];account=str(s.get('account','')).strip();broker=str(s.get('broker','')).strip()
                    if not account or not broker or len(account)>80 or len(broker)>160:raise Error('请同步 MT5 账户及券商标识')
                    key=digest(broker+':'+account)
                    if link['account_key'] and link['account_key']!=key:raise Error('此账号已绑定固定 MT5 账户，暂不支持切换交易账户',409)
                    clock=record_clock(db,uid,broker,s,now)
                    # 采集端可以两种时间口径：券商墙钟（TongpinSync.mq5 原来的做法），
                    # 或者已经换算好的 UTC + 券商时间（WebBridge 这类本地桥）。
                    # 后者不再走“只认当前测量窗口”的校准，历史补传也能落库。
                    def normalize(item):
                        if item.get('time_basis')=='utc' and isinstance(item.get('closed_server'),(int,float)) and item.get('closed') is not None:
                            return {**item,'time_verified':True,'time_estimated':False}
                        return utc_trade({**{k:v for k,v in item.items() if k not in ('time_basis','time_verified')},'closed_server':item['closed']},clock)
                    hs=[normalize(t) for t in hs]
                    db.execute('UPDATE mt5_links SET account_key=?,updated=? WHERE user_id=?',(key,now,uid));s={k:s[k] for k in ('balance','equity','currency','online','positions') if k in s};s['history']=[]
                    db.execute('INSERT INTO snapshots VALUES(?,?,?) ON CONFLICT(person) DO UPDATE SET payload=excluded.payload,updated=excluded.updated',(uid,json.dumps(s,allow_nan=False),now))
                    for t in hs:db.execute('INSERT INTO trades VALUES(?,?,?) ON CONFLICT(person,ticket) DO UPDATE SET payload=excluded.payload',(uid,str(t['ticket']),json.dumps(t,allow_nan=False)))
                    for e in es:db.execute('INSERT OR IGNORE INTO events(person,event_key,kind,text,created) VALUES(?,?,?,?,?)',(uid,e['key'],e['kind'],e['text'],now))
                    journal.queue_missing(db,uid)
                    result={'ok':True,'review_ticket':journal.job(db,uid)}
                else:
                    u=self.user(db);uid=u['id'];result={'ok':True}
                    if path=='/api/journal':result=journal.save(db,uid,data)
                    elif path=='/api/chart/state':
                        ticket=str(data.get('ticket',''));journal.trade(db,uid,ticket)
                        result=chart.clear_state(db,uid,ticket) if data.get('clear') is True else chart.save_state(db,uid,ticket,data.get('state'))
                    elif path=='/api/reviews/share':
                        ticket=str(data.get('ticket',''));journal.trade(db,uid,ticket)
                        result=chart.share(db,uid,ticket,data.get('recipients'),data.get('message',''))
                    elif path=='/api/reviews/share/seen':
                        share_id=data.get('id')
                        if not isinstance(share_id,int) or isinstance(share_id,bool):raise Error('作业编号不正确')
                        result=chart.mark_seen(db,uid,share_id)
                    elif path=='/api/trade-review/request':
                        target=data.get('person',uid);owner=db.execute('SELECT * FROM users WHERE id=?',(target,)).fetchone()
                        if not owner or not visible(db,uid,target) or (target!=uid and not owner['share_reviews']):raise Error('对方未分享复盘，或你没有交易数据权限',403)
                        result=journal.request(db,target,data)
                    elif path=='/api/trusted/revoke':
                        db.execute('DELETE FROM trusted_devices WHERE user_id=?',(uid,));result={'ok':True}
                    elif path=='/api/sessions/revoke':
                        db.execute('DELETE FROM sessions WHERE hash=? AND user_id=?',(str(data.get('session_id','')),uid));result={'ok':True}
                    elif path in ('/api/mfa/setup','/api/mfa/enable'):
                        if u['username']!=ADMIN_USERNAME:raise Error('仅管理员可设置验证器',403)
                        if not auth_security.limit(db,'mfa:'+uid,8,600):raise Error('操作过于频繁',429)
                        if not pw_ok(data.get('current_password'),u['password']):raise Error('当前密码不正确',403)
                        if path=='/api/mfa/setup':
                            existing=db.execute('SELECT enabled FROM account_mfa WHERE user_id=?',(uid,)).fetchone()
                            if existing and existing[0]:raise Error('验证器已经启用',409)
                            secret=auth_security.base64.b32encode(secrets.token_bytes(20)).decode().rstrip('=')
                            db.execute('INSERT OR REPLACE INTO account_mfa VALUES(?,?,0,-1)',(uid,secret))
                            result={'secret':secret,'uri':'otpauth://totp/Leo:'+u['username']+'?secret='+secret+'&issuer=Leo'}
                        else:
                            row=db.execute('SELECT secret,enabled FROM account_mfa WHERE user_id=?',(uid,)).fetchone()
                            if not row or row[1]:raise Error('请先开始绑定',400)
                            step=int(time.time()/30)
                            if not any(hmac.compare_digest(auth_security.totp(row[0],n),str(data.get('otp',''))) for n in (step-1,step,step+1)):raise Error('动态码不正确',400)
                            db.execute('UPDATE account_mfa SET enabled=1,last_step=? WHERE user_id=?',(step,uid))
                            own=SimpleCookie();own.load(self.headers.get('Cookie',''));db.execute('DELETE FROM sessions WHERE user_id=? AND hash<>?',(uid,digest(own['tongpin_session'].value)))
                            codes=[secrets.token_hex(6) for _ in range(8)]
                            db.executemany('INSERT INTO mfa_recovery VALUES(?,?)',[(uid,hashlib.sha256((uid+code).encode()).hexdigest()) for code in codes])
                            result={'ok':True,'recovery_codes':codes}
                    elif path=='/api/logout':db.execute('DELETE FROM sessions WHERE user_id=?',(uid,));cookie=self.cookie()
                    elif path=='/api/profile':
                        nick,bio,avatar=(str(data.get(k,'')).strip() for k in ('nickname','bio','avatar'))
                        if not 1<=len(nick)<=30 or len(bio)>300 or (len(avatar)>4 and avatar not in ['avatar'+str(i) for i in range(1,13)]):raise Error('请检查昵称、简介和头像字符长度')
                        db.execute('UPDATE users SET nickname=?,bio=?,avatar=? WHERE id=?',(nick,bio,avatar,uid))
                    elif path=='/api/onboarding':
                        step=data.get('step')
                        if not isinstance(step,int) or not 0<=step<=4:raise Error('步骤不正确')
                        db.execute('UPDATE users SET onboarding_step=? WHERE id=?',(step,uid))
                    elif path=='/api/settings':
                        if 'share_reviews' in data and not isinstance(data['share_reviews'],bool):raise Error('复盘开关值不正确')
                        if not isinstance(data.get('allow_follow'),bool) or not isinstance(data.get('share_data'),bool):raise Error('开关值不正确')
                        db.execute('UPDATE users SET allow_follow=?,share_data=? WHERE id=?',(data['allow_follow'],data['share_data'],uid))
                        if 'share_reviews' in data:db.execute('UPDATE users SET share_reviews=? WHERE id=?',(data['share_reviews'],uid))
                    elif path=='/api/notifications/read':
                        db.execute('UPDATE social_notifications SET seen=1 WHERE recipient=?',(uid,))
                    elif path=='/api/invite/rotate':
                        if u['username']!=ADMIN_USERNAME:raise Error('只有管理员可以更换邀请码',403)
                        code=secrets.token_hex(6).upper();db.execute('UPDATE registration_invite SET code=?,updated=? WHERE id=1',(code,now));result['code']=code
                    elif path=='/api/password':
                        if not pw_ok(data.get('current_password'),u['password']):raise Error('当前密码不正确',403)
                        pw=pw_hash(data.get('new_password'));db.execute('DELETE FROM trusted_devices WHERE user_id=?',(uid,));db.execute('DELETE FROM login_pending WHERE user_id=?',(uid,));db.execute('UPDATE users SET password=? WHERE id=?',(pw,uid));db.execute('DELETE FROM sessions WHERE user_id=?',(uid,));cookie=self.session(db,uid)
                    elif path in ('/api/follow','/api/unfollow'):
                        target=data.get('target');row=db.execute('SELECT * FROM users WHERE id=?',(target,)).fetchone() if isinstance(target,str) else None
                        if not row or target==uid:raise Error('关注对象不正确')
                        if path=='/api/unfollow':db.execute('DELETE FROM follows WHERE follower=? AND target=?',(uid,target))
                        else:
                            if not row['allow_follow'] and not db.execute('SELECT 1 FROM follows WHERE follower=? AND target=?',(uid,target)).fetchone():raise Error('对方暂不接受新关注',403)
                            added=db.execute('INSERT OR IGNORE INTO follows VALUES(?,?,?)',(uid,target,now)).rowcount
                            if added:db.execute('INSERT INTO social_notifications(recipient,actor,created) VALUES(?,?,?)',(target,uid,now))
                    elif path=='/api/mt5/token':
                        token=secrets.token_urlsafe(36);db.execute('INSERT INTO mt5_links(user_id,token_hash,updated) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,updated=excluded.updated',(uid,digest(token),now));result['token']=token
                    elif path=='/api/mt5/unlink':
                        db.execute('DELETE FROM mt5_bindings WHERE user_id=?',(uid,))
                        db.execute('UPDATE mt5_links SET token_hash=NULL,updated=? WHERE user_id=?',(now,uid));snap=db.execute('SELECT payload FROM snapshots WHERE person=?',(uid,)).fetchone()
                        if snap:
                            s=json.loads(snap['payload']);s['online']=False;db.execute('UPDATE snapshots SET payload=? WHERE person=?',(json.dumps(s),uid))
                    elif path=='/api/messages':
                        text=str(data.get('text','')).strip()
                        if not 1<=len(text)<=1000:raise Error('留言需为 1–1000 个字')
                        db.execute('INSERT INTO messages(person,text,created) VALUES(?,?,?)',(uid,text,now))
                    else:raise Error('接口不存在',404)
            self.reply(result,cookie=cookie)
        except journal.JournalError as e:self.reply({'error':e.text},e.code)
        except chart.ChartError as e:self.reply({'error':e.text},e.code)
        except Error as e:
            if urlparse(self.path).path=='/api/snapshot':print('Snapshot rejected:',e.code,e.text,flush=True)
            self.reply({'error':e.text},e.code)
        except sqlite3.IntegrityError:self.reply({'error':'记录已存在，请刷新重试'},409)
        except (ValueError,TypeError,KeyError) as e:
            if urlparse(self.path).path=='/api/snapshot':print('Snapshot parse rejected:',type(e).__name__,flush=True)
            self.reply({'error':'请求数据不正确'},400)
        except Exception:self.reply({'error':'服务暂时不可用'},500)
if __name__=='__main__':
    host=os.environ.get('HOST','127.0.0.1');port=int(os.environ.get('PORT','18886'));print(f'Tongpin v2: http://{host}:{port}',flush=True);ThreadingHTTPServer((host,port),Handler).serve_forever()

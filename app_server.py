"""Authenticated social board. No third-party runtime dependencies."""
import ipaddress
import client_address
import auth_security
import device_pairing
import bars
import chart
import dm
import groups
import live
import local_ea
import sync_history
import ea_hub
import journal
import review_notes
import market
import market_symbols
import bar_sync_jobs
from trade_time import utc_trade, record_clock
from datetime import datetime, timezone
import hashlib, hmac, json, math, os, re, secrets, sqlite3, time, io, zipfile, struct
from pathlib import Path
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from app_config import ADMIN_USERNAME,ROOT,DATA,DB,PUBLIC_ORIGIN,SECURE
from accounts import digest,pw_hash,pw_ok,invite_normalize,invite_hash,new_invite_code,is_admin,public
from social import friend_pair,friend_edge,edge_state,are_friends,can_chat,relation,friends_of,blocked_of,friend_requests,visible,review_visible
from review_service import history_for,history_snapshot,review_market_source,review_bars
from http_errors import Error
import database,trade_store,observability
from routes import reviews as review_routes,market as market_routes,admin as admin_routes
from migrations import migrate as migrate_database
AVATAR_VERSIONS={p.stem:hashlib.sha256(p.read_bytes()).hexdigest()[:16] for p in (ROOT/'web'/'avatars').glob('avatar*.svg')}

def initialize_database():
 return migrate_database(DB)

def connect():
 return database.connect(DB)
def hub_trade(user_id,item,offset):
    """EA 直连 hub 时平仓：落交易记录，并从 hub 缓存的 K 线拼复盘图。"""
    with connect() as db:
        trade={k:v for k,v in item.items() if k not in ('time_basis','time_verified')}
        trade['time_basis']='utc';trade['time_verified']=True
        trade_store.store_legacy(db,user_id,trade,'ea-hub')
        if db.execute('SELECT 1 FROM trades WHERE person=? AND ticket=?',(user_id,str(item['ticket']))).fetchone():return
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
LIVE=live.LiveStore()
FORMING=live.FormingBars()


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


class Handler(BaseHTTPRequestHandler):
    forming=FORMING
    def send_response(self,code,message=None):
        self.response_status=code
        return super().send_response(code,message)
    def log_message(self,*_):pass
    def redirect(self,location,code=302):
        self.send_response(code);self.send_header('Location',location);self.send_header('Cache-Control','no-store');self.send_header('Content-Length','0');self.end_headers()
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
        if u['locked']:
            db.execute('DELETE FROM sessions WHERE user_id=?',(u['id'],))
            raise Error('账号已被停用，请联系管理员',403)
        return u
    def client_ip(self):
        # 空串要当成“没配置”，否则会绕过 client_address 里的 127.0.0.1/32 默认值，
        # 让所有请求都变成 127.0.0.1（限流桶全局共享）。
        return client_address.resolve_client_ip(self.client_address[0],self.headers,proxy_cidrs=os.environ.get('TRUSTED_PROXY_CIDRS') or None,proxy_hosts=os.environ.get('TRUSTED_PROXY_HOSTS') or None)
    def session(self,db,uid,cap=None):
        token=secrets.token_urlsafe(32);now=time.time();expires=min(now+2592000,cap) if cap is not None else now+2592000
        if expires<=now:raise Error('登录已到期，请重新登录',401)
        db.execute('DELETE FROM sessions WHERE expires<?',(now,));db.execute('INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)',(digest(token),uid,expires));return self.cookie(token,max(1,int(expires-now)))
    def sudo_until(self,db):
        c=SimpleCookie()
        try:c.load(self.headers.get('Cookie',''))
        except Exception:return 0
        token=c.get('tongpin_session')
        if not token:return 0
        row=db.execute('SELECT sudo_until FROM sessions WHERE hash=?',(digest(token.value),)).fetchone()
        return float(row['sudo_until'] or 0) if row else 0
    def require_admin(self,u,db,sudo=True):
        if not is_admin(u):raise Error('页面不存在',404)
        if sudo and self.sudo_until(db)<time.time():raise Error('请先验证管理员密码',403)
    def link_user(self,db):
        """Bearer 连接码 → mt5_links 行。停用账号与网页会话一样拒绝，数据不落库。"""
        auth=self.headers.get('Authorization','');token=auth[7:] if auth.startswith('Bearer ') else ''
        link=db.execute('SELECT * FROM mt5_links WHERE token_hash=?',(digest(token),)).fetchone() if token else None
        if not link:raise Error('连接码无效或已撤销',401)
        owner=db.execute('SELECT locked FROM users WHERE id=?',(link['user_id'],)).fetchone()
        if not owner or owner['locked']:raise Error('账号已被停用，请联系管理员',403)
        return link

    @observability.http('http.get')
    def do_GET(self):
        try:
            path=urlparse(self.path).path;q=parse_qs(urlparse(self.path).query)
            if path=='/api/mt5/device/status':
                with connect() as db:return self.reply(device_pairing.status(db,self.user(db)))
            if path=='/api/login-challenge':
                with connect() as db:
                    if not auth_security.limit(db,'challenge:'+self.client_ip(),60,60):raise Error('请求过于频繁',429)
                    return self.reply(auth_security.challenge(db))
            if path=='/api/health':return self.reply({'ok':True,'version':'0.2','authentication':True})
            packages={'/downloads/syncnote.zip':'syncnote','/downloads/synctrade.zip':'synctrade'}
            if path in packages:
                try:body=local_ea.source_package(ROOT,packages[path])
                except (OSError,ValueError):raise Error('本机 EA 源码包尚未就绪',503)
                self.send_response(200)
                for k,v in [('Content-Type','application/zip'),('Content-Disposition','attachment; filename="'+path.rsplit('/',1)[-1]+'"'),('Content-Length',str(len(body))),('Cache-Control','no-store'),('X-Content-Type-Options','nosniff')]:self.send_header(k,v)
                self.end_headers();self.wfile.write(body);return
            if path=='/api/mt5/status':
                with connect() as db:
                    link=self.link_user(db)
                    snap=db.execute('SELECT * FROM snapshots WHERE person=?',(link['user_id'],)).fetchone()
                    last_history=db.execute('SELECT max(updated) FROM mt5_history_batches WHERE person=?',(link['user_id'],)).fetchone()[0]
                    online=bool((snap and time.time()-snap['updated']<=45 and json.loads(snap['payload']).get('online',True)) or (last_history and time.time()-last_history<=90))
                    return self.reply({'online':online,'last_sync':max(snap['updated'] if snap else 0,last_history or 0) or None,'mode':'history' if last_history else 'snapshot'})
            if path.startswith('/api/'):
                with connect() as db:
                    u=self.user(db);uid=u['id']
                    endpoint=review_routes.GET.get(path) or market_routes.GET.get(path) or admin_routes.GET.get(path)
                    if endpoint:return endpoint(self,db,u,q)
                    if path=='/api/mt5/history-job':return self.reply({'ok':True,'website_user_id':uid,'review_job':sync_history.review_job(db,uid)})
                    if path=='/api/live':
                        try:limit=int(q.get('limit',['500'])[0])
                        except ValueError:limit=500
                        live_payload=LIVE.read(uid,max(50,min(3000,limit))) or {'bars':{},'tick':None,'updated':None,'age':None}
                        # 实时 K 线也是券商墙钟，同样换成 UTC，和复盘/历史的坐标一致。
                        feed=bars.feed_of(db,uid)
                        shift=bars.source_offset(db,feed['source']) if feed else int(live_payload.get('offset') or 0)
                        if shift:
                            for rows in (live_payload.get('bars') or {}).values():
                                for row in rows:
                                    if row and isinstance(row[0],(int,float)):row[0]=int(row[0])-shift
                            live_payload['offset_sec']=shift
                        return self.reply(live_payload)
                    if path=='/api/groups':
                        return self.reply({'groups':groups.groups_of(db,uid)})
                    if path=='/api/groups/messages':
                        gid=str(q.get('group',[''])[0])
                        try:
                            limit=int(q.get('limit',['100'])[0])
                        except ValueError:
                            limit=100
                        return self.reply({'messages':groups.messages(db,gid,uid,limit)})
                    if path=='/api/dm/threads':
                        allowed={r['id'] for r in friends_of(db,uid) if can_chat(db,uid,r['id'])}
                        return self.reply({'threads':dm.threads(db,uid,allowed),'unread':dm.total_unread(db,uid,allowed)})
                    if path=='/api/dm':
                        peer=str(q.get('with',[''])[0])
                        if not peer or not are_friends(db,uid,peer):raise Error('你们还不是好友',403)
                        owner=db.execute('SELECT id,nickname,avatar FROM users WHERE id=?',(peer,)).fetchone()
                        if not owner:raise Error('用户不存在',404)
                        return self.reply({'peer':{'id':owner['id'],'nickname':owner['nickname'],'avatar':owner['avatar']},'messages':dm.thread(db,uid,peer)})
                    if path=='/api/groups/members':
                        return self.reply({'members':groups.members(db,str(q.get('group',[''])[0]),uid)})
                    if path=='/api/sessions':
                        cookies=SimpleCookie();cookies.load(self.headers.get('Cookie',''));current=digest(cookies['tongpin_session'].value)
                        rows=db.execute('SELECT hash,expires FROM sessions WHERE user_id=? AND expires>?',(uid,time.time())).fetchall()
                        mfa=db.execute('SELECT enabled FROM account_mfa WHERE user_id=?',(uid,)).fetchone()
                        return self.reply({'sessions':[{'id':r['hash'],'expires':r['expires'],'current':r['hash']==current} for r in rows],'mfa_enabled':bool(mfa and mfa[0])})
                    if path=='/api/me':return self.reply({'user':public(u)})
                    if path=='/api/profile':
                        # following / followers 保留旧字段名给老页面用，语义统一成「好友」。
                        incoming,outgoing=friend_requests(db,uid)
                        following=[public(r) for r in friends_of(db,uid)]
                        followers=following
                        link=db.execute('SELECT * FROM mt5_links WHERE user_id=?',(uid,)).fetchone();snap=db.execute('SELECT * FROM snapshots WHERE person=?',(uid,)).fetchone()
                        last_history=db.execute('SELECT max(updated) FROM mt5_history_batches WHERE person=?',(uid,)).fetchone()[0]
                        configured=bool(link and (link['token_hash'] or link['account_key']))
                        online=bool(configured and ((snap and time.time()-snap['updated']<=45 and json.loads(snap['payload']).get('online',True)) or (last_history and time.time()-last_history<=90)))
                        return self.reply({'user':public(u),'following':following,'followers':followers,'friends':[{**person,'can_chat':can_chat(db,uid,person['id'])} for person in following],'incoming':[public(r) for r in incoming],'outgoing':[public(r) for r in outgoing],'blocked':[public(r) for r in blocked_of(db,uid)],'mt5':{'configured':configured,'bound':bool(link and link['account_key']),'online':online,'last_sync':max(snap['updated'] if snap else 0,last_history or 0) or None,'mode':'history' if last_history else 'snapshot'}})
                    if path=='/api/users':
                        text=q.get('q',[''])[0].strip().lower()
                        if not 2<=len(text)<=40:raise Error('请输入至少 2 个字符查找用户')
                        pattern='%'+text.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')+'%'
                        rows=db.execute("SELECT * FROM users WHERE id<>? AND (username LIKE ? ESCAPE '\\' OR nickname LIKE ? ESCAPE '\\') LIMIT 20",(uid,pattern,pattern)).fetchall()
                        return self.reply({'users':[{**public(r),'relation':relation(db,uid,r['id'])} for r in rows]})
                    if path=='/api/history':
                        target=q.get('person',[uid])[0]
                        if not visible(db,uid,target):raise Error('对方未开放交易数据，或你们还不是好友',403)
                        return self.reply({'history':history_for(db,target)})
                    if path=='/api/state':
                        db.execute('INSERT INTO presence VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET updated=excluded.updated',(uid,time.time()))
                        following=[r for r in friends_of(db,uid) if can_chat(db,uid,r['id'])]
                        members=[];snapshots={};allowed=[]
                        for r in [u]+following:
                            can=r['id']==uid or bool(r['share_data']);can_review=can and (r['id']==uid or bool(r['share_reviews']))
                            members.append({'id':r['id'],'name':r['nickname'],'username':r['username'],'avatar':r['avatar'],'can_view':can,'can_review':can_review,'reviewed':journal.reviewed(db,r['id']) if can else []})
                            if not can:continue
                            allowed.append(r['id'])
                            snapshot=history_snapshot(db,r['id'],HUB.live(r['id']))
                            if snapshot:snapshots[r['id']]=snapshot
                        marks=','.join('?' for _ in allowed);events=[dict(r) for r in db.execute(f'SELECT * FROM events WHERE person IN ({marks}) ORDER BY id DESC LIMIT 100',allowed)]
                        mutual=[r['id'] for r in following];chat=[uid]+mutual;cm=','.join('?' for _ in chat)
                        messages=[dict(r) for r in db.execute(f'SELECT * FROM messages WHERE person IN ({cm}) ORDER BY id DESC LIMIT 100',chat)][::-1];names={r['id']:r['nickname'] for r in [u]+following}
                        for m in messages:m['name']=names.get(m['person'],'')
                        feed=bars.feed_of(db,uid)
                        return self.reply({'user':public(u),'market_source':feed['source'] if feed else None,'members':members,'snapshots':snapshots,'events':events,'messages':messages,'now':time.time(),'online_users':[r[0] for r in db.execute('SELECT user_id FROM presence WHERE updated>? AND user_id IN (SELECT target FROM follows WHERE follower=?)',(time.time()-45,uid))],'notifications':[dict(r) for r in db.execute('SELECT n.id,n.actor,u.nickname FROM social_notifications n JOIN users u ON u.id=n.actor WHERE n.recipient=? AND n.seen=0 ORDER BY n.id DESC',(uid,))],'reviewed':journal.reviewed(db,uid)})
                    raise Error('接口不存在',404)
            assets={'/board':'index.html','/history':'history.html','/login':'auth.html','/register':'auth.html','/profile':'profile.html','/welcome':'welcome.html','/local-ea':'local-ea.html','/local-ea.css':'local-ea.css','/admin':'admin.html','/admin.js':'admin.js','/admin.css':'admin.css'}
            for f in ('api.js','app.js','history.js','auth.js','login-security.js','login-security.css','registration.js','profile.js','profile-prefs.js','style.css','favicon.svg','welcome.js','avatars.js','assistant.js','journal-ui.js'):assets['/'+f]=f
            if re.fullmatch(r'/avatars/avatar(?:[1-9]|1[0-2])\.svg',path):assets[path]=path.lstrip('/')
            # 首页就是交易台；旧看板挪到 /board。
            if path in ('/','/chart','/chart/'):
                page=ROOT/'web'/'chart'/'index.html'
                if not page.is_file():raise Error('图表页尚未构建，请先执行 web/chart-src 的 npm run build',503)
                body=page.read_bytes()
                self.send_response(200)
                # Vela 会在页面里注入 <style> 元素，这张页面单独放开内联样式；
                # 静态资源从 jsDelivr 取（国内到新加坡直连太慢），脚本仍只允许同源 + 这个 CDN。
                self.send_header('Content-Type','text/html; charset=utf-8')
                self.send_header('Cache-Control','no-store')
                self.send_header('Content-Length',str(len(body)))
                self.send_header('X-Content-Type-Options','nosniff')
                self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: blob:; font-src 'self' data: https://cdn.jsdelivr.net; connect-src 'self' ws://127.0.0.1:18765; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
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
            if path=='/admin':
                with connect() as db:
                    try:page_user=self.user(db)
                    except Error as e:
                        if e.code==401:return self.redirect('/login?next=/admin')
                        raise
                    if not is_admin(page_user):raise Error('页面不存在',404)
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
        except bar_sync_jobs.JobError as e:self.reply({'error':e.text},e.code)
        except device_pairing.PairError as e:self.reply({'error':e.text},e.code)
        except sync_history.HistoryError as e:self.reply({'error':e.text},e.code)
        except journal.JournalError as e:self.reply({'error':e.text},e.code)
        except chart.ChartError as e:self.reply({'error':e.text},e.code)
        except groups.GroupError as e:self.reply({'error':e.text},e.code)
        except dm.DmError as e:self.reply({'error':e.text},e.code)
        except Error as e:self.reply({'error':e.text},e.code)
        except Exception:self.reply({'error':'服务暂时不可用'},500)
    @observability.http('http.post')
    def do_POST(self):
        try:
            origin=self.headers.get('Origin');host=self.headers.get('Host','')
            if self.headers.get('Sec-Fetch-Site')=='cross-site' or (origin and origin.rstrip('/') not in {PUBLIC_ORIGIN,'http://'+host,'https://'+host}):raise Error('请求来源不正确',403)
            if 'application/json' not in self.headers.get('Content-Type',''):raise Error('请使用 JSON 请求',415)
            length=int(self.headers.get('Content-Length','0'))
            if not 1<=length<=(1048576 if urlparse(self.path).path in ('/api/chart/state','/api/notes','/api/reviews/share','/api/groups/share') else 2097152 if urlparse(self.path).path=='/api/mt5/review' else 524288):raise Error('请求大小不正确')
            data=decode_request(self.rfile.read(length),urlparse(self.path).path)
            if not isinstance(data,dict):raise Error('数据格式不正确')
            path=urlparse(self.path).path;now=time.time();cookie=None;trusted_cookie=None
            with connect() as db:
                if path.startswith('/api/mt5/device/'):
                    if path=='/api/mt5/device/start':result=device_pairing.start(db,self.client_ip())
                    elif path=='/api/mt5/device/resolve':result=device_pairing.resolve(db,self.client_ip(),self.user(db),data)
                    elif path=='/api/mt5/device/claim':result=device_pairing.claim(db,self.client_ip(),self.user(db),data)
                    elif path=='/api/mt5/device/poll':result=device_pairing.poll(db,self.client_ip(),data)
                    elif path=='/api/mt5/device/confirm':result=device_pairing.confirm(db,self.client_ip(),data)
                    else:raise Error('页面不存在',404)
                    db.commit()
                    return self.reply(result)
                elif path in ('/api/login','/api/login/verify'):
                    status,result,login_cookie=auth_security.progressive_login(self,db,data,path,pw_ok)
                    return self.reply(result,status,cookie=login_cookie)
                if path == '/api/register':
                    account=str(data.get('username','')).strip().lower()[:64]
                    if not auth_security.limit(db,'account:'+account,10,600) or not auth_security.limit(db,'ip:'+self.client_ip(),150,600):raise Error('尝试过于频繁，请10分钟后重试',429)
                    db.commit()  # Persist registration limits even when validation fails.
                    if not auth_security.verify_challenge(db,data):raise Error('验证码不正确或已过期，请刷新',400)
                    username=str(data.get('username','')).strip().lower()
                    if not re.fullmatch('[a-z0-9_]{2,24}',username):raise Error('用户名需为 2–24 位字母、数字或下划线')
                    db.execute('BEGIN IMMEDIATE')
                    invite=data.get('invite_code','')
                    if not db.execute("SELECT 1 FROM users WHERE username=?",(ADMIN_USERNAME,)).fetchone():raise Error('站点尚未初始化完成，请稍后再试',503)
                    if not isinstance(invite,str) or not invite.strip():raise Error('请填写邀请码',403)
                    grant=db.execute("SELECT id FROM invites WHERE code_hash=? AND used_by IS NULL AND revoked=0 AND (expires=0 OR expires>?)",(invite_hash(invite),now)).fetchone()
                    if not grant:raise Error('邀请码不正确、已被使用或已过期',403)
                    nickname=str(data.get('nickname','')).strip()
                    if not 1<=len(nickname)<=30:raise Error('昵称需为 1–30 个字符')
                    pw=pw_hash(data.get('password'));uid=secrets.token_hex(12)
                    if db.execute('SELECT 1 FROM users WHERE username=?',(username,)).fetchone():raise Error('该用户名已注册',409)
                    claimed=db.execute("UPDATE invites SET used_by=?,used_at=?,code_plain='' WHERE id=? AND used_by IS NULL AND revoked=0",(uid,now,grant['id']))
                    if claimed.rowcount!=1:raise Error('这个邀请码刚刚被用掉了，请换一个',409)
                    db.execute('INSERT INTO users(id,username,nickname,password,created,share_data,onboarding_step) VALUES(?,?,?,?,?,1,0)',(uid,username,nickname,pw,now))
                    cookie=self.session(db,uid)
                    if trusted_cookie:cookie=[cookie,trusted_cookie]
                    result={'ok':True,'user':public(db.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone())}
                elif path=='/api/mt5/assistant':
                    self.user(db)
                    raise Error('独立源码版请下载MQ5源码手动安装采集程序',501)
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
                    link=self.link_user(db)
                    current=journal.trade(db,link['user_id'],str(data.get('ticket','')))
                    if current.get('source')==sync_history.SCHEMA:
                        account,server,key=sync_history.identity(data)
                        bars.bind_feed(db,link['user_id'],account,server,now)
                        if current.get('source_account_key')!=key:raise Error('复盘任务不属于此 MT5 账户',409)
                    result=journal.receive(db,link['user_id'],data)
                    review_bars(db,link['user_id'],current,data,now)
                elif path=='/api/market/bind-track':
                    _,feed=bar_sync_jobs.bind_local_request(db,self.user(db)['id'],data,now)
                    result={'ok':True,'source':feed['source']}
                elif path=='/api/market/sync-jobs':
                    result=bar_sync_jobs.create(db,self.user(db)['id'],data,now)
                elif path=='/api/market/sync-jobs/cancel':
                    result=bar_sync_jobs.cancel(db,self.user(db)['id'],data,now)
                elif path=='/api/market/sync-jobs/local-poll':
                    result=bar_sync_jobs.local_poll(db,self.user(db)['id'],data,now)
                elif path=='/api/market/sync-jobs/local-result':
                    result=bar_sync_jobs.local_result(db,self.user(db)['id'],data,now)
                elif path=='/api/mt5/bar-sync/poll':
                    result=bar_sync_jobs.poll(db,self.link_user(db),data,now)
                elif path=='/api/mt5/bar-sync/result':
                    result=bar_sync_jobs.result(db,self.link_user(db),data,now)
                elif path=='/api/mt5/symbols-sync':
                    result=market_symbols.ingest(db,self.link_user(db),data,now)
                elif path in ('/api/mt5/history-sync','/api/mt5/history-import'):
                    if path=='/api/mt5/history-sync':uid=self.link_user(db)['user_id']
                    else:
                        uid=self.user(db)['id']
                        if data.get('website_user_id')!=uid:raise Error('网站登录账号已改变，请重新授权历史同步',409)
                    account,server,key=sync_history.identity(data)
                    bars.bind_feed(db,uid,account,server,now)
                    result=sync_history.ingest(db,uid,data,now)
                    clock=data.get('clock')
                    if isinstance(clock,dict):record_clock(db,uid,data['server'],{'clock':clock},now)
                    sync_history.queue_review_jobs(db,uid)
                    result['review_job']=sync_history.review_job(db,uid)
                elif path=='/api/mt5/history-review':
                    uid=self.user(db)['id']
                    if data.get('website_user_id')!=uid:raise Error('网站登录账号已改变，请重新授权历史同步',409)
                    account,server,key=sync_history.identity(data)
                    bars.bind_feed(db,uid,account,server,now)
                    result=journal.receive(db,uid,data)
                    review_bars(db,uid,journal.trade(db,uid,str(data.get('ticket',''))),data,now)
                elif path=='/api/market/backfill':
                    # 历史 K 线连续回填进共享轨道（单周期一段）。两种鉴权,都必须证明
                    # 请求体的 (server,account) 确属调用者已绑定的 MT5 账户——否则任何登录用户
                    # 都能往别人券商 source 的全局共享轨道灌伪造 K 线。
                    #  - 连接码 Bearer(SyncNote EA):link.account_key 必须等于请求体 identity key。
                    #  - 网站会话(SyncTrade 浏览器):feed_of 取用户已绑定账户,account_key 必须等于 key;
                    #    未绑定 MT5 的用户直接拒绝(无法证明该券商属于他)。
                    account,server,key=sync_history.identity(data)
                    if self.headers.get('Authorization','').startswith('Bearer '):
                        link=self.link_user(db)
                        if not link['account_key'] or link['account_key']!=key:raise Error('连接码未绑定此 MT5 账户',403)
                        uid=link['user_id']
                    else:
                        uid=self.user(db)['id']
                        if data.get('website_user_id')!=uid:raise Error('网站登录账号已改变，请重新授权',409)
                        bound=bars.feed_of(db,uid)
                        if not bound or bound['account_key']!=key:raise Error('该券商账户未绑定到当前网站账号，无法回填',403)
                    bars.bind_feed(db,uid,account,server,now)
                    symbol=str(data.get('symbol') or '')
                    tf=bars.normalize_tf(str(data.get('tf') or ''))
                    rows=data.get('bars')
                    if not tf:raise Error('周期不正确')
                    if not isinstance(rows,list):raise Error('K 线数据格式不正确')
                    begin,end=data.get('from_server'),data.get('to_server')
                    source=bars.source_for(server)
                    confirmed_empty=data.get('confirmed_empty') is True
                    if confirmed_empty:
                        period=bars.tf_seconds(tf)
                        if (rows or type(begin) is not int or type(end) is not int or begin<=0 or end<begin
                            or begin%period or end%period or end-begin>=2000*period
                            or end+period>now+bars.source_offset(db,source)):
                            raise Error('无数据确认需要已收盘且对齐的空区间')
                    # 普通回填只登记实际收到的行。仅 EA 验证过的空区间可登记为已检查。
                    series={tf:{'bars':rows,'complete':confirmed_empty,'from_server':begin,'to_server':end}}
                    try:summary=bars.ingest(db,source,key,symbol,series,now)
                    except (bars.BarsError,ValueError,TypeError) as e:raise Error('回填入库失败：'+str(e))
                    result={'ok':True,'tf':tf,'account_key':key,'account':account,'server':server,
                            'source':bars.source_for(server),'symbol':symbol,
                            'summary':(summary.get('series') or {}).get(tf) if isinstance(summary,dict) else None}
                elif path=='/api/market/coverage':
                    if self.headers.get('Authorization','').startswith('Bearer '):
                        _,server,key=sync_history.identity(data)
                        link=self.link_user(db)
                        if not link['account_key'] or link['account_key']!=key:raise Error('连接码未绑定此 MT5 账户',403)
                        source=bars.source_for(server)
                    else:
                        feed=bars.feed_of(db,self.user(db)['id'])
                        if not feed or data.get('account_key')!=feed['account_key'] or data.get('source')!=feed['source']:
                            raise Error('当前绑定券商轨道已改变',409)
                        source,key=feed['source'],feed['account_key']
                    symbol=str(data.get('symbol') or 'XAUUSD')[:64]
                    tf=bars.normalize_tf(str(data.get('tf') or 'M1'))
                    if not tf:raise Error('周期不正确')
                    try:start=int(data.get('from') or 0);end=int(data.get('to') or 0)
                    except (ValueError,TypeError):raise Error('时间范围不正确')
                    if start<=0 or end<start:raise Error('时间范围不正确')
                    bars.record_quote_sessions(db,key,symbol,data.get('quote_sessions'),now)
                    holes=bars.backfill_missing(db,source,key,symbol,tf,start,end,now)
                    # SyncNote(MQL5)只读标量,不解析数组:额外给"最靠右的那个洞"和总数,省掉 EA 侧数组解析。
                    right=max(holes,key=lambda h:h[1]) if holes else None
                    result={'source':source,'symbol':symbol,'tf':tf,'from':start,'to':end,'missing':[{'from':h[0],'to':h[1]} for h in holes],
                            'holes':len(holes),'hole_from':right[0] if right else 0,'hole_to':right[1] if right else 0}
                elif path=='/api/mt5/forming-bars':
                    link=self.link_user(db)
                    _,server,key=sync_history.identity(data)
                    feed=bars.feed_of(db,link['user_id'])
                    if not feed or feed['account_key']!=key or feed['server']!=server:raise Error('报价账户与绑定券商不一致',403)
                    symbol=data.get('symbol')
                    if not isinstance(symbol,str) or not 1<=len(symbol)<=64 or any(ord(c)<32 for c in symbol):raise Error('品种标识不正确')
                    accepted=FORMING.put((link['user_id'],key,link['token_hash']),symbol,data.get('tick_time_msc_server'),
                                         data.get('bars'),bars.source_offset(db,feed['source']),now)
                    result={'ok':True,'accepted':accepted}
                elif path=='/api/mt5/live':
                    link=self.link_user(db)
                    ingested=LIVE.ingest(link['user_id'],data);result={'ok':True,'bars':ingested['bars'],'bootstrap':ingested['first']}
                elif path=='/api/snapshot':
                    link=self.link_user(db)
                    s,hs,es=validate(data);uid=link['user_id'];broker=str(s.get('broker','')).strip()
                    if not broker or len(broker)>160:raise Error('请同步 MT5 账户及券商标识')
                    # 旧采集程序（SyncNoteSync / bridge_push）的快照通道：只回填账户与成交，
                    # **不再绑定账户**。绑定统一走 bars.bind_feed，用真实的 ACCOUNT_SERVER 建 source。
                    clock=record_clock(db,uid,broker,s,now)
                    # 采集端可以两种时间口径：券商墙钟（SyncNoteSync.mq5 原来的做法），
                    # 或者已经换算好的 UTC + 券商时间（WebBridge 这类本地桥）。
                    # 后者不再走“只认当前测量窗口”的校准，历史补传也能落库。
                    def normalize(item):
                        if item.get('time_basis')=='utc' and isinstance(item.get('closed_server'),(int,float)) and item.get('closed') is not None:
                            return {**item,'time_verified':True,'time_estimated':False}
                        return utc_trade({**{k:v for k,v in item.items() if k not in ('time_basis','time_verified')},'closed_server':item['closed']},clock)
                    hs=[normalize(t) for t in hs]
                    s={k:s[k] for k in ('balance','equity','currency','online','positions') if k in s};s['history']=[]
                    db.execute('INSERT INTO snapshots VALUES(?,?,?) ON CONFLICT(person) DO UPDATE SET payload=excluded.payload,updated=excluded.updated',(uid,json.dumps(s,allow_nan=False),now))
                    for t in hs:trade_store.store_legacy(db,uid,t,'snapshot')
                    for e in es:db.execute('INSERT OR IGNORE INTO events(person,event_key,kind,text,created) VALUES(?,?,?,?,?)',(uid,e['key'],e['kind'],e['text'],now))
                    journal.queue_missing(db,uid)
                    result={'ok':True,'review_ticket':journal.job(db,uid)}
                else:
                    u=self.user(db);uid=u['id'];result={'ok':True}
                    if path in admin_routes.POST:return admin_routes.POST[path](self,db,u,data)
                    if path=='/api/notes':result=review_notes.save(db,uid,data)
                    elif path=='/api/journal':result=journal.save(db,uid,data)
                    elif path=='/api/journal/templates':result=journal.journal_templates.save_template(db,uid,data)
                    elif path=='/api/journal/chapters/favorite':result=journal.journal_templates.favorite_chapter(db,uid,data)
                    elif path=='/api/journal/phrases':result=journal.journal_templates.save_phrase(db,uid,data)
                    elif path=='/api/journal/phrases/pin':result=journal.journal_templates.pin_phrase(db,uid,data)
                    elif path=='/api/journal/templates/pin':result=journal.journal_templates.pin_item(db,uid,data)
                    elif path=='/api/journal/library/use':result=journal.journal_templates.library_item(db,uid,data)
                    elif path=='/api/journal/library/remove':result=journal.journal_templates.library_item(db,uid,data,True)
                    elif path=='/api/chart/state':
                        ticket=str(data.get('ticket',''));journal.trade(db,uid,ticket)
                        result=chart.clear_state(db,uid,ticket) if data.get('clear') is True else chart.save_state(db,uid,ticket,data.get('state'))
                        review_notes.sync_legacy(db,uid,ticket,document=None if data.get('clear') is True else data.get('state'),write_document=True)
                    elif path=='/api/reviews/share':
                        if data.get('note_id'):result=review_notes.share(db,uid,data)
                        else:
                            ticket=str(data.get('ticket',''));journal.trade(db,uid,ticket)
                            result=chart.share(db,uid,ticket,data.get('recipients'),data.get('message',''),data.get('snapshot'),journal.notes(db,uid)['notes'].get(ticket))
                    elif path=='/api/reviews/share/seen':
                        share_id=data.get('id')
                        if not isinstance(share_id,int) or isinstance(share_id,bool):raise Error('消息编号不正确')
                        result=chart.mark_seen(db,uid,share_id)
                    elif path=='/api/trade-review/request':
                        target=data.get('person',uid);owner=db.execute('SELECT * FROM users WHERE id=?',(target,)).fetchone()
                        if not owner or not visible(db,uid,target) or (target!=uid and not owner['share_reviews']):raise Error('对方未分享复盘，或你们还不是好友',403)
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
                        if 'auto_history_sync' in data and not isinstance(data['auto_history_sync'],bool):raise Error('自动续传开关值不正确')
                        if not isinstance(data.get('allow_follow'),bool) or not isinstance(data.get('share_data'),bool):raise Error('开关值不正确')
                        db.execute('UPDATE users SET allow_follow=?,share_data=? WHERE id=?',(data['allow_follow'],data['share_data'],uid))
                        if 'share_reviews' in data:db.execute('UPDATE users SET share_reviews=? WHERE id=?',(data['share_reviews'],uid))
                        if 'auto_history_sync' in data:db.execute('UPDATE users SET auto_history_sync=? WHERE id=?',(data['auto_history_sync'],uid))
                    elif path=='/api/notifications/read':
                        db.execute('UPDATE social_notifications SET seen=1 WHERE recipient=?',(uid,))
                    elif path=='/api/invite/rotate':
                        self.require_admin(u,db)
                        code=secrets.token_hex(6).upper();db.execute('UPDATE registration_invite SET code=?,updated=? WHERE id=1',(code,now));result['code']=code
                    elif path=='/api/password':
                        if not pw_ok(data.get('current_password'),u['password']):raise Error('当前密码不正确',403)
                        pw=pw_hash(data.get('new_password'));db.execute('DELETE FROM trusted_devices WHERE user_id=?',(uid,));db.execute('DELETE FROM login_pending WHERE user_id=?',(uid,));db.execute('UPDATE users SET password=? WHERE id=?',(pw,uid));db.execute('DELETE FROM sessions WHERE user_id=?',(uid,));cookie=self.session(db,uid)
                    elif path=='/api/dm':
                        to=str(data.get('to',''))
                        result=dm.send(db,uid,to,str(data.get('text','')),bool(to) and are_friends(db,uid,to),data.get('reply_to'))
                    elif path=='/api/dm/reaction':
                        to=str(data.get('to',''))
                        result=dm.reaction(db,uid,to,data.get('id'),data.get('emoji'),data.get('active'),bool(to) and are_friends(db,uid,to))
                    elif path=='/api/groups/create':
                        result=groups.create(db,uid,str(data.get('name','')))
                    elif path=='/api/groups/join':
                        result=groups.join(db,uid,str(data.get('code','')))
                    elif path=='/api/groups/leave':
                        result=groups.leave(db,uid,str(data.get('group','')))
                    elif path=='/api/groups/recall':
                        mid=data.get('id')
                        if not isinstance(mid,int) or isinstance(mid,bool):raise Error('消息编号不正确')
                        result=groups.recall(db,str(data.get('group','')),uid,mid)
                    elif path=='/api/groups/rename':
                        result=groups.rename(db,uid,str(data.get('group','')),data.get('name'),data.get('avatar'))
                    elif path=='/api/groups/notice':
                        result=groups.set_notice(db,uid,str(data.get('group','')),str(data.get('notice','')))
                    elif path=='/api/groups/kick':
                        result=groups.kick(db,uid,str(data.get('group','')),str(data.get('target','')))
                    elif path=='/api/groups/message':
                        result=groups.post(db,uid,str(data.get('group','')),str(data.get('text','')),data.get('reply_to'))
                    elif path=='/api/groups/reaction':
                        result=groups.reaction(db,uid,str(data.get('group','')),data.get('id'),data.get('emoji'),data.get('active'))
                    elif path=='/api/groups/share':
                        if data.get('note_id'):result=review_notes.share_group(db,uid,data)
                        else:
                            result=groups.share_trade(db,uid,str(data.get('group','')),str(data.get('ticket','')),data.get('snapshot'),data.get('message',''))
                    elif path=='/api/groups/open':
                        mid=data.get('id')
                        if not isinstance(mid,int) or isinstance(mid,bool):raise Error('消息编号不正确')
                        result=groups.open_trade(db,str(data.get('group','')),uid,mid)
                    elif path in ('/api/friends/request','/api/follow'):
                        target=data.get('target')
                        row=db.execute('SELECT * FROM users WHERE id=?',(target,)).fetchone() if isinstance(target,str) else None
                        if not row or target==uid:raise Error('好友对象不正确')
                        st=edge_state(db,uid,target)
                        if st and st['i_blocked']:raise Error('你已把对方拉黑，先在黑名单里解除')
                        if st and st['they_blocked']:raise Error('对方已把你拉黑',403)
                        if st and st['i_deleted']:
                            a,b=friend_pair(uid,target)
                            side='a' if a==uid else 'b'
                            db.execute('UPDATE friend_edges SET '+side+'_deleted=0 WHERE a=? AND b=?',(a,b))
                            st=edge_state(db,uid,target)
                        if st and st['status']=='accepted' and are_friends(db,uid,target):
                            result['status']='friend'
                        elif st and st['status']=='pending' and st['requested_by']==uid:
                            result['status']='pending'
                        elif st and st['status']=='pending' and st['requested_by']==target:
                            a,b=friend_pair(uid,target)
                            db.execute("UPDATE friend_edges SET status='accepted',decided=?,a_deleted=0,b_deleted=0 WHERE a=? AND b=?",(now,a,b))
                            db.execute('DELETE FROM social_notifications WHERE recipient=? AND actor=?',(uid,target))
                            result['status']='friend'
                        else:
                            if not row['allow_follow']:raise Error('对方暂不接受好友申请',403)
                            a,b=friend_pair(uid,target)
                            if st:db.execute("UPDATE friend_edges SET status='pending',requested_by=?,created=?,decided=NULL WHERE a=? AND b=?",(uid,now,a,b))
                            else:db.execute("INSERT INTO friend_edges(a,b,status,requested_by,created) VALUES(?,?,'pending',?,?)",(a,b,uid,now))
                            db.execute('INSERT INTO social_notifications(recipient,actor,created) VALUES(?,?,?)',(target,uid,now))
                            result['status']='pending'
                    elif path=='/api/friends/accept':
                        target=data.get('target')
                        if relation(db,uid,target)!='incoming':raise Error('没有待通过的好友申请')
                        a,b=friend_pair(uid,target)
                        db.execute("UPDATE friend_edges SET status='accepted',decided=?,a_deleted=0,b_deleted=0 WHERE a=? AND b=?",(now,a,b))
                        db.execute('DELETE FROM social_notifications WHERE recipient=? AND actor=?',(uid,target))
                        result['status']='friend'
                    elif path=='/api/friends/reject':
                        target=data.get('target')
                        if relation(db,uid,target)!='incoming':raise Error('没有待通过的好友申请')
                        a,b=friend_pair(uid,target)
                        db.execute('DELETE FROM friend_edges WHERE a=? AND b=?',(a,b))
                        db.execute('DELETE FROM social_notifications WHERE recipient=? AND actor=?',(uid,target))
                        result['status']='none'
                    elif path in ('/api/friends/remove','/api/unfollow'):
                        target=data.get('target')
                        if not isinstance(target,str):raise Error('好友对象不正确')
                        st=edge_state(db,uid,target)
                        if not st:result['status']='none'
                        elif st['status']=='pending' and st['requested_by']==uid:
                            a,b=friend_pair(uid,target)
                            db.execute('DELETE FROM friend_edges WHERE a=? AND b=?',(a,b))
                            result['status']='none'
                        elif st['status']=='pending':
                            raise Error('对方已经申请过你，请到「好友申请」里处理')
                        else:
                            a,b=friend_pair(uid,target)
                            side='a' if a==uid else 'b'
                            db.execute('UPDATE friend_edges SET '+side+'_deleted=1 WHERE a=? AND b=?',(a,b))
                            result['status']='deleted'
                    elif path in ('/api/friends/block','/api/friends/unblock'):
                        target=data.get('target')
                        if not isinstance(target,str):raise Error('好友对象不正确')
                        if target==uid:raise Error('不能对自己操作')
                        a,b=friend_pair(uid,target)
                        side='a' if a==uid else 'b'
                        st=edge_state(db,uid,target)
                        if path=='/api/friends/block':
                            if not st:
                                db.execute('INSERT INTO friend_edges(a,b,status,requested_by,created) VALUES(?,?,?,?,?)',(a,b,'accepted',uid,now))
                            db.execute('UPDATE friend_edges SET '+side+'_blocked=1, '+side+'_deleted=0 WHERE a=? AND b=?',(a,b))
                            db.execute('DELETE FROM social_notifications WHERE actor=? AND recipient=?',(uid,target))
                            result['status']='blocked'
                        else:
                            if st:db.execute('UPDATE friend_edges SET '+side+'_blocked=0 WHERE a=? AND b=?',(a,b))
                            result['status']='unblocked'
                    elif path in ('/api/friends/hide','/api/friends/mute'):
                        target=data.get('target')
                        if not isinstance(target,str) or not are_friends(db,uid,target):raise Error('好友关系不正确')
                        on=bool(data.get('on',True))
                        a,b=friend_pair(uid,target)
                        side='a' if a==uid else 'b'
                        col=side+('_hide' if path=='/api/friends/hide' else '_mute')
                        db.execute('UPDATE friend_edges SET '+col+'=? WHERE a=? AND b=?',(1 if on else 0,a,b))
                        result['status']='ok'

                    elif path=='/api/mt5/token':
                        db.execute('DELETE FROM mt5_device_pairs WHERE user_id=?',(uid,))
                        token=secrets.token_urlsafe(36);db.execute('INSERT INTO mt5_links(user_id,token_hash,updated) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,updated=excluded.updated',(uid,digest(token),now));result['token']=token
                    elif path=='/api/mt5/unlink':
                        db.execute('DELETE FROM mt5_bindings WHERE user_id=?',(uid,))
                        db.execute('DELETE FROM mt5_device_pairs WHERE user_id=?',(uid,))
                        db.execute('UPDATE mt5_links SET token_hash=NULL,updated=? WHERE user_id=?',(now,uid));snap=db.execute('SELECT payload FROM snapshots WHERE person=?',(uid,)).fetchone()
                        if snap:
                            s=json.loads(snap['payload']);s['online']=False;db.execute('UPDATE snapshots SET payload=? WHERE person=?',(json.dumps(s),uid))
                    elif path=='/api/messages':
                        text=str(data.get('text','')).strip()
                        if not 1<=len(text)<=1000:raise Error('留言需为 1–1000 个字')
                        db.execute('INSERT INTO messages(person,text,created) VALUES(?,?,?)',(uid,text,now))
                    else:raise Error('接口不存在',404)
            self.reply(result,cookie=cookie)
        except device_pairing.PairError as e:self.reply({'error':e.text},e.code)
        except market_symbols.CatalogError as e:self.reply({'error':e.text},e.code)
        except bar_sync_jobs.JobError as e:self.reply({'error':e.text},e.code)
        except sync_history.HistoryError as e:self.reply({'error':e.text},e.code)
        except journal.JournalError as e:self.reply({'error':e.text},e.code)
        except chart.ChartError as e:self.reply({'error':e.text},e.code)
        except groups.GroupError as e:self.reply({'error':e.text},e.code)
        except dm.DmError as e:self.reply({'error':e.text},e.code)
        except Error as e:
            if urlparse(self.path).path=='/api/snapshot':print('Snapshot rejected:',e.code,e.text,flush=True)
            self.reply({'error':e.text},e.code)
        except sqlite3.IntegrityError:self.reply({'error':'记录已存在，请刷新重试'},409)
        except (ValueError,TypeError,KeyError) as e:
            if urlparse(self.path).path=='/api/snapshot':print('Snapshot parse rejected:',type(e).__name__,flush=True)
            self.reply({'error':'请求数据不正确'},400)
        except Exception:self.reply({'error':'服务暂时不可用'},500)
def main():
 import argparse,signal
 from app_runtime import Runtime
 parser=argparse.ArgumentParser()
 parser.add_argument('--migrate',action='store_true',help='Apply database migrations and exit')
 args=parser.parse_args()
 version=initialize_database()
 if args.migrate:
  print('Database schema:',version);return
 host=os.environ.get('HOST','127.0.0.1');port=int(os.environ.get('PORT','18886'))
 def stop(signum,frame):raise KeyboardInterrupt
 signal.signal(signal.SIGTERM,stop)
 with ThreadingHTTPServer((host,port),Handler) as server, Runtime(connect,HUB):
  server.daemon_threads=False
  print(f'SyncNote: http://{host}:{port}',flush=True)
  try:server.serve_forever()
  except KeyboardInterrupt:pass

if __name__=='__main__':main()

"""Cached UTC reference XAUUSD candles, fetched independently of MT5."""
import json,lzma,struct,os,time,threading,urllib.request,urllib.error
from datetime import datetime,timezone,timedelta
from concurrent.futures import ThreadPoolExecutor
POOL=ThreadPoolExecutor(max_workers=2)
ACTIVE=set();LOCK=threading.Lock()
SOURCE='Dukascopy XAU/USD 买价参考行情'

def initialize(db):
 db.execute('CREATE TABLE IF NOT EXISTS market_days(day TEXT PRIMARY KEY,payload TEXT NOT NULL,updated REAL NOT NULL)')

def decode(blob,start):
 raw=lzma.decompress(blob,memlimit=64*1024*1024)
 if len(raw)%24 or len(raw)>1440*24:raise ValueError('Invalid candle file')
 bars=[];previous=-1
 for sec,o,c,l,h,volume in struct.iter_unpack('>5If',raw):
  if sec<=previous or sec>=86400 or sec%60 or not 0<l<=min(o,c)<=max(o,c)<=h:raise ValueError('Invalid candle record')
  bars.append([start+sec,o/1000,h/1000,l/1000,c/1000]);previous=sec
 return bars

def daily(connect,day):
 start=int(day.timestamp());key=day.strftime('%Y-%m-%d')
 with connect() as db:r=db.execute('SELECT payload,updated FROM market_days WHERE day=?',(key,)).fetchone()
 if r and (start+86400<time.time()-3600 or time.time()-r['updated']<300):return json.loads(r['payload'])
 url='https://datafeed.dukascopy.com/datafeed/XAUUSD/'+day.strftime('%Y/')+f'{day.month-1:02d}/'+day.strftime('%d/')+'BID_candles_min_1.bi5'
 proxy=os.environ.get('MARKET_HTTP_PROXY');opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':proxy}) if proxy else urllib.request.ProxyHandler())
 try:
  response=opener.open(urllib.request.Request(url,headers={'User-Agent':'Tongpin-Journal/1.0'}),timeout=15)
  blob=response.read(2*1024*1024+1)
  if len(blob)>2*1024*1024:raise ValueError('Market response too large')
  bars=decode(blob,start)
 except urllib.error.HTTPError as e:
  if e.code==404 and day.weekday() in (5,6):bars=[]
  else:raise
 with connect() as db:db.execute('INSERT INTO market_days VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET payload=excluded.payload,updated=excluded.updated',(key,json.dumps(bars),time.time()))
 return bars

def aggregate(bars,seconds):
 result=[]
 for b in bars:
  key=int(b[0]//seconds)*seconds
  if result and result[-1][0]==key:result[-1][2]=max(result[-1][2],b[2]);result[-1][3]=min(result[-1][3],b[3]);result[-1][4]=b[4]
  else:result.append([key,*b[1:]])
 return result

def collect(connect,person,ticket,normalize):
 import journal
 with connect() as db:
  t=normalize(journal.trade(db,person,ticket),db.execute('SELECT * FROM broker_clocks WHERE person=?',(person,)).fetchone())
  if t.get('closed') is None or not t.get('opened_server'):return
  shift=t['closed_server']-t['closed'];opened=t['opened_server']-shift;closed=t['closed']
 if not t.get('symbol','').upper().startswith(('XAUUSD','GOLD')):raise ValueError('Only gold supported')
 if closed<opened or closed-opened>14*86400:raise ValueError('Trade interval too large')
 start=opened-30*3600;end=min(closed+30*3600,time.time());day=datetime.fromtimestamp(start,timezone.utc).replace(hour=0,minute=0,second=0,microsecond=0);last=datetime.fromtimestamp(end,timezone.utc).replace(hour=0,minute=0,second=0,microsecond=0);all_bars=[]
 while day<=last:all_bars.extend(daily(connect,day));day+=timedelta(days=1)
 charts={};errors={}
 for tf,sec in [('M1',60),('M5',300),('M15',900),('H1',3600)]:
  bars=aggregate([b for b in all_bars if opened-30*sec<=b[0]<=closed+30*sec],sec)
  if len(bars)>2000:errors[tf]='持仓跨度较长，该周期暂无法显示完整行情';bars=[]
  if bars and not(bars[0][0]<=opened and bars[-1][0]+sec>closed):bars=[];errors[tf]='参考行情未覆盖这笔交易的完整时间'
  if not bars and tf not in errors:errors[tf]='该时间段暂无参考行情'
  charts[tf]=bars
 payload={'charts':charts,'errors':errors,'opened_server':t['opened_server'],'closed_server':t['closed_server'],'time_basis':'utc','source':SOURCE}
 with connect() as db:db.execute("INSERT INTO trade_reviews VALUES(?,?,'ready',?,?) ON CONFLICT(person,ticket) DO UPDATE SET status='ready',payload=excluded.payload,updated=excluded.updated",(person,ticket,json.dumps(payload,ensure_ascii=False),time.time()))

def schedule(connect,person,ticket,normalize,force=False):
 import journal
 with connect() as db:
  t=journal.trade(db,person,ticket)
  if not t.get('opened_server'):return
  row=db.execute('SELECT * FROM trade_reviews WHERE person=? AND ticket=?',(person,ticket)).fetchone()
  if row and not force:
   if row['status']=='ready':return
   if row['status']=='reference_error' and time.time()-row['updated']<120:return
 key=(person,ticket)
 with LOCK:
  if key in ACTIVE or len(ACTIVE)>=20:return
  ACTIVE.add(key)
 with connect() as db:db.execute("INSERT INTO trade_reviews VALUES(?,?,'reference_pending',NULL,?) ON CONFLICT(person,ticket) DO UPDATE SET status='reference_pending',updated=excluded.updated",(person,ticket,time.time()))
 def work():
  try:collect(connect,person,ticket,normalize)
  except Exception:
   with connect() as db:
    row=db.execute('SELECT payload FROM trade_reviews WHERE person=? AND ticket=?',(person,ticket)).fetchone();saved=json.loads(row['payload']) if row and row['payload'] else {'source':SOURCE}
    saved['error']='参考行情获取失败，请稍后重试。交易记录和笔记仍可使用。'
    status='ready' if any(saved.get('charts',{}).values()) else 'reference_error'
    db.execute('UPDATE trade_reviews SET status=?,payload=?,updated=? WHERE person=? AND ticket=?',(status,json.dumps(saved,ensure_ascii=False),time.time(),person,ticket))
  finally:
   with LOCK:ACTIVE.discard(key)
 POOL.submit(work)

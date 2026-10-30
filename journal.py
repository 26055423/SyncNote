"""Private trade notes and on-demand broker chart collection."""
import json,math,time
DEFAULT_TAGS=['止损管理','资金管理','方向判断','入场时机','出场管理','冲动交易','未按计划','执行良好']
class JournalError(Exception):
 def __init__(self,text,code=400):self.text,self.code=text,code

def initialize(db):
 db.executescript('''CREATE TABLE IF NOT EXISTS trade_notes(person TEXT NOT NULL,ticket TEXT NOT NULL,body TEXT NOT NULL,tags TEXT NOT NULL,updated REAL NOT NULL,PRIMARY KEY(person,ticket),FOREIGN KEY(person,ticket) REFERENCES trades(person,ticket));
 CREATE TABLE IF NOT EXISTS trade_reviews(person TEXT NOT NULL,ticket TEXT NOT NULL,status TEXT NOT NULL,payload TEXT,updated REAL NOT NULL,PRIMARY KEY(person,ticket),FOREIGN KEY(person,ticket) REFERENCES trades(person,ticket));''')
 db.execute("UPDATE trade_reviews SET status='pending' WHERE status IN ('reference_pending','reference_error')")

def trade(db,person,ticket):
 r=db.execute('SELECT payload FROM trades WHERE person=? AND ticket=?',(person,str(ticket))).fetchone()
 if not r:raise JournalError('这笔交易不属于你，或尚未同步',404)
 return json.loads(r[0])

def notes(db,person):
 return {'categories':DEFAULT_TAGS,'notes':{r['ticket']:{'body':r['body'],'tags':json.loads(r['tags']),'updated':r['updated']} for r in db.execute('SELECT * FROM trade_notes WHERE person=?',(person,))}}

def save(db,person,data):
 ticket=str(data.get('ticket',''));trade(db,person,ticket)
 body=data.get('body','');tags=data.get('tags',[])
 if not isinstance(body,str) or len(body)>10000:raise JournalError('笔记最多 10000 字')
 if not isinstance(tags,list) or len(tags)>12 or any(not isinstance(t,str) or not 1<=len(t.strip())<=40 for t in tags):raise JournalError('分类最多 12 个，每个不超过 40 字')
 tags=list(dict.fromkeys(t.strip() for t in tags));now=time.time()
 db.execute('INSERT INTO trade_notes VALUES(?,?,?,?,?) ON CONFLICT(person,ticket) DO UPDATE SET body=excluded.body,tags=excluded.tags,updated=excluded.updated',(person,ticket,body.strip(),json.dumps(tags,ensure_ascii=False),now))
 return {'ok':True,'note':{'body':body.strip(),'tags':tags,'updated':now}}

def request(db,person,data):
 ticket=str(data.get('ticket',''));trade(db,person,ticket)
 old=db.execute('SELECT status,updated FROM trade_reviews WHERE person=? AND ticket=?',(person,ticket)).fetchone()
 if old and old['status']=='ready' and not data.get('retry'):return {'ok':True}
 if not old or old['status']!='pending':
  if db.execute("SELECT count(*) FROM trade_reviews WHERE person=? AND status='pending'",(person,)).fetchone()[0]>=20:raise JournalError('已有 20 笔图表等待同步，请稍后再试',429)
  db.execute("INSERT INTO trade_reviews VALUES(?,?,'pending',NULL,?) ON CONFLICT(person,ticket) DO UPDATE SET status='pending',updated=excluded.updated",(person,ticket,time.time()))
 return {'ok':True}

def job(db,person):
 r=db.execute("SELECT ticket FROM trade_reviews WHERE person=? AND status='pending' ORDER BY updated LIMIT 1",(person,)).fetchone()
 return r['ticket'] if r else ''

def receive(db,person,data):
 ticket=str(data.get('ticket',''));t=trade(db,person,ticket)
 if not db.execute("SELECT 1 FROM trade_reviews WHERE person=? AND ticket=? AND status='pending'",(person,ticket)).fetchone():raise JournalError('没有这笔图表请求',409)
 payload={'charts':{},'errors':{}}
 if data.get('error'):
  payload['error']='MT5 暂时无法读取这笔交易，请确认交易历史已加载后重试'
 else:
  opened,closed=data.get('opened_server'),data.get('closed_server')
  raw=t.get('closed_server',t.get('closed'))
  if any(isinstance(x,bool) or not isinstance(x,(float,int)) or not math.isfinite(x) for x in (opened,closed)) or not 0<opened<=closed or abs(closed-raw)>1:raise JournalError('图表成交时间与订单不一致')
  payload.update(opened_server=opened,closed_server=closed)
  charts=data.get('charts',{});errors=data.get('errors',{})
  if not isinstance(charts,dict) or not isinstance(errors,dict):raise JournalError('行情格式不正确')
  for tf,seconds in [('M1',60),('M5',300),('M15',900),('H1',3600)]:
   bars=charts.get(tf,[])
   if not isinstance(bars,list) or len(bars)>2000:raise JournalError('行情数量不正确')
   previous=0
   for b in bars:
    if not isinstance(b,list) or len(b)!=5 or any(isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x) for x in b):raise JournalError('K线格式不正确')
    ts,o,h,l,c=b
    if ts<=previous or min(o,h,l,c)<=0 or l>min(o,c) or h<max(o,c) or l>h or not opened-40*seconds<=ts<=closed+40*seconds:raise JournalError('K线数据不正确')
    previous=ts
   if bars and not (bars[0][0]<=opened and bars[-1][0]+seconds>closed):raise JournalError('行情没有覆盖开仓和平仓时间')
   payload['charts'][tf]=bars
   if not bars:payload['errors'][tf]='持仓跨度较长，暂无法显示完整行情' if errors.get(tf)=='range_too_long' else 'MT5 未提供该周期的完整行情，请加载历史行情后重试'
 db.execute("UPDATE trade_reviews SET status='ready',payload=?,updated=? WHERE person=? AND ticket=?",(json.dumps(payload,ensure_ascii=False,allow_nan=False),time.time(),person,ticket))
 return {'ok':True}

def review(db,person,ticket,clock,normalize):
 t=normalize(trade(db,person,ticket),clock)
 r=db.execute('SELECT * FROM trade_reviews WHERE person=? AND ticket=?',(person,str(ticket))).fetchone()
 opened=t.get('opened_server');closed=t.get('closed');raw=t.get('closed_server')
 opened_utc=opened-(raw-closed) if isinstance(opened,(int,float)) and not isinstance(opened,bool) and opened>0 and closed is not None else None
 result={'opened':opened_utc,'trade':t,'status':r['status'] if r else 'not_requested','charts':{},'errors':{}}
 if r and r['payload']:
  p=json.loads(r['payload']);result['errors']=p.get('errors',{});result['error']=p.get('error');result['source']=p.get('source')
  raw=t.get('closed_server');closed=t.get('closed')
  if closed is None:result['error']='交易时间尚未校准，暂不能定位图表';return result
  shift=raw-closed
  if p.get('opened_server'):result['opened']=p['opened_server']-shift
  result['charts']={tf:[[b[0]-(0 if p.get('time_basis')=='utc' else shift),*b[1:]] for b in bars] for tf,bars in p.get('charts',{}).items()}
 return result


def queue_missing(db,person):
 """Fill a small durable chart queue while MT5 uploads are arriving."""
 count=db.execute("SELECT count(*) FROM trade_reviews WHERE person=? AND status='pending'",(person,)).fetchone()[0]
 available=max(0,20-count)
 if not available:return
 # Prefer recent trades, then progressively fill older history.
 rows=db.execute("SELECT t.ticket,t.payload FROM trades t LEFT JOIN trade_reviews r ON r.person=t.person AND r.ticket=t.ticket WHERE t.person=? AND r.ticket IS NULL",(person,)).fetchall()
 rows=sorted(rows,key=lambda r:json.loads(r['payload']).get('closed_server') or 0,reverse=True)[:available]
 db.executemany("INSERT OR IGNORE INTO trade_reviews VALUES(?,?,'pending',NULL,?)",[(person,r['ticket'],time.time()+i*.001) for i,r in enumerate(rows)])

def _has_marks(document):
 """画线存档里是否真的画了东西（空文档、只有缩放都不算）。"""
 if not isinstance(document, dict):
  return False
 charts = document.get('charts')
 if not isinstance(charts, list):
  return False
 for chart in charts:
  if not isinstance(chart, dict):
   continue
  drawings = chart.get('drawings')
  if isinstance(drawings, dict) and drawings.get('drawings'):
   return True
  if isinstance(drawings, list) and drawings:
   return True
 return False


def reviewed(db, person):
 """真正复盘过的成交：写过笔记，或在图上画过东西。"""
 done = set()
 for row in db.execute('SELECT ticket,body FROM trade_notes WHERE person=?', (person,)):
  if (row['body'] or '').strip():
   done.add(str(row['ticket']))
 for row in db.execute('SELECT ticket,state FROM chart_states WHERE person=?', (person,)):
  try:
   document = json.loads(row['state'])
  except (TypeError, ValueError):
   continue
  if _has_marks(document):
   done.add(str(row['ticket']))
 return sorted(done)

"""Explicit account-scoped historical bar jobs. UTC requests, broker-wall segments."""
import hashlib,json,secrets,time
import bars,market_symbols,sync_history,trade_time

PERIODS={'M1':60,'M5':300,'M15':900,'H1':3600}
ACTIVE=('waiting','running')
class JobError(Exception):
 def __init__(self,text,code=400):self.text=text;self.code=code;super().__init__(text)

def initialize(db):
 db.executescript('''
 CREATE TABLE IF NOT EXISTS bar_sync_jobs(job_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,account_key TEXT NOT NULL,token_hash TEXT NOT NULL,source TEXT NOT NULL,symbol TEXT NOT NULL,from_utc INTEGER NOT NULL,to_utc INTEGER NOT NULL,status TEXT NOT NULL,total_segments INTEGER NOT NULL,processed_segments INTEGER NOT NULL DEFAULT 0,bars_received INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',created REAL NOT NULL,updated REAL NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_bar_sync_jobs_owner ON bar_sync_jobs(user_id,created);
 CREATE TABLE IF NOT EXISTS bar_sync_segments(job_id TEXT NOT NULL,segment_id TEXT NOT NULL,ordinal INTEGER NOT NULL,tf TEXT NOT NULL,from_server INTEGER NOT NULL,to_server INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'waiting',result_hash TEXT NOT NULL DEFAULT '',accepted INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',PRIMARY KEY(job_id,segment_id));
 CREATE INDEX IF NOT EXISTS idx_bar_sync_segments_order ON bar_sync_segments(job_id,ordinal);
 ''')

def integer(value,name):
 if type(value) is not int or not 1<=value<=32535215999:raise JobError('时间参数不正确：'+name)
 return value

def link_of(db,uid):
 link=db.execute('SELECT * FROM mt5_links WHERE user_id=?',(uid,)).fetchone()
 feed=bars.feed_of(db,uid)
 if not link or not link['token_hash'] or not feed or link['account_key']!=feed['account_key']:raise JobError('请先授权 SyncNote 并同步券商账户',409)
 return link,feed

def public(row):
 if row is None:return None
 return {key:row[key] for key in ('job_id','symbol','status','processed_segments','total_segments','bars_received','last_error','created','updated')}|{'from':row['from_utc'],'to':row['to_utc']}

def current(db,uid,symbol=None):
 link,feed=link_of(db,uid)
 sql='SELECT * FROM bar_sync_jobs WHERE user_id=? AND account_key=? AND token_hash=?'
 params=[uid,feed['account_key'],link['token_hash']]
 if symbol:
  sql+=' AND symbol=?';params.append(symbol)
 return db.execute(sql+' ORDER BY created DESC,rowid DESC LIMIT 1',params).fetchone()

def status(db,uid,symbol=None):
 try:return {'job':public(current(db,uid,symbol))}
 except JobError:return {'job':None}

def create(db,uid,data,now=None):
 now=time.time() if now is None else now
 link,feed=link_of(db,uid)
 symbol=data.get('symbol')
 if not isinstance(symbol,str) or not symbol or len(symbol)>64:raise JobError('请选择券商原始品种代码')
 catalog=market_symbols.read(db,uid,feed['source'])
 if not any(item['symbol']==symbol for item in catalog['symbols']):raise JobError('该品种不属于当前券商目录，请先更新 SyncNote 品种目录',409)
 begin=integer(data.get('from'),'from');end=integer(data.get('to'),'to')
 if end<=begin or end-begin>365*86400:raise JobError('同步区间需大于 0 且不超过 365 天')
 if end>now+60:raise JobError('不能同步未来行情')
 active=db.execute("SELECT * FROM bar_sync_jobs WHERE user_id=? AND account_key=? AND token_hash=? AND status IN ('waiting','running') ORDER BY created DESC LIMIT 1",(uid,feed['account_key'],link['token_hash'])).fetchone()
 if active:raise JobError('已有 '+active['symbol']+' 同步任务，请等待完成或先取消',409)
 offset=trade_time.offset_for(db,feed['source'])
 queues=[]
 for tf,p in PERIODS.items():
  start=((begin+offset+p-1)//p)*p
  last=min(((end+offset)//p)*p-p,((int(now)+offset)//p)*p-p)
  queue=[]
  # Newest segments first; rotate periods so long M1 history cannot starve H1.
  while last>=start:
   first=max(start,last-1999*p);queue.append((tf,first,last));last=first-p
  queues.append(queue)
 segments=[]
 for index in range(max((len(q) for q in queues),default=0)):
  for queue in queues:
   if index<len(queue):segments.append(queue[index])
 if not segments:raise JobError('区间内没有已收盘 K 线，请选择更早的开始时间')
 job_id=secrets.token_hex(16)
 db.execute('INSERT INTO bar_sync_jobs(job_id,user_id,account_key,token_hash,source,symbol,from_utc,to_utc,status,total_segments,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(job_id,uid,feed['account_key'],link['token_hash'],feed['source'],symbol,begin,end,'waiting',len(segments),now,now))
 db.executemany('INSERT INTO bar_sync_segments(job_id,segment_id,ordinal,tf,from_server,to_server) VALUES(?,?,?,?,?,?)',[(job_id,secrets.token_hex(12),i,tf,start,end) for i,(tf,start,end) in enumerate(segments)])
 return {'job':public(db.execute('SELECT * FROM bar_sync_jobs WHERE job_id=?',(job_id,)).fetchone())}

def cancel(db,uid,data,now=None):
 now=time.time() if now is None else now
 link,feed=link_of(db,uid)
 row=db.execute('SELECT * FROM bar_sync_jobs WHERE job_id=? AND user_id=? AND account_key=? AND token_hash=?',(str(data.get('job_id') or ''),uid,feed['account_key'],link['token_hash'])).fetchone()
 if not row:raise JobError('同步任务不存在',404)
 if row['status'] in ACTIVE:db.execute("UPDATE bar_sync_jobs SET status='cancelled',updated=? WHERE job_id=?",(now,row['job_id']))
 return {'job':public(db.execute('SELECT * FROM bar_sync_jobs WHERE job_id=?',(row['job_id'],)).fetchone())}

def identity(db,link,data):
 account,server,key=sync_history.identity(data)
 if not link['account_key'] or key!=link['account_key']:raise JobError('此 EA 账户与绑定账户不一致',403)
 if not link['token_hash'] or not db.execute('SELECT 1 FROM mt5_links WHERE user_id=? AND account_key=? AND token_hash=?',(link['user_id'],key,link['token_hash'])).fetchone():raise JobError('同步授权已撤销',401)
 return account,server,key

def poll(db,link,data,now=None):
 now=time.time() if now is None else now
 account,server,key=identity(db,link,data)
 row=db.execute("SELECT * FROM bar_sync_jobs WHERE user_id=? AND account_key=? AND token_hash=? AND status IN ('waiting','running') ORDER BY created LIMIT 1",(link['user_id'],key,link['token_hash'])).fetchone()
 if not row:return {'ok':True,'job':None}
 segment=db.execute("SELECT * FROM bar_sync_segments WHERE job_id=? AND state='waiting' ORDER BY ordinal LIMIT 1",(row['job_id'],)).fetchone()
 if not segment:return {'ok':True,'job':None}
 db.execute("UPDATE bar_sync_jobs SET status='running',updated=? WHERE job_id=?",(now,row['job_id']))
 return {'ok':True,'job':{'job_id':row['job_id'],'segment_id':segment['segment_id'],'account_key':key,'account':account,'server':server,'symbol':row['symbol'],'tf':segment['tf'],'from_server':segment['from_server'],'to_server':segment['to_server']}}

def result(db,link,data,now=None):
 now=time.time() if now is None else now
 account,server,key=identity(db,link,data)
 row=db.execute('SELECT * FROM bar_sync_jobs WHERE job_id=? AND user_id=? AND account_key=? AND token_hash=?',(str(data.get('job_id') or ''),link['user_id'],key,link['token_hash'])).fetchone()
 if not row or row['status']=='cancelled':raise JobError('任务已取消、账户已改变或同步授权已失效',409)
 segment=db.execute('SELECT * FROM bar_sync_segments WHERE job_id=? AND segment_id=?',(row['job_id'],str(data.get('segment_id') or ''))).fetchone()
 if not segment:raise JobError('同步分段不存在',409)
 if data.get('symbol')!=row['symbol'] or data.get('tf')!=segment['tf'] or any(type(data.get(k)) is not int or data[k]!=segment[k] for k in ('from_server','to_server')):raise JobError('同步分段身份或范围不一致',409)
 raw=data.get('bars');error=data.get('error','')
 if not isinstance(raw,list) or len(raw)>2000 or not isinstance(error,str) or len(error)>256:raise JobError('K 线分段格式不正确')
 digest=hashlib.sha256(json.dumps({'bars':raw,'error':error},sort_keys=True,separators=(',',':')).encode()).hexdigest()
 def ack(accepted,state):return {'ok':True,'job_id':row['job_id'],'segment_id':segment['segment_id'],'account_key':key,'symbol':row['symbol'],'tf':segment['tf'],'from_server':segment['from_server'],'to_server':segment['to_server'],'accepted':accepted,'status':state}
 if segment['state']!='waiting':
  if segment['result_hash']!=digest:raise JobError('同一分段结果已改变',409)
  return ack(segment['accepted'],row['status'])
 if row['status'] not in ACTIVE:raise JobError('任务已结束',409)
 first=db.execute("SELECT segment_id FROM bar_sync_segments WHERE job_id=? AND state='waiting' ORDER BY ordinal LIMIT 1",(row['job_id'],)).fetchone()
 if not first or first['segment_id']!=segment['segment_id']:raise JobError('同步分段顺序不一致',409)
 p=PERIODS[segment['tf']];previous=0
 for bar in raw:
  if not isinstance(bar,list) or len(bar)<5 or type(bar[0]) is not int or not segment['from_server']<=bar[0]<=segment['to_server'] or bar[0]%p or bar[0]<=previous:raise JobError('K 线时间顺序或范围不正确')
  previous=bar[0]
 db.execute('SAVEPOINT bar_sync_result')
 try:
  summary=bars.ingest(db,row['source'],key,row['symbol'],{segment['tf']:{'bars':raw,'complete':False,'from_server':segment['from_server'],'to_server':segment['to_server']}},now)['series'][segment['tf']]
  if summary['accepted']!=len(raw) or summary['dropped']:raise JobError('K 线包含未收盘或无效数据')
  count=db.execute('SELECT count(*) FROM bars WHERE source=? AND symbol=? AND tf=? AND t BETWEEN ? AND ?',(row['source'],row['symbol'],segment['tf'],segment['from_server'],segment['to_server'])).fetchone()[0]
  full=count==(segment['to_server']-segment['from_server'])//p+1
  state='completed' if full else 'partial'
  reason='' if full else error or '区间内存在未确认的空窗或缺失 K 线'
  db.execute('UPDATE bar_sync_segments SET state=?,result_hash=?,accepted=?,error=? WHERE job_id=? AND segment_id=?',(state,digest,len(raw),reason,row['job_id'],segment['segment_id']))
  processed=row['processed_segments']+1
  status='running'
  if processed==row['total_segments']:
   partial=db.execute("SELECT 1 FROM bar_sync_segments WHERE job_id=? AND state='partial' LIMIT 1",(row['job_id'],)).fetchone()
   status='partial' if partial else 'completed'
  db.execute('UPDATE bar_sync_jobs SET status=?,processed_segments=?,bars_received=bars_received+?,last_error=CASE WHEN ?!=\'\' THEN ? ELSE last_error END,updated=? WHERE job_id=?',(status,processed,len(raw),reason,reason,now,row['job_id']))
  db.execute('RELEASE bar_sync_result')
 except Exception:
  db.execute('ROLLBACK TO bar_sync_result');db.execute('RELEASE bar_sync_result');raise
 return ack(len(raw),status)

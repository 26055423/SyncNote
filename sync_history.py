"""History-only ingestion. Raw MT5 deals are retained; closed trades are derived server-side."""
import hashlib,json,math,re,time

SCHEMA='syncnote-history.v1'
MAX_BATCH=200
class HistoryError(Exception):
 def __init__(self,text,code=400):self.text,self.code=text,code

def initialize(db):
 db.executescript('''
 CREATE TABLE IF NOT EXISTS mt5_raw_deals(person TEXT NOT NULL,account_key TEXT NOT NULL,deal_ticket TEXT NOT NULL,position_id TEXT NOT NULL,time_msc_server INTEGER NOT NULL,payload TEXT NOT NULL,fingerprint TEXT NOT NULL,updated REAL NOT NULL,PRIMARY KEY(person,account_key,deal_ticket));
 CREATE INDEX IF NOT EXISTS idx_mt5_deal_position ON mt5_raw_deals(person,account_key,position_id,time_msc_server);
 CREATE TABLE IF NOT EXISTS mt5_history_batches(person TEXT NOT NULL,account_key TEXT NOT NULL,batch_id TEXT NOT NULL,fingerprint TEXT NOT NULL,ack TEXT NOT NULL,updated REAL NOT NULL,PRIMARY KEY(person,account_key,batch_id));
 CREATE TABLE IF NOT EXISTS mt5_history_issues(person TEXT NOT NULL,account_key TEXT NOT NULL,deal_ticket TEXT NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(person,account_key,deal_ticket));
 CREATE TABLE IF NOT EXISTS mt5_history_coverage(person TEXT NOT NULL,account_key TEXT NOT NULL,from_server INTEGER NOT NULL,through_server INTEGER NOT NULL,PRIMARY KEY(person,account_key,from_server));
 ''')

def encoded(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)
def digest(value):return hashlib.sha256(value.encode('utf-8')).hexdigest()
def account_key(server,account):return digest(server+'\n'+account)
def number(value,name,minimum=-1e15,maximum=1e15,integer=False):
 if isinstance(value,bool) or not isinstance(value,(int,float)) or not minimum<=value<=maximum or not math.isfinite(value) or (integer and int(value)!=value):raise HistoryError('历史字段不正确：'+name)
 return int(value) if integer else float(value)
def ticket(value,name,zero=False):
 if not isinstance(value,str) or not re.fullmatch(r'[0-9]{1,20}',value) or (not zero and int(value)==0):raise HistoryError('成交标识不正确：'+name)
 return str(int(value))

def identity(data):
 account=ticket(data.get('account'),'account')
 server=data.get('server')
 if not isinstance(server,str) or not 1<=len(server)<=160 or any(ord(c)<32 for c in server):raise HistoryError('券商服务器标识不正确')
 key=account_key(server,account)
 if data.get('account_key')!=key:raise HistoryError('MT5 账户摘要不匹配')
 return account,server,key

def clean_deal(raw,begin,end):
 if not isinstance(raw,dict):raise HistoryError('成交必须是对象')
 fields={'deal_ticket','order_ticket','position_id','time_msc_server','time_server','type','entry','symbol','volume','price','profit','commission','swap','fee','magic','reason','comment','external_id','position_first_deal_ticket','position_first_time_msc_server','position_context_status'}
 if set(raw)-fields:raise HistoryError('成交包含不支持的字段')
 value={name:ticket(raw.get(name,'0'),name,name!='deal_ticket') for name in ('deal_ticket','order_ticket','position_id')}
 value['time_msc_server']=number(raw.get('time_msc_server'),'time_msc_server',1,4102444800000,True)
 if 'time_server' in raw and number(raw['time_server'],'time_server',1,4102444800,True)!=value['time_msc_server']//1000:raise HistoryError('成交秒与毫秒时间不一致')
 if not begin*1000<=value['time_msc_server']<(end+1)*1000:raise HistoryError('成交时间不在本次历史窗口中')
 value['type']=number(raw.get('type'),'type',0,255,True)
 value['entry']=number(raw.get('entry'),'entry',0,3,True)
 for name in ('volume','price'):value[name]=number(raw.get(name,0),name,0,1e12)
 for name in ('profit','commission','swap','fee'):value[name]=number(raw.get(name,0),name)
 magic=raw.get('magic','0')
 if isinstance(magic,str):
  if not re.fullmatch(r'-?[0-9]{1,20}',magic):raise HistoryError('成交 magic 不正确')
  value['magic']=str(int(magic))
 else:value['magic']=str(number(magic,'magic',-9007199254740991,9007199254740991,True))
 value['reason']=number(raw.get('reason',0),'reason',0,255,True)
 for name,limit in (('symbol',160),('comment',1024),('external_id',256)):
  val=raw.get(name,'')
  if not isinstance(val,str) or len(val)>limit or any(ord(c)<32 for c in val):raise HistoryError('成交文本字段不正确：'+name)
  value[name]=val
 if value['type'] in (0,1) and (not value['symbol'] or value['volume']<=0 or value['price']<=0 or value['position_id']=='0'):raise HistoryError('买卖成交缺少有效品种、价格、数量或持仓标识')
 status=raw.get('position_context_status','unavailable')
 if status not in ('available','unavailable','too_large'):raise HistoryError('持仓历史起点证据不正确')
 value['position_context_status']=status
 value['position_first_deal_ticket']=ticket(raw.get('position_first_deal_ticket','0'),'position_first_deal_ticket',status!='available')
 value['position_first_time_msc_server']=number(raw.get('position_first_time_msc_server',0),'position_first_time_msc_server',1 if status=='available' else 0,value['time_msc_server'],True)
 if status!='available' and (value['position_first_deal_ticket']!='0' or value['position_first_time_msc_server']!=0):raise HistoryError('未确认的持仓起点不能携带有效锚点')
 return value

def trade_id(key,deal_ticket):return 'deal:'+key[:16]+':'+deal_ticket

def _coverage(db,person,key,begin,through):
 old=[(r['from_server'],r['through_server']) for r in db.execute('SELECT from_server,through_server FROM mt5_history_coverage WHERE person=? AND account_key=? ORDER BY from_server',(person,key))]
 merged=[]
 for start,end in sorted(old+([(begin,through)] if through>=begin else [])):
  if merged and start<=merged[-1][1]+1:merged[-1]=(merged[-1][0],max(end,merged[-1][1]))
  else:merged.append((start,end))
 if merged!=old:
  db.execute('DELETE FROM mt5_history_coverage WHERE person=? AND account_key=?',(person,key))
  db.executemany('INSERT INTO mt5_history_coverage VALUES(?,?,?,?)',[(person,key,start,end) for start,end in merged])
 return merged,merged!=old

def _context(deals,coverage):
 ordered=sorted((d for d in deals if d['type'] in (0,1)),key=lambda d:(d['time_msc_server'],int(d['deal_ticket'])))
 if not ordered:return False,'没有买卖成交上下文'
 anchors={(d['position_first_deal_ticket'],d['position_first_time_msc_server']) for d in ordered if d.get('position_context_status')=='available'}
 if len(anchors)!=1:return False,'缺少一致的 MT5 持仓历史起点证据，原始成交已保留'
 first=ordered[0];anchor=next(iter(anchors))
 if anchor!=(first['deal_ticket'],first['time_msc_server']):return False,'MT5 起点位于已收到历史之外，请扩大历史范围或等待补齐'
 if first['entry']!=0 or first['order_ticket']!=first['position_id']:return False,'最早成交不是可验证的原始开仓订单'
 stamp=first['time_msc_server']//1000
 if not any(start<=stamp<=end for start,end in coverage):return False,'开仓所在整秒的历史分页尚未确认完整'
 return True,'mt5_position_anchor_and_covered_window'

def summarize(deals,offset,coverage=()):
 """Require a real position-origin anchor, then derive weighted partial/reversal exits."""
 volume=price=fees=0.0;side=None;opened=0;symbol='';complete=True
 trades=[];issues=[]
 context,proof=_context(deals,coverage)
 origin=min((d['time_msc_server']//1000 for d in deals if d['type'] in (0,1)),default=0)
 for d in sorted(deals,key=lambda row:(row['time_msc_server'],int(row['deal_ticket']))):
  if d['type'] not in (0,1):
   issues.append((d['deal_ticket'],'unallocated_financial_event','独立资金/佣金/费用事件仅保留原始记录，未分摊至交易净盈亏'))
   continue
  if not context:
   issues.append((d['deal_ticket'],'context_unverified',proof));continue
  # A completed lifecycle is not enough if the next position event is still in an
  # unconfirmed page: a missing earlier scale-in could change weighted cost basis.
  if not any(start<=origin<=d['time_msc_server']//1000<=end for start,end in coverage):
   issues.append((d['deal_ticket'],'context_unverified','此成交所在整秒的历史分页尚未确认完整'));continue
  if not complete:
   issues.append((d['deal_ticket'],'context_unavailable','此前成交上下文冲突，等待完整历史更正'));continue
  entry=d['entry'];size=d['volume'];direction=d['type'];stamp=d['time_msc_server']//1000
  charge=d['commission']+d['fee']
  if entry==0:
   if volume>1e-8 and (side!=direction or symbol!=d['symbol']):
    complete=False;issues.append((d['deal_ticket'],'context_unavailable','入场方向或品种与已有持仓上下文冲突'));continue
   if volume<=1e-8:side=direction;opened=stamp;symbol=d['symbol'];price=fees=volume=0
   price=(price*volume+d['price']*size)/(volume+size);volume+=size;fees+=charge+d['swap']+d['profit']
   continue
  if volume<=1e-8 or not complete or side==direction or symbol!=d['symbol'] or (entry in (1,3) and size>volume+1e-8) or (entry==2 and size<volume-1e-8):
   issues.append((d['deal_ticket'],'context_unavailable','缺少完整开仓上下文，原始成交已保留；请扩大历史范围'))
   volume=fees=price=0;side=None;complete=False
   # An unknown INOUT starting position cannot establish the residual position size.
   continue
  closed=min(size,volume);allocated=fees*closed/volume
  closing_charge=charge*(closed/size) if entry==2 else charge
  trade={'deal_ticket':d['deal_ticket'],'position_id':d['position_id'],'symbol':d['symbol'],'side':'buy' if side==0 else 'sell','volume':round(closed,8),'open':price,'close':d['price'],'profit':d['profit']+d['swap']+closing_charge+allocated,'commission':closing_charge+allocated,'swap':d['swap'],'opened_server':opened,'closed_server':stamp,'closed':stamp-offset,'history_offset_seconds':offset,'time_basis':'utc','time_verified':False,'time_estimated':True,'history_status':'complete','context_proof':proof,'source':SCHEMA}
  trades.append(trade);fees-=allocated;volume=max(0,volume-closed)
  if entry==2:
   residual=max(0,size-closed);side=direction;opened=stamp;symbol=d['symbol'];price=d['price'];volume=residual;fees=charge-closing_charge
  elif volume<=1e-8:volume=fees=price=0;side=None
 return trades,issues

def ingest(db,person,data,now=None):
 now=time.time() if now is None else now
 allowed={'schema','account_key','account','server','currency','batch_id','range','deals','closed_trades','summary_status','checkpoint','server_offset_sec','clock','website_user_id','time_basis'}
 if set(data)-allowed:raise HistoryError('历史同步只接受成交及同步元数据，不接受余额、持仓或交易指令')
 if data.get('schema')!=SCHEMA:raise HistoryError('历史同步协议版本不支持')
 if data.get('time_basis','broker_server')!='broker_server':raise HistoryError('原始历史必须保留券商服务器时间')
 account,server,key=identity(data)
 batch=data.get('batch_id')
 if not isinstance(batch,str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,100}',batch):raise HistoryError('批次标识不正确')
 window=data.get('range');checkpoint=data.get('checkpoint')
 if not isinstance(window,dict) or not isinstance(checkpoint,dict):raise HistoryError('缺少历史窗口或确认游标')
 begin=number(window.get('from_server'),'from_server',1,4102444800,True);end=number(window.get('to_server'),'to_server',begin,4102444800,True)
 if end-begin>3660*86400:raise HistoryError('一次历史扫描范围不能超过十年')
 through=number(checkpoint.get('through_server'),'through_server',begin-1,end,True)
 if not isinstance(checkpoint.get('window_complete'),bool):raise HistoryError('window_complete 必须是布尔值')
 if checkpoint['window_complete'] and through!=end:raise HistoryError('完成的历史窗口必须确认到窗口结束')
 ticket(checkpoint.get('last_deal_ticket','0'),'last_deal_ticket',True)
 offset=number(data.get('server_offset_sec',0),'server_offset_sec',-43200,50400,True)
 currency=data.get('currency','')
 if not isinstance(currency,str) or len(currency)>12:raise HistoryError('货币标识不正确')
 raw=data.get('deals')
 if not isinstance(raw,list) or len(raw)>MAX_BATCH:raise HistoryError('每批最多 200 条原始成交')
 cleaned=[clean_deal(d,begin,end) for d in raw]
 if len({d['deal_ticket'] for d in cleaned})!=len(cleaned):raise HistoryError('同一批内成交标识重复')
 fingerprint=digest(encoded(data))
 old=db.execute('SELECT fingerprint,ack FROM mt5_history_batches WHERE person=? AND account_key=? AND batch_id=?',(person,key,batch)).fetchone()
 if old:
  if old['fingerprint']!=fingerprint:raise HistoryError('相同批次标识对应了不同数据',409)
  return json.loads(old['ack'])
 coverage,coverage_changed=_coverage(db,person,key,begin,through)
 touched=set();changed=0
 for d in cleaned:
  body=encoded(d);hash_value=digest(body)
  old=db.execute('SELECT position_id,fingerprint FROM mt5_raw_deals WHERE person=? AND account_key=? AND deal_ticket=?',(person,key,d['deal_ticket'])).fetchone()
  if old and old['fingerprint']==hash_value:continue
  if old:touched.add(old['position_id'])
  touched.add(d['position_id']);changed+=1
  db.execute('INSERT INTO mt5_raw_deals VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(person,account_key,deal_ticket) DO UPDATE SET position_id=excluded.position_id,time_msc_server=excluded.time_msc_server,payload=excluded.payload,fingerprint=excluded.fingerprint,updated=excluded.updated',(person,key,d['deal_ticket'],d['position_id'],d['time_msc_server'],body,hash_value,now))
 if coverage_changed:
  touched.update(r['position_id'] for r in db.execute('SELECT DISTINCT position_id FROM mt5_raw_deals WHERE person=? AND account_key=? AND time_msc_server>=? AND time_msc_server<?',(person,key,begin*1000,(through+1)*1000)))
 derived=0;invalidated=0
 for position in touched:
  rows=[json.loads(r['payload']) for r in db.execute('SELECT payload FROM mt5_raw_deals WHERE person=? AND account_key=? AND position_id=? ORDER BY time_msc_server',(person,key,position))]
  trades,issues=summarize(rows,offset,coverage)
  for row in rows:db.execute('DELETE FROM mt5_history_issues WHERE person=? AND account_key=? AND deal_ticket=?',(person,key,row['deal_ticket']))
  current={trade_id(key,t['deal_ticket']) for t in trades}
  # Keep source rows and annotations when corrected broker data removes a previously
  # valid derivation. Do not delete parent trades referenced by notes/reviews/shares.
  for old in db.execute('SELECT ticket,payload FROM trades WHERE person=?',(person,)).fetchall():
   payload=json.loads(old['payload'])
   if payload.get('source')!=SCHEMA or payload.get('source_account_key')!=key or payload.get('position_id')!=position or old['ticket'] in current:continue
   if payload.get('history_status')=='invalidated':continue
   payload.update(history_status='invalidated',profit=None,closed=None,time_verified=False,time_estimated=False,invalidation_reason='原始成交或历史完整性证据已改变，原派生结果不再有效')
   db.execute('UPDATE trades SET payload=? WHERE person=? AND ticket=?',(encoded(payload),person,old['ticket']));invalidated+=1
  for t in trades:
   t.update(ticket=trade_id(key,t['deal_ticket']),account=account,server=server,currency=currency,source_account_key=key)
   db.execute('INSERT INTO trades VALUES(?,?,?) ON CONFLICT(person,ticket) DO UPDATE SET payload=excluded.payload',(person,t['ticket'],encoded(t)));derived+=1
  for deal,status,reason in issues:
   db.execute('INSERT OR REPLACE INTO mt5_history_issues VALUES(?,?,?,?,?)',(person,key,deal,status,reason))
 warnings=[dict(r) for r in db.execute('SELECT deal_ticket,status,reason FROM mt5_history_issues WHERE person=? AND account_key=? LIMIT 20',(person,key))]
 issue_count=db.execute('SELECT count(*) FROM mt5_history_issues WHERE person=? AND account_key=?',(person,key)).fetchone()[0]
 ack={'ok':True,'schema':SCHEMA,'batch_id':batch,'account_key':key,'account':account,'server':server,'accepted':len(cleaned),'changed':changed,'closed_trades_updated':derived,'closed_trades_invalidated':invalidated,'summary_status':'warnings' if issue_count else 'complete','summary_warnings':issue_count,'issues':warnings,'checkpoint':checkpoint}
 db.execute('INSERT INTO mt5_history_batches VALUES(?,?,?,?,?,?)',(person,key,batch,fingerprint,encoded(ack),now))
 db.execute('DELETE FROM mt5_history_batches WHERE person=? AND account_key=? AND batch_id NOT IN (SELECT batch_id FROM mt5_history_batches WHERE person=? AND account_key=? ORDER BY updated DESC LIMIT 5000)',(person,key,person,key))
 return ack

def _reviewable(trade):
 return trade.get('source')==SCHEMA and trade.get('history_status')=='complete' and all(trade.get(k) for k in ('account','server','source_account_key','ticket','symbol','opened_server','closed_server'))

def queue_review_jobs(db,person):
 pending=0;candidates=[]
 for row in db.execute('SELECT t.ticket,t.payload,r.status FROM trades t LEFT JOIN trade_reviews r ON r.person=t.person AND r.ticket=t.ticket WHERE t.person=?',(person,)):
  trade=json.loads(row['payload'])
  if not _reviewable(trade):continue
  if row['status']=='pending':pending+=1
  elif row['status'] is None:candidates.append(trade)
 for i,trade in enumerate(sorted(candidates,key=lambda t:t['closed_server'],reverse=True)[:max(0,20-pending)]):
  db.execute("INSERT OR IGNORE INTO trade_reviews VALUES(?,?,'pending',NULL,?)",(person,trade['ticket'],time.time()+i*.001))

def review_job(db,person):
 for row in db.execute("SELECT t.payload FROM trade_reviews r JOIN trades t ON t.person=r.person AND t.ticket=r.ticket WHERE r.person=? AND r.status='pending' ORDER BY r.updated",(person,)):
  trade=json.loads(row['payload'])
  if _reviewable(trade):return {k:trade[k] for k in ('ticket','symbol','opened_server','closed_server','account','server','source_account_key')}
 return None

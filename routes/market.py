"""Market HTTP endpoints."""
import json,time
import bars,market_symbols,bar_sync_jobs,trade_store
from http_errors import Error

def get_market_symbols(self,db,u,q):
 uid=u['id']
 # 与行情读取共用登录权限和 source 范围；只返回原始代码，不暴露账户。
 feed=bars.feed_of(db,uid)
 source=str(q.get('source',[''])[0]) or (feed['source'] if feed else '')
 if not source:source=bars.public_source(db) or ''
 return self.reply({'source':source,**market_symbols.read(db,uid,source),'public':not feed or source!=feed['source']})

def get_market_sync_jobs(self,db,u,q):
 uid=u['id']
 return self.reply(bar_sync_jobs.status(db,uid,str(q.get('symbol',[''])[0]) or None,str(q.get('transport',['syncnote'])[0]),str(q.get('account_key',[''])[0]) or None))

def get_market_forming_bars(self,db,u,q):
 uid=u['id']
 source=q.get('source',[''])[0];symbol=q.get('symbol',[''])[0]
 feed=bars.feed_of(db,uid)
 link=db.execute('SELECT token_hash FROM mt5_links WHERE user_id=?',(uid,)).fetchone()
 rows={}
 if feed and feed['source']==source and link and link['token_hash']:
  rows=self.forming.read((uid,feed['account_key'],link['token_hash']),symbol,time.time())
 return self.reply({'source':source,'symbol':symbol,'bars':rows})

def get_market_bars(self,db,u,q):
 uid=u['id']
 # 「行情」页 / 没有 MT5 的用户：优先自己那条券商轨，其次公共轨（只读）。
 # `limit=N&before=UTC秒`：同轨道向前按根数分页，不按日历窗口切。
 symbol=str(q.get('symbol',['XAUUSD'])[0] or 'XAUUSD')[:64]
 tf=str(q.get('tf',['M15'])[0])
 requested=str(q.get('source',[''])[0])
 feed=bars.feed_of(db,uid)
 source=requested or (feed['source'] if feed else '')
 if not source:source=bars.public_source(db,symbol) or ''
 if not source:raise Error('服务器上还没有这个品种的 K 线数据',404)
 is_public=not feed or source!=feed['source']
 counted=bool(q.get('limit'))
 if q.get('before') and not counted:raise Error('向前翻页需指定 limit')
 if counted:
  try:
   limit=int(q['limit'][0]);before=int(q['before'][0]) if q.get('before') else None
  except ValueError:raise Error('根数或翻页时间不正确')
  if limit<1 or (before is not None and not 1<=before<=32535215999):raise Error('根数或翻页时间不正确')
  try:payload=bars.latest_utc(db,source,symbol,tf,limit,time.time(),before)
  except bars.BarsError as error:raise Error(error.text,error.code)
 else:
  try:
   start=int(q.get('from',['0'])[0]);end=int(q.get('to',['0'])[0])
  except ValueError:raise Error('时间范围不正确')
  if end<=start:raise Error('时间范围不正确')
  try:payload=bars.read_utc(db,source,symbol,tf,start,end,time.time())
  except bars.BarsError as error:raise Error(error.text,error.code)
 last=db.execute('SELECT max(t) FROM bars WHERE source=? AND symbol=? AND tf=?',(source,symbol,payload['tf'])).fetchone()[0]
 entry=bars.catalog_entry(db,source,symbol) or {}
 payload['feed']={'source':source,'server':entry.get('server',''),'account':'' if is_public else feed['account']}
 payload['public']=is_public
 shift=bars.source_offset(db,source)
 payload['last_bar']=(int(last)-shift) if last else last
 return self.reply(payload)

def get_market_coverage(self,db,u,q):
 uid=u['id']
 # 回填调度器查：这条券商轨某周期在 [from,to] 里还有哪些段没填（have/empty 都算已扫）。
 # 墙钟进墙钟出；前端按券商墙钟切窗口，不在这里换 UTC。
 feed=bars.feed_of(db,uid)
 source=feed['source'] if feed else ''
 if not source:raise Error('请先连接本机 MT5 绑定账户',409)
 if q.get('source') and q['source'][0]!=source:raise Error('当前绑定券商轨道已改变',409)
 symbol=str(q.get('symbol',['XAUUSD'])[0] or 'XAUUSD')[:64]
 tf=bars.normalize_tf(str(q.get('tf',['M1'])[0]))
 if not tf:raise Error('周期不正确')
 try:start=int(q.get('from',['0'])[0]);end=int(q.get('to',['0'])[0])
 except ValueError:raise Error('时间范围不正确')
 if start<=0 or end<start:raise Error('时间范围不正确')
 holes=bars.backfill_missing(db,source,feed['account_key'],symbol,tf,start,end)
 return self.reply({'source':source,'symbol':symbol,'tf':tf,'missing':[{'from':h[0],'to':h[1]} for h in holes]})

def get_market_earliest(self,db,u,q):
 uid=u['id']
 # 回填起点：本账户最早一笔交易的开仓墙钟。前端据此退 100 根、再夹 5 年上限。
 earliest=None
 for r in trade_store.history_rows(db,uid):
  try:t=json.loads(r['payload']).get('opened_server')
  except (ValueError,TypeError):t=None
  if isinstance(t,(int,float)) and t>0 and (earliest is None or t<earliest):earliest=int(t)
 return self.reply({'earliest_server':earliest})

def get_data_sources(self,db,u,q):
 uid=u['id']
 # 数据源目录：公共轨 + 自己那条轨，附带每个周期的覆盖/根数。
 # 第三类用户（没有 MT5）靠它选数据、自己复盘。
 feed=bars.feed_of(db,uid)
 mine=feed['source'] if feed else None
 rows=[]
 for entry in bars.catalog(db):
  rows.append({
   'id':entry['source'],
   'kind':'personal' if entry['source']==mine else 'public',
   'server':entry['server'],
   'symbol':entry['symbol'],
   'bars':entry['bars'],
   'last_bar':entry['last_bar']-bars.source_offset(db,entry['source']),
   'tfs':{tf:{'from':info['from']-bars.source_offset(db,entry['source']),
     'to':info['to']-bars.source_offset(db,entry['source']),
     'bars':info['bars']} for tf,info in entry['tfs'].items()},
   'can_draw':True,
   'can_review':True,
  })
 return self.reply({'sources':rows,'personal':mine})

GET={'/api/market/symbols':get_market_symbols,'/api/market/sync-jobs':get_market_sync_jobs,'/api/market/forming-bars':get_market_forming_bars,'/api/market/bars':get_market_bars,'/api/market/coverage':get_market_coverage,'/api/market/earliest':get_market_earliest,'/api/data/sources':get_data_sources}

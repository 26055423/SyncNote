"""Account-private MT5 symbol directories; complete paged snapshots replace atomically."""
import json,re,time
import bars,sync_history

class CatalogError(Exception):
 def __init__(self,text,code=400):self.text=text;self.code=code;super().__init__(text)

def initialize(db):
 db.executescript('''
 CREATE TABLE IF NOT EXISTS mt5_symbol_catalogs(user_id TEXT PRIMARY KEY,account_key TEXT NOT NULL,source TEXT NOT NULL,token_hash TEXT NOT NULL,catalog_id TEXT NOT NULL,total INTEGER NOT NULL,payload TEXT NOT NULL,updated REAL NOT NULL);
 CREATE TABLE IF NOT EXISTS mt5_symbol_uploads(user_id TEXT PRIMARY KEY,account_key TEXT NOT NULL,token_hash TEXT NOT NULL,catalog_id TEXT NOT NULL,total INTEGER NOT NULL,payload TEXT NOT NULL,updated REAL NOT NULL);
 ''')

def integer(value,name,minimum,maximum):
 if type(value) is not int or not minimum<=value<=maximum:raise CatalogError('品种目录参数不正确：'+name)
 return value

def text(value,name,maximum,empty=True):
 if not isinstance(value,str) or len(value)>maximum or (not empty and not value) or any(ord(c)<32 for c in value):raise CatalogError('品种目录字段不正确：'+name)
 return value

def clean_symbol(raw):
 if not isinstance(raw,dict) or set(raw)-{'symbol','description','path','trade_mode','digits'}:raise CatalogError('品种目录字段不正确')
 return {'symbol':text(raw.get('symbol'),'symbol',128,False),'description':text(raw.get('description',''),'description',256),'path':text(raw.get('path',''),'path',512),
         'trade_mode':integer(raw.get('trade_mode',0),'trade_mode',0,4),'digits':integer(raw.get('digits',0),'digits',0,16)}

def ingest(db,link,data,now=None):
 now=time.time() if now is None else now
 account,server,key=sync_history.identity(data)
 if not link['account_key'] or link['account_key']!=key:raise CatalogError('连接码未绑定此 MT5 账户',403)
 if not link['token_hash']:raise CatalogError('连接码无效或已撤销',401)
 catalog_id=text(data.get('catalog_id'),'catalog_id',80,False)
 if not re.fullmatch(r'[A-Za-z0-9_.:-]+',catalog_id):raise CatalogError('品种目录批次标识不正确')
 offset=integer(data.get('offset'),'offset',0,20000);total=integer(data.get('total'),'total',0,20000)
 raw=data.get('symbols')
 if not isinstance(raw,list) or len(raw)>200 or offset+len(raw)>total or (not raw and total!=0):raise CatalogError('品种目录分页范围不正确')
 rows=[clean_symbol(item) for item in raw]
 if len({r['symbol'] for r in rows})!=len(rows):raise CatalogError('品种目录包含重复代码')
 uid=link['user_id'];token=link['token_hash'];source=bars.source_for(server)
 end=offset+len(rows)
 ack={'ok':True,'catalog_id':catalog_id,'offset':offset,'next_offset':end,'total':total,'complete':end==total,'account_key':key}
 existing=db.execute('SELECT * FROM mt5_symbol_catalogs WHERE user_id=?',(uid,)).fetchone()
 if existing and existing['catalog_id']==catalog_id and existing['account_key']==key and existing['token_hash']==token:
  current=json.loads(existing['payload'])
  if existing['total']!=total or current[offset:end]!=rows:raise CatalogError('同一目录批次内容已改变',409)
  return ack
 pending=db.execute('SELECT * FROM mt5_symbol_uploads WHERE user_id=?',(uid,)).fetchone()
 same=pending and pending['account_key']==key and pending['token_hash']==token and pending['catalog_id']==catalog_id
 if same:
  if pending['total']!=total:raise CatalogError('目录批次总数已改变',409)
  collected=json.loads(pending['payload'])
  if offset<len(collected):
   if end>len(collected) or collected[offset:end]!=rows:raise CatalogError('同一目录分页内容已改变',409)
   return ack
  if offset!=len(collected):raise CatalogError('品种目录分页不连续',409)
 else:
  if offset!=0:raise CatalogError('请从目录第一页重新同步',409)
  collected=[]
 names={r['symbol'] for r in collected}
 if any(r['symbol'] in names for r in rows):raise CatalogError('品种目录包含重复代码')
 collected.extend(rows);payload=json.dumps(collected,ensure_ascii=False,separators=(',',':'))
 if end==total:
  db.execute('INSERT INTO mt5_symbol_catalogs VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET account_key=excluded.account_key,source=excluded.source,token_hash=excluded.token_hash,catalog_id=excluded.catalog_id,total=excluded.total,payload=excluded.payload,updated=excluded.updated',(uid,key,source,token,catalog_id,total,payload,now))
  db.execute('DELETE FROM mt5_symbol_uploads WHERE user_id=?',(uid,))
 else:
  db.execute('INSERT INTO mt5_symbol_uploads VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET account_key=excluded.account_key,token_hash=excluded.token_hash,catalog_id=excluded.catalog_id,total=excluded.total,payload=excluded.payload,updated=excluded.updated',(uid,key,token,catalog_id,total,payload,now))
 return ack

def read(db,uid,source):
 stored={row['symbol']:{**row,'has_bars':True} for row in bars.symbols(db,source)}
 row=db.execute('SELECT c.* FROM mt5_symbol_catalogs c JOIN mt5_links l ON l.user_id=c.user_id AND l.account_key=c.account_key AND l.token_hash=c.token_hash WHERE c.user_id=? AND c.source=? AND l.token_hash IS NOT NULL',(uid,source)).fetchone()
 if row:
  for item in json.loads(row['payload']):stored[item['symbol']]={**item,'has_bars':item['symbol'] in stored}
 return {'symbols':[stored[key] for key in sorted(stored)],'catalog_available':bool(row),'catalog_updated':row['updated'] if row else None}

"""Reproducible synthetic SQLite workload; never reads production DATA_DIR."""
import argparse,json,platform,statistics,sys,tempfile,time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import bars,chart,database,migrations
from review_service import history_for

def run(users=100,trades=500,bar_count=100000,workers=8,requests=160):
 with tempfile.TemporaryDirectory(prefix='syncnote-capacity-') as folder:
  path=Path(folder)/'board.sqlite3';migrations.migrate(path)
  with database.connect(path) as db:
   for user in range(users):
    uid='synthetic-'+str(user)
    db.execute('INSERT INTO users(id,username,nickname,password,created) VALUES(?,?,?,?,0)',(uid,uid,uid,'not-a-login-hash'))
    db.executemany('INSERT INTO trades VALUES(?,?,?)',((uid,str(i),json.dumps({'ticket':str(i),'symbol':'XAUUSD','open':100,'close':101,'profit':1,'closed':1700000000+i,'closed_server':1700000000+i,'time_basis':'utc','history_status':'complete','source':'syncnote-history.v1'})) for i in range(trades)))
   db.execute("INSERT INTO source_clock VALUES('srv:Synthetic',0,0)")
   db.executemany('INSERT INTO bars VALUES(?,?,?,?,?,?,?,?,?,?)',(('srv:Synthetic','XAUUSD','M1',1600000020+i*60,100,102,99,101,1,1700000000) for i in range(bar_count)))
   started=time.perf_counter();bars.refresh_catalog(db);catalog_ms=(time.perf_counter()-started)*1000
   if users>1:
    for i in range(min(trades,50)):chart.share(db,'synthetic-0',str(i),['synthetic-1'],'Synthetic review')
  operations=('history','bars','inbox','write')
  def sample(index):
   operation=operations[index%len(operations)];start=time.perf_counter();error=None
   try:
    with database.connect(path) as db:
     if operation=='history':history_for(db,'synthetic-'+str(index%users))
     elif operation=='bars':bars.latest_utc(db,'srv:Synthetic','XAUUSD','M1',2000,time.time())
     elif operation=='inbox':chart.inbox(db,'synthetic-1')
     else:db.execute('INSERT INTO presence VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET updated=excluded.updated',('synthetic-'+str(index%users),time.time()))
   except Exception as failure:error=type(failure).__name__
   return operation,(time.perf_counter()-start)*1000,error
  start=time.perf_counter()
  with ThreadPoolExecutor(max_workers=workers) as pool:results=list(pool.map(sample,range(requests)))
  elapsed=time.perf_counter()-start;summary={}
  for operation in operations:
   values=sorted(row[1] for row in results if row[0]==operation)
   summary[operation]={'count':len(values),'p50_ms':round(statistics.median(values),2),'p95_ms':round(values[min(len(values)-1,int(len(values)*.95))],2),'max_ms':round(max(values),2)}
  return {'python':platform.python_version(),'platform':platform.system()+' '+platform.machine(),'synthetic_only':True,'users':users,'trades_per_user':trades,'bars':bar_count,'workers':workers,'requests':requests,'elapsed_seconds':round(elapsed,2),'operations_per_second':round(requests/elapsed,2),'catalog_refresh_ms':round(catalog_ms,2),'database_mb':round(path.stat().st_size/1048576,2),'errors':[error for _,_,error in results if error],'operations':summary}

if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__)
 for name,default in [('users',100),('trades',500),('bars',100000),('workers',8),('requests',160)]:parser.add_argument('--'+name,type=int,default=default)
 args=parser.parse_args()
 if min(args.users,args.trades,args.bars,args.workers)<1 or args.requests<4:parser.error('Positive sizes and at least four requests required')
 result=run(args.users,args.trades,args.bars,args.workers,args.requests)
 print(json.dumps(result,ensure_ascii=False,indent=2));sys.exit(bool(result['errors']))

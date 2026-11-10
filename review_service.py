"""Trade/review read models and broker-scoped market data."""
import json,time
import bars,trade_store
from trade_time import utc_trade

def history_for(db,person):
 clock=db.execute('SELECT * FROM broker_clocks WHERE person=?',(person,)).fetchone()
 rows=[json.loads(row[0]) for row in trade_store.history_rows(db,person)]
 history=[utc_trade(row,clock) for row in rows if row.get('history_status') not in ('invalidated','context_unavailable','context_unverified')]
 return sorted(history,key=lambda row:(row.get('closed') is not None,row.get('closed') or 0),reverse=True)

def history_snapshot(db,person,live_data=None):
 """Account freshness and persisted trade-history acknowledgements are separate clocks."""
 history=history_for(db,person)
 synced=db.execute('SELECT max(updated) FROM mt5_history_batches WHERE person=?',(person,)).fetchone()[0]
 snap=db.execute('SELECT payload,updated FROM snapshots WHERE person=?',(person,)).fetchone()
 if live_data:
  data=dict(live_data);updated=time.time()
 elif snap:
  data=json.loads(snap['payload']);updated=snap['updated']
 elif history or synced is not None:
  data={'source':'history-only','online':False,'positions':[]}
  updated=synced if synced is not None else max((t.get('closed') or 0 for t in history),default=0)
 else:return None
 # A hub keeps only its latest 500 trades. It must not hide the full persisted journal.
 data['history']=history
 return {'data':data,'updated':updated,'history_synced_at':synced}

def review_market_source(db,person,trade):
 source=bars.source_of_trade(trade)
 if source:return source
 feed=bars.feed_of(db,person)
 return feed['source'] if feed else None

def review_bars(db,person,trade,data,now):
 """复盘上传顺带回填 K 线（P0 不新增 EA 端点）。回填失败不影响复盘本身。"""
 source=bars.source_of_trade(trade or {})
 symbol=str((trade or {}).get('symbol') or '')
 if not source or not symbol:return None
 series=bars.series_from_review(data.get('charts'),data.get('errors'))
 if not series:return None
 try:return bars.ingest(db,source,str((trade or {}).get('source_account_key') or ''),symbol,series,now)
 except (bars.BarsError,ValueError,TypeError):return None

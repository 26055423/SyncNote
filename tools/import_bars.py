"""把 tools/export_market_bars.py 导出的 CSV.gz 灌进 bars 表。

用法（在服务器上跑，需先停服务避免并发写）::

    sudo systemctl stop syncnote
    sudo -u tongpin python3 tools/import_bars.py \
        --db /SyncTrade/data/board.sqlite3 \
        --dir /SyncTrade/data/import/xauusd \
        --server EasyTradingOnlineLtd-Server --account 510715 --symbol XAUUSD
    sudo systemctl start syncnote

- `t` 原样保留（券商服务器墙钟秒），与 bars.read 的口径一致；
- 按 `(source, symbol, tf, t)` 主键 upsert，重复运行安全；
- 每个文件导入完写一条 `have` 覆盖（整段区间），后续复盘只会补缺口。
"""

import argparse
import csv
import gzip
import os
import sqlite3
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import bars  # noqa: E402

BATCH = 20000


def load_file(db, path, tf, source, account_key, symbol, now):
  count = 0
  inserted = 0
  first = None
  last = None
  buffer = []
  period = bars.tf_seconds(tf)

  def flush():
    nonlocal buffer, inserted
    if not buffer:
      return
    db.executemany(
      'INSERT INTO bars(source,symbol,tf,t,o,h,l,c,v,updated) VALUES(?,?,?,?,?,?,?,?,?,?)'
      ' ON CONFLICT(source,symbol,tf,t) DO UPDATE SET o=excluded.o,h=excluded.h,l=excluded.l,c=excluded.c,v=excluded.v,updated=excluded.updated',
      [(source, symbol, tf) + tuple(row) + (now,) for row in buffer],
    )
    inserted += len(buffer)
    buffer = []

  with gzip.open(path, 'rt', encoding='utf-8', newline='') as handle:
    reader = csv.reader(handle)
    header = next(reader, None)
    if not header or header[0] != 't':
      raise SystemExit('表头不正确: ' + path)
    for row in reader:
      if len(row) < 5:
        continue
      t = int(row[0])
      if t + period > now:
        continue
      buffer.append([t, float(row[1]), float(row[2]), float(row[3]), float(row[4]), float(row[5]) if len(row) > 5 else 0.0])
      count += 1
      if first is None:
        first = t
      last = t
      if len(buffer) >= BATCH:
        flush()
        db.commit()
  flush()
  db.commit()
  if first is not None:
    bars.mark_coverage(db, source, symbol, tf, first, last, 'have', now)
    db.commit()
  return {'tf': tf, 'rows': count, 'inserted': inserted, 'from': first, 'to': last}


def main():
  parser = argparse.ArgumentParser(description='导入 K 线 CSV.gz 到 bars 表')
  parser.add_argument('--db', required=True)
  parser.add_argument('--dir', required=True)
  parser.add_argument('--server', required=True)
  parser.add_argument('--account', required=True)
  parser.add_argument('--symbol', default='XAUUSD')
  args = parser.parse_args()

  if not os.path.isfile(args.db):
    raise SystemExit('找不到数据库: ' + args.db)
  now = time.time()
  db = sqlite3.connect(args.db)
  db.row_factory = sqlite3.Row
  bars.initialize(db)
  feed = bars.ensure_feed(db, args.server, args.account, now)
  db.commit()
  print('source:', feed['source'])

  total = 0
  for name in sorted(os.listdir(args.dir)):
    if not name.endswith('.csv.gz'):
      continue
    tf = bars.normalize_tf(name.rsplit('_', 1)[-1][:-len('.csv.gz')])
    if not tf:
      print('skip:', name)
      continue
    started = time.time()
    result = load_file(db, os.path.join(args.dir, name), tf, feed['source'], feed['account_key'], args.symbol.upper(), now)
    total += result['rows']
    print('%-4s %8d rows  %.1fs  %s -> %s' % (result['tf'], result['rows'], time.time() - started, result['from'], result['to']), flush=True)
  print('total rows:', total)
  print('bars in db:', db.execute('SELECT count(*) FROM bars WHERE source=?', (feed['source'],)).fetchone()[0])
  db.close()


if __name__ == '__main__':
  main()

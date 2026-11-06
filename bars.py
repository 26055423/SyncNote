"""K 线序列：按行情来源（source）累积，供复盘/行情按需读取。

设计见 docs/K线数据与复盘覆盖方案.md。三条不变量：

1. **一屏一源**：一块画布只用一个 source 的 K 线，不拼接、不补偿。
2. **只落已收盘**：`t + 周期 <= now` 的 bar 才入库；正在形成的那根不算覆盖。
3. **覆盖显式记录**：`have`/`empty` 是 source 级的（同券商共享），`failed` 是账户级的（可重试）。
"""

import hashlib
import json
import math
import re
import time

TF_SECONDS = {'M1': 60, 'M5': 300, 'M15': 900, 'M30': 1800, 'H1': 3600, 'H4': 14400, 'D1': 86400}
TF_ALIASES = {'1m': 'M1', '5m': 'M5', '15m': 'M15', '30m': 'M30', '1h': 'H1', '4h': 'H4', '1d': 'D1', '1D': 'D1'}
MAX_BARS_PER_SERIES = 2000
MAX_RANGE_SECONDS = 3660 * 86400
MIN_GAP_BARS = 30
BAR_ROUND = 6

SCHEMA = 'syncnote-bars.v1'


class BarsError(Exception):
  def __init__(self, text, code=400):
    self.text, self.code = text, code


def initialize(db):
  db.executescript('''
  CREATE TABLE IF NOT EXISTS feeds(
    account_key TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    server TEXT NOT NULL DEFAULT '',
    account TEXT NOT NULL DEFAULT '',
    updated REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_feeds_source ON feeds(source);
  CREATE TABLE IF NOT EXISTS bars(
    source TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL, t INTEGER NOT NULL,
    o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL DEFAULT 0,
    updated REAL NOT NULL,
    PRIMARY KEY(source, symbol, tf, t)
  );
  CREATE TABLE IF NOT EXISTS bar_coverage(
    source TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL,
    from_t INTEGER NOT NULL, to_t INTEGER NOT NULL, state TEXT NOT NULL, updated REAL NOT NULL,
    PRIMARY KEY(source, symbol, tf, from_t)
  );
  CREATE TABLE IF NOT EXISTS bar_attempt(
    account_key TEXT NOT NULL, source TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL,
    from_t INTEGER NOT NULL, to_t INTEGER NOT NULL, state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 1, updated REAL NOT NULL,
    PRIMARY KEY(account_key, source, symbol, tf, from_t)
  );
  -- 每条券商轨的时区偏移：bars 里存的是券商墙钟，出库时统一减掉它换成 UTC。
  CREATE TABLE IF NOT EXISTS source_catalog(
    source TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL,
    first_t INTEGER NOT NULL, last_t INTEGER NOT NULL, bars INTEGER NOT NULL,
    updated REAL NOT NULL, PRIMARY KEY(source, symbol, tf)
  );
  CREATE TABLE IF NOT EXISTS source_clock(
    source TEXT PRIMARY KEY,
    offset_sec INTEGER NOT NULL,
    updated REAL NOT NULL
  );
  ''')


# ---------------------------------------------------------------- 身份

def normalize_tf(name):
  if not isinstance(name, str):
    return None
  value = name.strip()
  if value in TF_SECONDS:
    return value
  return TF_ALIASES.get(value)


def tf_seconds(tf):
  return TF_SECONDS[tf]


def account_key(server, account):
  return hashlib.sha256((str(server) + '\n' + str(account)).encode('utf-8')).hexdigest()


def source_for(server):
  name = str(server or '').strip()
  if not name or len(name) > 160 or any(ord(c) < 32 for c in name):
    raise BarsError('券商服务器标识不正确')
  return 'srv:' + name


def bind_feed(db, person, account, server, now=None):
  """账户 → source 的映射。同一个网站账号只能绑一个 MT5 账户（新架构不做旧的占位迁移）。"""
  now = time.time() if now is None else now
  feed = ensure_feed(db, server, account, now)
  row = db.execute('SELECT account_key FROM mt5_links WHERE user_id=?', (person,)).fetchone()
  if row and row['account_key'] and row['account_key'] != feed['account_key']:
    raise BarsError('此网站账号已绑定其他 MT5 账户，请先在个人中心解除连接', 409)
  db.execute('UPDATE mt5_links SET account_key=?,updated=? WHERE user_id=?', (feed['account_key'], now, person))
  # 顺手记下这条轨的时区偏移，出库时用它把墙钟换成 UTC。
  clock = db.execute('SELECT offset FROM broker_clocks WHERE person=?', (person,)).fetchone()
  if clock and isinstance(clock['offset'], (int, float)):
    set_source_offset(db, feed['source'], int(clock['offset']), now)
  return feed


def set_source_offset(db, source, offset_sec, now=None):
  """记住某条券商轨的墙钟偏移（秒）。0 表示该源本来就是 UTC。"""
  now = time.time() if now is None else now
  db.execute(
    'INSERT INTO source_clock(source,offset_sec,updated) VALUES(?,?,?)'
    ' ON CONFLICT(source) DO UPDATE SET offset_sec=excluded.offset_sec,updated=excluded.updated',
    (source, int(offset_sec), now),
  )
  return int(offset_sec)


def source_offset(db, source):
  """这条轨的墙钟偏移：统一交给 trade_time.offset_for（规则 → 观测 → 0）。"""
  try:
    import trade_time
    return trade_time.offset_for(db, source)
  except Exception:
    return 0


def to_utc(bars_payload, offset_sec):
  """把按墙钟出的 K 线整段减掉偏移，统一成 UTC（缺省不改）。"""
  if not offset_sec:
    return bars_payload
  rows = bars_payload.get('bars') or []
  for row in rows:
    if row and isinstance(row[0], (int, float)):
      row[0] = int(row[0]) - int(offset_sec)
  for field in ('from_server', 'to_server', 'earliest', 'next_before', 'next_after'):
    if isinstance(bars_payload.get(field), (int, float)):
      bars_payload[field] = int(bars_payload[field]) - int(offset_sec)
  missing = bars_payload.get('missing') or []
  bars_payload['missing'] = [
    {'from': int(item['from']) - int(offset_sec), 'to': int(item['to']) - int(offset_sec)}
    for item in missing if isinstance(item, dict) and 'from' in item and 'to' in item
  ]
  for item in bars_payload.get('covered') or []:
    if isinstance(item, dict) and 'from' in item and 'to' in item:
      item['from'] = int(item['from']) - int(offset_sec)
      item['to'] = int(item['to']) - int(offset_sec)
  bars_payload['offset_sec'] = int(offset_sec)
  return bars_payload


def ensure_feed(db, server, account, now=None):
  """只登记 feed（导入历史数据时用，不需要绑定到某个用户）。"""
  now = time.time() if now is None else now
  key = account_key(server, account)
  source = source_for(server)
  db.execute(
    'INSERT INTO feeds(account_key,source,server,account,updated) VALUES(?,?,?,?,?)'
    ' ON CONFLICT(account_key) DO UPDATE SET source=excluded.source,server=excluded.server,account=excluded.account,updated=excluded.updated',
    (key, source, str(server), str(account), now),
  )
  return {'account_key': key, 'source': source, 'server': str(server), 'account': str(account)}


def feed_of(db, person):
  row = db.execute(
    'SELECT f.* FROM mt5_links l JOIN feeds f ON f.account_key=l.account_key WHERE l.user_id=?',
    (person,),
  ).fetchone()
  return row


def source_of_trade(trade):
  """交易 payload 里有 server 就用它算 source；没有就返回 None（退回 payload 快照）。"""
  server = trade.get('server')
  if not server:
    return None
  try:
    return source_for(server)
  except BarsError:
    return None


def series_from_review(charts, errors=None):
  """把 EA 复盘上传里的 `charts`（M1/M5/M15/H1）转成 ingest 需要的样子。

  复盘图的窗口就是这笔交易的四周期 K 线；它天然是“某个 source 在某个区间的采样”，
  所以第一版不需要新的 EA 端点，直接回收利用。
  """
  if not isinstance(charts, dict):
    return {}
  errors = errors if isinstance(errors, dict) else {}
  series = {}
  for name, rows in charts.items():
    tf = normalize_tf(name)
    if not tf or not isinstance(rows, list) or not rows:
      continue
    clean = []
    for row in rows:
      if isinstance(row, list) and len(row) >= 5:
        try:
          clean.append([int(row[0]), float(row[1]), float(row[2]), float(row[3]), float(row[4]),
                        float(row[5]) if len(row) > 5 else 0.0])
        except (TypeError, ValueError):
          continue
    if not clean:
      continue
    error = errors.get(name) or errors.get(tf) or None
    series[tf] = {
      'bars': clean,
      'complete': not error,
      'error': error,
      'from_server': clean[0][0],
      'to_server': clean[-1][0],
    }
  return series


# ---------------------------------------------------------------- 入库

def _number(value, name, minimum=-1e15, maximum=1e15):
  if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
    raise BarsError('K 线字段不正确：' + name)
  return float(value)


def _clean_bars(tf, rows, now):
  period = tf_seconds(tf)
  if not isinstance(rows, list) or len(rows) > MAX_BARS_PER_SERIES:
    raise BarsError('每个周期单次最多 %d 根' % MAX_BARS_PER_SERIES)
  out = []
  dropped = 0
  last = None
  for row in rows:
    if not isinstance(row, list) or len(row) < 5:
      dropped += 1
      continue
    try:
      t = int(row[0])
    except (TypeError, ValueError):
      dropped += 1
      continue
    if t <= 0 or (last is not None and t <= last):
      dropped += 1
      continue
    try:
      o = _number(row[1], 'open', 1e-9, 1e12)
      h = _number(row[2], 'high', 1e-9, 1e12)
      l = _number(row[3], 'low', 1e-9, 1e12)
      c = _number(row[4], 'close', 1e-9, 1e12)
      v = _number(row[5], 'volume', 0, 1e15) if len(row) > 5 else 0.0
    except BarsError:
      dropped += 1
      continue
    if h < l or o > h + 1e-6 or o < l - 1e-6 or c > h + 1e-6 or c < l - 1e-6:
      dropped += 1
      continue
    if t + period > now:  # 未收盘：不入库，也不算覆盖
      dropped += 1
      continue
    out.append((t, round(o, BAR_ROUND), round(h, BAR_ROUND), round(l, BAR_ROUND), round(c, BAR_ROUND), round(v, 2)))
    last = t
  return out, dropped


def _coverage_rows(db, source, symbol, tf):
  return [(r['from_t'], r['to_t'], r['state']) for r in db.execute(
    'SELECT from_t,to_t,state FROM bar_coverage WHERE source=? AND symbol=? AND tf=? ORDER BY from_t',
    (source, symbol, tf),
  )]


def _apply_coverage(db, source, symbol, tf, start, end, state, now):
  if end < start:
    return
  rows = _coverage_rows(db, source, symbol, tf)
  rows.append((start, end, state))
  # 同状态相邻合并；不同状态重叠时 have 优先（保留更"确定"的那个）
  rows.sort()
  merged = []
  for begin, close, current in rows:
    if merged:
      prev_begin, prev_close, prev_state = merged[-1]
      if begin <= prev_close + 1:
        if prev_state == current:
          merged[-1] = (prev_begin, max(prev_close, close), prev_state)
          continue
        if prev_state == 'have' or current == 'have':
          merged[-1] = (min(prev_begin, begin), max(prev_close, close), 'have')
          continue
        merged[-1] = (min(prev_begin, begin), max(prev_close, close), current)
        continue
    merged.append((begin, close, current))
  old = _coverage_rows(db, source, symbol, tf)
  if merged == old:
    return
  db.execute('DELETE FROM bar_coverage WHERE source=? AND symbol=? AND tf=?', (source, symbol, tf))
  db.executemany(
    'INSERT INTO bar_coverage(source,symbol,tf,from_t,to_t,state,updated) VALUES(?,?,?,?,?,?,?)',
    [(source, symbol, tf, begin, close, current, now) for begin, close, current in merged],
  )


def ingest(db, source, account_key_value, symbol, series, now=None):
  """写入一批 K 线。series 的键是周期别名（M1/1m…），值是 {bars, complete, error, from_server, to_server}。"""
  now = time.time() if now is None else now
  # 输入 K 线是券商墙钟；只有闭盘判断使用墙钟当前时间，审计 updated 仍为 UTC。
  wall_now = now + source_offset(db, source)
  if not isinstance(series, dict) or not series:
    raise BarsError('没有可入库的 K 线')
  symbol = str(symbol or '').strip()
  if not symbol or len(symbol) > 64:
    raise BarsError('品种标识不正确')
  summary = {}
  for name, payload in series.items():
    tf = normalize_tf(name)
    if not tf:
      continue
    if not isinstance(payload, dict):
      raise BarsError('K 线分段格式不正确：' + str(name))
    rows, dropped = _clean_bars(tf, payload.get('bars') or [], wall_now)
    error = payload.get('error')
    period = tf_seconds(tf)
    accepted = 0
    if rows:
      db.executemany(
        'INSERT INTO bars(source,symbol,tf,t,o,h,l,c,v,updated) VALUES(?,?,?,?,?,?,?,?,?,?)'
        ' ON CONFLICT(source,symbol,tf,t) DO UPDATE SET o=excluded.o,h=excluded.h,l=excluded.l,c=excluded.c,v=excluded.v,updated=excluded.updated',
        [(source, symbol, tf) + row + (now,) for row in rows],
      )
      accepted = len(rows)
    complete = payload.get('complete', True)
    begin = payload.get('from_server')
    end = payload.get('to_server')
    if not isinstance(begin, int) or not isinstance(end, int):
      begin, end = (rows[0][0], rows[-1][0]) if rows else (None, None)
    if isinstance(begin, int) and isinstance(end, int) and end >= begin:
      # 未收盘的部分不算“扫过”：被裁到最后一根已收盘 bar，避免把未来的一段标成
      # empty/have —— 那会让真正收盘后的那根永远补不回来。
      closed_end = min(end, wall_now - period)
      if begin > closed_end:
        summary[tf] = {'accepted': accepted, 'dropped': dropped, 'state': 'pending',
                       'from_server': begin, 'to_server': end, 'complete': bool(complete)}
        continue
      if error:
        db.execute(
          'INSERT INTO bar_attempt(account_key,source,symbol,tf,from_t,to_t,state,attempts,updated) VALUES(?,?,?,?,?,?,?,1,?)'
          ' ON CONFLICT(account_key,source,symbol,tf,from_t) DO UPDATE SET attempts=bar_attempt.attempts+1,state=excluded.state,updated=excluded.updated',
          (account_key_value or '', source, symbol, tf, begin, closed_end, 'failed', now),
        )
        state = 'failed'
      else:
        if complete:
          _apply_coverage(db, source, symbol, tf, begin, closed_end, 'have' if accepted else 'empty', now)
        elif accepted:
          # 未证明请求完整时，只登记真正收到的连续 K 线，不吞掉缺失前缀或内部缺口。
          run_start = last = None
          for row in rows:
            stamp = row[0]
            if stamp < begin or stamp > closed_end:
              continue
            if run_start is None:
              run_start = stamp
            elif stamp - last > period:
              _apply_coverage(db, source, symbol, tf, run_start, last, 'have', now)
              run_start = stamp
            last = stamp
          if run_start is not None:
            _apply_coverage(db, source, symbol, tf, run_start, last, 'have', now)
        state = 'have' if accepted else 'empty' if complete else 'pending'
        if account_key_value:
          db.execute(
            'INSERT INTO bar_attempt(account_key,source,symbol,tf,from_t,to_t,state,attempts,updated) VALUES(?,?,?,?,?,?,?,1,?)'
            ' ON CONFLICT(account_key,source,symbol,tf,from_t) DO UPDATE SET attempts=bar_attempt.attempts+1,state=excluded.state,updated=excluded.updated',
            (account_key_value, source, symbol, tf, begin, end, 'ok' if complete else 'partial', now),
          )
      summary[tf] = {'accepted': accepted, 'dropped': dropped, 'state': state,
                     'from_server': begin, 'to_server': end, 'complete': bool(complete)}
    else:
      summary[tf] = {'accepted': accepted, 'dropped': dropped, 'state': 'have' if accepted else 'empty' if complete else 'pending',
                     'from_server': None, 'to_server': None, 'complete': bool(complete)}
  if not summary:
    raise BarsError('没有可识别的周期')
  return {'ok': True, 'schema': SCHEMA, 'symbol': symbol, 'source': source, 'series': summary}


# ---------------------------------------------------------------- 读取

def _coverage(db, source, symbol, tf, start, end):
  out = []
  for begin, close, state in _coverage_rows(db, source, symbol, tf):
    if close < start or begin > end:
      continue
    out.append((max(begin, start), min(close, end), state))
  return out


def missing(db, source, symbol, tf, start, end):
  """[start,end] 里没被扫过的区间（have 和 empty 都算扫过）。

  这里**不合并碎片**：调用方（前端提示、EA 任务）自己决定多小的洞才值得请求。
  """
  covered = sorted((begin, close) for begin, close, _state in _coverage(db, source, symbol, tf, start, end))
  holes = []
  cursor = start
  for begin, close in covered:
    if begin > cursor:
      holes.append((cursor, begin - 1))
    cursor = max(cursor, close + 1)
  if cursor <= end:
    holes.append((cursor, end))
  return holes


def jobs(db, source, symbol, tf, start, end, min_bars=MIN_GAP_BARS):
  """可以派给 EA 去抓的缺口：把短于 min_bars 根的空洞并进相邻区间，避免碎片请求。"""
  period = tf_seconds(tf)
  raw = missing(db, source, symbol, tf, start, end)
  merged = []
  for begin, close in raw:
    if merged and begin - merged[-1][1] <= min_bars * period:
      merged[-1] = (merged[-1][0], close)
    else:
      merged.append((begin, close))
  return [(a, b) for a, b in merged if b - a + period >= min_bars * period]


def read(db, source, symbol, tf, start, end, now=None):
  now = time.time() if now is None else now
  tf = normalize_tf(tf)
  if not tf:
    raise BarsError('周期不正确')
  start, end = int(start), int(end)
  if end < start or end - start > MAX_RANGE_SECONDS:
    raise BarsError('时间范围不正确')
  period = tf_seconds(tf)
  rows = db.execute(
    'SELECT t,o,h,l,c,v FROM bars WHERE source=? AND symbol=? AND tf=? AND t>=? AND t<=? AND t+?<=? ORDER BY t',
    (source, symbol, tf, start, end, period, now),
  ).fetchall()
  bars = [[r['t'], r['o'], r['h'], r['l'], r['c'], r['v']] for r in rows]
  covered = [{'from': a, 'to': b, 'state': state} for a, b, state in _coverage(db, source, symbol, tf, start, end)]
  return {
    'schema': SCHEMA,
    'source': source,
    'symbol': symbol,
    'tf': tf,
    'from_server': start,
    'to_server': end,
    'bars': bars,
    'covered': covered,
    'missing': [{'from': a, 'to': b} for a, b in missing(db, source, symbol, tf, start, end)],
    'now': now,
  }

def read_utc(db, source, symbol, tf, start, end, now=None):
  """UTC 范围与时钟先转券商墙钟查询，K 线及覆盖/缺口再统一转回 UTC。"""
  now = time.time() if now is None else now
  shift = source_offset(db, source)
  payload = read(db, source, symbol, tf, int(start) + shift, int(end) + shift, now + shift)
  payload = to_utc(payload, shift)
  payload['now'] = now
  payload['time_basis'] = 'utc'
  return payload


def tracks(db, symbol, source_active, start, end, tfs=('M1', 'M5', 'M15', 'H1'), utc=False):
  """视频编辑软件式的“轨道”：一个券商服务器一条轨，返回每条轨在 [start,end] 的覆盖情况。

  `source_active` 是当前这笔交易所属的轨（会被前端提到最上层）。
  """
  result = []
  for feed in db.execute('SELECT DISTINCT source,server,account FROM feeds ORDER BY source').fetchall():
    source = feed['source']
    shift = source_offset(db, source) if utc else 0
    wall_start, wall_end = int(start) + shift, int(end) + shift
    per = {}
    covered_seconds = 0
    total = max(1, end - start)
    blocks = []
    for tf in tfs:
      intervals = _coverage(db, source, symbol, tf, wall_start, wall_end)
      span = sum(max(0, close - begin + tf_seconds(tf)) for begin, close, _state in intervals)
      bars_count = db.execute(
        'SELECT count(*) FROM bars WHERE source=? AND symbol=? AND tf=? AND t>=? AND t<=?',
        (source, symbol, tf, wall_start, wall_end),
      ).fetchone()[0]
      per[tf] = {'covered_seconds': span, 'bars': bars_count, 'segments': len(intervals)}
      if tf == 'M1':
        covered_seconds = span
        blocks = [[max(begin, wall_start) - shift, min(close, wall_end) - shift] for begin, close, _state in intervals]
    result.append({
      'source': source,
      'server': feed['server'],
      'account': feed['account'],
      'active': source == source_active,
      'coverage': round(min(1.0, covered_seconds / total), 4),
      'blocks': blocks,
      'series': per,
    })
  result.sort(key=lambda row: (not row['active'], row['source']))
  return {'symbol': symbol, 'from': start, 'to': end, 'tf': 'M1', 'tracks': result}


def tracks_utc(db, symbol, source_active, start, end, tfs=('M1', 'M5', 'M15', 'H1')):
  """同一 UTC 窗口内，各券商轨分别按自己的墙钟偏移查询和换回 UTC。"""
  payload = tracks(db, symbol, source_active, start, end, tfs, utc=True)
  payload['time_basis'] = 'utc'
  return payload

def mark_coverage(db, source, symbol, tf, start, end, state='have', now=None):
  """直接登记一段覆盖（导入历史数据时用，避免逐批重算区间）。"""
  now = time.time() if now is None else now
  tf = normalize_tf(tf)
  if not tf:
    raise BarsError('周期不正确')
  _apply_coverage(db, source, symbol, tf, int(start), int(end), state, now)

def latest(db, source, symbol, tf, limit=4000, now=None, before=None):
  """取同一轨严格早于 before 的最近 N 根；入参和结果均为库内券商墙钟。"""
  now = time.time() if now is None else now
  tf = normalize_tf(tf)
  if not tf:
    raise BarsError('周期不正确')
  limit = max(1, min(20000, int(limit)))
  period = tf_seconds(tf)
  where = 'source=? AND symbol=? AND tf=? AND t<=?'
  params = [source, symbol, tf, now - period]
  if before is not None:
    where += ' AND t<?'
    params.append(int(before))
  rows = db.execute(
    'SELECT t,o,h,l,c,v FROM bars WHERE ' + where + ' ORDER BY t DESC LIMIT ?',
    (*params, limit + 1),
  ).fetchall()
  has_more = len(rows) > limit
  bars = [[r['t'], r['o'], r['h'], r['l'], r['c'], r['v']] for r in reversed(rows[:limit])]
  first = db.execute(
    'SELECT t FROM bars WHERE source=? AND symbol=? AND tf=? AND t<=? ORDER BY t LIMIT 1',
    (source, symbol, tf, now - period),
  ).fetchone()
  return {
    'schema': SCHEMA,
    'source': source,
    'symbol': symbol,
    'tf': tf,
    'bars': bars,
    'count': len(bars),
    'has_more': has_more,
    'earliest': first['t'] if first else None,
    'next_before': bars[0][0] if bars and has_more else None,
    'from_server': bars[0][0] if bars else None,
    'to_server': bars[-1][0] if bars else None,
    'now': now,
  }


def latest_utc(db, source, symbol, tf, limit=4000, now=None, before=None):
  """行情分页边界只在这里换算：UTC 游标 → 券商墙钟查询 → UTC 报文。"""
  now = time.time() if now is None else now
  shift = source_offset(db, source)
  payload = latest(db, source, symbol, tf, limit, now + shift, None if before is None else int(before) + shift)
  payload = to_utc(payload, shift)
  payload['now'] = now
  payload['time_basis'] = 'utc'
  return payload


def following(db, source, symbol, tf, after, limit=4000, now=None):
  """严格晚于 after 的下 N 根，跨周末/缺口按实际根数取；使用券商墙钟。"""
  now = time.time() if now is None else now
  tf = normalize_tf(tf)
  if not tf:
    raise BarsError('周期不正确')
  limit = max(1, min(20000, int(limit)))
  rows = db.execute(
    'SELECT t,o,h,l,c,v FROM bars WHERE source=? AND symbol=? AND tf=? AND t>? AND t+?<=? ORDER BY t LIMIT ?',
    (source, symbol, tf, int(after), tf_seconds(tf), now, limit + 1),
  ).fetchall()
  has_more = len(rows) > limit
  bars = [[r['t'], r['o'], r['h'], r['l'], r['c'], r['v']] for r in rows[:limit]]
  return {
    'schema': SCHEMA, 'source': source, 'symbol': symbol, 'tf': tf,
    'bars': bars, 'count': len(bars), 'has_more': has_more,
    'next_after': bars[-1][0] if bars and has_more else None,
    'from_server': bars[0][0] if bars else None,
    'to_server': bars[-1][0] if bars else None, 'now': now,
  }


def following_utc(db, source, symbol, tf, after, limit=4000, now=None):
  """UTC 向后游标和当前时钟只在这里换算。"""
  now = time.time() if now is None else now
  shift = source_offset(db, source)
  payload = following(db, source, symbol, tf, int(after) + shift, limit, now + shift)
  payload = to_utc(payload, shift)
  payload['now'] = now
  payload['time_basis'] = 'utc'
  return payload

# ---------------------------------------------------------------- 数据源目录

_CATALOG_TTL = 60.0
_catalog_cache = {'at': 0.0, 'value': None}


def catalog(db, now=None):
  """全局数据源目录：每个 (source, symbol, tf) 的覆盖范围、根数与缺口。

  这是「第三类用户」的入口：不绑 MT5 也能从公共轨取数、自己复盘。
  结果缓存 60 秒——bars 是只增不改的，没必要每个请求都扫一遍。
  """
  now = time.time() if now is None else now
  cached = _catalog_cache.get('value')
  if cached is not None and now - _catalog_cache['at'] < _CATALOG_TTL:
    return cached
  # 优先读物化表：全量 GROUP BY 在 300 万行上要 2.5 秒，不能放在请求路径里。
  rows = db.execute('SELECT * FROM source_catalog').fetchall()
  if not rows:
    refresh_catalog(db, now)
    rows = db.execute('SELECT * FROM source_catalog').fetchall()
  servers = {}
  for feed in db.execute('SELECT DISTINCT source, server FROM feeds').fetchall():
    servers.setdefault(feed['source'], feed['server'])
  grouped = {}
  for row in rows:
    entry = grouped.setdefault((row['source'], row['symbol']), {
      'source': row['source'],
      'server': servers.get(row['source'], row['source'][4:] if row['source'].startswith('srv:') else row['source']),
      'symbol': row['symbol'],
      'last_bar': 0,
      'bars': 0,
      'tfs': {},
    })
    entry['tfs'][row['tf']] = {
      'from': int(row['first_t']),
      'to': int(row['last_t']),
      'bars': int(row['bars']),
    }
    entry['bars'] += int(row['bars'])
    entry['last_bar'] = max(entry['last_bar'], int(row['last_t']))
  value = sorted(grouped.values(), key=lambda item: (-item['bars'], item['source']))
  _catalog_cache['value'] = value
  _catalog_cache['at'] = now
  return value


def refresh_catalog(db, now=None):
  """重算并落库 source_catalog。由后台线程定期调用，不放在请求里。"""
  now = time.time() if now is None else now
  rows = db.execute(
    'SELECT source, symbol, tf, min(t) AS first_t, max(t) AS last_t, count(*) AS bars'
    ' FROM bars GROUP BY source, symbol, tf',
  ).fetchall()
  db.execute('DELETE FROM source_catalog')
  db.executemany(
    'INSERT INTO source_catalog(source, symbol, tf, first_t, last_t, bars, updated) VALUES(?,?,?,?,?,?,?)',
    [(row['source'], row['symbol'], row['tf'], int(row['first_t']), int(row['last_t']), int(row['bars']), now) for row in rows],
  )
  db.commit()
  _catalog_cache['value'] = None
  _catalog_cache['at'] = 0.0
  return len(rows)


def catalog_entry(db, source, symbol, now=None):
  """单个数据源的目录项；找不到返回 None。"""
  for entry in catalog(db, now):
    if entry['source'] == source and entry['symbol'] == symbol:
      return entry
  return None


def public_source(db, symbol=None, now=None):
  """给没有绑定 feed 的登录用户用的公共轨：取数据量最大的那条。"""
  for entry in catalog(db, now):
    if symbol and entry['symbol'] != symbol:
      continue
    return entry['source']
  return None

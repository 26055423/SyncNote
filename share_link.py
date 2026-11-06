"""对外只读分享链接：一条链接只对应一笔交易的复盘快照。

权限边界：
- token 是唯一凭证，拿到链接就能看，不需要登录；
- 快照里只有这一笔交易（摘要 + 笔记 + 四周期 K 线），不含账户、持仓、其它交易；
- 撤销立即失效；快照在生成时冻结，之后改笔记不会影响已发出的链接。
"""
import hashlib
import json
import secrets
import time

MAX_BARS = 600
TRADE_FIELDS = ('ticket', 'symbol', 'side', 'volume', 'price_open', 'price_close', 'opened', 'closed', 'profit', 'commission', 'swap')


class ShareError(Exception):
  pass


def initialize(db):
  db.execute('CREATE TABLE IF NOT EXISTS share_links(token TEXT PRIMARY KEY,owner TEXT NOT NULL,ticket TEXT NOT NULL,created REAL NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,payload TEXT NOT NULL)')
  db.execute('CREATE INDEX IF NOT EXISTS idx_share_links_owner ON share_links(owner,ticket)')
  db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_share_links_active ON share_links(owner,ticket) WHERE revoked=0')


def _token():
  return secrets.token_urlsafe(18)


def _snapshot(review, note, author):
  # sqlite3.Row 没有 .get()，统一转成 dict 再取字段。
  author = dict(author) if author is not None and not isinstance(author, dict) else (author or {})
  charts = {}
  for tf, rows in (review.get('charts') or {}).items():
    if isinstance(rows, list):
      charts[tf] = [row[:6] for row in rows[-MAX_BARS:] if isinstance(row, list) and len(row) >= 5]
  trade = review.get('trade') or {}
  # 交易原始字段是 open/close + opened_server/closed_server；对外统一成可读的名字。
  summary = {
    'ticket': trade.get('ticket'),
    'symbol': trade.get('symbol'),
    'side': trade.get('side'),
    'volume': trade.get('volume'),
    'price_open': trade.get('price_open', trade.get('open')),
    'price_close': trade.get('price_close', trade.get('close')),
    'profit': trade.get('profit'),
    'opened': review.get('opened') if review.get('opened') is not None else trade.get('opened'),
    'closed': trade.get('closed') if trade.get('closed') is not None else trade.get('closed_server'),
  }
  summary = {key: value for key, value in summary.items() if value is not None}
  return {
    'version': 1,
    'trade': summary,
    'opened': review.get('opened'),
    'author': {'name': (author or {}).get('nickname') or '', 'avatar': (author or {}).get('avatar') or ''},
    'note': (note or {}),
    'charts': charts,
    'created': time.time(),
  }


def create(db, owner, ticket, review, note, author=None):
  ticket = str(ticket)
  charts = review.get('charts') or {}
  if not charts:
    raise ShareError('这笔交易还没有可分享的 K 线，先同步复盘数据再生成链接')
  payload = json.dumps(_snapshot(review, note, author), ensure_ascii=False)
  row = db.execute('SELECT token FROM share_links WHERE owner=? AND ticket=? AND revoked=0', (owner, ticket)).fetchone()
  if row:
    db.execute('UPDATE share_links SET payload=?,created=? WHERE token=?', (payload, time.time(), row['token']))
    return {'token': row['token'], 'created': time.time()}
  token = _token()
  db.execute('INSERT INTO share_links(token,owner,ticket,created,revoked,payload) VALUES(?,?,?,?,0,?)', (token, owner, ticket, time.time(), payload))
  return {'token': token, 'created': time.time()}


def revoke(db, owner, ticket):
  cur = db.execute('UPDATE share_links SET revoked=1 WHERE owner=? AND ticket=? AND revoked=0', (owner, str(ticket)))
  return {'ok': True, 'revoked': cur.rowcount > 0}


def active(db, owner, ticket):
  row = db.execute('SELECT token,created FROM share_links WHERE owner=? AND ticket=? AND revoked=0', (owner, str(ticket))).fetchone()
  return {'token': row['token'], 'created': row['created']} if row else {'token': None}


def read(db, token):
  row = db.execute('SELECT * FROM share_links WHERE token=? AND revoked=0', (str(token),)).fetchone()
  if not row:
    raise ShareError('链接不存在或已被取消')
  try:
    payload = json.loads(row['payload'])
  except (TypeError, ValueError):
    raise ShareError('链接内容已损坏')
  payload['created'] = row['created']
  return payload

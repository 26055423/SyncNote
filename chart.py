"""复盘图表页的共享状态：画线/标注存档、复盘作业（分享给其他用户）。

图表的 K 线仍由 journal/market 提供（每笔交易同步或参考行情），这里只负责
“这张图上画了什么”和“这张图发给了谁”，不做行情计算。
"""
import json
import time

MAX_STATE_BYTES = 512 * 1024
MAX_RECIPIENTS = 20
MAX_MESSAGE = 500


class ChartError(Exception):
    def __init__(self, text, code=400):
        self.text, self.code = text, code


def initialize(db):
    db.executescript('''
    CREATE TABLE IF NOT EXISTS chart_states(person TEXT NOT NULL,ticket TEXT NOT NULL,state TEXT NOT NULL,updated REAL NOT NULL,PRIMARY KEY(person,ticket));
    CREATE TABLE IF NOT EXISTS review_shares(id INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,ticket TEXT NOT NULL,recipient TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',created REAL NOT NULL,seen INTEGER NOT NULL DEFAULT 0,CONSTRAINT one_share UNIQUE(owner,ticket,recipient));
    CREATE INDEX IF NOT EXISTS idx_review_shares_recipient ON review_shares(recipient,seen);
    CREATE INDEX IF NOT EXISTS idx_review_shares_owner ON review_shares(owner,ticket);
    ''')


def state(db, person, ticket):
    row = db.execute('SELECT state,updated FROM chart_states WHERE person=? AND ticket=?', (person, str(ticket))).fetchone()
    if not row:
        return None
    try:
        doc = json.loads(row['state'])
    except ValueError:
        return None
    return {'document': doc, 'updated': row['updated']}


def save_state(db, person, ticket, document):
    """Persist one chart document. Size-capped; shape is re-sanitized by Vela on load."""
    if not isinstance(document, dict) or document.get('version') != 1:
        raise ChartError('图表状态格式不正确')
    charts = document.get('charts')
    if not isinstance(charts, list) or not 0 < len(charts) <= 32:
        raise ChartError('图表状态格式不正确')
    raw = json.dumps(document, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
    if len(raw.encode('utf-8')) > MAX_STATE_BYTES:
        raise ChartError('画线内容过大，请减少标注后重试', 413)
    now = time.time()
    db.execute('INSERT INTO chart_states VALUES(?,?,?,?) ON CONFLICT(person,ticket) DO UPDATE SET state=excluded.state,updated=excluded.updated', (person, str(ticket), raw, now))
    return {'ok': True, 'bytes': len(raw.encode('utf-8')), 'updated': now}


def clear_state(db, person, ticket):
    db.execute('DELETE FROM chart_states WHERE person=? AND ticket=?', (person, str(ticket)))
    return {'ok': True}


def share(db, owner, ticket, recipients, message):
    """Send one review chart to other users; re-sending the same ticket updates the message."""
    if not isinstance(recipients, list) or not recipients:
        raise ChartError('请选择至少一位收件人')
    if len(recipients) > MAX_RECIPIENTS:
        raise ChartError('一次最多发给 %d 位用户' % MAX_RECIPIENTS)
    if not isinstance(message, str) or len(message) > MAX_MESSAGE:
        raise ChartError('留言最多 %d 字' % MAX_MESSAGE)
    ids = []
    for value in recipients:
        if not isinstance(value, str) or not value or value == owner:
            continue
        if value not in ids:
            ids.append(value)
    if not ids:
        raise ChartError('请选择至少一位收件人')
    marks = ','.join('?' for _ in ids)
    known = {r[0] for r in db.execute('SELECT id FROM users WHERE id IN (%s)' % marks, ids)}
    missing = [i for i in ids if i not in known]
    if missing:
        raise ChartError('收件人不存在')
    now = time.time()
    for recipient in ids:
        db.execute('INSERT INTO review_shares(owner,ticket,recipient,message,created,seen) VALUES(?,?,?,?,?,0) ON CONFLICT(owner,ticket,recipient) DO UPDATE SET message=excluded.message,created=excluded.created,seen=0', (owner, str(ticket), recipient, message.strip(), now))
    return {'ok': True, 'sent': len(ids), 'created': now}


def inbox(db, uid, limit=50):
    rows = db.execute('SELECT s.*,u.nickname,u.avatar FROM review_shares s JOIN users u ON u.id=s.owner WHERE s.recipient=? ORDER BY s.seen ASC,s.created DESC LIMIT ?', (uid, limit)).fetchall()
    tickets = {}
    for row in rows:
        key = (row['owner'], row['ticket'])
        if key in tickets:
            continue
        trade = db.execute('SELECT payload FROM trades WHERE person=? AND ticket=?', key).fetchone()
        tickets[key] = json.loads(trade['payload']) if trade else None
    items = []
    for row in rows:
        trade = tickets.get((row['owner'], row['ticket'])) or {}
        items.append({
            'id': row['id'], 'ticket': row['ticket'], 'owner': {'id': row['owner'], 'name': row['nickname'], 'avatar': row['avatar']},
            'message': row['message'], 'created': row['created'], 'seen': bool(row['seen']),
            'trade': {k: trade.get(k) for k in ('symbol', 'side', 'volume', 'open', 'close', 'profit', 'closed')} if trade else None,
        })
    return {'items': items, 'unseen': sum(1 for i in items if not i['seen'])}


def share_row(db, uid, share_id):
    row = db.execute('SELECT * FROM review_shares WHERE id=?', (share_id,)).fetchone()
    if not row or uid not in (row['recipient'], row['owner']):
        raise ChartError('作业不存在，或不是发给你的', 404)
    return row


def mark_seen(db, uid, share_id):
    row = share_row(db, uid, share_id)
    if row['recipient'] == uid:
        db.execute('UPDATE review_shares SET seen=1 WHERE id=?', (row['id'],))
    return {'ok': True, 'seen': True}

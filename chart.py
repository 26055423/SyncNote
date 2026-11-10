"""复盘图表页的共享状态：画线/标注存档、复盘消息（分享给其他用户）。

图表的 K 线仍由 journal/market 提供（每笔交易同步或参考行情），这里只负责
“这张图上画了什么”和“这张图发给了谁”，不做行情计算。

一次分享 = 一条带复盘切片的富文本消息：分享人点击分享那一刻的**激活格子**、
它的周期、可见窗口中点的时间戳，以及当时的整份画线文档。收件人打开时按这三样
直接还原同一张图，而不是读分享人后来改过的存档。
"""
import json
import time
import trade_store

MAX_STATE_BYTES = 512 * 1024
MAX_SNAPSHOT_BYTES = 512 * 1024
MAX_RECIPIENTS = 20
MAX_MESSAGE = 500
MAX_ANCHOR_MS = 4102444800000


class ChartError(Exception):
    def __init__(self, text, code=400):
        self.text, self.code = text, code


def initialize_legacy(db):
    db.executescript('''
    CREATE TABLE IF NOT EXISTS chart_states(person TEXT NOT NULL,ticket TEXT NOT NULL,state TEXT NOT NULL,updated REAL NOT NULL,PRIMARY KEY(person,ticket));
    CREATE TABLE IF NOT EXISTS review_shares(id INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,ticket TEXT NOT NULL,recipient TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',created REAL NOT NULL,seen INTEGER NOT NULL DEFAULT 0,CONSTRAINT one_share UNIQUE(owner,ticket,recipient));
    CREATE INDEX IF NOT EXISTS idx_review_shares_recipient ON review_shares(recipient,seen);
    CREATE INDEX IF NOT EXISTS idx_review_shares_owner ON review_shares(owner,ticket);
    ''')
    columns = {row[1] for row in db.execute('PRAGMA table_info(review_shares)')}
    if 'snapshot' not in columns:
        db.execute("ALTER TABLE review_shares ADD COLUMN snapshot TEXT NOT NULL DEFAULT ''")
    if 'note_snapshot' not in columns:
        db.execute("ALTER TABLE review_shares ADD COLUMN note_snapshot TEXT NOT NULL DEFAULT ''")


def initialize(db):
 from share_migrations import initialize_schema,migrate_shares
 columns={r[1] for r in db.execute('PRAGMA table_info(review_shares)')}
 if columns and 'snapshot_id' not in columns:
  initialize_legacy(db);migrate_shares(db)
 else:initialize_schema(db)


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


def clean_snapshot(snapshot):
    """一条消息附带的复盘切片：激活格子的周期 + 可见窗口中点时间 + 画线文档。"""
    if snapshot is None:
        return ''
    if not isinstance(snapshot, dict):
        raise ChartError('分享视图格式不正确')
    anchor = snapshot.get('anchor_ms')
    if isinstance(anchor, bool) or not isinstance(anchor, int) or not 0 < anchor <= MAX_ANCHOR_MS:
        raise ChartError('分享视图缺少正确的 K 线时间')
    timeframe = snapshot.get('timeframe', '')
    if not isinstance(timeframe, str) or len(timeframe) > 8:
        raise ChartError('分享视图的周期不正确')
    layout = snapshot.get('layout', '')
    if not isinstance(layout, str) or len(layout) > 8:
        raise ChartError('分享视图的布局不正确')
    document = snapshot.get('document')
    if document is not None:
        if not isinstance(document, dict) or document.get('version') != 1 or not isinstance(document.get('charts'), list):
            raise ChartError('分享的画线存档格式不正确')
    visible_range = snapshot.get('range')
    if visible_range is not None and (not isinstance(visible_range, dict) or any(isinstance(visible_range.get(k), bool) or not isinstance(visible_range.get(k), (int,float)) for k in ('from','to')) or not 0 < visible_range['from'] < visible_range['to'] <= MAX_ANCHOR_MS):
        raise ChartError('分享窗口范围不正确')
    body = json.dumps({'anchor_ms': anchor, 'timeframe': timeframe, 'layout': layout, 'range': visible_range, 'document': document}, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
    if len(body.encode('utf-8')) > MAX_SNAPSHOT_BYTES:
        raise ChartError('分享的画线内容过大，请减少标注后重试', 413)
    return body


def share_view(row):
    """解析一行的分享切片；内容与空值均来自冻结快照。"""
    raw = row['snapshot'] if 'snapshot' in row.keys() else ''
    value = {}
    if raw:
        try:
            parsed = json.loads(raw)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            value = parsed
    frozen = row['note_snapshot'] if 'note_snapshot' in row.keys() else ''
    if frozen:
        try:
            value['note'] = json.loads(frozen)
        except ValueError:
            value['note'] = None
    return value or None


def share(db, owner, ticket, recipients, message, snapshot=None, note=None):
    """Send one review chart to other users; each send freezes an independent snapshot."""
    if not isinstance(recipients, list) or not recipients:
        raise ChartError('请选择至少一位收件人')
    if len(recipients) > MAX_RECIPIENTS:
        raise ChartError('一次最多发给 %d 位用户' % MAX_RECIPIENTS)
    if not isinstance(message, str) or len(message) > MAX_MESSAGE:
        raise ChartError('留言最多 %d 字' % MAX_MESSAGE)
    body = clean_snapshot(snapshot)
    note_body = json.dumps(note if isinstance(note, dict) else None, ensure_ascii=False)
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
    snapshot_id=create_snapshot(db,owner,ticket,message,body,note_body)
    for recipient in ids:deliver(db,snapshot_id,recipient)
    return {'ok': True, 'sent': len(ids), 'created': db.execute('SELECT created FROM review_snapshots WHERE id=?',(snapshot_id,)).fetchone()[0], 'has_snapshot': bool(body)}


def create_snapshot(db,owner,ticket,message,body,note_body,group_id=None,created=None):
 # Freeze absence as well as content. A share without an explicit viewport freezes
 # the currently saved document but leaves anchor/timeframe unspecified.
 if not body:
  saved=state(db,owner,ticket)
  body=json.dumps({'document':saved['document'] if saved else None},ensure_ascii=False)
 return db.execute('INSERT INTO review_snapshots(owner,ticket,message,created,snapshot,note_snapshot,group_id) VALUES(?,?,?,?,?,?,?)',(owner,str(ticket),message.strip(),time.time() if created is None else created,body,note_body or 'null',group_id)).lastrowid


def deliver(db,snapshot_id,recipient):
 db.execute('INSERT OR IGNORE INTO review_shares(snapshot_id,recipient) VALUES(?,?)',(snapshot_id,recipient))
 return db.execute('SELECT id FROM review_shares WHERE snapshot_id=? AND recipient=?',(snapshot_id,recipient)).fetchone()[0]


def inbox(db, uid, limit=50):
    rows = db.execute('SELECT s.*,u.nickname,u.avatar FROM review_share_entries s JOIN users u ON u.id=s.owner WHERE s.recipient=? AND s.group_id IS NULL ORDER BY s.seen ASC,s.created DESC LIMIT ?', (uid, limit)).fetchall()
    tickets = {}
    for row in rows:
        key = (row['owner'], row['ticket'])
        if key in tickets:
            continue
        trade = trade_store.lookup(db,*key)
        tickets[key] = json.loads(trade['payload']) if trade else None
    items = []
    for row in rows:
        trade = tickets.get((row['owner'], row['ticket'])) or {}
        view = share_view(row) or {}
        items.append({
            'id': row['id'], 'ticket': row['ticket'], 'owner': {'id': row['owner'], 'name': row['nickname'], 'avatar': row['avatar']},
            'message': row['message'], 'created': row['created'], 'seen': bool(row['seen']),
            'anchor_ms': view.get('anchor_ms'), 'timeframe': view.get('timeframe'), 'layout': view.get('layout'),
            'trade': {k: trade.get(k) for k in ('symbol', 'side', 'volume', 'open', 'close', 'profit', 'closed')} if trade else None,
        })
    return {'items': items, 'unseen': sum(1 for i in items if not i['seen'])}


def share_row(db, uid, share_id):
    row = db.execute('SELECT * FROM review_share_entries WHERE id=?', (share_id,)).fetchone()
    if not row or uid not in (row['recipient'], row['owner']):
        raise ChartError('消息不存在，或不是发给你的', 404)
    if row['group_id'] is not None:
        member=db.execute('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?',(row['group_id'],uid)).fetchone()
        message=db.execute('SELECT 1 FROM group_messages WHERE review_snapshot_id=? AND recalled=0',(row['snapshot_id'],)).fetchone()
        if not member or not message:raise ChartError('群分享已撤回，或你已不在群内',404)
    return row


def mark_seen(db, uid, share_id):
    row = share_row(db, uid, share_id)
    if row['recipient'] == uid:
        db.execute('UPDATE review_shares SET seen=1 WHERE id=?', (row['id'],))
    return {'ok': True, 'seen': True}

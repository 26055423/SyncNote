"""好友之间的一对一私信（微信式：离线也能发，上线后补收）。"""

import time

MAX_TEXT = 1000


class DmError(Exception):
    def __init__(self, text, code=400):
        super().__init__(text)
        self.text = text
        self.code = code


def initialize(db):
    db.executescript(
        '''
        CREATE TABLE IF NOT EXISTS direct_messages(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender TEXT NOT NULL REFERENCES users(id),
            recipient TEXT NOT NULL REFERENCES users(id),
            text TEXT NOT NULL,
            created REAL NOT NULL,
            read_at REAL
        );
        CREATE INDEX IF NOT EXISTS idx_dm_pair ON direct_messages(sender,recipient,id);
        CREATE INDEX IF NOT EXISTS idx_dm_inbox ON direct_messages(recipient,read_at);
        '''
    )


def send(db, sender, recipient, text, can_chat):
    """发私信。can_chat 由调用方（好友关系）判定，离线不影响发送。"""
    if not isinstance(recipient, str) or not recipient or recipient == sender:
        raise DmError('收件人不正确')
    row = db.execute('SELECT id FROM users WHERE id=?', (recipient,)).fetchone()
    if not row:
        raise DmError('用户不存在', 404)
    if not can_chat:
        raise DmError('你们还不是好友', 403)
    text = (text or '').strip()
    if not 1 <= len(text) <= MAX_TEXT:
        raise DmError('消息需要 1–%d 个字' % MAX_TEXT)
    now = time.time()
    db.execute('INSERT INTO direct_messages(sender,recipient,text,created) VALUES(?,?,?,?)', (sender, recipient, text, now))
    message_id = db.execute('SELECT last_insert_rowid()').fetchone()[0]
    return {'id': message_id, 'created': now}


def thread(db, uid, peer, limit=100):
    """两个人之间的消息（时间正序），顺便把对方发来的标成已读。"""
    rows = db.execute(
        '''SELECT id,sender,text,created,read_at FROM direct_messages
           WHERE (sender=? AND recipient=?) OR (sender=? AND recipient=?)
           ORDER BY id DESC LIMIT ?''',
        (uid, peer, peer, uid, max(1, min(limit, 300))),
    ).fetchall()
    db.execute('UPDATE direct_messages SET read_at=? WHERE recipient=? AND sender=? AND read_at IS NULL', (time.time(), uid, peer))
    items = []
    for row in reversed(rows):
        items.append({
            'id': row['id'],
            'mine': row['sender'] == uid,
            'text': row['text'],
            'created': row['created'],
            'read': bool(row['read_at']),
        })
    return items


def unread(db, uid, peer):
    return db.execute(
        'SELECT count(*) FROM direct_messages WHERE recipient=? AND sender=? AND read_at IS NULL',
        (uid, peer),
    ).fetchone()[0]


def threads(db, uid):
    """会话列表：每个好友最后一条消息 + 未读数。"""
    rows = db.execute(
        '''SELECT m.* FROM direct_messages m
           JOIN (SELECT CASE WHEN sender=? THEN recipient ELSE sender END AS peer, max(id) AS last_id
                 FROM direct_messages WHERE sender=? OR recipient=? GROUP BY peer) t ON t.last_id=m.id
           ORDER BY m.id DESC LIMIT 50''',
        (uid, uid, uid),
    ).fetchall()
    out = []
    for row in rows:
        peer = row['recipient'] if row['sender'] == uid else row['sender']
        user = db.execute('SELECT id,nickname,avatar FROM users WHERE id=?', (peer,)).fetchone()
        if not user:
            continue
        out.append({
            'peer': {'id': user['id'], 'nickname': user['nickname'], 'avatar': user['avatar']},
            'text': row['text'],
            'created': row['created'],
            'mine': row['sender'] == uid,
            'unread': unread(db, uid, peer),
        })
    return out


def total_unread(db, uid):
    return db.execute('SELECT count(*) FROM direct_messages WHERE recipient=? AND read_at IS NULL', (uid,)).fetchone()[0]

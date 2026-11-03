"""好友之间的一对一私信（微信式：离线也能发，上线后补收）。"""

import time

MAX_TEXT = 1000
REACTIONS = ("👍", "❤️", "😂", "🎉", "👀", "✅")


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
        CREATE TABLE IF NOT EXISTS dm_reactions(
            message_id INTEGER NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id),
            emoji TEXT NOT NULL,
            PRIMARY KEY(message_id,user_id,emoji)
        );
        '''
    )
    if 'reply_to' not in {r[1] for r in db.execute('PRAGMA table_info(direct_messages)')}:
        db.execute('ALTER TABLE direct_messages ADD COLUMN reply_to INTEGER REFERENCES direct_messages(id) ON DELETE SET NULL')


def send(db, sender, recipient, text, can_chat, reply_to=None):
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
    if reply_to is not None:
        _message(db, sender, recipient, reply_to)
    now = time.time()
    db.execute('INSERT INTO direct_messages(sender,recipient,text,created,reply_to) VALUES(?,?,?,?,?)', (sender, recipient, text, now, reply_to))
    message_id = db.execute('SELECT last_insert_rowid()').fetchone()[0]
    return {'id': message_id, 'created': now}


def thread(db, uid, peer, limit=100):
    """两个人之间的消息（时间正序），顺便把对方发来的标成已读。"""
    rows = db.execute(
        '''SELECT m.*,u.nickname,u.avatar FROM direct_messages m JOIN users u ON u.id=m.sender
           WHERE (m.sender=? AND m.recipient=?) OR (m.sender=? AND m.recipient=?)
           ORDER BY m.id DESC LIMIT ?''',
        (uid, peer, peer, uid, max(1, min(limit, 300))),
    ).fetchall()
    db.execute('UPDATE direct_messages SET read_at=? WHERE recipient=? AND sender=? AND read_at IS NULL', (time.time(), uid, peer))
    items = []
    for row in reversed(rows):
        items.append({
            'id': row['id'],
            'kind': 'text',
            'mine': row['sender'] == uid,
            'text': row['text'],
            'created': row['created'],
            'read': bool(row['read_at']),
            'person': row['sender'],
            'name': row['nickname'],
            'avatar': row['avatar'],
            'reply': _reply(db, uid, peer, row['reply_to']),
            'reactions': reactions(db, 'dm_reactions', row['id'], uid),
        })
    # 合并两个人之间互相分享的复盘：在聊天里就是一张卡片，和微信分享文章一样。
    shares = db.execute(
        '''SELECT s.*,u.nickname,u.avatar FROM review_shares s JOIN users u ON u.id=s.owner
           WHERE (s.owner=? AND s.recipient=?) OR (s.owner=? AND s.recipient=?)
           ORDER BY s.created DESC LIMIT ?''',
        (uid, peer, peer, uid, max(1, min(limit, 300))),
    ).fetchall()
    db.executemany('UPDATE review_shares SET seen=1 WHERE id=? AND recipient=? AND seen=0', ((row['id'], uid) for row in shares))
    for row in shares:
        items.append({
            'id': 's' + str(row['id']),
            'kind': 'share',
            'mine': row['owner'] == uid,
            'text': row['message'] or '',
            'ticket': row['ticket'],
            'share': row['id'],
            'created': row['created'],
            'read': True,
            'person': row['owner'],
            'name': row['nickname'],
            'avatar': row['avatar'],
            'reply': None,
            'reactions': [],
        })
    items.sort(key=lambda item: item['created'])
    return items


def unread(db, uid, peer):
    return db.execute(
        'SELECT count(*) FROM direct_messages WHERE recipient=? AND sender=? AND read_at IS NULL',
        (uid, peer),
    ).fetchone()[0]


def threads(db, uid, allowed=None):
 """按最后一条私信或复盘排序，仅返回当前可聊天的好友。"""
 rows = db.execute(
  """SELECT CASE WHEN sender=? THEN recipient ELSE sender END AS peer,text,created,sender=? AS mine,id FROM direct_messages WHERE sender=? OR recipient=?
  UNION ALL
  SELECT CASE WHEN owner=? THEN recipient ELSE owner END AS peer,CASE WHEN message='' THEN '交易复盘' ELSE message END AS text,created,owner=? AS mine,id FROM review_shares WHERE owner=? OR recipient=?
  ORDER BY created DESC,id DESC""", (uid, uid, uid, uid, uid, uid, uid, uid)).fetchall()
 out = []
 visited = set()
 for row in rows:
  peer = row['peer']
  if peer in visited or (allowed is not None and peer not in allowed):
   continue
  visited.add(peer)
  user = db.execute('SELECT u.id,u.nickname,u.avatar,coalesce(p.updated,0) AS updated FROM users u LEFT JOIN presence p ON p.user_id=u.id WHERE u.id=?', (peer,)).fetchone()
  if not user:
   continue
  shares = db.execute('SELECT count(*) FROM review_shares WHERE recipient=? AND owner=? AND seen=0', (uid, peer)).fetchone()[0]
  out.append({
   'peer': {'id': user['id'], 'nickname': user['nickname'], 'avatar': user['avatar'], 'online': user['updated'] > time.time() - 45},
   'text': row['text'], 'created': row['created'], 'mine': bool(row['mine']), 'unread': unread(db, uid, peer) + shares,
  })
  if len(out) >= 50:
   break
 return out


def total_unread(db, uid, allowed=None):
 if allowed is not None:
  return sum(unread(db, uid, peer) + db.execute('SELECT count(*) FROM review_shares WHERE recipient=? AND owner=? AND seen=0', (uid, peer)).fetchone()[0] for peer in allowed)
 messages = db.execute('SELECT count(*) FROM direct_messages WHERE recipient=? AND read_at IS NULL', (uid,)).fetchone()[0]
 shares = db.execute('SELECT count(*) FROM review_shares WHERE recipient=? AND seen=0', (uid,)).fetchone()[0]
 return messages + shares


def _message(db, uid, peer, message_id):
 if not isinstance(message_id, int) or isinstance(message_id, bool) or message_id < 1:
  raise DmError('消息编号不正确')
 row = db.execute('SELECT m.*,u.nickname FROM direct_messages m JOIN users u ON u.id=m.sender WHERE m.id=? AND ((m.sender=? AND m.recipient=?) OR (m.sender=? AND m.recipient=?))', (message_id, uid, peer, peer, uid)).fetchone()
 if not row:
  raise DmError('消息不存在', 404)
 return row


def _reply(db, uid, peer, message_id):
 if message_id is None:
  return None
 row = _message(db, uid, peer, message_id)
 return {'id': row['id'], 'name': row['nickname'], 'text': row['text']}


def reactions(db, table, message_id, uid):
 # 表名仅由本模块和群模块传入固定常量。
 if table not in ('dm_reactions', 'group_reactions'):
  raise ValueError('Unknown reaction table')
 rows = db.execute('SELECT emoji,count(*) AS count,max(user_id=?) AS mine FROM '+table+' WHERE message_id=? GROUP BY emoji ORDER BY emoji', (uid, message_id)).fetchall()
 return [{'emoji': r['emoji'], 'count': r['count'], 'mine': bool(r['mine'])} for r in rows]


def reaction(db, uid, peer, message_id, emoji, active, can_chat):
 if not can_chat:
  raise DmError('你们还不是好友', 403)
 _message(db, uid, peer, message_id)
 if not isinstance(emoji, str) or emoji not in REACTIONS or not isinstance(active, bool):
  raise DmError('表情回应不正确')
 if active:
  db.execute('INSERT OR IGNORE INTO dm_reactions(message_id,user_id,emoji) VALUES(?,?,?)', (message_id, uid, emoji))
 else:
  db.execute('DELETE FROM dm_reactions WHERE message_id=? AND user_id=? AND emoji=?', (message_id, uid, emoji))
 return {'reactions': reactions(db, 'dm_reactions', message_id, uid)}

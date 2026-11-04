"""群组：建群、邀请码加入、群聊、把一笔交易发进群。

设计要点：
- 群成员看某笔交易，走的是已有的 `review_shares` 通道：发进群时给每个成员
  各写一条 share 记录，前端用 `?share=<id>` 打开，权限、K 线、轨道全部复用，
  不再给群单独开一套行情权限。
- 群聊消息表只存文本 / 交易卡片（ticket + 分享人），不存行情数据。
- 群成员之间**不**因此获得「看全部交易」的权限：整份历史仍然要求互为好友。
"""

import json
import re
import secrets
import time

import chart
import dm

MAX_NAME = 40
MAX_TEXT = 1000
MAX_MEMBERS = 200


class GroupError(Exception):
    def __init__(self, text, code=400):
        super().__init__(text)
        self.text = text
        self.code = code


def initialize(db):
    db.executescript(
        '''
        CREATE TABLE IF NOT EXISTS groups(
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            owner TEXT NOT NULL REFERENCES users(id),
            code TEXT NOT NULL UNIQUE,
            created REAL NOT NULL,
            notice TEXT NOT NULL DEFAULT '',
            avatar TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS group_members(
            group_id TEXT NOT NULL REFERENCES groups(id),
            user_id TEXT NOT NULL REFERENCES users(id),
            role TEXT NOT NULL DEFAULT 'member',
            joined REAL NOT NULL,
            last_read REAL NOT NULL DEFAULT 0,
            PRIMARY KEY(group_id,user_id)
        );
        CREATE TABLE IF NOT EXISTS group_messages(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL REFERENCES groups(id),
            person TEXT NOT NULL REFERENCES users(id),
            kind TEXT NOT NULL DEFAULT 'text',
            text TEXT NOT NULL DEFAULT '',
            ticket TEXT,
            created REAL NOT NULL,
            mentions TEXT NOT NULL DEFAULT '[]',
            recalled INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_group_messages ON group_messages(group_id,id);
        CREATE TABLE IF NOT EXISTS group_reactions(
            message_id INTEGER NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id),
            emoji TEXT NOT NULL,
            PRIMARY KEY(message_id,user_id,emoji)
        );
        '''
    )
    # 老库补列
    group_cols = {r[1] for r in db.execute('PRAGMA table_info(groups)')}
    if 'notice' not in group_cols:
        db.execute("ALTER TABLE groups ADD COLUMN notice TEXT NOT NULL DEFAULT ''")
    if 'avatar' not in group_cols:
        db.execute("ALTER TABLE groups ADD COLUMN avatar TEXT NOT NULL DEFAULT ''")
    message_cols = {r[1] for r in db.execute('PRAGMA table_info(group_messages)')}
    if 'snapshot' not in message_cols:
        db.execute('ALTER TABLE group_messages ADD COLUMN snapshot TEXT')
    if 'reply_to' not in message_cols:
        db.execute('ALTER TABLE group_messages ADD COLUMN reply_to INTEGER REFERENCES group_messages(id) ON DELETE SET NULL')
    if 'mentions' not in message_cols:
        db.execute("ALTER TABLE group_messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]'")
    if 'recalled' not in message_cols:
        db.execute("ALTER TABLE group_messages ADD COLUMN recalled INTEGER NOT NULL DEFAULT 0")


def _member(db, gid, uid):
    return db.execute('SELECT * FROM group_members WHERE group_id=? AND user_id=?', (gid, uid)).fetchone()


def require_member(db, gid, uid):
    group = db.execute('SELECT * FROM groups WHERE id=?', (gid,)).fetchone()
    if not group:
        raise GroupError('群不存在', 404)
    if not _member(db, gid, uid):
        raise GroupError('你不在这个群里', 403)
    return group


def _payload(db, row, uid):
    members = db.execute('SELECT count(*) FROM group_members WHERE group_id=?', (row['id'],)).fetchone()[0]
    last = db.execute('SELECT person,kind,text,created,recalled FROM group_messages WHERE group_id=? ORDER BY id DESC LIMIT 1', (row['id'],)).fetchone()
    mine = _member(db, row['id'], uid)
    unread = 0
    mentions = 0
    if mine:
        unread = db.execute('SELECT count(*) FROM group_messages WHERE group_id=? AND created>? AND person<>? AND recalled=0', (row['id'], mine['last_read'], uid)).fetchone()[0]
        for r in db.execute('SELECT mentions FROM group_messages WHERE group_id=? AND created>? AND person<>? AND recalled=0', (row['id'], mine['last_read'], uid)):
            try:
                if uid in json.loads(r['mentions'] or '[]'):
                    mentions += 1
            except ValueError:
                pass
    return {
        'id': row['id'],
        'name': row['name'],
        'owner': row['owner'],
        'code': row['code'] if row['owner'] == uid else '',
        'members': members,
        'notice': row['notice'] if 'notice' in row.keys() else '',
        'avatar': (row['avatar'] if 'avatar' in row.keys() else '') or '',
        'mentions': mentions,
        'role': mine['role'] if mine else 'guest',
        'unread': unread,
        'last': ({'person': last['person'], 'kind': 'recalled' if last['recalled'] else last['kind'], 'text': '' if last['recalled'] else last['text'], 'created': last['created']} if last else None),
    }


def groups_of(db, uid):
    rows = db.execute(
        'SELECT g.* FROM groups g JOIN group_members m ON m.group_id=g.id WHERE m.user_id=? ORDER BY g.created DESC',
        (uid,),
    ).fetchall()
    return [_payload(db, row, uid) for row in rows]


def create(db, uid, name):
    name = (name or '').strip()
    if not 1 <= len(name) <= MAX_NAME:
        raise GroupError('群名需要 1–%d 个字' % MAX_NAME)
    gid = 'g-' + secrets.token_hex(5)
    code = secrets.token_hex(3).upper()
    now = time.time()
    db.execute('INSERT INTO groups(id,name,owner,code,created) VALUES(?,?,?,?,?)', (gid, name, uid, code, now))
    db.execute("INSERT INTO group_members(group_id,user_id,role,joined,last_read) VALUES(?,?,'owner',?,0)", (gid, uid, now))
    return _payload(db, db.execute('SELECT * FROM groups WHERE id=?', (gid,)).fetchone(), uid)


def join(db, uid, code):
    code = (code or '').strip().upper()
    row = db.execute('SELECT * FROM groups WHERE code=?', (code,)).fetchone()
    if not row:
        raise GroupError('邀请码不正确', 404)
    if _member(db, row['id'], uid):
        return _payload(db, row, uid)
    count = db.execute('SELECT count(*) FROM group_members WHERE group_id=?', (row['id'],)).fetchone()[0]
    if count >= MAX_MEMBERS:
        raise GroupError('群人数已满', 403)
    db.execute("INSERT INTO group_members(group_id,user_id,role,joined,last_read) VALUES(?,?,'member',?,0)", (row['id'], uid, time.time()))
    return _payload(db, row, uid)


def leave(db, uid, gid):
    group = require_member(db, gid, uid)
    if group['owner'] == uid:
        others = db.execute('SELECT user_id FROM group_members WHERE group_id=? AND user_id<>? ORDER BY joined LIMIT 1', (gid, uid)).fetchone()
        if not others:
            # 最后一个人退群：先清消息、成员，再删群（外键要求）。
            db.execute('DELETE FROM group_messages WHERE group_id=?', (gid,))
            db.execute('DELETE FROM group_members WHERE group_id=?', (gid,))
            db.execute('DELETE FROM groups WHERE id=?', (gid,))
            return {'ok': True}
        db.execute("UPDATE group_members SET role='owner' WHERE group_id=? AND user_id=?", (gid, others['user_id']))
        db.execute('UPDATE groups SET owner=? WHERE id=?', (others['user_id'], gid))
    db.execute('DELETE FROM group_members WHERE group_id=? AND user_id=?', (gid, uid))
    return {'ok': True}


def members(db, gid, uid):
    """群成员列表：昵称、头像、角色、加入时间。"""
    require_member(db, gid, uid)
    rows = db.execute(
        'SELECT u.id,u.nickname,u.avatar,m.role,m.joined,coalesce(p.updated,0) AS updated FROM group_members m JOIN users u ON u.id=m.user_id LEFT JOIN presence p ON p.user_id=u.id WHERE m.group_id=? ORDER BY (m.role=\'owner\') DESC,m.joined',
        (gid,),
    ).fetchall()
    return [{'id': r['id'], 'nickname': r['nickname'], 'avatar': r['avatar'], 'role': r['role'], 'joined': r['joined'], 'online': r['updated'] > time.time() - 45} for r in rows]


def set_notice(db, uid, gid, text):
    """只有群主能改群公告。"""
    group = require_member(db, gid, uid)
    if group['owner'] != uid:
        raise GroupError('只有群主可以修改群公告', 403)
    text = (text or '').strip()
    if len(text) > 500:
        raise GroupError('群公告最多 500 字')
    db.execute('UPDATE groups SET notice=? WHERE id=?', (text, gid))
    return {'notice': text}


def kick(db, uid, gid, target):
    group = require_member(db, gid, uid)
    if group['owner'] != uid:
        raise GroupError('只有群主可以移除成员', 403)
    if target == uid:
        raise GroupError('群主不能移除自己')
    if not _member(db, gid, target):
        raise GroupError('这个人不在群里', 404)
    db.execute('DELETE FROM group_members WHERE group_id=? AND user_id=?', (gid, target))
    return {'ok': True}


def post(db, uid, gid, text, reply_to=None):
    require_member(db, gid, uid)
    text = (text or '').strip()
    if not 1 <= len(text) <= MAX_TEXT:
        raise GroupError('消息需要 1–%d 个字' % MAX_TEXT)
    now = time.time()
    mentions = _parse_mentions(db, gid, text, uid)
    if reply_to is not None:
        _message(db, gid, reply_to)
    db.execute("INSERT INTO group_messages(group_id,person,kind,text,created,mentions,reply_to) VALUES(?,?,'text',?,?,?,?)", (gid, uid, text, now, json.dumps(mentions), reply_to))
    message_id = db.execute('SELECT last_insert_rowid()').fetchone()[0]
    _touch(db, gid, uid, now)
    return {'id': message_id, 'created': now}


def _touch(db, gid, uid, now):
    db.execute('UPDATE group_members SET last_read=? WHERE group_id=? AND user_id=?', (now, gid, uid))


def share_trade(db, uid, gid, ticket, snapshot=None, message=''):
    """把一笔交易发进群：群里留一张卡片，同时给每个成员各写一条 review_shares。"""
    require_member(db, gid, uid)
    if not isinstance(message, str) or len(message) > chart.MAX_MESSAGE:
        raise GroupError('分享留言最多 %d 字' % chart.MAX_MESSAGE)
    message = message.strip()
    ticket = str(ticket or '')
    trade = db.execute('SELECT * FROM trades WHERE person=? AND ticket=?', (uid, ticket)).fetchone()
    if not trade:
        raise GroupError('只能分享自己的成交', 403)
    members = [r['user_id'] for r in db.execute('SELECT user_id FROM group_members WHERE group_id=?', (gid,))]
    recipients = [m for m in members if m != uid]
    now = time.time()
    saved_snapshot = chart.clean_snapshot(snapshot)
    db.execute("INSERT INTO group_messages(group_id,person,kind,text,ticket,created,snapshot) VALUES(?,?,'trade',?,?,?,?)", (gid, uid, message, ticket, now, saved_snapshot))
    message_id = db.execute('SELECT last_insert_rowid()').fetchone()[0]
    for start in range(0, len(recipients), chart.MAX_RECIPIENTS):
        chart.share(db, uid, ticket, recipients[start:start + chart.MAX_RECIPIENTS], message, snapshot)
    _touch(db, gid, uid, now)
    return {'id': message_id, 'created': now, 'sent': len(recipients)}


def _parse_mentions(db, gid, text, author):
    """把消息里的 @昵称 解析成成员 id；@所有人 则展开成全部成员（不含自己）。"""
    rows = db.execute('SELECT u.id,u.nickname FROM group_members m JOIN users u ON u.id=m.user_id WHERE m.group_id=?', (gid,)).fetchall()
    found = []
    if '@所有人' in text or '@all' in text:
        found = [r['id'] for r in rows if r['id'] != author]
    else:
        for r in rows:
            name = (r['nickname'] or '').strip()
            if name and name != author and ('@' + name) in text and r['id'] not in found:
                found.append(r['id'])
    return found


def recall(db, gid, uid, message_id):
    """撤回：作者 2 分钟内可撤，群主随时可撤。"""
    require_member(db, gid, uid)
    row = db.execute('SELECT * FROM group_messages WHERE id=? AND group_id=?', (message_id, gid)).fetchone()
    if not row:
        raise GroupError('消息不存在', 404)
    group = db.execute('SELECT owner FROM groups WHERE id=?', (gid,)).fetchone()
    is_owner = bool(group and group['owner'] == uid)
    if row['person'] != uid and not is_owner:
        raise GroupError('只能撤回自己的消息', 403)
    if row['recalled']:
        return {'ok': True}
    if row['person'] == uid and not is_owner and time.time() - row['created'] > 120:
        raise GroupError('超过 2 分钟，不能撤回', 403)
    db.execute('UPDATE group_messages SET recalled=1 WHERE id=?', (message_id,))
    return {'ok': True}


def rename(db, uid, gid, name=None, avatar=None):
    """群主改群名 / 群头像。"""
    group = require_member(db, gid, uid)
    if group['owner'] != uid:
        raise GroupError('只有群主可以修改群资料', 403)
    if name is not None:
        name = str(name).strip()
        if not 1 <= len(name) <= MAX_NAME:
            raise GroupError('群名需要 1–%d 个字' % MAX_NAME)
        db.execute('UPDATE groups SET name=? WHERE id=?', (name, gid))
    if avatar is not None:
        avatar = str(avatar).strip()
        if avatar and not re.fullmatch(r'avatar(?:[1-9]|1[0-2])', avatar):
            raise GroupError('群头像不正确')
        db.execute('UPDATE groups SET avatar=? WHERE id=?', (avatar, gid))
    row = db.execute('SELECT * FROM groups WHERE id=?', (gid,)).fetchone()
    return {'name': row['name'], 'avatar': row['avatar']}


def messages(db, gid, uid, limit=100):
    group = require_member(db, gid, uid)
    rows = db.execute(
        'SELECT m.*,u.nickname,u.avatar FROM group_messages m JOIN users u ON u.id=m.person WHERE m.group_id=? ORDER BY m.id DESC LIMIT ?',
        (gid, max(1, min(limit, 200))),
    ).fetchall()
    out = []
    for row in reversed(rows):
        try:
            mentioned = json.loads(row['mentions'] or '[]')
        except ValueError:
            mentioned = []
        item = {
            'id': row['id'],
            'person': row['person'],
            'name': row['nickname'],
            'avatar': row['avatar'],
            'kind': 'recalled' if row['recalled'] else row['kind'],
            'text': '' if row['recalled'] else row['text'],
            'ticket': None if row['recalled'] else row['ticket'],
            'created': row['created'],
            'mentions': [] if row['recalled'] else mentioned,
            'reply': None if row['recalled'] else _reply(db, gid, row['reply_to']),
            'reactions': [] if row['recalled'] else dm.reactions(db, 'group_reactions', row['id'], uid),
            'mine': row['person'] == uid,
            'recallable': bool(not row['recalled'] and (group['owner'] == uid or (row['person'] == uid and time.time() - row['created'] <= 120))),
        }
        if not row['recalled'] and row['kind'] == 'trade' and row['ticket']:
            share = db.execute(
                'SELECT id FROM review_shares WHERE owner=? AND ticket=? AND recipient=?',
                (row['person'], row['ticket'], uid),
            ).fetchone()
            item['share'] = share['id'] if share else None
        out.append(item)
    _touch(db, gid, uid, time.time())
    return out


def open_trade(db, gid, uid, message_id):
    """成员点击交易卡片：确保自己有这条 share，返回 share id。"""
    require_member(db, gid, uid)
    row = db.execute('SELECT * FROM group_messages WHERE id=? AND group_id=?', (message_id, gid)).fetchone()
    if not row or row['recalled'] or row['kind'] != 'trade' or not row['ticket']:
        raise GroupError('这条消息不是交易', 404)
    share = db.execute('SELECT id FROM review_shares WHERE owner=? AND ticket=? AND recipient=?', (row['person'], row['ticket'], uid)).fetchone()
    if share:
        return {'share': share['id']}
    chart.share(db, row['person'], row['ticket'], [uid], row['text'] or '', json.loads(row['snapshot']) if row['snapshot'] else None)
    share = db.execute('SELECT id FROM review_shares WHERE owner=? AND ticket=? AND recipient=?', (row['person'], row['ticket'], uid)).fetchone()
    if not share:
        raise GroupError('这笔交易暂时无法打开', 404)
    return {'share': share['id']}


def _message(db, gid, message_id, allow_recalled=False):
 if not isinstance(message_id, int) or isinstance(message_id, bool) or message_id < 1:
  raise GroupError('消息编号不正确')
 row = db.execute('SELECT m.*,u.nickname FROM group_messages m JOIN users u ON u.id=m.person WHERE m.id=? AND m.group_id=?', (message_id, gid)).fetchone()
 if not row or (row['recalled'] and not allow_recalled):
  raise GroupError('消息不存在或已撤回', 404)
 return row


def _reply(db, gid, message_id):
 if message_id is None:
  return None
 row = _message(db, gid, message_id, True)
 text = '消息已撤回' if row['recalled'] else row['text'] or '交易复盘'
 return {'id': row['id'], 'name': row['nickname'], 'text': text}


def reaction(db, uid, gid, message_id, emoji, active):
 require_member(db, gid, uid)
 _message(db, gid, message_id)
 if not isinstance(emoji, str) or emoji not in dm.REACTIONS or not isinstance(active, bool):
  raise GroupError('表情回应不正确')
 if active:
  db.execute('INSERT OR IGNORE INTO group_reactions(message_id,user_id,emoji) VALUES(?,?,?)', (message_id, uid, emoji))
 else:
  db.execute('DELETE FROM group_reactions WHERE message_id=? AND user_id=? AND emoji=?', (message_id, uid, emoji))
 return {'reactions': dm.reactions(db, 'group_reactions', message_id, uid)}

"""群组：建群、邀请码加入、群聊、把一笔交易发进群。

设计要点：
- 群成员看某笔交易，走的是已有的 `review_shares` 通道：发进群时给每个成员
  各写一条 share 记录，前端用 `?share=<id>` 打开，权限、K 线、轨道全部复用，
  不再给群单独开一套行情权限。
- 群聊消息表只存文本 / 交易卡片（ticket + 分享人），不存行情数据。
- 群成员之间**不**因此获得「看全部交易」的权限：整份历史仍然要求互为好友。
"""

import secrets
import time

import chart

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
            created REAL NOT NULL
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
            created REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_group_messages ON group_messages(group_id,id);
        '''
    )


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
    last = db.execute('SELECT person,kind,text,created FROM group_messages WHERE group_id=? ORDER BY id DESC LIMIT 1', (row['id'],)).fetchone()
    mine = _member(db, row['id'], uid)
    unread = 0
    if mine:
        unread = db.execute('SELECT count(*) FROM group_messages WHERE group_id=? AND id>0 AND created>? AND person<>?', (row['id'], mine['last_read'], uid)).fetchone()[0]
    return {
        'id': row['id'],
        'name': row['name'],
        'owner': row['owner'],
        'code': row['code'] if row['owner'] == uid else '',
        'members': members,
        'role': mine['role'] if mine else 'guest',
        'unread': unread,
        'last': ({'person': last['person'], 'kind': last['kind'], 'text': last['text'], 'created': last['created']} if last else None),
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


def kick(db, uid, gid, target):
    group = require_member(db, gid, uid)
    if group['owner'] != uid:
        raise GroupError('只有群主可以移除成员', 403)
    if target == uid:
        raise GroupError('群主不能移除自己')
    db.execute('DELETE FROM group_members WHERE group_id=? AND user_id=?', (gid, target))
    return {'ok': True}


def post(db, uid, gid, text):
    require_member(db, gid, uid)
    text = (text or '').strip()
    if not 1 <= len(text) <= MAX_TEXT:
        raise GroupError('消息需要 1–%d 个字' % MAX_TEXT)
    now = time.time()
    db.execute("INSERT INTO group_messages(group_id,person,kind,text,created) VALUES(?,?,'text',?,?)", (gid, uid, text, now))
    _touch(db, gid, uid, now)
    return {'created': now}


def _touch(db, gid, uid, now):
    db.execute('UPDATE group_members SET last_read=? WHERE group_id=? AND user_id=?', (now, gid, uid))


def share_trade(db, uid, gid, ticket):
    """把一笔交易发进群：群里留一张卡片，同时给每个成员各写一条 review_shares。"""
    require_member(db, gid, uid)
    ticket = str(ticket or '')
    trade = db.execute('SELECT * FROM trades WHERE person=? AND ticket=?', (uid, ticket)).fetchone()
    if not trade:
        raise GroupError('只能分享自己的成交', 403)
    members = [r['user_id'] for r in db.execute('SELECT user_id FROM group_members WHERE group_id=?', (gid,))]
    recipients = [m for m in members if m != uid]
    now = time.time()
    db.execute("INSERT INTO group_messages(group_id,person,kind,text,ticket,created) VALUES(?,?,'trade','',?,?)", (gid, uid, ticket, now))
    message_id = db.execute('SELECT last_insert_rowid()').fetchone()[0]
    if recipients:
        chart.share(db, uid, ticket, recipients, '', None)
    _touch(db, gid, uid, now)
    return {'id': message_id, 'created': now, 'sent': len(recipients)}


def messages(db, gid, uid, limit=100):
    require_member(db, gid, uid)
    rows = db.execute(
        'SELECT m.*,u.nickname,u.avatar FROM group_messages m JOIN users u ON u.id=m.person WHERE m.group_id=? ORDER BY m.id DESC LIMIT ?',
        (gid, max(1, min(limit, 200))),
    ).fetchall()
    out = []
    for row in reversed(rows):
        item = {
            'id': row['id'],
            'person': row['person'],
            'name': row['nickname'],
            'avatar': row['avatar'],
            'kind': row['kind'],
            'text': row['text'],
            'ticket': row['ticket'],
            'created': row['created'],
        }
        if row['kind'] == 'trade' and row['ticket']:
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
    if not row or row['kind'] != 'trade' or not row['ticket']:
        raise GroupError('这条消息不是交易', 404)
    share = db.execute('SELECT id FROM review_shares WHERE owner=? AND ticket=? AND recipient=?', (row['person'], row['ticket'], uid)).fetchone()
    if share:
        return {'share': share['id']}
    chart.share(db, row['person'], row['ticket'], [uid], '', None)
    share = db.execute('SELECT id FROM review_shares WHERE owner=? AND ticket=? AND recipient=?', (row['person'], row['ticket'], uid)).fetchone()
    if not share:
        raise GroupError('这笔交易暂时无法打开', 404)
    return {'share': share['id']}

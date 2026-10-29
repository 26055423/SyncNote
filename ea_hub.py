"""多用户 EA hub：MT5 上的 WebBridge EA 直接连到这里，网页从同一份状态读。

协议沿用 `live_data/ea_bridge/PROTOCOL.md` 的 v1 NDJSON：
    hello（携带连接码）→ 之后 account / positions / orders / bars / trade / heartbeat

和本地 gateway.py 的区别只有两点：
  * 监听在服务器上，按连接码把会话绑定到同频用户，一个用户一条连接；
  * 状态只留在内存，按周期落一次快照到同频的 SQLite（成交单独落 trades）。

TLS 还没接（等域名）：现在先用明文 TCP + 连接码，仅用于打通链路。
"""
import asyncio
import hashlib
import json
import os
import sqlite3
import threading
import time
from collections import deque

HUB_PORT = int(os.environ.get('EA_HUB_PORT', '8788'))
HUB_HOST = os.environ.get('EA_HUB_HOST', '0.0.0.0')
HEARTBEAT_TIMEOUT = 15.0
MAX_BARS = 1500
PERSIST_SECONDS = 2.0
STALE_SECONDS = 20.0

PING = os.environ.get('EA_HUB_PING', '1') == '1'


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


class Session:
    """一个用户的 EA 连接与它最新的状态。"""

    def __init__(self, user_id, token_hash, generation):
        self.user_id = user_id
        self.token_hash = token_hash
        self.generation = generation
        self.account = {}
        self.positions = []
        self.orders = []
        self.bars = {tf: deque(maxlen=MAX_BARS) for tf in ('1m', '5m', '15m', '1h')}
        self.deals = {}
        self.history = {}
        self.events = []
        self.connected_at = time.time()
        self.last_seen = time.time()
        self.server_offset = 0
        self.dirty = False

    def snapshot(self):
        """网页可直接用的快照，形状和 /api/snapshot 落库的一致。"""
        now = time.time()
        offset = self.server_offset
        history = []
        for item in self.history.values():
            history.append(dict(item))
        history.sort(key=lambda row: row.get('closed', 0), reverse=True)
        return {
            'balance': float(self.account.get('balance') or 0),
            'equity': float(self.account.get('equity') or 0),
            'currency': self.account.get('currency') or 'USD',
            'account': str(self.account.get('login') or ''),
            'online': now - self.last_seen <= STALE_SECONDS,
            'positions': [
                {
                    'ticket': str(p.get('ticket')),
                    'symbol': p.get('symbol'),
                    'side': p.get('side'),
                    'volume': float(p.get('volume') or 0),
                    'open': float(p.get('price_open') or 0),
                    'profit': float(p.get('profit') or 0),
                    'sl': float(p['sl']) if p.get('sl') else None,
                    'tp': float(p['tp']) if p.get('tp') else None,
                }
                for p in self.positions
            ],
            'history': history[:500],
            'clock_offset': offset,
            'source': 'ea-hub',
        }


class Hub:
    def __init__(self, connect, on_trade=None):
        self.connect = connect
        self.on_trade = on_trade
        self.sessions = {}
        self.lock = threading.Lock()
        self.generation = 0
        self.loop = None
        self.server = None
        self.thread = None
        self._stop = None
        self._persist_task = None

    # ---------------------------------------------------------------- 生命周期
    def start(self):
        self.thread = threading.Thread(target=self._run, name='ea-hub', daemon=True)
        self.thread.start()
        return self

    def _run(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self._stop = asyncio.Event()
        self.loop.run_until_complete(self._serve())

    async def _serve(self):
        try:
            self.server = await asyncio.start_server(self._handle, HUB_HOST, HUB_PORT, limit=4 * 1024 * 1024)
        except OSError as error:
            print('ea hub: cannot bind %s:%s (%s)' % (HUB_HOST, HUB_PORT, error), flush=True)
            return
        print('ea hub: listening on %s:%s' % (HUB_HOST, HUB_PORT), flush=True)
        self._persist_task = asyncio.create_task(self._persist_loop())
        async with self.server:
            await self._stop.wait()

    # ------------------------------------------------------------------ 会话
    async def _handle(self, reader, writer):
        peer = writer.get_extra_info('peername')
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=5.0)
        except (asyncio.TimeoutError, ConnectionError):
            writer.close()
            return
        try:
            hello = json.loads(line.decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            writer.close()
            return
        if not isinstance(hello, dict) or hello.get('v') != 1 or hello.get('type') != 'hello':
            writer.close()
            return
        token = hello.get('token') or ''
        if not isinstance(token, str) or len(token) < 16:
            await self._close(writer, 'bad token')
            return
        try:
            with self.connect() as db:
                link = db.execute('SELECT user_id FROM mt5_links WHERE token_hash=?', (digest(token),)).fetchone()
        except sqlite3.Error:
            link = None
        if not link:
            await self._close(writer, 'unknown token')
            return
        user_id = link['user_id']
        with self.lock:
            self.generation += 1
            session = Session(user_id, digest(token), self.generation)
            session.server_offset = int(hello.get('server_offset_sec') or 0)
            old = self.sessions.get(user_id)
            self.sessions[user_id] = session
        if old is not None:
            print('ea hub: replacing session for %s' % user_id[-6:], flush=True)

        writer.write((json.dumps({'type': 'hello_ack', 'ok': True, 'server_time': int(time.time() * 1000)}) + '\n').encode())
        await writer.drain()
        print('ea hub: %s connected from %s' % (user_id[-6:], peer[0] if peer else '?'), flush=True)

        try:
            while True:
                line = await asyncio.wait_for(reader.readline(), timeout=HEARTBEAT_TIMEOUT)
                if not line:
                    break
                try:
                    message = json.loads(line.decode('utf-8'))
                except (ValueError, UnicodeDecodeError):
                    continue
                if not isinstance(message, dict):
                    continue
                self._apply(session, message)
        except (asyncio.TimeoutError, ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            with self.lock:
                if self.sessions.get(user_id) is session:
                    self.sessions.pop(user_id, None)
            try:
                with self.connect() as db:
                    row = db.execute('SELECT payload FROM snapshots WHERE person=?', (user_id,)).fetchone()
                    if row:
                        payload = json.loads(row['payload'])
                        payload['online'] = False
                        db.execute('UPDATE snapshots SET payload=? WHERE person=?', (json.dumps(payload, ensure_ascii=False), user_id))
            except Exception:
                pass
            print('ea hub: %s disconnected' % user_id[-6:], flush=True)
            try:
                writer.close()
            except Exception:
                pass

    async def _close(self, writer, reason):
        try:
            writer.write((json.dumps({'type': 'error', 'error': reason}) + '\n').encode())
            await writer.drain()
        except Exception:
            pass
        writer.close()

    def _apply(self, session, message):
        kind = message.get('type')
        session.last_seen = time.time()
        if kind == 'account':
            session.account = message
            session.dirty = True
        elif kind == 'positions':
            items = message.get('items')
            if isinstance(items, list):
                session.positions = items[:500]
                session.dirty = True
        elif kind == 'orders':
            items = message.get('items')
            if isinstance(items, list):
                session.orders = items[:200]
        elif kind == 'bars':
            tf = message.get('tf')
            values = message.get('bars') or message.get('items') or []
            if tf in session.bars and isinstance(values, list):
                for bar in values:
                    if isinstance(bar, dict) and isinstance(bar.get('bar_time'), (int, float)):
                        session.bars[tf].append(bar)
        elif kind == 'trade':
            self._trade(session, message)
        elif kind == 'heartbeat':
            if isinstance(message.get('server_offset_sec'), (int, float)):
                session.server_offset = int(message['server_offset_sec'])

    def _trade(self, session, message):
        """把成对 deal 合成已平仓交易（开仓方向即持仓方向）。"""
        position = str(message.get('position') or message.get('order') or '')
        side = message.get('side')
        price = message.get('price')
        volume = message.get('volume')
        stamp = message.get('time_msc')
        if not position or side not in ('buy', 'sell') or not isinstance(price, (int, float)) or not isinstance(volume, (int, float)) or not isinstance(stamp, (int, float)):
            return
        deal = {'side': side, 'price': float(price), 'volume': float(volume), 'time_msc': int(stamp),
                'profit': float(message.get('profit') or 0), 'symbol': message.get('symbol') or ''}
        rows = session.deals.setdefault(position, [])
        rows.append(deal)
        first_side = rows[0]['side']
        entries = [r for r in rows if r['side'] == first_side]
        exits = [r for r in rows if r['side'] != first_side]
        if not exits:
            return
        volume = sum(r['volume'] for r in exits) or sum(r['volume'] for r in entries)
        if volume <= 0:
            return
        entry_volume = sum(r['volume'] for r in entries) or volume
        exit_volume = sum(r['volume'] for r in exits) or volume
        item = {
            'ticket': position,
            'symbol': rows[0]['symbol'],
            'side': 'buy' if first_side == 'buy' else 'sell',
            'volume': round(volume, 4),
            'open': round(sum(r['price'] * r['volume'] for r in entries) / entry_volume, 5),
            'close': round(sum(r['price'] * r['volume'] for r in exits) / exit_volume, 5),
            'profit': round(sum(r['profit'] for r in exits), 2),
            'opened_server': int(min(r['time_msc'] for r in entries) // 1000),
            'closed_server': int(max(r['time_msc'] for r in exits) // 1000),
            'time_basis': 'utc',
        }
        item['closed'] = item['closed_server'] - session.server_offset
        session.history[position] = item
        session.events.append({
            'key': 'deal-%s-%s' % (position, deal['time_msc']),
            'kind': 'close',
            'text': '平仓 %s · %.2f 手 · 盈亏 %+.2f' % (item['symbol'], item['volume'], item['profit']),
        })
        session.dirty = True
        if self.on_trade:
            try:
                self.on_trade(session.user_id, item, session.server_offset)
            except Exception as error:
                print('ea hub: on_trade failed (%s)' % error, flush=True)

    # ------------------------------------------------------------------ 落库
    async def _persist_loop(self):
        while True:
            await asyncio.sleep(PERSIST_SECONDS)
            try:
                self.persist_once()
            except Exception as error:
                print('ea hub: persist failed (%s)' % error, flush=True)

    def persist_once(self):
        with self.lock:
            sessions = list(self.sessions.values())
        if not sessions:
            return
        with self.connect() as db:
            for session in sessions:
                if not session.dirty:
                    continue
                data = session.snapshot()
                data.pop('history', None)
                db.execute('INSERT INTO snapshots VALUES(?,?,?) ON CONFLICT(person) DO UPDATE SET payload=excluded.payload,updated=excluded.updated',
                           (session.user_id, json.dumps(data, allow_nan=False, ensure_ascii=False), session.last_seen))
                for event in session.events[:50]:
                    db.execute('INSERT OR IGNORE INTO events(person,event_key,kind,text,created) VALUES(?,?,?,?,?)',
                               (session.user_id, event['key'], event['kind'], event['text'], session.last_seen))
                session.events = session.events[50:]
                session.dirty = False

    # ------------------------------------------------------------------ 读取
    def live(self, user_id):
        with self.lock:
            session = self.sessions.get(user_id)
            if not session:
                return None
            if time.time() - session.last_seen > STALE_SECONDS:
                return None
            return session.snapshot()

    def connected(self):
        with self.lock:
            return {uid: round(time.time() - s.last_seen, 1) for uid, s in self.sessions.items()}

    def review_charts(self, user_id, opened_server, closed_server):
        """用 EA 推上来的 bars 拼复盘用的四周期 K 线（券商时间）。"""
        with self.lock:
            session = self.sessions.get(user_id)
            if not session:
                return None
            cached = {tf: list(session.bars[tf]) for tf in session.bars}
        if not cached.get('1m'):
            return None
        charts, errors = {}, {}
        for name, tf, seconds in (('M1', '1m', 60), ('M5', '5m', 300), ('M15', '15m', 900), ('H1', '1h', 3600)):
            rows = [b for b in cached.get(tf, []) if opened_server - 30 * seconds <= b.get('bar_time', 0) <= closed_server + 30 * seconds]
            reason = ''
            if len(rows) > 2000:
                rows, reason = [], 'range_too_long'
            elif not rows or rows[0]['bar_time'] > opened_server or rows[-1]['bar_time'] + seconds <= closed_server:
                rows, reason = [], 'history_unavailable'
            charts[name] = [[b['bar_time'], b['open'], b['high'], b['low'], b['close']] for b in rows]
            errors[name] = reason
        return {'charts': charts, 'errors': errors}

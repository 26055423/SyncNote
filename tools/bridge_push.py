"""把本地 MT5 WebBridge 的数据推给同频，替代 TongpinSync.mq5。

MT5 已经挂了 WebBridge（EA → gateway.py → http://127.0.0.1:8790）时，不用再装第二个 EA：
这个脚本在本机读 bridge 的账户/持仓/成交和 K 线，转成同频 `/api/snapshot` 的格式推上去，
并按同频返回的 review_ticket 上传四周期复盘 K 线。

用法：
    python tools/bridge_push.py --token <个人中心生成的连接码>
    python tools/bridge_push.py --token ... --tongpin https://你的域名 --once

只读：不碰 MT5，不写 bridge 数据库，只发 HTTP。
"""
import argparse
import json
import os
import sqlite3
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_BRIDGE = 'http://127.0.0.1:8790'
_LEGACY_DB = r'D:\Projects\trade_dashboard\live_data\ea_bridge\ea_bridge.db'
_REPO_DB = str(Path(__file__).resolve().parents[1] / 'bridge' / 'ea_bridge.db')
# 优先用仓库内的 bridge 数据库；还没迁过去时回退到旧路径，保证现有网关不中断。
DEFAULT_DB = os.environ.get('EA_BRIDGE_DB') or (_REPO_DB if os.path.exists(_REPO_DB) else _LEGACY_DB)
STATE_FILE = Path(__file__).with_name('bridge_push_state.json')
TIMEFRAMES = (('M1', '1m', 60), ('M5', '5m', 300), ('M15', '15m', 900), ('H1', '1h', 3600))


def request_json(url, data=None, token=None, timeout=15):
    body = None
    headers = {'Accept': 'application/json'}
    if data is not None:
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw = response.read()
        return response.status, (json.loads(raw.decode('utf-8')) if raw else {})


def load_state():
    try:
        return json.loads(STATE_FILE.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {'last_deal_id': 0, 'events_sent': []}


def save_state(state):
    try:
        STATE_FILE.write_text(json.dumps(state, ensure_ascii=False), encoding='utf-8')
    except OSError:
        pass


def read_deals(db_path):
    """只读打开 bridge 的 SQLite（WAL 模式，gateway 在写）。"""
    con = sqlite3.connect('file:%s?mode=ro' % Path(db_path).as_posix(), uri=True, timeout=5)
    con.row_factory = sqlite3.Row
    try:
        con.execute('PRAGMA busy_timeout=3000')
        return [dict(row) for row in con.execute('SELECT * FROM trades ORDER BY id')]
    finally:
        con.close()


def closed_positions(deals):
    """把成对的成交合成已平仓交易（开仓方向即为持仓方向）。"""
    grouped = {}
    for deal in deals:
        grouped.setdefault(deal['position_ticket'], []).append(deal)
    result = {}
    for position, rows in grouped.items():
        rows.sort(key=lambda r: (r['time_msc'], r['id']))
        side = rows[0]['side']
        entries = [r for r in rows if r['side'] == side]
        exits = [r for r in rows if r['side'] != side]
        if not entries or not exits:
            continue
        volume = sum(r['volume'] for r in exits) or sum(r['volume'] for r in entries)
        if volume <= 0:
            continue
        entry_volume = sum(r['volume'] for r in entries) or volume
        open_price = sum(r['price'] * r['volume'] for r in entries) / entry_volume
        exit_volume = sum(r['volume'] for r in exits)
        close_price = sum(r['price'] * r['volume'] for r in exits) / exit_volume
        result[str(position)] = {
            'ticket': str(position),
            'symbol': entries[0]['symbol'],
            'side': 'buy' if side == 'buy' else 'sell',
            'volume': round(volume, 4),
            'open': round(open_price, 5),
            'close': round(close_price, 5),
            'profit': round(sum(r['profit'] for r in exits), 2),
            'opened_server': int(min(r['time_msc'] for r in entries) // 1000),
            'closed_server': int(max(r['time_msc'] for r in exits) // 1000),
            'last_deal_id': max(r['id'] for r in rows),
        }
    return result


def snapshot_payload(bridge, db_path, state):
    health = request_json(bridge + '/api/health')[1]
    account = request_json(bridge + '/api/account')[1]['account']
    positions = request_json(bridge + '/api/positions')[1]['items']
    deals = read_deals(db_path)
    closed = closed_positions(deals)
    offset = int(health.get('server_offset_sec') or 0)
    now = int(time.time())

    mapped_positions = []
    for item in positions:
        mapped_positions.append({
            'ticket': str(item.get('ticket')),
            'symbol': item.get('symbol'),
            'side': 'sell' if item.get('side') == 'sell' else 'buy',
            'volume': float(item.get('volume') or 0),
            'open': float(item.get('price_open') or 0),
            'profit': float(item.get('profit') or 0),
            'sl': float(item['sl']) if item.get('sl') else None,
            'tp': float(item['tp']) if item.get('tp') else None,
        })

    events = []
    last_id = int(state.get('last_deal_id') or 0)
    for deal in deals:
        if deal['id'] <= last_id:
            continue
        position = closed.get(str(deal['position_ticket']))
        opening = position is None or deal['side'] == position['side']
        events.append({
            'key': 'deal-%s' % deal['deal_ticket'],
            'kind': 'open' if opening else 'close',
            'text': ('%s %s · %.2f 手' % ('买入' if deal['side'] == 'buy' else '卖出', deal['symbol'], deal['volume']))
            if opening else
            ('平仓 %s · %.2f 手 · 盈亏 %+.2f' % (deal['symbol'], deal['volume'], deal['profit'])),
        })

    # bridge 的成交时间是券商墙钟；同频要 UTC 的 closed 加上券商时间的 closed_server，
    # 这样历史补传也能按 (closed_server - closed) 校准，而不用依赖“刚平仓”的测量窗口。
    for item in closed.values():
        item['closed'] = item['closed_server'] - offset
        item['time_basis'] = 'utc'
    history = list(closed.values())
    history.sort(key=lambda r: r['closed'], reverse=True)
    payload = {
        'snapshot': {
            'clock': {'server': now + offset, 'utc': now},
            'account': str(account.get('login') or ''),
            'broker': 'WebBridge',
            'currency': account.get('currency') or 'USD',
            'balance': float(account.get('balance') or 0),
            'equity': float(account.get('equity') or 0),
            'online': bool(health.get('ea_connected')),
            'positions': mapped_positions,
            'history': history[:500],
        },
        'events': events[:100],
    }
    return payload, closed, max([d['id'] for d in deals], default=last_id)


def upload_review(bridge, tongpin, token, ticket, closed):
    trade = closed.get(str(ticket))
    if not trade:
        return 'unknown ticket'
    opened, end = trade['opened_server'], trade['closed_server']
    charts, errors = {}, {}
    for name, tf, seconds in TIMEFRAMES:
        rows, reason = [], ''
        try:
            bars = request_json('%s/api/bars?tf=%s&limit=5000' % (bridge, tf))[1].get('bars') or []
        except urllib.error.URLError as error:
            bars, reason = [], 'bridge: %s' % error
        window = [b for b in bars if opened - 30 * seconds <= b['bar_time'] <= end + 30 * seconds]
        if not bars and not reason:
            reason = 'history_unavailable'
        elif len(window) > 2000:
            reason = 'range_too_long'
            window = []
        elif not window or window[0]['bar_time'] > opened or window[-1]['bar_time'] + seconds <= end:
            reason = 'history_unavailable'
            window = []
        charts[name] = [[b['bar_time'], b['open'], b['high'], b['low'], b['close']] for b in window]
        errors[name] = reason
    body = {'ticket': str(ticket), 'opened_server': opened, 'closed_server': end, 'error': '', 'charts': charts, 'errors': errors}
    try:
        status, _ = request_json(tongpin + '/api/mt5/review', body, token)
        return 'uploaded' if status == 200 else 'http %s' % status
    except urllib.error.HTTPError as error:
        return 'rejected %s %s' % (error.code, error.read()[:160].decode('utf-8', 'replace'))
    except urllib.error.URLError as error:
        return 'network %s' % error


def push_live(bridge, tongpin, token, state):
    """把最新 tick 和 K 线推给同频（首次 300 根，之后只补最新几根）。"""
    health = request_json(bridge + '/api/health')[1]
    offset = int(health.get('server_offset_sec') or 0)
    bootstrap = not state.get('live_bootstrapped')
    limit = 300 if bootstrap else 3
    latest = request_json(bridge + '/api/latest')[1]
    tick = latest.get('tick') or {}
    payload = {
        'offset': offset,
        'tick': {
            'bid': float(tick.get('bid') or 0),
            'ask': float(tick.get('ask') or 0),
            'time': int((tick.get('ts_msc') or 0) // 1000) - offset,
        } if tick else None,
        'bars': {},
    }
    for tf in ('1m', '5m', '15m', '1h'):
        data = request_json('%s/api/bars?tf=%s&limit=%d' % (bridge, tf, limit))[1]
        rows = []
        for bar in data.get('bars') or []:
            rows.append([bar['bar_time'] - offset, bar['open'], bar['high'], bar['low'], bar['close']])
        if rows:
            payload['bars'][tf] = rows
    status, reply = request_json(tongpin + '/api/mt5/live', payload, token)
    if status == 200:
        # 服务端重启过（内存行情为空）时要求重新 bootstrap，否则只会补几根。
        state['live_bootstrapped'] = not (reply or {}).get('bootstrap')
        save_state(state)
    return status


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--token', default=os.environ.get('TONGPIN_TOKEN',''), help='同频个人中心生成的连接码（也可用环境变量 TONGPIN_TOKEN）')
    parser.add_argument('--tongpin', default='http://127.0.0.1:18886', help='同频地址，例如 https://tongpin.example.com')
    parser.add_argument('--bridge', default=DEFAULT_BRIDGE)
    parser.add_argument('--db', default=DEFAULT_DB, help='bridge 的 ea_bridge.db')
    parser.add_argument('--interval', type=float, default=5.0)
    parser.add_argument('--once', action='store_true', help='只推一次，便于排查')
    args = parser.parse_args()
    if not args.token:
        print('缺少连接码：--token 或环境变量 TONGPIN_TOKEN')
        return 2

    tongpin = args.tongpin.rstrip('/')
    state = load_state()
    while True:
        try:
            payload, closed, last_id = snapshot_payload(args.bridge, args.db, state)
            status, reply = request_json(tongpin + '/api/snapshot', payload, args.token)
            if status != 200:
                print('snapshot rejected:', status, reply)
            else:
                job = (reply or {}).get('review_ticket') or ''
                if job:
                    print('review job:', job, upload_review(args.bridge, tongpin, args.token, job, closed))
                state['last_deal_id'] = last_id
                save_state(state)
                print('pushed', len(payload['snapshot']['history']), 'closed /', len(payload['snapshot']['positions']), 'open')
            try:
                push_live(args.bridge, tongpin, args.token, state)
            except (urllib.error.URLError, OSError, KeyError) as error:
                print('live push skipped:', error)
        except urllib.error.HTTPError as error:
            print('http error:', error.code, error.read()[:200])
            if error.code in (401, 403):
                print('连接码无效或已撤销，请到个人中心重新生成')
                return 1
        except (urllib.error.URLError, OSError, sqlite3.Error) as error:
            print('bridge unreachable:', error)
        if args.once:
            return 0
        time.sleep(max(2.0, args.interval))


if __name__ == '__main__':
    raise SystemExit(main())

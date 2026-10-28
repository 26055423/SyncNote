"""本地演示实例：临时空库 + 合成示例数据，用来在浏览器里看完整效果。

用法：
    python tools/local_demo.py                 # 默认 127.0.0.1:18900
    python tools/local_demo.py --port 18901

数据写在 --data 指定的目录（默认系统临时目录下的 tongpin-demo），
删除该目录即可重置。所有账号、交易、行情都是脚本生成的合成数据。
"""
import argparse
import json
import os
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def build_bars(opened, closed, seed):
    """围绕一笔交易生成 1 分钟 K 线，再聚合成 5m/15m/1h。"""
    start = opened - 4 * 3600
    end = closed + 4 * 3600
    bars = []
    price = 2640.0 + seed
    for i in range((end - start) // 60):
        drift = 0.18 if (i // 45) % 2 == 0 else -0.14
        open_ = price
        close = price + drift
        high = max(open_, close) + 0.45
        low = min(open_, close) - 0.4
        bars.append([start + i * 60, round(open_, 2), round(high, 2), round(low, 2), round(close, 2), 8 + i % 7])
        price = close
    return bars


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=18900)
    parser.add_argument('--data', default=os.path.join(tempfile.gettempdir(), 'tongpin-demo'))
    parser.add_argument('--password', default='tongpin-demo-2026')
    args = parser.parse_args()

    data_dir = Path(args.data)
    data_dir.mkdir(parents=True, exist_ok=True)
    fresh = not (data_dir / 'board.sqlite3').exists()

    os.environ.setdefault('DATA_DIR', str(data_dir))
    os.environ.setdefault('HOST', '127.0.0.1')
    os.environ.setdefault('PORT', str(args.port))
    os.environ.setdefault('PUBLIC_ORIGIN', 'http://127.0.0.1:%d' % args.port)
    os.environ.setdefault('COOKIE_SECURE', '0')
    os.environ.setdefault('ADMIN_USERNAME', 'admin')

    if fresh:
        from bootstrap_admin import create_admin
        create_admin(args.password)

    import app_server as app
    import market

    db = app.connect()
    admin = db.execute("SELECT * FROM users LIMIT 1").fetchone()
    if admin is None:
        raise SystemExit('数据库里没有账号，请删除 %s 后重试' % data_dir)
    admin_id = admin['id']

    if db.execute('SELECT count(*) FROM trades').fetchone()[0] == 0:
        now = time.time()
        friend_id = 'demo-friend-0001'
        db.execute(
            "INSERT OR IGNORE INTO users(id,username,nickname,avatar,password,allow_follow,share_data,share_reviews,created,onboarding_step) VALUES(?,?,?,?,?,1,1,1,?,4)",
            (friend_id, 'demo_friend', '阿哲', 'avatar3', app.pw_hash('friend-demo-9021'), now),
        )
        db.execute("INSERT OR IGNORE INTO follows VALUES(?,?,?)", (admin_id, friend_id, now))
        db.execute("INSERT OR IGNORE INTO follows VALUES(?,?,?)", (friend_id, admin_id, now))

        trades = [
            ('DEMO-1001', 'buy', datetime(2026, 10, 27, 6, 20, tzinfo=timezone.utc), 45, 2650.4, 2662.8, 0.1),
            ('DEMO-1002', 'sell', datetime(2026, 10, 27, 13, 10, tzinfo=timezone.utc), 80, 2661.2, 2652.6, 0.05),
            ('DEMO-1003', 'buy', datetime(2026, 10, 28, 1, 5, tzinfo=timezone.utc), 35, 2645.8, 2641.1, 0.2),
            ('DEMO-1004', 'buy', datetime(2026, 10, 28, 8, 40, tzinfo=timezone.utc), 55, 2653.0, 2667.5, 0.1),
        ]
        notes = {
            'DEMO-1001': ('按计划等回调到 15 分钟需求区才进场，止损放在结构下方。出场偏早，后面还有一段。', ['执行良好', '出场管理']),
            'DEMO-1003': ('进场前没有确认 1 小时趋势，逆势接了下跌，止损被打后行情继续下行。', ['方向判断', '未按计划']),
        }
        for index, (ticket, side, opened_dt, minutes, open_price, close_price, volume) in enumerate(trades):
            opened = int(opened_dt.timestamp())
            closed = opened + minutes * 60
            profit = round((close_price - open_price) * (1 if side == 'buy' else -1) * volume * 100, 2)
            trade = {
                'ticket': ticket, 'symbol': 'XAUUSD', 'side': side, 'volume': volume,
                'open': open_price, 'close': close_price, 'profit': profit,
                'closed': closed, 'closed_server': closed, 'opened_server': opened, 'time_basis': 'utc',
            }
            db.execute('INSERT OR REPLACE INTO trades VALUES(?,?,?)', (admin_id, ticket, json.dumps(trade)))
            bars = build_bars(opened, closed, seed=index * 3)
            charts = {
                'M1': bars,
                'M5': market.aggregate(bars, 300),
                'M15': market.aggregate(bars, 900),
                'H1': market.aggregate(bars, 3600),
            }
            payload = {
                'charts': charts, 'errors': {}, 'opened_server': opened, 'closed_server': closed,
                'time_basis': 'utc', 'source': '演示数据 · 合成的 XAUUSD 参考行情',
            }
            db.execute("INSERT OR REPLACE INTO trade_reviews VALUES(?,?,'ready',?,?)",
                       (admin_id, ticket, json.dumps(payload), now))
            if ticket in notes:
                body, tags = notes[ticket]
                db.execute('INSERT OR REPLACE INTO trade_notes VALUES(?,?,?,?,?)',
                           (admin_id, ticket, body, json.dumps(tags, ensure_ascii=False), now))

        # 一笔来自朋友的「作业」：收件箱里能看到，点进去是同图只读。
        first = db.execute('SELECT payload FROM trades WHERE person=? AND ticket=?', (admin_id, 'DEMO-1002')).fetchone()
        friend_trade = json.loads(first['payload'])
        db.execute('INSERT OR REPLACE INTO trades VALUES(?,?,?)', (friend_id, 'DEMO-2002', json.dumps({**friend_trade, 'ticket': 'DEMO-2002'})))
        review = db.execute('SELECT payload FROM trade_reviews WHERE person=? AND ticket=?', (admin_id, 'DEMO-1002')).fetchone()
        db.execute("INSERT OR REPLACE INTO trade_reviews VALUES(?,?,'ready',?,?)",
                   (friend_id, 'DEMO-2002', review['payload'], now))
        db.execute('INSERT INTO review_shares(owner,ticket,recipient,message,created,seen) VALUES(?,?,?,?,?,0)',
                   (friend_id, 'DEMO-2002', admin_id, '看我 10 月 27 日那笔空单，标一下你觉得可以改进的地方。', now - 3600))

        # 看板：两个人的持仓 + 留言，让首页不是空的。
        def snapshot(equity, balance, positions):
            return json.dumps({'balance': balance, 'equity': equity, 'currency': 'USD', 'online': True,
                               'positions': positions, 'history': []}, ensure_ascii=False)

        db.execute('INSERT OR REPLACE INTO snapshots VALUES(?,?,?)', (admin_id, snapshot(10248.6, 10000.0, [
            {'ticket': 'DEMO-3001', 'symbol': 'XAUUSD', 'side': 'buy', 'volume': 0.1, 'open': 2651.2,
             'current': 2663.88, 'profit': 126.8, 'sl': 2643.0, 'tp': 2678.0, 'sl_profit': -82.0, 'tp_profit': 268.0},
        ]), now))
        db.execute('INSERT OR REPLACE INTO snapshots VALUES(?,?,?)', (friend_id, snapshot(12562.4, 12500.0, [
            {'ticket': 'DEMO-3002', 'symbol': 'XAUUSD', 'side': 'sell', 'volume': 0.05, 'open': 2666.4,
             'current': 2663.88, 'profit': 12.6, 'sl': 2674.0, 'tp': 2650.0, 'sl_profit': -38.0, 'tp_profit': 82.0},
        ]), now))
        db.execute('INSERT INTO messages(person,text,created) VALUES(?,?,?)', (friend_id, '黄金这段 15 分钟结构还没破，等回踩确认。', now - 900))
        db.execute('INSERT INTO messages(person,text,created) VALUES(?,?,?)', (admin_id, '收到，我先把昨天那笔空单复盘写好。', now - 600))
        db.execute('INSERT INTO events(person,event_key,kind,text,created) VALUES(?,?,?,?,?)',
                   (friend_id, 'demo-open', 'open', '卖出 XAUUSD · 0.05 手 · 开仓价 2666.40', now - 1200))
    db.commit()
    db.close()

    from http.server import ThreadingHTTPServer
    server = ThreadingHTTPServer(('127.0.0.1', args.port), app.Handler)
    print('演示实例已启动：http://127.0.0.1:%d' % args.port, flush=True)
    print('登录：admin / %s' % args.password, flush=True)
    print('数据目录：%s' % data_dir, flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()

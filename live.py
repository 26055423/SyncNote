"""实时行情缓存：本机 bridge 推上来，网页按需读。

只保留最近若干根 K 线和一个最新 tick，全部放内存——行情是易失数据，
重启后由采集端重新 bootstrap，不落库。
"""
import threading
import time
import math

FORMING_PERIODS = {'M1': 60, 'M5': 300, 'M15': 900, 'H1': 3600}
FORMING_TTL = 12


class FormingBars:
    """Short-lived, private snapshots of a bound account's current candles."""

    def __init__(self):
        self._lock = threading.Lock()
        self._data = {}

    def put(self, key, symbol, tick_ms, series, offset, now):
        if type(tick_ms) is not int or not 0 < tick_ms <= 4102444800000 or not isinstance(series, dict):
            return False
        tick = tick_ms / 1000 - offset
        if not now - FORMING_TTL <= tick <= now + 3:
            return False
        current = {}
        for tf, period in FORMING_PERIODS.items():
            row = series.get(tf)
            if not isinstance(row, list) or len(row) != 6 or type(row[0]) is not int:
                continue
            if any(type(value) not in (int, float) or not -1e15 <= value <= 1e15 or not math.isfinite(value) for value in row):
                continue
            start, opened, high, low, closed, volume = row
            start -= offset
            if not (start <= tick < start + period and now < start + period):
                continue
            if low <= 0 or not low <= min(opened, closed) <= max(opened, closed) <= high or volume < 0:
                continue
            current[tf] = [[start, opened, high, low, closed, volume]]
        if not current:
            return False
        with self._lock:
            expired = [entry for entry, (seen, _) in self._data.items() if seen < now - FORMING_TTL]
            for entry in expired:
                del self._data[entry]
            identity = (key, symbol)
            previous = self._data.get(identity)
            if previous and previous[0] > tick:
                return False
            self._data[identity] = (tick, current)
        return True

    def read(self, key, symbol, now):
        with self._lock:
            entry = self._data.get((key, symbol))
            if not entry or entry[0] < now - FORMING_TTL:
                return {}
            return {tf: rows for tf, rows in entry[1].items() if rows[0][0] + FORMING_PERIODS[tf] > now}

TIMEFRAMES = ('1m', '5m', '15m', '1h')
MAX_BARS = 3000


class LiveStore:
    def __init__(self):
        self._lock = threading.Lock()
        self._data = {}
        self._rev = 0

    def ingest(self, user_id, payload):
        """payload: {"tick": {...}, "bars": {"1m": [[t,o,h,l,c], ...]}, "offset": 10800}"""
        if not isinstance(payload, dict):
            return {'bars': 0, 'first': False}
        now = time.time()
        count = 0
        with self._lock:
            entry = self._data.get(user_id)
            first = entry is None
            if entry is None:
                entry = {'bars': {tf: [] for tf in TIMEFRAMES}, 'tick': None, 'updated': now, 'offset': 0}
                self._data[user_id] = entry
            offset = payload.get('offset')
            if isinstance(offset, (int, float)):
                entry['offset'] = int(offset)
            tick = payload.get('tick')
            if isinstance(tick, dict) and isinstance(tick.get('time'), (int, float)):
                entry['tick'] = tick
            bars = payload.get('bars')
            if isinstance(bars, dict):
                for tf, rows in bars.items():
                    if tf not in entry['bars'] or not isinstance(rows, list):
                        continue
                    bucket = entry['bars'][tf]
                    for row in rows:
                        if not isinstance(row, list) or len(row) < 5:
                            continue
                        stamp = row[0]
                        if not isinstance(stamp, (int, float)):
                            continue
                        if bucket and bucket[-1][0] == stamp:
                            bucket[-1] = row[:5]
                        elif not bucket or bucket[-1][0] < stamp:
                            bucket.append(row[:5])
                        else:
                            # 补历史或乱序：二分找位置
                            index = len(bucket)
                            while index > 0 and bucket[index - 1][0] > stamp:
                                index -= 1
                            if index < len(bucket) and bucket[index][0] == stamp:
                                bucket[index] = row[:5]
                            else:
                                bucket.insert(index, row[:5])
                        count += 1
                    if len(bucket) > MAX_BARS:
                        del bucket[:len(bucket) - MAX_BARS]
            entry['updated'] = now
            self._rev += 1
        # first=True 表示这个用户在本进程里还没有行情，采集端应当重新 bootstrap 历史。
        return {'bars': count, 'first': first}

    def read(self, user_id, limit=500):
        with self._lock:
            entry = self._data.get(user_id)
            if not entry:
                return None
            return {
                'tick': entry['tick'],
                'offset': entry['offset'],
                'updated': entry['updated'],
                'age': round(time.time() - entry['updated'], 1),
                'bars': {tf: list(rows)[-limit:] for tf, rows in entry['bars'].items()},
            }

    def summary(self):
        with self._lock:
            return {uid: round(time.time() - e['updated'], 1) for uid, e in self._data.items()}

"""把一份本地 SQLite 行情库导出成可上传的 CSV.gz 包（供 bars 表导入）。

纯标准库；只读源库，不改动任何东西。

用法::

    python tools/export_market_bars.py --source <market.db> --out dist/bars

源库约定（trade_dashboard 的 `backend/data/market.db`）::

    klines(symbol, timeframe, bar_time, open, high, low, close, tick_vol)

`bar_time` 是 **券商服务器墙钟秒**（MT5 的 bar_time 原值），不是 UTC。导出保持原值，
与成交历史、EA 上传的 K 线用同一个时间基；显示时再由网页按 server_offset_sec 换算。
"""

import argparse
import csv
import gzip
import hashlib
import io
import json
import os
import sqlite3
import sys
import time

# 网页支持的周期（与 web/chart-src/src/vela/provider.ts 的 TIMEFRAMES 对齐）
DEFAULT_TFS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"]


def export(source, out_dir, symbol, timeframes):
    if not os.path.isfile(source):
        raise SystemExit("找不到源库: " + source)
    os.makedirs(out_dir, exist_ok=True)
    db = sqlite3.connect("file:" + os.path.abspath(source) + "?mode=ro", uri=True)
    manifest = {
        "schema": "syncnote-bars-export.v1",
        "symbol": symbol,
        "source": os.path.abspath(source),
        "time_basis": "broker_server",
        "note": "t 是券商服务器墙钟秒（MT5 bar_time 原值），不是 UTC",
        "generated_at": int(time.time()),
        "series": {},
    }
    total = 0
    for tf in timeframes:
        rows = db.execute(
            "SELECT bar_time, open, high, low, close, tick_vol FROM klines"
            " WHERE symbol=? AND timeframe=? ORDER BY bar_time",
            (symbol, tf),
        )
        name = "%s_%s.csv.gz" % (symbol.lower(), tf)
        path = os.path.join(out_dir, name)
        count = 0
        first = last = 0
        # mtime=0 + 固定文件名顺序 → 同样的源库永远导出同样的字节，sha256 才可比对。
        with open(path, "wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz:
                with io.TextIOWrapper(gz, encoding="utf-8", newline="", write_through=True) as handle:
                    writer = csv.writer(handle)
                    writer.writerow(["t", "o", "h", "l", "c", "v"])
                    for bar_time, open_, high, low, close, tick_vol in rows:
                        writer.writerow([bar_time, "%.5f" % open_, "%.5f" % high, "%.5f" % low, "%.5f" % close, "%.2f" % (tick_vol or 0)])
                        count += 1
                        if count == 1:
                            first = bar_time
                        last = bar_time
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
        size = os.path.getsize(path)
        total += size
        manifest["series"][tf] = {
            "file": name,
            "rows": count,
            "from_server": first,
            "to_server": last,
            "bytes": size,
            "sha256": digest.hexdigest(),
        }
        print("%-4s %9d rows  %9.1f KB  %d -> %d" % (tf, count, size / 1024.0, first, last), flush=True)
    db.close()
    with open(os.path.join(out_dir, "MANIFEST.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    print("total %.1f MB -> %s" % (total / 1024 / 1024, out_dir))


def main():
    parser = argparse.ArgumentParser(description="导出本地行情库为 CSV.gz 包")
    parser.add_argument("--source", required=True, help="SQLite 行情库路径")
    parser.add_argument("--out", required=True, help="输出目录")
    parser.add_argument("--symbol", default="XAUUSD")
    parser.add_argument("--timeframes", default=",".join(DEFAULT_TFS))
    args = parser.parse_args()
    export(args.source, args.out, args.symbol.upper(), [tf.strip() for tf in args.timeframes.split(",") if tf.strip()])


if __name__ == "__main__":
    sys.exit(main())

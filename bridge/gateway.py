#!/usr/bin/env python3
"""Production-lean MT5 EA <-> web gateway.

The MT5 Expert Advisor owns all MetaTrader 5 access. This process only speaks:
  * NDJSON over TCP with the EA on 127.0.0.1:8788 (default)
  * REST + WebSocket with a browser

It deliberately has no `import MetaTrader5`, no MT5 IPC and no DLLs.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import hmac
import json
import logging
import math
import os
import queue
import sqlite3
import threading
import time
import uuid
from collections import OrderedDict, deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

import uvicorn
from fastapi import Body, FastAPI, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator

LOG = logging.getLogger("ea_bridge")

PROTOCOL_VERSION = 1
SUPPORTED_TFS: tuple[str, ...] = ("1m", "5m", "15m", "1h")
TF_SECONDS = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600}
HANDSHAKE_TIMEOUT = 5.0
HEARTBEAT_TIMEOUT = 5.0
COMMAND_TIMEOUT = 10.0
MAX_LINE_BYTES = 4 * 1024 * 1024
MAX_PENDING_COMMANDS = 128
TICK_HISTORY = 100_000
BAR_HISTORY = 5_000
WS_TICK_INTERVAL = 0.1
WS_QUEUE_MAX = 512
WS_SEND_TIMEOUT = 15.0
DAILY_LOSS_IDEMPOTENCY_TTL = 24 * 60 * 60


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------
class ProtocolError(ValueError):
    pass


class EAUnavailable(RuntimeError):
    pass


class EACommandTimeout(RuntimeError):
    def __init__(self, command_id: str):
        super().__init__(f"EA command {command_id} timed out")
        self.command_id = command_id


class IdempotencyConflict(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class Config:
    host: str = "127.0.0.1"
    port: int = 8790
    ea_host: str = "127.0.0.1"
    ea_port: int = 8788
    db: Path = Path("ea_bridge.db")
    token: str = ""
    symbol: str = "XAUUSD"
    max_volume: float = 1.0
    max_daily_loss: float = 0.0
    max_price_deviation_pct: float = 20.0
    static_dir: Path | None = None
    log_level: str = "INFO"


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    return default if value is None or value == "" else value


def parse_args(argv: list[str] | None = None) -> Config:
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="MT5 EA NDJSON <-> web gateway")
    parser.add_argument("--host", default=_env("EA_BRIDGE_HOST", "127.0.0.1"), help="web bind host")
    parser.add_argument("--port", type=int, default=int(_env("EA_BRIDGE_PORT", "8790")), help="web HTTP/WS port")
    parser.add_argument("--ea-host", default=_env("EA_BRIDGE_EA_HOST", "127.0.0.1"), help="EA listener bind host")
    parser.add_argument("--ea-port", type=int, default=int(_env("EA_BRIDGE_EA_PORT", "8788")), help="EA TCP port")
    parser.add_argument("--db", default=_env("EA_BRIDGE_DB", str(here / "ea_bridge.db")), help="SQLite database path")
    parser.add_argument("--token", default=_env("EA_BRIDGE_TOKEN"), help="shared EA handshake token (or EA_BRIDGE_TOKEN)")
    parser.add_argument("--symbol", default=_env("EA_BRIDGE_SYMBOL", "XAUUSD"), help="whitelisted EA symbol")
    parser.add_argument(
        "--max-volume",
        type=float,
        default=float(_env("EA_BRIDGE_MAX_VOLUME", "1.0")),
        help="maximum order volume in lots",
    )
    parser.add_argument(
        "--max-daily-loss",
        type=float,
        default=float(_env("EA_BRIDGE_MAX_DAILY_LOSS", "0")),
        help="optional positive daily realized-loss limit; 0 disables",
    )
    parser.add_argument(
        "--max-price-deviation-pct",
        type=float,
        default=float(_env("EA_BRIDGE_MAX_PRICE_DEVIATION_PCT", "20")),
        help="max pending-order price deviation from last mid, percent",
    )
    parser.add_argument(
        "--static-dir",
        default=_env("EA_BRIDGE_STATIC_DIR", str(here / "web")),
        help="optional frontend directory to serve at /",
    )
    parser.add_argument("--log-level", default=_env("EA_BRIDGE_LOG_LEVEL", "INFO"), help="DEBUG/INFO/WARNING/ERROR")
    args = parser.parse_args(argv)

    if not args.token:
        parser.error("--token or EA_BRIDGE_TOKEN is required")
    if args.port <= 0 or args.port > 65535:
        parser.error("--port must be 1..65535")
    if args.ea_port <= 0 or args.ea_port > 65535:
        parser.error("--ea-port must be 1..65535")
    if args.max_volume <= 0:
        parser.error("--max-volume must be > 0")
    if args.max_daily_loss < 0:
        parser.error("--max-daily-loss must be >= 0")
    if not (0 < args.max_price_deviation_pct <= 1000):
        parser.error("--max-price-deviation-pct must be in (0, 1000]")
    if not args.symbol.strip():
        parser.error("--symbol must not be empty")

    static = Path(args.static_dir).expanduser() if args.static_dir else None
    return Config(
        host=args.host,
        port=args.port,
        ea_host=args.ea_host,
        ea_port=args.ea_port,
        db=Path(args.db).expanduser(),
        token=args.token,
        symbol=args.symbol.strip().upper(),
        max_volume=float(args.max_volume),
        max_daily_loss=float(args.max_daily_loss),
        max_price_deviation_pct=float(args.max_price_deviation_pct),
        static_dir=static,
        log_level=args.log_level.upper(),
    )


# ---------------------------------------------------------------------------
# Time / validation helpers
# ---------------------------------------------------------------------------
def now_msc() -> int:
    return int(time.time() * 1000)


def iso_utc(ms: int | None) -> str | None:
    if ms is None:
        return None
    try:
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="milliseconds")
    except (OverflowError, OSError, ValueError):
        return None


BEIJING_TZ = timezone(timedelta(hours=8))


def iso_beijing(ms: int | None) -> str | None:
    if ms is None:
        return None
    try:
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).astimezone(BEIJING_TZ).isoformat(timespec="milliseconds")
    except (OverflowError, OSError, ValueError):
        return None


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _num(obj: dict[str, Any], key: str, *, default: float | None = None, minimum: float | None = None) -> float:
    value = obj.get(key, default)
    if value is None or not _is_number(value):
        raise ProtocolError(f"{key} must be a finite number")
    value = float(value)
    if minimum is not None and value < minimum:
        raise ProtocolError(f"{key} must be >= {minimum}")
    return value


def _int(obj: dict[str, Any], key: str, *, default: int | None = None, minimum: int | None = None) -> int:
    value = obj.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise ProtocolError(f"{key} must be an integer")
    if float(value) != int(value):
        raise ProtocolError(f"{key} must be an integer")
    value = int(value)
    if minimum is not None and value < minimum:
        raise ProtocolError(f"{key} must be >= {minimum}")
    return value


def _str(obj: dict[str, Any], key: str, *, default: str | None = None, max_len: int = 4096) -> str:
    value = obj.get(key, default)
    if not isinstance(value, str):
        raise ProtocolError(f"{key} must be a string")
    if len(value) > max_len:
        raise ProtocolError(f"{key} is too long")
    return value


def normalize_tf(tf: str) -> str:
    value = tf.strip().lower()
    if value not in SUPPORTED_TFS:
        raise ProtocolError(f"unsupported timeframe {tf!r}")
    return value


def _compact_json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


# ---------------------------------------------------------------------------
# Market store
# ---------------------------------------------------------------------------
class MarketStore:
    """All market state is mutated only on the asyncio event loop."""

    def __init__(self, symbol: str) -> None:
        self.symbol = symbol
        self.ticks: dict[str, deque[dict[str, Any]]] = {symbol: deque(maxlen=TICK_HISTORY)}
        self.latest_ticks: dict[str, dict[str, Any]] = {}
        self.tick_seq: dict[str, int] = {}
        self.bars: dict[tuple[str, str], OrderedDict[int, dict[str, Any]]] = {}
        self.last_bar: dict[str, Any] | None = None
        self.account: dict[str, Any] | None = None
        self.positions: dict[int, dict[str, Any]] = {}
        self.orders: dict[int, dict[str, Any]] = {}
        self.trades: deque[dict[str, Any]] = deque(maxlen=10_000)
        self.daily_pnl_date: str | None = None
        self.daily_realized_pnl: float = 0.0
        self.ticks_received = 0
        self.bars_received = 0
        self.trades_received = 0
        self.protocol_errors = 0
        self.last_message_ms: int | None = None

    # returns (normalized, is_new_tick)
    def add_tick(self, event: dict[str, Any]) -> dict[str, Any]:
        self._require_symbol(event)
        ts_msc = _int(event, "ts_msc", minimum=0)
        tick = {
            "symbol": self.symbol,
            "ts_msc": ts_msc,
            "bid": _num(event, "bid", minimum=0.0),
            "ask": _num(event, "ask", minimum=0.0),
            "last": _num(event, "last", default=0.0, minimum=0.0),
            "volume": _num(event, "volume", default=0.0, minimum=0.0),
            "flags": _int(event, "flags", default=0),
            "received_msc": now_msc(),
        }
        if tick["bid"] <= 0 or tick["ask"] <= 0:
            raise ProtocolError("bid/ask must be > 0")
        self.ticks.setdefault(self.symbol, deque(maxlen=TICK_HISTORY)).append(tick)
        self.latest_ticks[self.symbol] = tick
        self.tick_seq[self.symbol] = self.tick_seq.get(self.symbol, 0) + 1
        self.ticks_received += 1
        self.last_message_ms = now_msc()
        return tick

    def add_bar(self, event: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        """Return (bar, changed). Closed bars cannot be downgraded to open."""
        self._require_symbol(event)
        tf = normalize_tf(_str(event, "tf"))
        bar_time = _int(event, "bar_time", minimum=0)
        closed = bool(event.get("closed", False))
        bar = {
            "symbol": self.symbol,
            "tf": tf,
            "bar_time": bar_time,
            "open": _num(event, "open"),
            "high": _num(event, "high"),
            "low": _num(event, "low"),
            "close": _num(event, "close"),
            "tick_volume": _int(event, "tick_volume", default=0, minimum=0),
            "spread": _int(event, "spread", default=0, minimum=0),
            "closed": closed,
            "received_msc": now_msc(),
        }
        key = (self.symbol, tf)
        series = self.bars.setdefault(key, OrderedDict())
        existing = series.get(bar_time)
        if existing is not None:
            if existing.get("closed") and not closed:
                return existing, False
            comparable = {k: existing.get(k) for k in bar if k not in ("received_msc",)}
            if comparable == {k: bar.get(k) for k in bar if k not in ("received_msc",)}:
                return existing, False
        series[bar_time] = bar
        while len(series) > BAR_HISTORY:
            series.popitem(last=False)
        self.last_bar = bar
        self.bars_received += 1
        self.last_message_ms = now_msc()
        return bar, True

    def set_account(self, event: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        account = {
            "login": _int(event, "login", default=0),
            "balance": _num(event, "balance", default=0.0),
            "equity": _num(event, "equity", default=0.0),
            "margin": _num(event, "margin", default=0.0),
            "free_margin": _num(event, "free_margin", default=0.0),
            "currency": _str(event, "currency", default="USD", max_len=16),
            "leverage": _int(event, "leverage", default=0),
            "profit": _num(event, "profit", default=0.0),
            "received_msc": now_msc(),
        }
        changed = account != self.account
        self.account = account
        self.last_message_ms = now_msc()
        return account, changed

    def set_positions(self, items: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], bool]:
        new = self._normalize_items(items, "positions")
        old = self.positions
        added = [item for ticket, item in new.items() if ticket not in old]
        updated = [item for ticket, item in new.items() if ticket in old and old[ticket] != item]
        removed = [item for ticket, item in old.items() if ticket not in new]
        changed = bool(added or updated or removed)
        self.positions = new
        self.last_message_ms = now_msc()
        return added, updated, removed, changed

    def set_orders(self, items: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], bool]:
        new = self._normalize_items(items, "orders")
        old = self.orders
        added = [item for ticket, item in new.items() if ticket not in old]
        updated = [item for ticket, item in new.items() if ticket in old and old[ticket] != item]
        removed = [item for ticket, item in old.items() if ticket not in new]
        changed = bool(added or updated or removed)
        self.orders = new
        self.last_message_ms = now_msc()
        return added, updated, removed, changed

    def add_trade(self, event: dict[str, Any]) -> dict[str, Any]:
        self._require_symbol(event)
        trade = {
            "trans_type": _int(event, "trans_type", default=0),
            "order": _int(event, "order", default=0),
            "deal": _int(event, "deal", default=0),
            "position": _int(event, "position", default=0),
            "symbol": self.symbol,
            "side": _str(event, "side", default="", max_len=16).lower(),
            "volume": _num(event, "volume", default=0.0, minimum=0.0),
            "price": _num(event, "price", default=0.0, minimum=0.0),
            "profit": _num(event, "profit", default=0.0),
            "time_msc": _int(event, "time_msc", default=0, minimum=0),
            "received_msc": now_msc(),
        }
        self.trades.append(trade)
        self.trades_received += 1
        self.last_message_ms = now_msc()
        today = datetime.now(timezone.utc).date().isoformat()
        if self.daily_pnl_date != today:
            self.daily_pnl_date = today
            self.daily_realized_pnl = 0.0
        self.daily_realized_pnl += trade["profit"]
        return trade

    def set_initial_daily_pnl(self, pnl: float) -> None:
        self.daily_pnl_date = datetime.now(timezone.utc).date().isoformat()
        self.daily_realized_pnl = float(pnl)

    def latest_tick(self, symbol: str | None = None) -> dict[str, Any] | None:
        return self.latest_ticks.get(symbol or self.symbol)

    def bars_for(self, symbol: str, tf: str, limit: int = 500) -> list[dict[str, Any]]:
        series = self.bars.get((symbol, normalize_tf(tf)))
        if not series:
            return []
        values = list(series.values())
        return values[-limit:]

    def last_bars(self, symbol: str) -> dict[str, dict[str, Any] | None]:
        return {tf: (self.bars_for(symbol, tf, 1)[-1] if self.bars_for(symbol, tf, 1) else None) for tf in SUPPORTED_TFS}

    def buffer_sizes(self) -> dict[str, Any]:
        return {
            "ticks": sum(len(v) for v in self.ticks.values()),
            "bars": {tf: len(self.bars.get((self.symbol, tf), {})) for tf in SUPPORTED_TFS},
            "trades": len(self.trades),
            "positions": len(self.positions),
            "orders": len(self.orders),
        }

    def _require_symbol(self, event: dict[str, Any]) -> None:
        symbol = _str(event, "symbol", default=self.symbol, max_len=64).upper()
        if symbol != self.symbol:
            raise ProtocolError(f"unexpected symbol {symbol!r}, expected {self.symbol!r}")

    def _normalize_items(self, items: list[Any], kind: str) -> dict[int, dict[str, Any]]:
        if not isinstance(items, list):
            raise ProtocolError(f"{kind}.items must be an array")
        if len(items) > 1000:
            raise ProtocolError(f"{kind}.items has too many entries")
        out: dict[int, dict[str, Any]] = {}
        for raw in items:
            if not isinstance(raw, dict):
                raise ProtocolError(f"{kind} item must be an object")
            item = dict(raw)
            ticket = _int(item, "ticket", minimum=1)
            item["ticket"] = ticket
            item["symbol"] = _str(item, "symbol", default=self.symbol, max_len=64).upper()
            if kind == "positions":
                item["side"] = _str(item, "side", default="buy", max_len=16).lower()
                item["volume"] = _num(item, "volume", default=0.0, minimum=0.0)
                item["price_open"] = _num(item, "price_open", default=0.0, minimum=0.0)
                item["sl"] = _num(item, "sl", default=0.0)
                item["tp"] = _num(item, "tp", default=0.0)
                item["profit"] = _num(item, "profit", default=0.0)
                item["magic"] = _int(item, "magic", default=0)
                item["comment"] = _str(item, "comment", default="", max_len=256)
                item["time_msc"] = _int(item, "time_msc", default=0, minimum=0)
            else:
                item["type"] = _str(item, "type", default="", max_len=32)
                item["side"] = _str(item, "side", default="", max_len=16).lower()
                item["volume"] = _num(item, "volume", default=0.0, minimum=0.0)
                item["price"] = _num(item, "price", default=0.0, minimum=0.0)
                item["sl"] = _num(item, "sl", default=0.0)
                item["tp"] = _num(item, "tp", default=0.0)
                item["magic"] = _int(item, "magic", default=0)
                item["comment"] = _str(item, "comment", default="", max_len=256)
                item["time_msc"] = _int(item, "time_msc", default=0, minimum=0)
                item["state"] = _str(item, "state", default="", max_len=64)
            out[ticket] = item
        return out


# ---------------------------------------------------------------------------
# SQLite persistence: dedicated writer thread, WAL, never called on loop
# ---------------------------------------------------------------------------
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS bars (
    symbol TEXT NOT NULL,
    tf TEXT NOT NULL,
    bar_time INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    tick_volume INTEGER NOT NULL DEFAULT 0,
    spread INTEGER NOT NULL DEFAULT 0,
    closed INTEGER NOT NULL DEFAULT 0,
    received_msc INTEGER NOT NULL,
    PRIMARY KEY (symbol, tf, bar_time)
);
CREATE INDEX IF NOT EXISTS idx_bars_symbol_tf_time ON bars(symbol, tf, bar_time);

CREATE TABLE IF NOT EXISTS ticks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    ts_msc INTEGER NOT NULL,
    bid REAL NOT NULL,
    ask REAL NOT NULL,
    last REAL NOT NULL,
    volume REAL NOT NULL,
    flags INTEGER NOT NULL,
    received_msc INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticks_symbol_ts ON ticks(symbol, ts_msc);

CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trans_type INTEGER NOT NULL,
    order_ticket INTEGER NOT NULL,
    deal_ticket INTEGER NOT NULL,
    position_ticket INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    volume REAL NOT NULL,
    price REAL NOT NULL,
    profit REAL NOT NULL,
    time_msc INTEGER NOT NULL,
    received_msc INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_symbol_time ON trades(symbol, time_msc);
CREATE INDEX IF NOT EXISTS idx_trades_position ON trades(position_ticket);

CREATE TABLE IF NOT EXISTS orders (
    ticket INTEGER PRIMARY KEY,
    symbol TEXT NOT NULL,
    type TEXT NOT NULL,
    side TEXT NOT NULL,
    volume REAL NOT NULL,
    price REAL NOT NULL,
    sl REAL NOT NULL,
    tp REAL NOT NULL,
    magic INTEGER NOT NULL,
    comment TEXT NOT NULL,
    state TEXT NOT NULL,
    time_msc INTEGER NOT NULL,
    received_msc INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_symbol ON orders(symbol);

CREATE TABLE IF NOT EXISTS positions (
    ticket INTEGER PRIMARY KEY,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    volume REAL NOT NULL,
    price_open REAL NOT NULL,
    sl REAL NOT NULL,
    tp REAL NOT NULL,
    profit REAL NOT NULL,
    magic INTEGER NOT NULL,
    comment TEXT NOT NULL,
    time_msc INTEGER NOT NULL,
    received_msc INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login INTEGER NOT NULL,
    balance REAL NOT NULL,
    equity REAL NOT NULL,
    margin REAL NOT NULL,
    free_margin REAL NOT NULL,
    currency TEXT NOT NULL,
    leverage INTEGER NOT NULL,
    profit REAL NOT NULL,
    received_msc INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_received ON account_snapshots(received_msc);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_msc INTEGER NOT NULL,
    action TEXT NOT NULL,
    symbol TEXT,
    request_id TEXT,
    idempotency_key TEXT,
    ok INTEGER,
    detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts_msc);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class Persistence:
    """Bounded tick queue + unbounded low-volume critical queue.

    `enqueue_*` only append to Python queues and never touch SQLite, so the event
    loop is never blocked by disk I/O.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._critical: queue.Queue[tuple[str, Any]] = queue.Queue()
        self._ticks: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=50_000)
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._thread: threading.Thread | None = None
        self._start_error: BaseException | None = None
        self.dropped_ticks = 0
        self.written_ticks = 0
        self.written_critical = 0
        self.write_errors = 0

    def start(self) -> None:
        if self._thread is not None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._thread = threading.Thread(target=self._run, name="ea-bridge-sqlite", daemon=True)
        self._thread.start()
        if not self._ready.wait(15):
            raise RuntimeError("SQLite writer did not start in time")
        if self._start_error is not None:
            raise RuntimeError(f"SQLite writer failed to start: {self._start_error}") from self._start_error

    def enqueue_tick(self, tick: dict[str, Any]) -> None:
        try:
            self._ticks.put_nowait(tick)
        except queue.Full:
            self.dropped_ticks += 1

    def _put_critical(self, kind: str, value: Any) -> None:
        self._critical.put((kind, value))

    def enqueue_closed_bar(self, bar: dict[str, Any]) -> None:
        if bar.get("closed"):
            self._put_critical("bar", bar)

    def enqueue_trade(self, trade: dict[str, Any]) -> None:
        self._put_critical("trade", trade)

    def enqueue_account(self, account: dict[str, Any]) -> None:
        self._put_critical("account", account)

    def enqueue_positions(self, symbol: str, items: Iterable[dict[str, Any]]) -> None:
        self._put_critical("positions", (symbol, list(items)))

    def enqueue_orders(self, symbol: str, items: Iterable[dict[str, Any]]) -> None:
        self._put_critical("orders", (symbol, list(items)))

    def enqueue_audit(
        self,
        action: str,
        *,
        symbol: str | None = None,
        request_id: str | None = None,
        idempotency_key: str | None = None,
        ok: bool | None = None,
        detail: Any = None,
    ) -> None:
        self._put_critical(
            "audit",
            {
                "ts_msc": now_msc(),
                "action": action,
                "symbol": symbol,
                "request_id": request_id,
                "idempotency_key": idempotency_key,
                "ok": None if ok is None else int(bool(ok)),
                "detail": _compact_json(detail) if detail is not None else None,
            },
        )

    def read_daily_profit(self, since_msc: int) -> float:
        if not self.path.exists():
            return 0.0
        # Read-only query; this runs in a worker thread, never on the event loop.
        conn = sqlite3.connect(str(self.path), timeout=5)
        try:
            row = conn.execute("SELECT COALESCE(SUM(profit), 0) FROM trades WHERE received_msc >= ?", (since_msc,)).fetchone()
            return float(row[0] or 0.0)
        finally:
            conn.close()

    def stats(self) -> dict[str, int]:
        return {
            "dropped_ticks": self.dropped_ticks,
            "written_ticks": self.written_ticks,
            "written_critical": self.written_critical,
            "write_errors": self.write_errors,
            "queued_ticks": self._ticks.qsize(),
            "queued_critical": self._critical.qsize(),
        }

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=10)

    def _run(self) -> None:
        conn: sqlite3.Connection | None = None
        try:
            conn = sqlite3.connect(self.path, timeout=10, isolation_level=None)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA temp_store=MEMORY")
            conn.execute("PRAGMA busy_timeout=5000")
            conn.execute("PRAGMA wal_autocheckpoint=1000")
            conn.executescript(SCHEMA_SQL)
            conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', '1')")
            self._ready.set()
        except BaseException as exc:  # pragma: no cover - startup failure path
            self._start_error = exc
            LOG.exception("SQLite startup failed")
            self._ready.set()
            if conn is not None:
                conn.close()
            return

        last_tick_flush = time.monotonic()
        try:
            while True:
                critical: list[tuple[str, Any]] = []
                while len(critical) < 2000:
                    try:
                        critical.append(self._critical.get_nowait())
                    except queue.Empty:
                        break

                tick_due = self._ticks.qsize() >= 1000 or (time.monotonic() - last_tick_flush >= 1.0 and not self._ticks.empty())
                ticks: list[dict[str, Any]] = []
                if tick_due:
                    while len(ticks) < 10_000:
                        try:
                            ticks.append(self._ticks.get_nowait())
                        except queue.Empty:
                            break
                    last_tick_flush = time.monotonic()

                if not critical and not ticks:
                    if self._stop.is_set() and self._ticks.empty() and self._critical.empty():
                        break
                    self._stop.wait(0.1)
                    continue

                try:
                    for kind, value in critical:
                        self._apply_critical(conn, kind, value)
                    if ticks:
                        conn.executemany(
                            "INSERT INTO ticks(symbol, ts_msc, bid, ask, last, volume, flags, received_msc) "
                            "VALUES(?,?,?,?,?,?,?,?)",
                            [
                                (
                                    t["symbol"], t["ts_msc"], t["bid"], t["ask"], t["last"],
                                    t["volume"], t["flags"], t["received_msc"],
                                )
                                for t in ticks
                            ],
                        )
                    conn.commit()
                    self.written_critical += len(critical)
                    self.written_ticks += len(ticks)
                except sqlite3.Error:
                    self.write_errors += 1
                    LOG.exception("SQLite write batch failed; rolling back")
                    with contextlib.suppress(sqlite3.Error):
                        conn.rollback()
                if self._stop.is_set() and self._ticks.empty() and self._critical.empty():
                    break
        finally:
            with contextlib.suppress(sqlite3.Error):
                if conn is not None:
                    conn.commit()
            if conn is not None:
                conn.close()

    @staticmethod
    def _apply_critical(conn: sqlite3.Connection, kind: str, value: Any) -> None:
        if kind == "bar":
            bar = value
            conn.execute(
                "INSERT INTO bars(symbol, tf, bar_time, open, high, low, close, tick_volume, spread, closed, received_msc) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(symbol, tf, bar_time) DO UPDATE SET "
                "open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, "
                "tick_volume=excluded.tick_volume, spread=excluded.spread, closed=excluded.closed, "
                "received_msc=excluded.received_msc",
                (
                    bar["symbol"], bar["tf"], bar["bar_time"], bar["open"], bar["high"], bar["low"],
                    bar["close"], bar["tick_volume"], bar["spread"], int(bool(bar["closed"])), bar["received_msc"],
                ),
            )
        elif kind == "trade":
            trade = value
            conn.execute(
                "INSERT INTO trades(trans_type, order_ticket, deal_ticket, position_ticket, symbol, side, volume, price, profit, time_msc, received_msc) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    trade["trans_type"], trade["order"], trade["deal"], trade["position"], trade["symbol"],
                    trade["side"], trade["volume"], trade["price"], trade["profit"], trade["time_msc"],
                    trade["received_msc"],
                ),
            )
        elif kind == "account":
            a = value
            conn.execute(
                "INSERT INTO account_snapshots(login, balance, equity, margin, free_margin, currency, leverage, profit, received_msc) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    a["login"], a["balance"], a["equity"], a["margin"], a["free_margin"], a["currency"],
                    a["leverage"], a["profit"], a["received_msc"],
                ),
            )
        elif kind in ("positions", "orders"):
            symbol, items = value
            table = "positions" if kind == "positions" else "orders"
            conn.execute(f"DELETE FROM {table} WHERE symbol=?", (symbol,))
            if kind == "positions":
                conn.executemany(
                    "INSERT OR REPLACE INTO positions(ticket, symbol, side, volume, price_open, sl, tp, profit, magic, comment, time_msc, received_msc) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    [
                        (
                            i["ticket"], i["symbol"], i["side"], i["volume"], i["price_open"], i["sl"],
                            i["tp"], i["profit"], i["magic"], i["comment"], i["time_msc"],
                            i.get("received_msc", now_msc()),
                        )
                        for i in items
                    ],
                )
            else:
                conn.executemany(
                    "INSERT OR REPLACE INTO orders(ticket, symbol, type, side, volume, price, sl, tp, magic, comment, state, time_msc, received_msc) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    [
                        (
                            i["ticket"], i["symbol"], i["type"], i["side"], i["volume"], i["price"],
                            i["sl"], i["tp"], i["magic"], i["comment"], i["state"], i["time_msc"],
                            i.get("received_msc", now_msc()),
                        )
                        for i in items
                    ],
                )
        elif kind == "audit":
            a = value
            conn.execute(
                "INSERT INTO audit_log(ts_msc, action, symbol, request_id, idempotency_key, ok, detail) "
                "VALUES(?,?,?,?,?,?,?)",
                (a["ts_msc"], a["action"], a["symbol"], a["request_id"], a["idempotency_key"], a["ok"], a["detail"]),
            )
        else:
            LOG.warning("unknown persistence item %s", kind)


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------
@dataclass
class IdempotencyEntry:
    fingerprint: str
    created: float
    future: asyncio.Future[tuple[int, dict[str, Any]]]
    result: tuple[int, dict[str, Any]] | None = None


class IdempotencyCache:
    def __init__(self, ttl: float = DAILY_LOSS_IDEMPOTENCY_TTL) -> None:
        self.ttl = ttl
        self._entries: dict[str, IdempotencyEntry] = {}
        self._lock = asyncio.Lock()

    @staticmethod
    def fingerprint(payload: Any) -> str:
        data = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        return hashlib.sha256(data.encode("utf-8")).hexdigest()

    async def begin(self, key: str, fingerprint: str) -> tuple[IdempotencyEntry, bool]:
        """Return (entry, is_owner). Raises IdempotencyConflict for a reused key."""
        async with self._lock:
            cutoff = time.monotonic() - self.ttl
            for stale_key in [k for k, entry in self._entries.items() if entry.created < cutoff]:
                self._entries.pop(stale_key, None)
            existing = self._entries.get(key)
            if existing is not None:
                if existing.fingerprint != fingerprint:
                    raise IdempotencyConflict("Idempotency-Key was already used with a different payload")
                return existing, False
            entry = IdempotencyEntry(
                fingerprint=fingerprint,
                created=time.monotonic(),
                future=asyncio.get_running_loop().create_future(),
            )
            self._entries[key] = entry
            return entry, True

    @staticmethod
    def finish(entry: IdempotencyEntry, status: int, body: dict[str, Any]) -> None:
        entry.result = (status, body)
        if not entry.future.done():
            entry.future.set_result((status, body))

    def count(self) -> int:
        return len(self._entries)


# ---------------------------------------------------------------------------
# EA connection
# ---------------------------------------------------------------------------
class EAConnection:
    def __init__(
        self,
        runtime: "GatewayRuntime",
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        hello: dict[str, Any],
        peer: str,
        generation: int,
    ) -> None:
        self.runtime = runtime
        self.reader = reader
        self.writer = writer
        self.hello = hello
        self.peer = peer
        self.generation = generation
        self.connected_at = now_msc()
        self.last_heartbeat = asyncio.get_running_loop().time()
        self.terminal = str(hello.get("terminal", ""))[:200]
        self.server_offset_sec = int(hello.get("server_offset_sec", 0) or 0)
        self.pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self.send_lock = asyncio.Lock()
        self.closed = False
        self.close_reason = ""
        self.last_rx_ms = now_msc()

    async def send_ack(self, ok: bool, error: str | None = None) -> None:
        ack: dict[str, Any] = {"type": "hello_ack", "ok": ok, "server_time": now_msc()}
        if error:
            ack["error"] = error
        self.writer.write((_compact_json(ack) + "\n").encode("utf-8"))
        await asyncio.wait_for(self.writer.drain(), timeout=5.0)

    async def command(self, command: dict[str, Any], timeout: float = COMMAND_TIMEOUT) -> dict[str, Any]:
        command_id = command.get("id")
        if not isinstance(command_id, str) or not command_id:
            raise ValueError("command.id is required")
        if self.closed:
            raise EAUnavailable("EA disconnected")
        if len(self.pending) >= MAX_PENDING_COMMANDS:
            raise EAUnavailable("too many commands in flight")
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self.pending[command_id] = future
        line = (_compact_json(command) + "\n").encode("utf-8")
        try:
            async with self.send_lock:
                if self.closed:
                    raise EAUnavailable("EA disconnected")
                self.writer.write(line)
                await asyncio.wait_for(self.writer.drain(), timeout=5.0)
            try:
                return await asyncio.wait_for(future, timeout=timeout)
            except asyncio.TimeoutError as exc:
                raise EACommandTimeout(command_id) from exc
        except (ConnectionError, OSError, asyncio.IncompleteReadError) as exc:
            await self.close("send_error")
            raise EAUnavailable(f"EA send failed: {exc}") from exc
        finally:
            self.pending.pop(command_id, None)

    def resolve_result(self, result: dict[str, Any]) -> None:
        command_id = result.get("id")
        if not isinstance(command_id, str):
            LOG.warning("EA result without string id ignored")
            return
        future = self.pending.pop(command_id, None)
        if future is None:
            LOG.info("late/unknown EA result ignored id=%s", command_id)
            return
        if not future.done():
            future.set_result(result)

    def fail_pending(self, reason: str) -> None:
        for future in list(self.pending.values()):
            if not future.done():
                future.set_exception(EAUnavailable(reason))
        self.pending.clear()

    async def close(self, reason: str) -> None:
        if self.closed:
            return
        self.closed = True
        self.close_reason = reason
        self.fail_pending(f"EA connection closed: {reason}")
        with contextlib.suppress(Exception):
            self.writer.close()
            await asyncio.wait_for(self.writer.wait_closed(), timeout=3.0)


# ---------------------------------------------------------------------------
# WebSocket clients
# ---------------------------------------------------------------------------
class WebClient:
    def __init__(self, websocket: WebSocket, client_id: str) -> None:
        self.websocket = websocket
        self.client_id = client_id
        self.subscriptions: dict[str, set[str]] = {}
        self.queue: deque[str] = deque()
        self.wake = asyncio.Event()
        self.sender_task: asyncio.Task[None] | None = None
        self.closed = False
        self.dropped = 0

    def wants(self, symbol: str | None = None, tf: str | None = None) -> bool:
        if symbol is None:
            return bool(self.subscriptions)
        tfs = self.subscriptions.get(symbol)
        if not tfs:
            return False
        return tf is None or tf in tfs

    def enqueue(self, payload: dict[str, Any]) -> None:
        if self.closed:
            return
        if len(self.queue) >= WS_QUEUE_MAX:
            self.queue.popleft()
            self.dropped += 1
        self.queue.append(_compact_json(payload))
        self.wake.set()

    def start(self) -> None:
        self.sender_task = asyncio.create_task(self._sender(), name=f"ws-send-{self.client_id}")

    async def _sender(self) -> None:
        try:
            while not self.closed:
                await self.wake.wait()
                self.wake.clear()
                while self.queue and not self.closed:
                    text = self.queue.popleft()
                    await asyncio.wait_for(self.websocket.send_text(text), timeout=WS_SEND_TIMEOUT)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            LOG.info("WebSocket client %s send failed: %s", self.client_id, exc)
            self.closed = True
            with contextlib.suppress(Exception):
                await self.websocket.close(code=1011)

    async def stop(self) -> None:
        self.closed = True
        self.wake.set()
        if self.sender_task is not None and self.sender_task is not asyncio.current_task():
            self.sender_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self.sender_task


# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
class GatewayRuntime:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.store = MarketStore(config.symbol)
        self.db = Persistence(config.db)
        self.ea: EAConnection | None = None
        self._ea_lock = asyncio.Lock()
        self._generation = 0
        self._server: asyncio.AbstractServer | None = None
        self._tasks: list[asyncio.Task[Any]] = []
        self.clients: dict[str, WebClient] = {}
        self._last_tick_sent: dict[str, int] = {}
        self._stopping = False
        self.started_monotonic = time.monotonic()
        self.idempotency = IdempotencyCache()

    async def start(self) -> None:
        await asyncio.to_thread(self.db.start)
        day_start = now_msc() - (now_msc() % 86_400_000)
        try:
            initial_pnl = await asyncio.to_thread(self.db.read_daily_profit, day_start)
            self.store.set_initial_daily_pnl(initial_pnl)
        except Exception:
            LOG.warning("could not read today's realized PnL from SQLite; starting at 0", exc_info=True)
        self._server = await asyncio.start_server(
            self._handle_ea,
            host=self.config.ea_host,
            port=self.config.ea_port,
            limit=MAX_LINE_BYTES,
            reuse_address=True,
        )
        self._tasks.append(asyncio.create_task(self._watchdog(), name="ea-watchdog"))
        self._tasks.append(asyncio.create_task(self._tick_pump(), name="ws-tick-pump"))
        if not _is_loopback(self.config.ea_host):
            LOG.warning("EA listener is bound to non-loopback host %s; token and firewall are critical", self.config.ea_host)
        LOG.info("EA listening on %s:%s; web on %s:%s", self.config.ea_host, self.config.ea_port, self.config.host, self.config.port)

    async def stop(self) -> None:
        self._stopping = True
        if self._server is not None:
            self._server.close()
            with contextlib.suppress(Exception):
                await self._server.wait_closed()
            self._server = None
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._tasks.clear()
        ea = self.ea
        self.ea = None
        if ea is not None:
            await ea.close("gateway_shutdown")
        clients = list(self.clients.values())
        self.clients.clear()
        for client in clients:
            await client.stop()
        await asyncio.to_thread(self.db.stop)

    def ea_connected(self) -> bool:
        return self.ea is not None and not self.ea.closed

    async def _handle_ea(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        peer = "%s:%s" % writer.get_extra_info("peername", ("?", "?"))[:2]
        conn: EAConnection | None = None
        try:
            try:
                raw = await asyncio.wait_for(reader.readline(), timeout=HANDSHAKE_TIMEOUT)
            except asyncio.TimeoutError:
                await self._reject_handshake(writer, peer, "handshake timeout")
                return
            if not raw:
                return
            if len(raw) > MAX_LINE_BYTES:
                await self._reject_handshake(writer, peer, "hello line too large")
                return
            try:
                hello = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                await self._reject_handshake(writer, peer, "hello is not valid UTF-8 JSON")
                return
            if not isinstance(hello, dict):
                await self._reject_handshake(writer, peer, "hello must be an object")
                return

            error = self._validate_hello(hello)
            if error:
                await self._reject_handshake(writer, peer, error)
                return

            assert isinstance(hello, dict)
            self._generation += 1
            conn = EAConnection(self, reader, writer, hello, peer, self._generation)
            await conn.send_ack(True)

            old: EAConnection | None
            async with self._ea_lock:
                old = self.ea
                self.ea = conn
            if old is not None:
                LOG.warning("new EA connection %s replaced previous session", peer)
                await old.close("replaced_by_new_connection")

            LOG.info(
                "EA connected peer=%s symbol=%s terminal=%r generation=%s",
                peer, self.config.symbol, conn.terminal, conn.generation,
            )
            self.db.enqueue_audit("ea_connected", symbol=self.config.symbol, detail={"peer": peer, "terminal": conn.terminal})
            self._broadcast_status(True)

            try:
                while not conn.closed:
                    raw = await reader.readline()
                    if not raw:
                        conn.close_reason = "peer_closed"
                        break
                    if len(raw) > MAX_LINE_BYTES:
                        conn.close_reason = "line_too_large"
                        LOG.warning("EA line exceeded limit; closing")
                        break
                    conn.last_rx_ms = now_msc()
                    try:
                        message = json.loads(raw.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        self.store.protocol_errors += 1
                        LOG.warning("discarding malformed EA JSON line")
                        continue
                    if not isinstance(message, dict):
                        self.store.protocol_errors += 1
                        continue
                    try:
                        self._handle_ea_message(conn, message)
                    except ProtocolError as exc:
                        self.store.protocol_errors += 1
                        LOG.warning("discarding invalid EA event: %s", exc)
            except (ConnectionError, OSError, asyncio.IncompleteReadError, ValueError) as exc:
                conn.close_reason = f"read_error: {exc}"
            finally:
                await self._unregister_ea(conn, conn.close_reason or "socket_closed")
        except asyncio.CancelledError:
            if conn is not None:
                await self._unregister_ea(conn, "server_cancelled")
            raise
        except Exception:
            LOG.exception("unexpected EA handler error peer=%s", peer)
            if conn is not None:
                await self._unregister_ea(conn, "handler_error")
        finally:
            if conn is None:
                with contextlib.suppress(Exception):
                    writer.close()
                    await writer.wait_closed()

    def _validate_hello(self, hello: dict[str, Any]) -> str | None:
        if hello.get("type") != "hello":
            return "first line must be type=hello"
        if hello.get("v") != PROTOCOL_VERSION:
            return f"unsupported protocol version {hello.get('v')!r}; expected 1"
        token = hello.get("token")
        if not isinstance(token, str) or not hmac.compare_digest(token.encode("utf-8"), self.config.token.encode("utf-8")):
            return "invalid token"
        symbol = hello.get("symbol")
        if not isinstance(symbol, str) or symbol.strip().upper() != self.config.symbol:
            return f"symbol must be {self.config.symbol}"
        if not isinstance(hello.get("terminal"), str):
            return "terminal must be a string"
        if not isinstance(hello.get("server_offset_sec"), (int, float)) or isinstance(hello.get("server_offset_sec"), bool):
            return "server_offset_sec must be a number"
        if not isinstance(hello.get("time"), (int, float)) or isinstance(hello.get("time"), bool):
            return "time must be a number"
        return None

    async def _reject_handshake(self, writer: asyncio.StreamWriter, peer: str, error: str) -> None:
        LOG.warning("EA handshake rejected peer=%s reason=%s", peer, error)
        self.db.enqueue_audit("ea_handshake_rejected", symbol=self.config.symbol, ok=False, detail={"peer": peer, "error": error})
        with contextlib.suppress(Exception):
            writer.write((_compact_json({"type": "hello_ack", "ok": False, "error": error}) + "\n").encode("utf-8"))
            await asyncio.wait_for(writer.drain(), timeout=2.0)
        with contextlib.suppress(Exception):
            writer.close()
            await asyncio.wait_for(writer.wait_closed(), timeout=2.0)

    async def _unregister_ea(self, conn: EAConnection, reason: str) -> None:
        changed = False
        async with self._ea_lock:
            if self.ea is conn:
                self.ea = None
                changed = True
        conn.fail_pending(f"EA disconnected: {reason}")
        await conn.close(reason)
        if changed:
            LOG.warning("EA disconnected: %s", reason)
            self.db.enqueue_audit("ea_disconnected", symbol=self.config.symbol, ok=False, detail={"reason": reason})
            self._broadcast_status(False)

    def _handle_ea_message(self, conn: EAConnection, message: dict[str, Any]) -> None:
        msg_type = message.get("type")
        if not isinstance(msg_type, str):
            raise ProtocolError("message.type must be a string")
        if msg_type == "result":
            if message.get("v") not in (None, PROTOCOL_VERSION):
                raise ProtocolError("unsupported result protocol version")
            self._validate_result(message)
            conn.resolve_result(message)
            return
        if message.get("v") != PROTOCOL_VERSION:
            raise ProtocolError("unsupported protocol version")

        if msg_type == "tick":
            tick = self.store.add_tick(message)
            self.db.enqueue_tick(tick)
        elif msg_type == "bar":
            bar, changed = self.store.add_bar(message)
            if changed:
                if bar["closed"]:
                    self.db.enqueue_closed_bar(bar)
                self._broadcast_bar(bar)
        elif msg_type == "account":
            account, changed = self.store.set_account(message)
            self.db.enqueue_account(account)
            if changed:
                self._broadcast_all({"type": "account", "account": account})
        elif msg_type == "positions":
            items = message.get("items")
            if not isinstance(items, list):
                raise ProtocolError("positions.items must be an array")
            added, updated, removed, changed = self.store.set_positions(items)
            if changed:
                self.db.enqueue_positions(self.config.symbol, self.store.positions.values())
                payload = {"type": "positions", "symbol": self.config.symbol, "items": list(self.store.positions.values())}
                self._broadcast_symbol(self.config.symbol, payload)
                for item in added + updated:
                    self._broadcast_symbol(self.config.symbol, {"type": "position", "action": "upsert", "item": item})
                for item in removed:
                    self._broadcast_symbol(self.config.symbol, {"type": "position", "action": "remove", "ticket": item["ticket"], "item": item})
        elif msg_type == "orders":
            items = message.get("items")
            if not isinstance(items, list):
                raise ProtocolError("orders.items must be an array")
            added, updated, removed, changed = self.store.set_orders(items)
            if changed:
                self.db.enqueue_orders(self.config.symbol, self.store.orders.values())
                payload = {"type": "orders", "symbol": self.config.symbol, "items": list(self.store.orders.values())}
                self._broadcast_symbol(self.config.symbol, payload)
                for item in added + updated:
                    self._broadcast_symbol(self.config.symbol, {"type": "order", "action": "upsert", "item": item})
                for item in removed:
                    self._broadcast_symbol(self.config.symbol, {"type": "order", "action": "remove", "ticket": item["ticket"], "item": item})
        elif msg_type == "trade":
            trade = self.store.add_trade(message)
            self.db.enqueue_trade(trade)
            self._broadcast_symbol(self.config.symbol, {"type": "trade", "trade": trade})
        elif msg_type == "heartbeat":
            conn.last_heartbeat = asyncio.get_running_loop().time()
            try:
                conn.server_offset_sec = _int(message, "server_offset_sec", default=conn.server_offset_sec)
            except ProtocolError:
                pass
            self.store.last_message_ms = now_msc()
        else:
            LOG.debug("ignoring unknown EA message type %s", msg_type)

    @staticmethod
    def _validate_result(message: dict[str, Any]) -> None:
        if not isinstance(message.get("id"), str):
            raise ProtocolError("result.id must be a string")
        if not isinstance(message.get("ok"), bool):
            raise ProtocolError("result.ok must be boolean")
        if "retcode" in message and not isinstance(message["retcode"], (int, float)):
            raise ProtocolError("result.retcode must be numeric")

    async def _watchdog(self) -> None:
        try:
            while True:
                await asyncio.sleep(1.0)
                conn = self.ea
                if conn is None or conn.closed:
                    continue
                age = asyncio.get_running_loop().time() - conn.last_heartbeat
                if age > HEARTBEAT_TIMEOUT:
                    LOG.warning("EA heartbeat timeout (%.1fs); closing", age)
                    await conn.close("heartbeat_timeout")
        except asyncio.CancelledError:
            raise

    async def _tick_pump(self) -> None:
        try:
            while True:
                await asyncio.sleep(WS_TICK_INTERVAL)
                for symbol, tick in list(self.store.latest_ticks.items()):
                    seq = self.store.tick_seq.get(symbol, 0)
                    if self._last_tick_sent.get(symbol) == seq:
                        continue
                    self._last_tick_sent[symbol] = seq
                    payload = {"type": "tick", **tick}
                    for client in tuple(self.clients.values()):
                        if client.wants(symbol):
                            client.enqueue(payload)
        except asyncio.CancelledError:
            raise

    # -- broadcasts ---------------------------------------------------------
    def _broadcast_all(self, payload: dict[str, Any]) -> None:
        for client in tuple(self.clients.values()):
            client.enqueue(payload)

    def _broadcast_symbol(self, symbol: str, payload: dict[str, Any]) -> None:
        for client in tuple(self.clients.values()):
            if client.wants(symbol):
                client.enqueue(payload)

    def _broadcast_bar(self, bar: dict[str, Any]) -> None:
        for client in tuple(self.clients.values()):
            if client.wants(bar["symbol"], bar["tf"]):
                client.enqueue({"type": "bar", **{k: v for k, v in bar.items() if k != "received_msc"}})

    def _broadcast_status(self, connected: bool) -> None:
        payload = {
            "type": "status",
            "ea_connected": connected,
            "symbol": self.config.symbol,
            "server_time": now_msc(),
        }
        self._broadcast_all(payload)

    # -- command API --------------------------------------------------------
    async def send_command(self, command: dict[str, Any], timeout: float = COMMAND_TIMEOUT) -> dict[str, Any]:
        conn = self.ea
        if conn is None or conn.closed:
            raise EAUnavailable("EA is not connected")
        return await conn.command(command, timeout=timeout)

    def add_client(self, client: WebClient) -> None:
        self.clients[client.client_id] = client

    async def remove_client(self, client: WebClient) -> None:
        self.clients.pop(client.client_id, None)
        await client.stop()

    def health(self) -> dict[str, Any]:
        tick = self.store.latest_tick()
        tick_age_ms = None if tick is None else max(0, now_msc() - tick.get("received_msc", tick["ts_msc"]))
        last_bar = self.store.last_bar
        conn = self.ea
        offset_sec = conn.server_offset_sec if conn is not None else 0
        last_bar_age_ms = None if last_bar is None else max(0, now_msc() - (last_bar["bar_time"] - offset_sec) * 1000)
        last_bar_public = None
        if last_bar is not None:
            last_bar_public = dict(last_bar)
            last_bar_public["bar_time_utc"] = iso_utc((last_bar["bar_time"] - offset_sec) * 1000)
            last_bar_public["bar_time_beijing"] = iso_beijing((last_bar["bar_time"] - offset_sec) * 1000)
        heartbeat_age_ms = None
        if conn is not None:
            heartbeat_age_ms = int((asyncio.get_running_loop().time() - conn.last_heartbeat) * 1000)
        last_tick_utc_ms = (tick["ts_msc"] - offset_sec * 1000) if tick else None
        return {
            "ea_connected": self.ea_connected(),
            "ea_peer": conn.peer if conn else None,
            "ea_terminal": conn.terminal if conn else None,
            "ea_generation": conn.generation if conn else None,
            "server_offset_sec": conn.server_offset_sec if conn else None,
            "last_tick_ms": tick["ts_msc"] if tick else None,
            "last_tick_utc_ms": last_tick_utc_ms,
            "last_tick_iso": iso_utc(last_tick_utc_ms) if tick else None,
            "age_ms": tick_age_ms,
            "last_bar": last_bar_public,
            "last_bar_age_ms": last_bar_age_ms,
            "last_message_ms": self.store.last_message_ms,
            "heartbeat_age_ms": heartbeat_age_ms,
            "clients": len(self.clients),
            "pending_commands": len(conn.pending) if conn else 0,
            "buffer_sizes": self.store.buffer_sizes(),
            "counters": {
                "ticks_received": self.store.ticks_received,
                "bars_received": self.store.bars_received,
                "trades_received": self.store.trades_received,
                "protocol_errors": self.store.protocol_errors,
                "ws_dropped": sum(c.dropped for c in self.clients.values()),
            },
            "db": self.db.stats(),
            "uptime_sec": round(time.monotonic() - self.started_monotonic, 3),
            "server_time": now_msc(),
            "version": PROTOCOL_VERSION,
            "symbol": self.config.symbol,
        }

    def symbols_response(self) -> list[dict[str, Any]]:
        tick = self.store.latest_tick()
        return [
            {
                "symbol": self.config.symbol,
                "timeframes": list(SUPPORTED_TFS),
                "last_tick": tick,
                "last_bars": self.store.last_bars(self.config.symbol),
            }
        ]


def _is_loopback(host: str) -> bool:
    return host in {"127.0.0.1", "::1", "localhost"}


# ---------------------------------------------------------------------------
# REST models and helpers
# ---------------------------------------------------------------------------
class OrderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    action: str
    side: str
    symbol: str
    volume: float
    price: float = 0.0
    sl: float = 0.0
    tp: float = 0.0
    deviation: int = Field(default=20, ge=0, le=10_000)
    magic: int = Field(default=0, ge=0)
    comment: str = Field(default="ea_bridge", max_length=31)

    @field_validator("action")
    @classmethod
    def _action(cls, value: str) -> str:
        value = value.lower()
        if value not in {"market", "limit", "stop"}:
            raise ValueError("action must be market, limit or stop")
        return value

    @field_validator("side")
    @classmethod
    def _side(cls, value: str) -> str:
        value = value.lower()
        if value not in {"buy", "sell"}:
            raise ValueError("side must be buy or sell")
        return value

    @field_validator("volume", "price", "sl", "tp")
    @classmethod
    def _finite(cls, value: float) -> float:
        if not math.isfinite(float(value)):
            raise ValueError("must be finite")
        return float(value)


class ClosePositionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    volume: float = Field(default=0.0, ge=0.0)
    comment: str = Field(default="ea_bridge_close", max_length=31)

    @field_validator("volume")
    @classmethod
    def _finite(cls, value: float) -> float:
        if not math.isfinite(float(value)):
            raise ValueError("must be finite")
        return float(value)


class ModifyPositionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sl: float = 0.0
    tp: float = 0.0
    comment: str = Field(default="ea_bridge_modify", max_length=31)

    @field_validator("sl", "tp")
    @classmethod
    def _finite_nonneg(cls, value: float) -> float:
        if not math.isfinite(float(value)) or value < 0:
            raise ValueError("must be a finite non-negative number")
        return float(value)


def _http_error_body(detail: Any) -> dict[str, Any]:
    return {"ok": False, "error": detail if isinstance(detail, str) else _compact_json(detail), "detail": detail}


def _result_body(result: dict[str, Any], *, symbol: str, command_id: str, action: str, idempotency_key: str | None = None) -> dict[str, Any]:
    body = {
        "ok": bool(result.get("ok", False)),
        "id": command_id,
        "action": action,
        "symbol": symbol,
        "retcode": int(result.get("retcode", 0) or 0),
        "retcode_name": str(result.get("retcode_name", "") or ""),
        "order": int(result.get("order", 0) or 0),
        "deal": int(result.get("deal", 0) or 0),
        "price": float(result.get("price", 0) or 0),
        "volume": float(result.get("volume", 0) or 0),
        "error": str(result.get("error", "") or ""),
        "server_time": now_msc(),
    }
    if idempotency_key:
        body["idempotency_key"] = idempotency_key
    return body


def _validate_order(runtime: GatewayRuntime, req: OrderRequest) -> None:
    cfg = runtime.config
    if req.symbol.upper() != cfg.symbol:
        raise HTTPException(status_code=422, detail=f"symbol is not allowed; expected {cfg.symbol}")
    if req.volume <= 0 or req.volume > cfg.max_volume:
        raise HTTPException(status_code=422, detail=f"volume must be > 0 and <= {cfg.max_volume}")
    if req.action in {"limit", "stop"} and req.price <= 0:
        raise HTTPException(status_code=422, detail="price is required for limit/stop orders")
    if req.price < 0 or req.sl < 0 or req.tp < 0:
        raise HTTPException(status_code=422, detail="price, sl and tp must be non-negative")
    tick = runtime.store.latest_tick(cfg.symbol)
    reference: float | None = None
    if req.action == "market":
        if tick is not None:
            reference = float(tick["ask"] if req.side == "buy" else tick["bid"])
        elif req.price > 0:
            reference = req.price
    else:
        reference = req.price
        if tick is not None:
            bid, ask = float(tick["bid"]), float(tick["ask"])
            mid = (bid + ask) / 2.0
            if mid > 0:
                deviation_pct = abs(req.price - mid) / mid * 100.0
                if deviation_pct > cfg.max_price_deviation_pct:
                    raise HTTPException(
                        status_code=422,
                        detail=f"price deviates {deviation_pct:.2f}% from last mid; limit is {cfg.max_price_deviation_pct}%",
                    )
            if req.side == "buy":
                if req.action == "limit" and req.price >= ask:
                    raise HTTPException(status_code=422, detail="buy limit price must be below current ask")
                if req.action == "stop" and req.price <= ask:
                    raise HTTPException(status_code=422, detail="buy stop price must be above current ask")
            else:
                if req.action == "limit" and req.price <= bid:
                    raise HTTPException(status_code=422, detail="sell limit price must be above current bid")
                if req.action == "stop" and req.price >= bid:
                    raise HTTPException(status_code=422, detail="sell stop price must be below current bid")
    if reference is not None:
        if req.sl > 0 and req.side == "buy" and req.sl >= reference:
            raise HTTPException(status_code=422, detail="buy stop loss must be below entry/reference price")
        if req.sl > 0 and req.side == "sell" and req.sl <= reference:
            raise HTTPException(status_code=422, detail="sell stop loss must be above entry/reference price")
        if req.tp > 0 and req.side == "buy" and req.tp <= reference:
            raise HTTPException(status_code=422, detail="buy take profit must be above entry/reference price")
        if req.tp > 0 and req.side == "sell" and req.tp >= reference:
            raise HTTPException(status_code=422, detail="sell take profit must be below entry/reference price")
    if cfg.max_daily_loss > 0:
        today = datetime.now(timezone.utc).date().isoformat()
        pnl = runtime.store.daily_realized_pnl if runtime.store.daily_pnl_date == today else 0.0
        if pnl <= -cfg.max_daily_loss:
            raise HTTPException(
                status_code=403,
                detail=f"daily loss limit reached ({pnl:.2f}); new orders are blocked",
            )


def _require_ea(runtime: GatewayRuntime) -> None:
    if not runtime.ea_connected():
        raise HTTPException(status_code=503, detail="EA is not connected")


def _order_command(req: OrderRequest, command_id: str) -> dict[str, Any]:
    return {
        "type": "order",
        "id": command_id,
        "action": req.action,
        "side": req.side,
        "symbol": req.symbol.upper(),
        "volume": req.volume,
        "price": req.price,
        "sl": req.sl,
        "tp": req.tp,
        "deviation": req.deviation,
        "magic": req.magic,
        "comment": req.comment,
    }


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
def create_app(config: Config) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        runtime = GatewayRuntime(config)
        app.state.runtime = runtime
        await runtime.start()
        try:
            yield
        finally:
            await runtime.stop()

    app = FastAPI(
        title="MT5 EA Bridge",
        version="1.0.0",
        description="EA-owned MT5 market data and order gateway. Python never touches MT5.",
        lifespan=lifespan,
    )

    def runtime(request: Request) -> GatewayRuntime:
        return request.app.state.runtime

    @app.get("/api/health")
    async def health(request: Request) -> dict[str, Any]:
        return runtime(request).health()

    @app.get("/api/symbols")
    async def symbols(request: Request) -> dict[str, Any]:
        rt = runtime(request)
        return {"symbols": rt.symbols_response(), "server_time": now_msc()}

    @app.get("/api/bars")
    async def bars(
        request: Request,
        symbol: str = Query(default=config.symbol),
        tf: str = Query(default="1m"),
        limit: int = Query(default=500, ge=1, le=BAR_HISTORY),
    ) -> dict[str, Any]:
        rt = runtime(request)
        symbol_u = symbol.upper()
        if symbol_u != rt.config.symbol:
            raise HTTPException(status_code=422, detail=f"symbol is not allowed; expected {rt.config.symbol}")
        try:
            tf_n = normalize_tf(tf)
        except ProtocolError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        values = rt.store.bars_for(symbol_u, tf_n, limit)
        return {"symbol": symbol_u, "tf": tf_n, "count": len(values), "bars": values}

    @app.get("/api/latest")
    async def latest(request: Request, symbol: str = Query(default=config.symbol)) -> dict[str, Any]:
        rt = runtime(request)
        symbol_u = symbol.upper()
        if symbol_u != rt.config.symbol:
            raise HTTPException(status_code=422, detail=f"symbol is not allowed; expected {rt.config.symbol}")
        return {
            "symbol": symbol_u,
            "tick": rt.store.latest_tick(symbol_u),
            "bars": rt.store.last_bars(symbol_u),
            "account": rt.store.account,
            "ea_connected": rt.ea_connected(),
            "server_time": now_msc(),
        }

    @app.get("/api/account")
    async def account(request: Request) -> dict[str, Any]:
        rt = runtime(request)
        return {"account": rt.store.account, "ea_connected": rt.ea_connected(), "server_time": now_msc()}

    @app.get("/api/positions")
    async def positions(request: Request) -> dict[str, Any]:
        rt = runtime(request)
        return {"symbol": rt.config.symbol, "items": list(rt.store.positions.values()), "count": len(rt.store.positions)}

    @app.get("/api/orders")
    async def orders(request: Request) -> dict[str, Any]:
        rt = runtime(request)
        return {"symbol": rt.config.symbol, "items": list(rt.store.orders.values()), "count": len(rt.store.orders)}

    @app.post("/api/orders")
    async def create_order(
        request: Request,
        req: OrderRequest,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> JSONResponse:
        rt = runtime(request)
        if not idempotency_key or len(idempotency_key) > 200:
            raise HTTPException(status_code=400, detail="Idempotency-Key header is required (<= 200 chars)")
        try:
            entry, owner = await rt.idempotency.begin(
                idempotency_key,
                rt.idempotency.fingerprint({"endpoint": "POST /api/orders", "body": req.model_dump()}),
            )
        except IdempotencyConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

        if not owner:
            status, body = await asyncio.shield(entry.future)
            return JSONResponse(
                body,
                status_code=status,
                headers={"Idempotent-Replay": "true"},
            )

        status = 500
        body: dict[str, Any] = {"ok": False, "error": "internal error"}
        command_id = str(uuid.uuid4())
        try:
            _validate_order(rt, req)
            _require_ea(rt)
            command = _order_command(req, command_id)
            rt.db.enqueue_audit(
                "order_request",
                symbol=req.symbol,
                request_id=command_id,
                idempotency_key=idempotency_key,
                ok=True,
                detail=req.model_dump(),
            )
            LOG.info("order request id=%s %s %s %.2f", command_id, req.action, req.side, req.volume)
            result = await rt.send_command(command)
            body = _result_body(result, symbol=req.symbol.upper(), command_id=command_id, action=req.action, idempotency_key=idempotency_key)
            status = 200
            rt.db.enqueue_audit(
                "order_result",
                symbol=req.symbol,
                request_id=command_id,
                idempotency_key=idempotency_key,
                ok=bool(body["ok"]),
                detail={k: body[k] for k in ("retcode", "retcode_name", "order", "deal", "price", "volume", "error")},
            )
        except HTTPException as exc:
            status = exc.status_code
            body = _http_error_body(exc.detail)
            body.update({"id": command_id, "action": req.action, "symbol": req.symbol.upper()})
            rt.db.enqueue_audit(
                "order_rejected",
                symbol=req.symbol,
                request_id=command_id,
                idempotency_key=idempotency_key,
                ok=False,
                detail={"status": status, "detail": exc.detail},
            )
        except EAUnavailable as exc:
            status = 503
            # The command may already have been written before the EA vanished.
            body = {"ok": False, "error": str(exc), "uncertain": True, "id": command_id, "action": req.action, "symbol": req.symbol.upper()}
            rt.db.enqueue_audit(
                "order_failed", symbol=req.symbol, request_id=command_id, idempotency_key=idempotency_key, ok=False,
                detail={"error": str(exc)},
            )
        except EACommandTimeout as exc:
            status = 504
            body = {
                "ok": False,
                "error": "EA command timed out; execution is uncertain",
                "uncertain": True,
                "id": command_id,
                "action": req.action,
                "symbol": req.symbol.upper(),
            }
            rt.db.enqueue_audit(
                "order_timeout", symbol=req.symbol, request_id=command_id, idempotency_key=idempotency_key, ok=False,
                detail={"error": str(exc)},
            )
        except Exception as exc:
            LOG.exception("order request failed id=%s", command_id)
            status = 500
            body = {"ok": False, "error": f"internal error: {exc}", "id": command_id}
            rt.db.enqueue_audit(
                "order_failed", symbol=req.symbol, request_id=command_id, idempotency_key=idempotency_key, ok=False,
                detail={"error": str(exc)},
            )
        finally:
            rt.idempotency.finish(entry, status, body)
        return JSONResponse(body, status_code=status)

    @app.delete("/api/orders/{ticket}")
    async def cancel_order(request: Request, ticket: int) -> JSONResponse:
        rt = runtime(request)
        if ticket <= 0:
            raise HTTPException(status_code=422, detail="ticket must be > 0")
        _require_ea(rt)
        command_id = str(uuid.uuid4())
        rt.db.enqueue_audit("cancel_request", symbol=rt.config.symbol, request_id=command_id, ok=True, detail={"order_ticket": ticket})
        try:
            result = await rt.send_command({"type": "cancel", "id": command_id, "order_ticket": ticket})
            body = _result_body(result, symbol=rt.config.symbol, command_id=command_id, action="cancel")
            return JSONResponse(body, status_code=200)
        except EACommandTimeout:
            rt.db.enqueue_audit("cancel_timeout", symbol=rt.config.symbol, request_id=command_id, ok=False, detail={"order_ticket": ticket})
            return JSONResponse(
                {"ok": False, "error": "EA command timed out; cancellation is uncertain", "uncertain": True, "id": command_id},
                status_code=504,
            )
        except EAUnavailable as exc:
            rt.db.enqueue_audit("cancel_failed", symbol=rt.config.symbol, request_id=command_id, ok=False, detail={"error": str(exc)})
            return JSONResponse(
                {"ok": False, "error": str(exc), "uncertain": True, "id": command_id},
                status_code=503,
            )

    @app.post("/api/positions/{ticket}/close")
    async def close_position(
        request: Request,
        ticket: int,
        payload: ClosePositionRequest | None = Body(default=None),
    ) -> JSONResponse:
        rt = runtime(request)
        if ticket <= 0:
            raise HTTPException(status_code=422, detail="ticket must be > 0")
        volume = payload.volume if payload else 0.0
        comment = payload.comment if payload else "ea_bridge_close"
        position = rt.store.positions.get(ticket)
        if position is not None and volume > 0 and volume > float(position.get("volume", 0)) + 1e-9:
            raise HTTPException(status_code=422, detail="close volume exceeds known position volume")
        if volume > rt.config.max_volume:
            raise HTTPException(status_code=422, detail=f"volume must be <= {rt.config.max_volume}")
        _require_ea(rt)
        command_id = str(uuid.uuid4())
        command = {"type": "close", "id": command_id, "position_ticket": ticket, "volume": volume, "comment": comment}
        rt.db.enqueue_audit("close_request", symbol=rt.config.symbol, request_id=command_id, ok=True, detail=command)
        try:
            result = await rt.send_command(command)
            return JSONResponse(_result_body(result, symbol=rt.config.symbol, command_id=command_id, action="close"), status_code=200)
        except EACommandTimeout:
            rt.db.enqueue_audit("close_timeout", symbol=rt.config.symbol, request_id=command_id, ok=False, detail={"position_ticket": ticket})
            return JSONResponse(
                {"ok": False, "error": "EA command timed out; close is uncertain", "uncertain": True, "id": command_id},
                status_code=504,
            )
        except EAUnavailable as exc:
            rt.db.enqueue_audit("close_failed", symbol=rt.config.symbol, request_id=command_id, ok=False, detail={"error": str(exc)})
            return JSONResponse(
                {"ok": False, "error": str(exc), "uncertain": True, "id": command_id},
                status_code=503,
            )

    @app.post("/api/positions/{ticket}/modify")
    async def modify_position(
        request: Request,
        ticket: int,
        payload: ModifyPositionRequest,
    ) -> JSONResponse:
        rt = runtime(request)
        if ticket <= 0:
            raise HTTPException(status_code=422, detail="ticket must be > 0")
        if payload.sl == 0 and payload.tp == 0:
            raise HTTPException(status_code=422, detail="at least one of sl/tp must be non-zero")
        _require_ea(rt)
        command_id = str(uuid.uuid4())
        command = {"type": "modify", "id": command_id, "ticket": ticket, "sl": payload.sl, "tp": payload.tp, "comment": payload.comment}
        rt.db.enqueue_audit("modify_request", symbol=rt.config.symbol, request_id=command_id, ok=True, detail=command)
        try:
            result = await rt.send_command(command)
            return JSONResponse(_result_body(result, symbol=rt.config.symbol, command_id=command_id, action="modify"), status_code=200)
        except EACommandTimeout:
            rt.db.enqueue_audit("modify_timeout", symbol=rt.config.symbol, request_id=command_id, ok=False, detail={"ticket": ticket})
            return JSONResponse(
                {"ok": False, "error": "EA command timed out; modify is uncertain", "uncertain": True, "id": command_id},
                status_code=504,
            )
        except EAUnavailable as exc:
            rt.db.enqueue_audit("modify_failed", symbol=rt.config.symbol, request_id=command_id, ok=False, detail={"error": str(exc)})
            return JSONResponse(
                {"ok": False, "error": str(exc), "uncertain": True, "id": command_id},
                status_code=503,
            )

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        await websocket.accept()
        rt: GatewayRuntime = websocket.app.state.runtime
        client = WebClient(websocket, uuid.uuid4().hex[:12])
        rt.add_client(client)
        client.start()
        client.enqueue(
            {
                "type": "welcome",
                "v": PROTOCOL_VERSION,
                "server_time": now_msc(),
                "symbols": [rt.config.symbol],
                "timeframes": list(SUPPORTED_TFS),
                "client_id": client.client_id,
            }
        )
        try:
            while True:
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    client.enqueue({"type": "error", "error": "invalid JSON"})
                    continue
                if not isinstance(msg, dict):
                    client.enqueue({"type": "error", "error": "message must be an object"})
                    continue
                action = msg.get("action")
                if action == "subscribe":
                    symbol = str(msg.get("symbol", "")).upper()
                    tf = str(msg.get("tf", "")).lower()
                    if symbol != rt.config.symbol:
                        client.enqueue({"type": "error", "error": f"symbol must be {rt.config.symbol}"})
                        continue
                    if tf not in SUPPORTED_TFS:
                        client.enqueue({"type": "error", "error": f"tf must be one of {list(SUPPORTED_TFS)}"})
                        continue
                    client.subscriptions.setdefault(symbol, set()).add(tf)
                    client.enqueue({"type": "subscribed", "symbol": symbol, "tf": tf})
                    snapshot_bars = rt.store.bars_for(symbol, tf, 500)
                    client.enqueue(
                        {
                            "type": "snapshot",
                            "symbol": symbol,
                            "tf": tf,
                            "bars": snapshot_bars,
                            "tick": rt.store.latest_tick(symbol),
                            "account": rt.store.account,
                            "positions": list(rt.store.positions.values()),
                            "orders": list(rt.store.orders.values()),
                            "ea_connected": rt.ea_connected(),
                            "server_time": now_msc(),
                        }
                    )
                elif action == "unsubscribe":
                    symbol = str(msg.get("symbol", rt.config.symbol)).upper()
                    tf = msg.get("tf")
                    if isinstance(tf, str):
                        subs = client.subscriptions.get(symbol)
                        if subs is not None:
                            subs.discard(tf.lower())
                            if not subs:
                                client.subscriptions.pop(symbol, None)
                    else:
                        client.subscriptions.pop(symbol, None)
                    client.enqueue({"type": "unsubscribed", "symbol": symbol, "tf": tf})
                elif action == "ping":
                    client.enqueue({"type": "pong", "server_time": now_msc()})
                else:
                    client.enqueue({"type": "error", "error": "unknown action; use subscribe, unsubscribe or ping"})
        except WebSocketDisconnect:
            pass
        except Exception:
            LOG.info("WebSocket receive failed for %s", client.client_id, exc_info=True)
        finally:
            await rt.remove_client(client)

    if config.static_dir is not None and config.static_dir.is_dir():
        LOG.info("serving static frontend from %s", config.static_dir)
        app.mount("/", StaticFiles(directory=str(config.static_dir), html=True), name="static")
    else:
        @app.get("/")
        async def root() -> dict[str, Any]:
            return {
                "service": "mt5-ea-bridge",
                "version": "1.0.0",
                "protocol": PROTOCOL_VERSION,
                "docs": "/docs",
                "health": "/api/health",
                "static_dir": str(config.static_dir) if config.static_dir else None,
            }

    return app


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> None:
    config = parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, config.log_level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    LOG.info("starting ea_bridge (no MetaTrader5 import, no MT5 IPC)")
    app = create_app(config)
    uvicorn.run(
        app,
        host=config.host,
        port=config.port,
        log_level=config.log_level.lower(),
        access_log=False,
    )


if __name__ == "__main__":
    main()

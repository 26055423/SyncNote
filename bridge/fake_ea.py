#!/usr/bin/env python3
"""Synthetic EA for integration tests and frontend development.

It speaks the exact v1 NDJSON protocol in PROTOCOL.md, but never touches MT5.
Run this instead of WebBridge.mq5 while working on the gateway or browser UI.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import math
import random
import time
from collections import deque
from dataclasses import dataclass
from typing import Any

LOG = logging.getLogger("fake_ea")

TFS = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600}


@dataclass
class FakeBar:
    tf: str
    bar_time: int
    open: float
    high: float
    low: float
    close: float
    tick_volume: int
    spread: int


class FakeEA:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.symbol = args.symbol.upper()
        self.price = 2650.0
        self.writer: asyncio.StreamWriter | None = None
        self.write_lock = asyncio.Lock()
        self.tasks: list[asyncio.Task[Any]] = []
        self.connected = False
        self.next_ticket = 500_000
        self.position_ticket = 700_001
        self.order_ticket = 800_001
        self.deal_ticket = 900_001
        self.bars: dict[str, FakeBar] = {}
        self.rng = random.Random(7)
        self.started = time.monotonic()
        self.stop_event = asyncio.Event()
        self.trade_sent = False

    # -- transport ---------------------------------------------------------
    async def send(self, payload: dict[str, Any]) -> None:
        writer = self.writer
        if writer is None:
            return
        line = json.dumps(payload, separators=(",", ":"), ensure_ascii=True) + "\n"
        async with self.write_lock:
            if self.writer is None:
                return
            writer.write(line.encode("utf-8"))
            await writer.drain()

    async def run(self) -> None:
        delay = 1.0
        while not self.stop_event.is_set():
            try:
                await self._connect_and_serve()
                delay = 1.0
            except asyncio.CancelledError:
                raise
            except (ConnectionError, OSError, asyncio.IncompleteReadError) as exc:
                LOG.warning("connection lost: %s (retrying in %.1fs)", exc, delay)
            except Exception:
                LOG.exception("fake EA failure (retrying in %.1fs)", delay)
            finally:
                self.connected = False
                await self._cancel_tasks()
                self.writer = None
            if self.args.duration and time.monotonic() - self.started >= self.args.duration:
                break
            if self.stop_event.is_set():
                break
            await asyncio.sleep(delay)
            delay = min(delay * 1.5, 5.0)

    async def _connect_and_serve(self) -> None:
        LOG.info("connecting to %s:%s", self.args.host, self.args.port)
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(self.args.host, self.args.port), timeout=5.0
        )
        self.writer = writer
        hello = {
            "v": 1,
            "type": "hello",
            "token": self.args.token,
            "terminal": "Fake MT5 Terminal (test)",
            "symbol": self.symbol,
            "server_offset_sec": 0,
            "time": int(time.time()),
        }
        await self.send(hello)
        raw = await asyncio.wait_for(reader.readline(), timeout=5.0)
        if not raw:
            raise ConnectionError("gateway closed during handshake")
        ack = json.loads(raw.decode("utf-8"))
        if not ack.get("ok"):
            raise ConnectionError(f"handshake rejected: {ack.get('error')}")
        LOG.info("handshake accepted (server_time=%s)", ack.get("server_time"))
        self.connected = True
        await self._send_initial_snapshot()
        self.tasks = [
            asyncio.create_task(self._tick_loop(), name="fake-ticks"),
            asyncio.create_task(self._slow_loop(), name="fake-bars-account"),
        ]
        try:
            while True:
                raw = await reader.readline()
                if not raw:
                    raise ConnectionError("gateway closed EA socket")
                try:
                    command = json.loads(raw.decode("utf-8"))
                except json.JSONDecodeError:
                    LOG.warning("ignoring malformed command: %r", raw[:200])
                    continue
                await self._handle_command(command)
        finally:
            with contextlib.suppress(Exception):
                writer.close()
                await writer.wait_closed()

    async def _cancel_tasks(self) -> None:
        for task in self.tasks:
            task.cancel()
        for task in self.tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self.tasks.clear()

    # -- synthetic data ----------------------------------------------------
    def _seed_bars(self) -> None:
        # Rebuild on every (re)connect so snapshot timestamps are current.
        now = int(time.time())
        for tf, seconds in TFS.items():
            current_time = now - (now % seconds)
            generated: deque[FakeBar] = deque(maxlen=self.args.snapshot_bars)
            for i in range(self.args.snapshot_bars, -1, -1):
                bar_time = current_time - i * seconds
                # Keep the synthetic history in a believable range without drifting.
                drift = math.sin(bar_time / 900.0 + seconds) * 4.0
                mid = self.price + drift * 0.25
                o = mid + self.rng.uniform(-0.8, 0.8)
                c = o + self.rng.uniform(-1.2, 1.2)
                hi = max(o, c) + self.rng.uniform(0.05, 1.0)
                lo = min(o, c) - self.rng.uniform(0.05, 1.0)
                generated.append(
                    FakeBar(tf, bar_time, o, hi, lo, c, self.rng.randint(20, 300), self.rng.randint(10, 35))
                )
            self.bars[tf] = generated[-1]
            # Remember all bars only for the initial snapshot.
            setattr(self, f"_snapshot_{tf}", list(generated))

    def _bar_event(self, bar: FakeBar, closed: bool) -> dict[str, Any]:
        return {
            "v": 1,
            "type": "bar",
            "symbol": self.symbol,
            "tf": bar.tf,
            "bar_time": bar.bar_time,
            "open": round(bar.open, 2),
            "high": round(bar.high, 2),
            "low": round(bar.low, 2),
            "close": round(bar.close, 2),
            "tick_volume": bar.tick_volume,
            "spread": bar.spread,
            "closed": closed,
        }

    def _account_event(self) -> dict[str, Any]:
        equity = 10_000.0 + math.sin(time.time() / 30.0) * 15.0
        return {
            "v": 1,
            "type": "account",
            "login": 12345678,
            "balance": 10_000.0,
            "equity": round(equity, 2),
            "margin": 100.0,
            "free_margin": round(equity - 100.0, 2),
            "currency": "USD",
            "leverage": 100,
            "profit": round(equity - 10_000.0, 2),
        }

    def _positions_event(self) -> dict[str, Any]:
        entry = round(self.price - 5.0, 2)
        return {
            "v": 1,
            "type": "positions",
            "items": [
                {
                    "ticket": self.position_ticket,
                    "symbol": self.symbol,
                    "side": "buy",
                    "volume": 0.1,
                    "price_open": entry,
                    "sl": round(entry - 10.0, 2),
                    "tp": round(entry + 20.0, 2),
                    "profit": round((self.price - entry) * 10.0, 2),
                    "magic": 0,
                    "comment": "fake-ea",
                    "time_msc": int(time.time() * 1000) - 60_000,
                }
            ],
        }

    def _orders_event(self) -> dict[str, Any]:
        return {
            "v": 1,
            "type": "orders",
            "items": [
                {
                    "ticket": self.order_ticket,
                    "symbol": self.symbol,
                    "type": "buy_limit",
                    "side": "buy",
                    "volume": 0.1,
                    "price": round(self.price - 30.0, 2),
                    "sl": round(self.price - 40.0, 2),
                    "tp": round(self.price - 10.0, 2),
                    "magic": 0,
                    "comment": "fake-ea",
                    "time_msc": int(time.time() * 1000) - 30_000,
                    "state": "placed",
                }
            ],
        }

    async def _send_initial_snapshot(self) -> None:
        self._seed_bars()
        for tf in TFS:
            snapshot = getattr(self, f"_snapshot_{tf}", [])
            for bar in snapshot:
                await self.send(self._bar_event(bar, closed=bar.bar_time != self.bars[tf].bar_time))
        await self.send(self._account_event())
        await self.send(self._positions_event())
        await self.send(self._orders_event())
        await self.send(self._heartbeat())
        LOG.info("initial snapshot sent (%s bars per TF)", self.args.snapshot_bars + 1)

    def _heartbeat(self) -> dict[str, Any]:
        return {"v": 1, "type": "heartbeat", "time": int(time.time()), "server_offset_sec": 0}

    async def _tick_loop(self) -> None:
        interval = 1.0 / max(1.0, self.args.rate)
        try:
            while True:
                if not self.connected:
                    return
                self.price += self.rng.uniform(-0.08, 0.08)
                self.price = min(2800.0, max(2400.0, self.price))
                spread = self.rng.choice([0.12, 0.2, 0.3])
                bid = round(self.price - spread / 2, 2)
                ask = round(self.price + spread / 2, 2)
                tick = {
                    "v": 1,
                    "type": "tick",
                    "symbol": self.symbol,
                    "ts_msc": int(time.time() * 1000),
                    "bid": bid,
                    "ask": ask,
                    "last": round(self.price, 2),
                    "volume": float(self.rng.randint(1, 5)),
                    "flags": 6,
                }
                await self.send(tick)
                # Keep the forming bar moving.
                for bar in self.bars.values():
                    bar.high = max(bar.high, ask)
                    bar.low = min(bar.low, bid)
                    bar.close = bid
                    bar.tick_volume += 1
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            raise

    async def _slow_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(1.0)
                if not self.connected:
                    return
                now = int(time.time())
                for tf, seconds in TFS.items():
                    current = self.bars[tf]
                    current_time = now - (now % seconds)
                    if current_time != current.bar_time:
                        # The old bar becomes final, then a new one opens.
                        previous = current
                        await self.send(self._bar_event(previous, closed=True))
                        open_price = previous.close
                        self.bars[tf] = FakeBar(
                            tf,
                            current_time,
                            open_price,
                            open_price,
                            open_price,
                            open_price,
                            0,
                            self.rng.randint(10, 35),
                        )
                    await self.send(self._bar_event(self.bars[tf], closed=False))
                await self.send(self._account_event())
                await self.send(self._positions_event())
                await self.send(self._orders_event())
                await self.send(self._heartbeat())
        except asyncio.CancelledError:
            raise

    # -- commands ----------------------------------------------------------
    async def _handle_command(self, command: dict[str, Any]) -> None:
        if not isinstance(command, dict):
            return
        command_id = command.get("id")
        if not isinstance(command_id, str):
            return
        kind = command.get("type")
        LOG.info("command %s id=%s", kind, command_id)
        await asyncio.sleep(0.01)
        if kind == "ping":
            await self._result(command_id, True, 10009, "TRADE_RETCODE_DONE", 0, 0, 0.0, 0.0, "")
            return
        if kind == "order":
            self.next_ticket += 1
            ticket = self.next_ticket
            self.deal_ticket += 1
            side = str(command.get("side", "buy"))
            action = str(command.get("action", "market"))
            volume = float(command.get("volume", 0) or 0)
            price = float(command.get("price", 0) or 0)
            if action == "market":
                price = self.price + (0.06 if side == "buy" else -0.06)
            self.order_ticket = ticket
            await self._result(
                command_id,
                True,
                10009,
                "TRADE_RETCODE_DONE",
                ticket,
                self.deal_ticket,
                round(price, 2),
                volume,
                "",
            )
            if not self.trade_sent:
                self.trade_sent = True
                await self.send(
                    {
                        "v": 1,
                        "type": "trade",
                        "trans_type": 2,
                        "order": ticket,
                        "deal": self.deal_ticket,
                        "position": self.position_ticket,
                        "symbol": self.symbol,
                        "side": "buy" if side == "buy" else "sell",
                        "volume": volume,
                        "price": round(price, 2),
                        "profit": 1.25,
                        "time_msc": int(time.time() * 1000),
                    }
                )
            return
        if kind == "cancel":
            await self._result(command_id, True, 10009, "TRADE_RETCODE_DONE", command.get("order_ticket", 0), 0, 0.0, 0.0, "")
            return
        if kind == "close":
            self.deal_ticket += 1
            await self._result(
                command_id,
                True,
                10009,
                "TRADE_RETCODE_DONE",
                0,
                self.deal_ticket,
                round(self.price, 2),
                float(command.get("volume", 0) or 0),
                "",
            )
            return
        if kind == "modify":
            await self._result(command_id, True, 10009, "TRADE_RETCODE_DONE", command.get("ticket", 0), 0, 0.0, 0.0, "")
            return
        await self._result(command_id, False, 10013, "TRADE_RETCODE_INVALID", 0, 0, 0.0, 0.0, f"unknown command {kind}")

    async def _result(
        self,
        command_id: str,
        ok: bool,
        retcode: int,
        retcode_name: str,
        order: int | Any,
        deal: int | Any,
        price: float,
        volume: float,
        error: str,
    ) -> None:
        await self.send(
            {
                "v": 1,
                "type": "result",
                "id": command_id,
                "ok": bool(ok),
                "retcode": int(retcode),
                "retcode_name": retcode_name,
                "order": int(order or 0),
                "deal": int(deal or 0),
                "price": float(price),
                "volume": float(volume),
                "error": error,
            }
        )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Synthetic MT5 EA for the EA bridge")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument("--token", default="test-token")
    parser.add_argument("--symbol", default="XAUUSD")
    parser.add_argument("--rate", type=float, default=5.0, help="ticks per second")
    parser.add_argument("--snapshot-bars", type=int, default=120)
    parser.add_argument("--duration", type=float, default=0.0, help="optional seconds to run, 0 = forever")
    parser.add_argument("--quiet", action="store_true")
    return parser.parse_args(argv)


async def async_main(args: argparse.Namespace) -> None:
    fake = FakeEA(args)
    if args.duration:
        task = asyncio.create_task(_stop_after(fake, args.duration))
        try:
            await fake.run()
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
    else:
        await fake.run()


async def _stop_after(fake: FakeEA, seconds: float) -> None:
    await asyncio.sleep(seconds)
    fake.stop_event.set()
    fake.connected = False
    await fake._cancel_tasks()
    if fake.writer is not None:
        with contextlib.suppress(Exception):
            fake.writer.close()
            await fake.writer.wait_closed()


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.WARNING if args.quiet else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        asyncio.run(async_main(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

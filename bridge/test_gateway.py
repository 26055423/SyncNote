#!/usr/bin/env python3
"""End-to-end test: real gateway process + fake EA. No MT5 required.

Run:
    python test_gateway.py

The test prints a compact summary and exits non-zero on failure. It can also be
collected by pytest because the main check is named `test_end_to_end`.
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import httpx
import websockets

HERE = Path(__file__).resolve().parent


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_http(client: httpx.Client, path: str, timeout: float = 20.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            response = client.get(path)
            if response.status_code == 200:
                return response.json()
            last_error = RuntimeError(f"{path} -> HTTP {response.status_code}: {response.text[:400]}")
        except (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError) as exc:
            last_error = exc
        time.sleep(0.1)
    raise TimeoutError(f"timed out waiting for {path}: {last_error}")


def wait_ea(client: httpx.Client, timeout: float = 20.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        last = wait_http(client, "/api/health", timeout=2.0)
        if last.get("ea_connected") and last.get("last_tick_ms"):
            return last
        time.sleep(0.1)
    raise TimeoutError(f"EA did not connect/send ticks; last health={last}")


async def check_websocket(host: str, port: int, symbol: str = "XAUUSD", tf: str = "1m") -> dict[str, int]:
    uri = f"ws://{host}:{port}/ws"
    seen = {"tick": 0, "bar": 0, "snapshot": 0, "account": 0}
    async with websockets.connect(uri, open_timeout=8, close_timeout=3, max_size=8 * 1024 * 1024) as ws:
        welcome = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
        assert welcome["type"] == "welcome", welcome
        await ws.send(json.dumps({"action": "subscribe", "symbol": symbol, "tf": tf}))
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not (seen["tick"] and seen["bar"] and seen["account"]):
            timeout = max(0.1, deadline - time.monotonic())
            message = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
            kind = message.get("type")
            if kind in seen:
                seen[kind] += 1
                if kind == "bar":
                    assert message["tf"] == tf and "close" in message, message
                if kind == "tick":
                    assert message["bid"] > 0 and message["ask"] > 0, message
                if kind == "account":
                    assert "balance" in message["account"], message
    assert seen["tick"] > 0, seen
    assert seen["bar"] > 0, seen
    assert seen["account"] > 0, seen
    return seen


def count_rows(db_path: Path, table: str) -> int:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
    try:
        return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
    finally:
        conn.close()


def wait_db_rows(db_path: Path, timeout: float = 10.0) -> dict[str, int]:
    deadline = time.monotonic() + timeout
    tables = ["bars", "ticks", "account_snapshots", "trades", "audit_log"]
    last: dict[str, int] = {}
    while time.monotonic() < deadline:
        try:
            last = {table: count_rows(db_path, table) for table in tables}
            if last["bars"] > 0 and last["ticks"] > 0 and last["account_snapshots"] > 0 and last["trades"] > 0:
                return last
        except sqlite3.Error:
            pass
        time.sleep(0.2)
    return last


def terminate(proc: subprocess.Popen[bytes] | None) -> None:
    if proc is None:
        return
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass


def tail(path: Path, lines: int = 80) -> str:
    try:
        content = path.read_text(encoding="utf-8", errors="replace").splitlines()
        return "\n".join(content[-lines:])
    except OSError:
        return "<no log>"


def test_end_to_end() -> None:
    web_port = free_port()
    ea_port = free_port()
    if web_port == ea_port:
        ea_port = free_port()
    token = "test-token-" + os.urandom(6).hex()

    with tempfile.TemporaryDirectory(prefix="ea_bridge_test_") as tmp:
        tmp_path = Path(tmp)
        db_path = tmp_path / "test.db"
        gw_log = tmp_path / "gateway.log"
        fake_log = tmp_path / "fake_ea.log"
        gateway: subprocess.Popen[bytes] | None = None
        fake: subprocess.Popen[bytes] | None = None
        gw_handle = fake_handle = None
        try:
            gw_handle = open(gw_log, "wb")
            fake_handle = open(fake_log, "wb")
            gateway = subprocess.Popen(
                [
                    sys.executable,
                    str(HERE / "gateway.py"),
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(web_port),
                    "--ea-host",
                    "127.0.0.1",
                    "--ea-port",
                    str(ea_port),
                    "--db",
                    str(db_path),
                    "--token",
                    token,
                    "--symbol",
                    "XAUUSD",
                    "--max-volume",
                    "5",
                    "--log-level",
                    "INFO",
                ],
                cwd=str(HERE),
                stdout=gw_handle,
                stderr=subprocess.STDOUT,
            )
            base_url = f"http://127.0.0.1:{web_port}"
            with httpx.Client(base_url=base_url, timeout=10.0) as client:
                wait_http(client, "/api/health", timeout=20)
                fake = subprocess.Popen(
                    [
                        sys.executable,
                        str(HERE / "fake_ea.py"),
                        "--host",
                        "127.0.0.1",
                        "--port",
                        str(ea_port),
                        "--token",
                        token,
                        "--symbol",
                        "XAUUSD",
                        "--rate",
                        "12",
                        "--snapshot-bars",
                        "40",
                    ],
                    cwd=str(HERE),
                    stdout=fake_handle,
                    stderr=subprocess.STDOUT,
                )
                health = wait_ea(client, timeout=25)
                assert health["ea_connected"] is True, health
                assert health["buffer_sizes"]["ticks"] > 0, health
                assert health["clients"] == 0, health

                symbols = client.get("/api/symbols").json()
                assert symbols["symbols"][0]["symbol"] == "XAUUSD", symbols

                bars = client.get("/api/bars", params={"symbol": "XAUUSD", "tf": "1m", "limit": 25}).json()
                assert bars["count"] > 0 and bars["count"] <= 25, bars
                assert bars["bars"][-1]["tf"] == "1m", bars["bars"][-1]
                for field in ("open", "high", "low", "close", "bar_time", "tf", "closed"):
                    assert field in bars["bars"][-1], (field, bars["bars"][-1])

                latest = client.get("/api/latest", params={"symbol": "XAUUSD"}).json()
                assert latest["tick"] is not None and latest["tick"]["bid"] > 0, latest
                assert client.get("/api/account").json()["account"] is not None
                assert client.get("/api/positions").json()["count"] >= 1
                assert client.get("/api/orders").json()["count"] >= 1

                ws_seen = asyncio.run(check_websocket("127.0.0.1", web_port))
                assert ws_seen["snapshot"] > 0 and ws_seen["account"] >= 0, ws_seen

                payload = {
                    "action": "market",
                    "side": "buy",
                    "symbol": "XAUUSD",
                    "volume": 0.1,
                    "price": 0,
                    "sl": 0,
                    "tp": 0,
                    "deviation": 20,
                    "magic": 0,
                    "comment": "integration-test",
                }
                headers = {"Idempotency-Key": "integration-order-1"}
                response = client.post("/api/orders", json=payload, headers=headers)
                assert response.status_code == 200, (response.status_code, response.text)
                order = response.json()
                assert order["ok"] is True, order
                assert order["retcode"] == 10009, order
                assert order["retcode_name"] == "TRADE_RETCODE_DONE", order
                assert order["order"] > 0, order

                duplicate = client.post("/api/orders", json=payload, headers=headers)
                assert duplicate.status_code == 200, duplicate.text
                assert duplicate.headers.get("Idempotent-Replay") == "true", duplicate.headers
                assert duplicate.json()["id"] == order["id"], (duplicate.json(), order)

                missing_key = client.post("/api/orders", json=payload)
                assert missing_key.status_code == 400, missing_key.text

                invalid_symbol = client.post(
                    "/api/orders",
                    json={**payload, "symbol": "EURUSD"},
                    headers={"Idempotency-Key": "integration-order-bad-symbol"},
                )
                assert invalid_symbol.status_code == 422, invalid_symbol.text

                too_big = client.post(
                    "/api/orders",
                    json={**payload, "volume": 99},
                    headers={"Idempotency-Key": "integration-order-too-big"},
                )
                assert too_big.status_code == 422, too_big.text

                cancel = client.delete("/api/orders/800001")
                assert cancel.status_code == 200 and cancel.json()["ok"], cancel.text

                close = client.post("/api/positions/700001/close", json={"volume": 0.1})
                assert close.status_code == 200 and close.json()["ok"], close.text

                modify = client.post(
                    "/api/positions/700001/modify",
                    json={"sl": 2630.0, "tp": 2680.0},
                )
                assert modify.status_code == 200 and modify.json()["ok"], modify.text

                # Wait for the 1 s tick batch and the post-order trade to be committed.
                counts = wait_db_rows(db_path, timeout=12)
                assert counts["bars"] > 0, counts
                assert counts["ticks"] > 0, counts
                assert counts["account_snapshots"] > 0, counts
                assert counts["trades"] > 0, counts
                assert counts["audit_log"] > 0, counts

                final_health = client.get("/api/health").json()
                assert final_health["ea_connected"] is True, final_health
                assert final_health["db"]["written_ticks"] > 0, final_health

            print("PASS")
            print(
                json.dumps(
                    {
                        "web_port": web_port,
                        "ea_port": ea_port,
                        "ws": ws_seen,
                        "order": {
                            "id": order["id"],
                            "retcode": order["retcode"],
                            "retcode_name": order["retcode_name"],
                            "order": order["order"],
                            "deal": order["deal"],
                        },
                        "db_rows": counts,
                        "health": {
                            "ea_connected": final_health["ea_connected"],
                            "ticks_received": final_health["counters"]["ticks_received"],
                            "bars_received": final_health["counters"]["bars_received"],
                            "clients": final_health["clients"],
                            "buffer_sizes": final_health["buffer_sizes"],
                        },
                        "db_path": str(db_path),
                    },
                    indent=2,
                )
            )
        except Exception:
            print("FAIL", file=sys.stderr)
            print("--- gateway log ---", file=sys.stderr)
            print(tail(gw_log), file=sys.stderr)
            print("--- fake EA log ---", file=sys.stderr)
            print(tail(fake_log), file=sys.stderr)
            raise
        finally:
            terminate(fake)
            terminate(gateway)
            if fake_handle is not None:
                fake_handle.close()
            if gw_handle is not None:
                gw_handle.close()


if __name__ == "__main__":
    test_end_to_end()

# WebBridge（MT5 本地桥）

从原 `trade_dashboard/live_data/ea_bridge` 迁进来的完整源码：**MT5 EA + 本地网关**。
它负责和 MT5 通信，并把行情/账户/持仓/下单能力以 HTTP + WebSocket 暴露给本机程序。

同频不直接依赖它也能跑（可以用 `web/TongpinSync.mq5` 直连云端），但如果你已经在用 WebBridge，
`tools/bridge_push.py` 会读它的接口，把数据和复盘同步到云端。

## 组成

| 文件 | 作用 |
|---|---|
| `WebBridge.mq5` | MT5 EA：socket 连本地网关，推送 tick/bar/账户/持仓/成交，接收下单指令 |
| `gateway.py` | 本地网关：TCP 8788 收 EA 数据，REST 8790 + WebSocket 给本机程序 |
| `PROTOCOL.md` | EA ↔ 网关的 NDJSON v1 协议 |
| `fake_ea.py` | 模拟 EA，没有 MT5 也能联调 |
| `test_gateway.py` | 网关端到端测试 |

## 运行

```bash
pip install -r requirements.txt      # fastapi / uvicorn / pydantic / websockets / httpx
python gateway.py                    # 默认 127.0.0.1:8790，EA 连 127.0.0.1:8788
```

数据默认写当前目录的 `ea_bridge.db`（SQLite）。首次运行前把 `WebBridge.mq5` 编译挂到 MT5 的一个
XAUUSD 图表上，`InpHost=127.0.0.1`、`InpPort=8788`、`InpToken` 与网关配置一致。

## 常用接口

| 接口 | 内容 |
|---|---|
| `GET /api/health` | EA 连接状态、行情缓冲大小、服务器时区偏移 |
| `GET /api/latest` | 最新 tick + 各周期最后一根 bar + 账户 |
| `GET /api/bars?tf=1m&limit=500` | 历史 K 线（`1m/5m/15m/1h`） |
| `GET /api/account`、`/api/positions`、`/api/orders` | 账户与持仓 |
| `POST /api/orders` 等 | 下单/平仓/改单（谨慎使用） |
| `WS /ws` | 实时 tick / bar / 成交推送 |

## 和同频的关系

```
MT5 ──▶ WebBridge EA ──▶ gateway.py:8790 ──▶ tools/bridge_push.py ──▶ 同频云端
                                        └──▶ 本机其它程序（如旧的 trade_dashboard 前端）
```

- **只读同频同步**：`bridge_push.py` 只调用 `GET /api/*`，不写数据库、不下单。
- **也可以绕过它**：把 EA 直接指向同频服务器的 `8788`（`ea_hub`），走 NDJSON 同款协议。

## 注意

- 网关的 REST **没有鉴权**，只应监听 `127.0.0.1`，不要暴露到公网。
- 这个目录需要 pip 依赖；同频主程序（`app_server.py`）仍然是零依赖标准库，二者独立。

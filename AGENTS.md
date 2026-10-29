# AGENTS.md

给接手这个仓库的 AI/开发者看的入口说明。细节在 [docs/架构说明.md](docs/架构说明.md)。

## 一句话

同频（SyncNote）是一个自托管的交易社区：**账号 + 交易看板 + 复盘图表 + 好友作业**。
后端是纯 Python 标准库（无 pip 依赖），前端是 Vite + React + `@luxalgo/vela`（构建产物入库）。

## 先读这几个文件

| 文件 | 作用 |
|---|---|
| `docs/架构说明.md` | 数据流、模块职责、API、数据库、部署 |
| `app_server.py` | 唯一的 HTTP 服务入口（约 500 行，路由全在这个文件里） |
| `ea_hub.py` | MT5 EA 直连的多用户 hub（TCP 8788 / NDJSON v1） |
| `live.py` | 实时行情内存缓存（tick + 4 个周期的最近 K 线） |
| `web/chart-src/src/App.tsx` | 交易台界面（顶栏 / K 线 / 右侧五面板 / 底栏） |
| `tools/bridge_push.py` | 本机 WebBridge → 同频 的同步器（成交 + 实时行情） |
| `bridge/` | WebBridge 全套源码（MT5 EA + 本地 gateway + 协议文档），已从 trade_dashboard 迁入 |

## 常用命令

```bash
python tests/smoke.py                 # 集成测试（临时库，78 项）
python tools/local_demo.py            # 本地演示实例（127.0.0.1:18900，合成数据）
cd web/chart-src && npm ci && npm run build   # 重新构建图表页 → web/chart
```

服务器更新（在 43.103.49.141 上）：`sudo tongpin-pull`（git pull → 重启 → 健康检查，失败自动回滚）。

## 硬性约定（改动前务必遵守）

1. **后端只用 Python 标准库**，不要引入 Flask/FastAPI/requests 等依赖。
   例外：`bridge/` 是独立的本地组件（FastAPI/uvicorn），不要把它 import 进主程序。
2. **Python 用 1 空格缩进**（不是 4 空格），别整体重排。
3. `web/chart` 是**构建产物**，改前端必须改 `web/chart-src/src` 再 `npm run build`，不要手改 `web/chart`。
4. 图表页构建默认走 jsDelivr（`vite.config.ts` 的 `CHART_BASE`）；本地调试用 `CHART_BASE=/chart/ npm run build`，否则会白屏（CDN 上还没有新文件）。
5. 提交前跑 `python tests/smoke.py`；前端改动至少跑一次 `npm run build`（含 `tsc --noEmit`）。
6. 不要在仓库里写连接码、管理员密码、`.env`；服务器上的数据在 `/SyncTrade/data/`。

## 数据源有两种，别混淆

- **复盘数据**：每笔交易的四周期 K 线，来自 `trade_reviews.payload`（EA 上传或 hub 用缓存 K 线生成）。
- **实时行情**：`live.py` 的内存缓存，由 `tools/bridge_push.py` 每 5 秒推 `tick + 4 个周期最近几根`，网页用 `/api/live` 读。

## 当前未完成 / 已知限制

- 域名 `sync-trade.top` 还没有 A 记录，所以**尚未启用 HTTPS**（登录密码目前明文过公网）。
- **下单通道未实现**：`ea_hub` 只收行情/账户，不发单；右栏「交易」面板是只读的。
- 顶栏价格取图表最后一根 K 线的收盘价，不是逐笔实时价。
- 「行情模式」的实时 K 线已接上 `LiveProvider`（3 秒轮询最新一根），但还没在真实浏览器里验证过推送更新。
- 连接码每个用户只有一条，重新生成会让正在同步的 `bridge_push` / EA 断开。

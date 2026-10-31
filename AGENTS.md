# AGENTS.md

给接手这个仓库的 AI/开发者看的入口说明。细节在 [docs/架构说明.md](docs/架构说明.md)。

## 一句话

同频（SyncNote）是一个自托管的交易社区：**账号 + 交易看板 + 复盘图表 + 好友作业 + 邀请制管理后台**。
后端是纯 Python 标准库（无 pip 依赖），前端是 Vite + React + `@luxalgo/vela`（构建产物入库）。

线上：**https://sync-trade.top**（Let's Encrypt，80 强制跳 443）。

## 先读这几个文件

| 文件 | 作用 |
|---|---|
| `docs/架构说明.md` | 数据流、模块职责、API、数据库、部署 |
| `docs/本机EA交易架构设计.md` | 网站 UI 直连本机开源 EA 的目标、配对、权限、故障恢复和验收；首版仅模拟账户交易 |
| `app_server.py` | 唯一的 HTTP 服务入口（路由全在这个文件里） |
| `ea_hub.py` | MT5 EA 直连的多用户 hub（TCP 8788 / NDJSON v1） |
| `live.py` | 实时行情内存缓存（tick + 4 个周期的最近 K 线） |
| `journal.py` | 笔记、复盘读写；`reviewed()` 判断哪些成交真的复盘过 |
| `chart.py` | 画线存档与作业分享 |
| `web/chart-src/src/App.tsx` | 交易台（顶栏 / K 线 / 右侧五面板 / 底部持仓历史） |
| `web/chart-src/src/LocalTradePanel.tsx` | 本机 MT5 连接 + 下单面板 |
| `web/chart-src/src/trade/OrderTicket.tsx` | 市价单票：手数、SL/TP、风险预览、解锁与确认 |
| `web/chart-src/src/BottomDock.tsx` | 底部「持仓 / 挂单 / 历史」 |
| `web/chart-src/src/DrawingFavs.tsx` | 顶部画图收藏栏（镜像 Vela 左侧工具栏的收藏） |
| `web/admin.html` / `web/admin.js` | 管理后台：用户锁定、邀请码生成与导出 |
| `tools/bridge_push.py` | 本机 WebBridge → 同频 的同步器（成交 + 实时行情） |
| `bridge/` | WebBridge 全套源码（MT5 EA + 本地 gateway + 协议） |

## 常用命令

```bash
python tests/smoke.py                 # 集成测试（临时库，107 项）
python tools/local_demo.py            # 本地演示实例（127.0.0.1:18900，密码 syncnote-demo-2026）
cd web/chart-src && npm ci && npm run build   # 重新构建图表页 → web/chart
```

服务器更新（在 43.103.49.141 上）：`sudo syncnote-pull`（git pull → 重启 → 健康检查，失败自动回滚）。

## 硬性约定（改动前务必遵守）

1. **后端只用 Python 标准库**，不要引入 Flask/FastAPI/requests 等依赖。
   例外：`bridge/` 是独立的本地组件（FastAPI/uvicorn），不要把它 import 进主程序。
2. **Python 用 1 空格缩进**（不是 4 空格），别整体重排。
3. `web/chart` 是**构建产物**，改前端必须改 `web/chart-src/src` 再 `npm run build`，不要手改 `web/chart`。
4. 图表页构建默认走 jsDelivr（`vite.config.ts` 的 `CHART_BASE`）；本地调试用 `CHART_BASE=/chart/ npm run build`，否则会白屏（CDN 上还没有新文件）。
5. 提交前跑 `python tests/smoke.py`；前端改动至少跑一次 `npm run build`（含 `tsc --noEmit`）。
6. 不要在仓库里写连接码、管理员密码、`.env`；服务器上的数据在 `/SyncTrade/data/`。
7. 管理接口一律走 `self.require_admin(u, db)`（管理员身份 + 15 分钟 sudo 窗口），非管理员返回 **404**，不暴露页面存在。

## 数据源有两种，别混淆

- **复盘数据**：每笔交易的四周期 K 线，来自 `trade_reviews.payload`（EA 上传或 hub 用缓存 K 线生成）。
- **实时行情**：`live.py` 的内存缓存，由 `tools/bridge_push.py` 每 5 秒推 `tick + 4 个周期最近几根`，网页用 `/api/live` 读；服务端重启后会回 `bootstrap:true`，采集端据此重推 300 根。

## 当前状态 / 已知限制

- 正式地址 `https://sync-trade.top`；EA 的 `InpAllowedOrigin` 用这个，不要用 IP。
- 服务已改名：`syncnote.service`、`syncnote-pull`、`nginx/syncnote.conf`；Cookie 仍是 `tongpin_session`（兼容保留）。
- **云端不提供下单通道**：`ea_hub` 只收行情/账户。本机 EA（`bridge/SyncNoteLocal.mq5`）默认只读、仅模拟对冲账户允许交易，协议 `tongpin-local.v1`。
- **本机 EA 首版只支持市价单**：协议没有挂单创建，网页的「限价 / 止损」按钮是禁用状态。
- 顶栏价格：有实时行情时用 tick 中间价，否则取最后一根 K 线收盘。
- 8788（EA hub）仍是明文 TCP；上 TLS 需要 EA 改用 `SocketTLSHandshake`。
- 服务器 SSH 已关闭密码登录（只认密钥）；ufw 未启用（靠云安全组），fail2ban 未安装。
- 连接码每个用户一条，重新生成会让正在同步的 `bridge_push` / EA 断开。
- 画图收藏存在浏览器 `localStorage`（`sn-chart-favs`），不跨设备。

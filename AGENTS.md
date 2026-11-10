# AGENTS.md

给接手这个仓库的 AI/开发者看的入口说明。细节在 [docs/架构说明.md](docs/架构说明.md)。

## 一句话

同频（SyncNote）是一个自托管的交易社区：**账号 + 交易看板 + 复盘图表 + 好友消息 + 邀请制管理后台**。
后端是纯 Python 标准库（无 pip 依赖），前端是 Vite + React + `@luxalgo/vela`（构建产物入库）。
本机有两款 EA：**SyncNote（笔记版，只读历史）** 与 **SyncTrade（SyncNote Pro，可交易）**。

线上：**https://sync-trade.top**（Let's Encrypt，80 强制跳 443）。

## 先读这几个文件

| 文件 | 作用 |
|---|---|
| `docs/架构说明.md` | 数据流、模块职责、API、数据库、部署 |
| `docs/K线数据与复盘覆盖方案.md` | K 线怎么按 feed 累积、覆盖与缺口怎么记（实施方案，待落地） |
| `docs/本机EA交易架构设计.md` | 网站 UI 直连本机开源 EA 的目标、配对、权限、故障恢复和验收；首版仅模拟账户交易 |
| `app_server.py` | 唯一的 HTTP 服务入口（路由全在这个文件里） |
| `ea_hub.py` | MT5 EA 直连的多用户 hub（TCP 8788 / NDJSON v1） |
| `live.py` | 实时行情内存缓存（tick + 4 个周期的最近 K 线） |
| `journal.py` | 笔记、复盘读写；`reviewed()` 判断哪些成交真的复盘过 |
| `chart.py` | 画线存档与消息（复盘分享） |
| `sync_history.py` | 只读历史入库：原始 deal 保留，交易由服务器重建 |
| `bars.py` | K 线序列：按券商 source 累积、只落已收盘、覆盖/缺口、轨道查询 |
| `tools/import_bars.py` | 把导出的 CSV.gz 灌进 `bars`（幂等，导入后登记 have 覆盖） |
| `local_ea.py` | 把 `bridge/` 打成 SyncNote / SyncTrade 两个源码包 |
| `resources/` | 前后端共用的公开静态资源，必须随后端部署 |
| `web/local-ea.html` | 下载页：两款 EA 的对比、安装、权限与「关网页之后」说明 |
| `web/chart-src/src/App.tsx` | 交易台（顶栏 / K 线 / 右侧五面板 / 底部持仓历史） |
| `web/chart-src/src/LocalTradePanel.tsx` | 本机 MT5 连接 + 下单面板 |
| `web/chart-src/src/trade/OrderTicket.tsx` | 市价单票：手数、SL/TP、风险预览、解锁与确认 |
| `web/chart-src/src/BottomDock.tsx` | 底部「持仓 / 挂单 / 历史」 |
| `web/chart-src/src/DrawingFavs.tsx` | 顶部画图收藏栏（镜像 Vela 左侧工具栏的收藏） |
| `web/chart-src/src/SettingsMenu.tsx` | 顶部「设置」：深/浅主题、显示时区、图表语言 |
| `web/chart-src/src/ChatDock.tsx` | 私信与群聊共用的聊天界面、引用、回应与复盘卡片 |
| `web/chart-src/src/GroupEntry.tsx` / `GroupDetails.tsx` | 聊天内创建 / 加入群，以及资料栏的群管理 |
| `web/chart-src/src/ReviewShareDialog.tsx` | 搜索、多选好友和群聊，附带留言并分享复盘切片 |
| `web/chart-src/src/ui/icons.tsx` | 右栏线框图标；主导航顺序为交易 / 复盘 / 聊天 |
| `web/chart-src/src/TrackStrip.tsx` | 「数据轨道」：一个券商一条轨，当前交易的轨提到最上层 |
| `web/chart-src/src/ui/prefs.ts` | 本机偏好存储（`localStorage.sn-ui.v1`）+ 写 `<html data-theme>` |
| `web/chart-src/src/lib/time.ts` | 显示时区格式化（`stamp()` 用的就是它），不要再写死 `+8` |
| `web/chart-src/src/styles.css` | 设计令牌（`:root` 深色 / `:root[data-theme='light']` 亮色） |
| `web/admin.html` / `web/admin.js` | 管理后台：用户锁定、邀请码生成与导出 |
| `tools/bridge_push.py` | 本机 WebBridge → 同频 的同步器（成交 + 实时行情） |
| `tools/export_market_bars.py` | 把本地行情库导成 CSV.gz（K 线导入包，确定性导出） |
| `bridge/SyncNote.mq5` | 笔记版 EA：只读历史上传，无 DLL、无 socket、无交易函数 |
| `bridge/SyncTrade.mq5` | 交易版 EA：本机 WS 看盘/下单 + 历史导出（由 `SyncNoteLocal.mq5` 派生） |
| `web/chart-src/src/localHistorySync.ts` | 交易版的历史代传：分页、断点、每页确认后才推进 |
| `bridge/` | WebBridge 全套源码（MT5 EA + 本地 gateway + 协议） |

## 常用命令

```bash
python tests/smoke.py                 # 集成测试（临时生成数据）
python tests/run.py                   # 全部 Python/EA 测试，每套独立进程
python tests/test_group_share.py           # 群分享超过 20 位成员的留言与切片回归
python tools/local_demo.py            # 本地演示实例（127.0.0.1:18900，密码 syncnote-demo-2026）
cd web/chart-src && npm ci && npm run build   # 重新构建图表页 → web/chart
```

服务器更新（在 43.103.49.141 上）：`sudo syncnote-pull`（git pull → 重启 → 健康检查，失败自动回滚）。

## 硬性约定（改动前务必遵守）

1. **后端只用 Python 标准库**，不要引入 Flask/FastAPI/requests 等依赖。
   例外：`bridge/` 是独立的本地组件（FastAPI/uvicorn），不要把它 import 进主程序。
2. **Python 用 1 空格缩进**（不是 4 空格），别整体重排。
3. `web/chart` 是**构建产物**，改前端必须改 `web/chart-src/src` 再 `npm run build`，不要手改 `web/chart`。
4. 图表页构建默认同源 `/chart/`（`vite.config.ts` 的 `CHART_BASE`）；显式使用 CDN 时必须固定提交，避免新分块尚未发布导致白屏。
5. 提交前跑 `python tests/smoke.py`；前端改动至少跑一次 `npm run build`（含 `tsc --noEmit`）。
6. 不要在仓库里写连接码、管理员密码、`.env`；服务器上的数据在 `/SyncTrade/data/`。
7. 管理接口一律走 `self.require_admin(u, db)`（管理员身份 + 15 分钟 sudo 窗口），非管理员返回 **404**，不暴露页面存在。
8. **新样式一律用 `styles.css` 里的 CSS 令牌**（`var(--panel)`/`var(--line)`/…），不要写十六进制颜色：
   `:root` 是深色、`:root[data-theme='light']` 是亮色，写死颜色就会在亮色主题下留一块深色补丁。
   图表那边同理：画线存档里的 `rendererConfig`（旧的主题配色）在回放前会被剥掉，别再加回去。
9. 页面里显示时间一律用 `stamp()`（`lib/time.ts`），它按「设置 → 显示时区」格式化；
   图表时间轴靠 `ws.setTimezone()`，两边必须同源，否则复盘定位会对不上。
10. **历史通道只有一条路**：EA 直传走 `/api/mt5/history-sync`，浏览器代传走 `/api/mt5/history-import`，
    两个入口都必须进 `sync_history.ingest`。不要为某个客户端另写一套入库或去重。
11. **SyncNote 必须保持只读**：`local_ea.source_package` 打包时会拒绝 `#import` / `OrderSend` / `CTrade` / `SocketCreate`，
    触发就返回 503。这条校验是产品不变量，不要为了让包能下得动而放宽。

## 时间对齐（改时间相关代码前必看）

库里存的是**券商墙钟**，接口一律返回 **UTC**，换算只有一处：`trade_time.offset_for()`。

- 不要在前端或各接口里自己加减偏移；`bars.to_utc()` 已经统一处理 K 线、缺口和范围。
- 新券商：在 `trade_time.RULES` 登记 `offset_seconds`（有夏令时就给 `zoneinfo` 规则），
  或等 `broker_clocks` 从 EA 心跳学到观测值。
- 复盘快照在 `journal.review()` 里已平移，别重复减。
- 详细约定见 `docs/架构说明.md` §5.1。

## 行情与复盘共用 K 线轨道

- **已收盘 K 线**：统一从 `bars` 读取，按券商轨道 `source`、品种、周期和时间区分。行情读 `/api/market/bars`，复盘按成交或分享授权读 `/api/chart/bars`。
- **复盘快照**：`trade_reviews.payload` 为已有交易提供起始窗口；同一时刻优先显示该轨道的已入库 K 线。图表后台读新数据并按需翻页。
- **盘中更新**：本机 SyncTrade 推送仅合入券商与品种均匹配的视图。旧 `/api/live` 内存缓存缺少可靠轨道身份，保留旧客户端兼容用途。

## 当前状态 / 已知限制

- 正式地址 `https://sync-trade.top`；EA 的 `InpAllowedOrigin` 用这个，不要用 IP。
- 服务已改名：`syncnote.service`、`syncnote-pull`、`nginx/syncnote.conf`；Cookie 仍是 `tongpin_session`（兼容保留）。
- **云端不提供下单通道**：`ea_hub` 只收行情/账户。本机 EA（`bridge/SyncNoteLocal.mq5`）默认只读、仅模拟对冲账户允许交易，协议 `tongpin-local.v1`。
- **本机 EA 首版只支持市价单**：协议没有挂单创建，网页的「限价 / 止损」按钮是禁用状态。
- 上述首版边界指旧 `SyncNoteLocal`。当前 `SyncTrade` 1.106 支持市价与限价/止损挂单，本机配对授权后固定取消账户类型及本地手数/敞口/每日额度门槛，身份字段为 `quota_unrestricted:true`；不授予净额管理权限，日志、券商规则、点差/偏离、配对和未知结果不重试继续保留。`SyncNote` 仍保持只读。详见 `bridge/SyncTrade_README.md`。
- 顶栏价格：有实时行情时用 tick 中间价，否则取最后一根 K 线收盘。
- 8788（EA hub）仍是明文 TCP；上 TLS 需要 EA 改用 `SocketTLSHandshake`。
- 服务器 SSH 已关闭密码登录（只认密钥）；ufw 未启用（靠云安全组），fail2ban 未安装。
- 连接码每个用户一条，重新生成会让正在同步的 `bridge_push` / EA 断开。
- 画图收藏存在浏览器 `localStorage`（`sn-chart-favs`），不跨设备。
- 主题 / 显示时区 / 图表语言存在浏览器 `localStorage`（`sn-ui.v1`），不跨设备、不上云；默认深色 + `Asia/Shanghai`。
- 设置只作用于 `/chart` 交易台；`/history`、`/profile` 等页面还是各自的静态页面。
- 主导航从上到下为「交易、复盘、聊天」；私信、群聊与群管理统一在聊天内，群未读数合并到聊天角标。
- 复盘面板与聊天输入栏共用分享选择窗口，可搜索、多选好友及群聊、附带 500 字留言；聊天入口预选当前会话。
  打开选择窗口时冻结激活格子的可见窗口中点、周期与画线文档，收件人按切片只读回放。
  群分享留言和切片保存在群消息中；为全部现有成员在同一事务中分批生成分享，新成员打开卡片时按权限补建。
- 分享兼容限制：`review_shares` 仍按 `(owner,ticket,recipient)` 唯一，重复分享同一交易会更新共用记录，旧卡片可能打开最新分享切片；尚未迁移为每条消息独立快照。
- **两款 EA 的差别只在"要不要交易"**：SyncNote 只读历史（关浏览器也继续传）；SyncTrade 多了本机 WS，
  历史由浏览器代传（关网页暂停，下次补齐）。旧的单文件采集程序已下线，不再提供下载。
- 历史重建要证据：缺开仓上下文时宁可标记「无法完整重建」，也不猜开仓价；券商改数据后旧派生交易标 `invalidated` 而不删除。

# SyncTrade（SyncNote Pro）本机交易 EA

SyncTrade 从 `SyncNoteLocal.mq5` 独立派生，保留旧 EA 文件。用于 Windows MT5，本机 WebSocket 看盘、模拟账户交易及授权后的成交历史导出。源码可编译不等于真实终端验收；本次开发不会挂载 EA 或发送任何订单。

## 安装与权限

将 `SyncTrade.mq5`、`SyncNoteLocalJson.mqh`、`SyncNoteLocalSocket.mqh`、`SyncNoteHistory.mqh`、`SyncNoteJson.mqh` 放在同一目录，在 MetaEditor 编译 SyncTrade。需要允许系统 DLL 导入：Winsock 用于 `127.0.0.1` 监听，bcrypt 用于随机配对码和令牌；不需要 Python、额外本机服务或自定义 DLL。

默认来源 `https://sync-trade.top`，端点 `ws://127.0.0.1:18765/ws`，子协议 `tongpin-local.v1`。端口与旧 SyncNoteLocal 相同，二者不能同时监听。网页输入图表上的临时配对码后，仍需用户在 MT5 图表点击授权；断开、撤销、重启或账户切换会使令牌失效。令牌只能留在网页内存，不得上传。

`InpAllowTrading=false` 是默认值。真实账户和净额账户硬性只读；仅模拟对冲账户可在本地显式开启交易。交易动作仍受品种、手数、点差、滑点、magic 所有权、MT5 权限和持久日志限制。历史读取不放宽任何交易权限。

日志继续使用原 `TongpinLocal/commands-<账户散列>.journal` 路径，保留升级前的命令去重与未决结果；不要删除日志以重试未知结果。交易没有自动重发或云端转发。

## 历史导出

`hello`、`paired`、`snapshot` 宣布 `product:"SyncTrade"` 和非交易功能 `features:["history"]`。原 `capabilities` 字段继续只表示交易动作。

只有配对后、携带当前 token/account_id/server/epoch 且来自对应连接的 `history` 请求才可读取历史；未配对不暴露账户数据。历史涵盖账户全部品种和 magic，和 `InpSymbol` 的交易范围无关。

请求字段：`type:"history"`、`request_id`、`from`、`to`、`cursor`、`limit`，外加上述授权字段。`from`/`to` 是券商服务器墙钟秒数；单页 `limit` 为 1..100；`from>=1`，单次固定窗口最长 3660 天，建议按 365 天分窗。首次 `cursor:""`，后续原样使用响应游标并保持时间窗不变。响应包含账户绑定、请求标识、`range:{from_server,to_server}`、`deals`、`next_cursor`、`has_more`、`errors`、`time_basis:"broker_server"` 和 `server_offset_sec`、`account_key` 和 `through_server`。错误返回带相同 `request_id` 的 `error`，不推进游标。账户/ticket/position/order 等标识使用字符串。

`server_offset_sec` 只是当前测量偏移，不证明历史夏令时规则。原始服务器时间必须保留，不能将减当前偏移的历史时间声称为已验证 UTC。首次固定 `to` 可用当前 UTC + `paired`/`snapshot` 的偏移；增量拉取须重叠时间窗、按成交 ticket 去重，并在发现券商修正时更新。

历史复盘 K 线使用 `bars` 的可选 `from_server` / `to_server`（必须同时提供）以及 `symbol` / `tf` / `limit`。范围最多 2000 个周期位置、2000 根，支持全部券商品种；响应 `time_basis:"broker_server"`，数组首列保持原服务器秒，不减当前 offset。首次起点会向周期边界取整，以覆盖非整分钟成交。未加载的系列、范围覆盖不足、超限均显式报错，不把缺失数据冒充完整图表。最新 K 线请求保持原有看盘口径和 500 根上限。范围读取与成交分页共用单个回填槽，网页应串行发起，收到 `BARS_BUSY` / `HISTORY_BUSY` 后稍后重试只读查询。

游标不含令牌，绑定原时间窗及最后处理的时间/ticket；网站若保存恢复点，还必须绑定 `account_key`。`through_server` 是已完整扫描到的服务器秒；同秒尚未扫完时不会越过该秒。分页不是券商快照隔离，新增或被券商修订的旧时间成交需要后续重叠补传和按 ticket 更新；禁止把非秘密游标当登录授权。

此 EA 不含云端 HTTP/WebRequest，不自动上传。朋友开启网站的同步选项后，由浏览器异步发送历史；关闭网页后该同步停止。账户切换后必须重新配对，不沿用旧账户上传绑定。

## 性能与验证边界

WebSocket 先处理请求；历史和 K 线批处理协调运行，慢客户端暂停历史输出，交易请求不进入历史队列。历史扫描按每次事件的条目数和耗时预算推进，但 MT5 的 `HistorySelect`/首次历史下载是同步调用，首次全量加载仍可能阻塞 EA 事件线程。不能据此宣称历史导出期间交易永不延迟；应先在 MT5 历史页预加载、分时间窗导出，并在没有交易操作时做首次归档。同步 `OrderSend` 本身也可能阻塞事件处理。

MetaEditor 离线编译只能验证语法和构建。仍需人工在模拟账户检查真实浏览器配对、分页无重漏、账户切换与撤销、慢客户端、未知成交类型和部分平仓，以及所有交易门禁。未经实际验收，不标记实盘可用。

2026-11-01 开发机实际调用 `C:/Program Files/MetaTrader 5/MetaEditor64.exe` 离线编译通过，0 errors / 0 warnings。此记录不覆盖真实 MT5 挂载、浏览器连接或模拟成交验收。

# Tongpin Local WebSocket Protocol v1

状态：首版本机 EA 与网页的实现协议；**离线编译通过不等于真实 MT5 交易验收通过**。首版交易仅限模拟对冲账户，实盘与净额账户在 EA 内硬性只读。

本协议与 `PROTOCOL.md` 中的 EA→Python gateway NDJSON v1 是两个独立协议。它不改变旧 WebBridge、云端 Hub 或其端口。

## 1. 连接与边界

- URL 固定为 `ws://127.0.0.1:18765/ws`；子协议必须是 `tongpin-local.v1`。
- EA 仅绑定 IPv4 回环地址；同一电脑只运行一个该 EA 端点，只允许一个升级成功的活动连接。
- WebSocket 请求的 `Origin` 必须精确等于 EA 参数 `InpAllowedOrigin`，默认 `https://sync-trade.top`；`Host` 必须是 `127.0.0.1:18765`。来源校验不能代替本机配对。
- 支持 RFC 6455 文本消息、掩码客户端帧、分片文本、ping/pong/close、部分读写；不支持二进制消息与扩展压缩。不合法帧断开。
- 客户端完整消息最多 32 KiB；输出队列最多 512 KiB，慢客户端超限断开。握手限 5 秒，90 秒无客户端流量断开。网页每 3 秒发应用层 ping。
- 新 Chrome/Edge 的公网 HTTPS→回环 WebSocket 可能要求本地网络访问许可。此许可与 EA 配对独立；网页缓存不会绕过它。版本兼容需真机验证，不要求用户关闭浏览器安全功能。

## 2. 编码约定

文本帧为 UTF-8 JSON。客户端请求限定为**扁平对象、唯一字段名、原始类型值**，禁止嵌套、数组、重复字段、NaN/Infinity、未知命令字段。响应可以嵌套对象与数组。

所有 `account_id`、`account.login`、ticket、order、deal 均为十进制**字符串**，避免 JavaScript 数值精度丢失。`command_id` 是 8–64 位 ASCII 字母/数字/`-`/`_`，推荐 UUID。`epoch`、令牌与实例 ID 为随机字符串。

`server_time_ms`、`expires_at_ms` 为 UTC Unix 毫秒；tick.time、bar_time 和 K 线数组时间为 UTC 秒。EA 将券商墙钟减当前观测的服务器 UTC 偏移；跨夏令时切换的历史偏移仍需单独校准，不能视为完整历史时区数据库。

## 3. 初始握手与本机批准

服务端握手后仅发公共元数据，不泄露账户或服务器：

```json
{"type":"hello","protocol":"tongpin-local","version":1,"ea_version":"0.100","instance_id":"<random>","pairing_required":true}
```

EA 图表显示由 Windows CSPRNG 生成的 8 位配对码，有效期 120 秒、最多 5 次尝试；到期生成新码。客户端：

```json
{"type":"pair","code":"<8 digits shown locally>"}
```

正确后响应 `{"type":"pair_pending","message":"..."}`。**仍未授权访问账户**。用户必须在 MT5 EA 图表上核对网站来源、账户，点击「允许本次连接」。待确认最长 60 秒且不超过配对码有效期。

确认后：

```json
{
  "type":"paired","token":"<64 hex chars; RAM only>",
  "instance_id":"<random>","account_id":"<login>","server":"<broker server>","epoch":"<random>",
  "symbol":"XAUUSD","demo":true,"read_only":true,"trade_enabled":false,"capabilities":[]
}
```

令牌绑定当前连接、EA 实例及账号/服务器/epoch，仅存在 EA 与当前网页内存。禁止进入 URL、日志、云端或持久浏览器存储。断线、EA 重启、账户变化、图表点击「撤销授权」都会撤销授权，必须重新配对。不支持自动恢复交易会话。

配对后立即发送完整 snapshot。`demo` 是 MT5 账户模式事实；`trade_enabled` 还要求模拟**对冲**账户、本地 `InpAllowTrading=true`、日志健康、账户稳定。对应动作仍须 MT5 算法交易权限。`capabilities` 根据 EA 本地动作开关列出可用动作；网页缺字段时保守禁用交易。

## 4. 所有已授权请求

除 pair 外，每条请求都带以下字段；下文 `...auth` 表示将这些字段平铺到顶层，不是嵌套对象：

```json
{"token":"<RAM token>","account_id":"<login>","server":"<broker server>","epoch":"<current epoch>"}
```

- `{"type":"ping",...auth}` → `{"type":"pong","server_time_ms":0}`；可选 `request_id` 原样返回。
- `{"type":"snapshot",...auth}` → 当前账户/持仓/挂单/tick 快照。
- `{"type":"subscribe",...auth}` 等价 snapshot；配对后本来就推送实时数据，不需重复订阅。
- `{"type":"disconnect",...auth}` 主动撤销本机授权并关闭连接。

### 快照与实时更新

```json
{
  "type":"snapshot","instance_id":"<id>","account_id":"<login>","server":"<server>","epoch":"<epoch>",
  "demo":true,"read_only":true,"trade_enabled":false,"capabilities":[],
  "account":{"login":"<login>","server":"<server>","balance":0,"equity":0,"margin":0,"free_margin":0,"profit":0,"currency":"USD"},
  "positions":[{"ticket":"123","symbol":"XAUUSD","side":"buy","volume":0.01,"price_open":0,"sl":0,"tp":0,"profit":0,"magic":26055423}],
  "orders":[{"ticket":"456","symbol":"XAUUSD","type":"buy_limit","volume":0.01,"price":0,"sl":0,"tp":0,"magic":26055423}],
  "tick":{"symbol":"XAUUSD","bid":0,"ask":0,"time":0,"time_msc":0},"bars":{},"server_time_ms":0
}
```

positions/orders 是替换快照（各最多 500 条）；可能列出当前账户其他品种，但交易只允许 EA 配置品种。所有数据仅发送已配对的本机网页。

推送：`{"type":"tick","tick":{...}}` 最多每 100 毫秒一条；snapshot 每秒或交易变化后刷新；当前四周期 K 线每秒发送 `{"type":"bar","symbol":"XAUUSD","tf":"1m","bar_time":0,"open":0,"high":0,"low":0,"close":0,"volume":0}`。这些是限频展示更新，不是无损 tick 存档。

### 历史 K 线

```json
{"type":"bars","request_id":"<id>","symbol":"XAUUSD","tf":"1m","limit":300,"token":"<token>","account_id":"<login>","server":"<server>","epoch":"<epoch>"}
```

tf 仅 `1m/5m/15m/1h`，limit 1–500。网页**串行请求**四个周期，收到上一周期响应或错误后再请求下一周期。EA 内部每次定时器拼装最多 50 根，最终一条完整响应：

```json
{"type":"bars","request_id":"<id>","symbol":"XAUUSD","tf":"1m","bars":[[0,0,0,0,0,0]],"instance_id":"<id>","account_id":"<login>","server":"<server>","epoch":"<epoch>","demo":true,"read_only":true,"trade_enabled":false,"capabilities":[]}
```

数组为 `[UTC秒,open,high,low,close,tick_volume]`，按时间升序。EA 只读取已同步的 MT5 历史；未同步时返回 `HISTORY_UNAVAILABLE`，用户先在 MT5 打开对应周期加载数据，不在网络处理过程中等待大规模下载。

## 5. 交易命令

所有交易命令平铺 auth，带 `command_id` 与 `expires_at_ms`。建议当前服务端校准时间加 10 秒；EA 拒绝过期或超过未来 30 秒的期限。相同操作重试不得生成新 ID；网页禁止自动重发、补发、重连后执行或离线排队。

| action | 额外字段 | 限制 |
|---|---|---|
| market | symbol、side=`buy/sell`、volume、sl、tp、deviation | 仅配置品种；手数须满足 MT5 网格、本地单笔上限、总敞口上限 |
| close | position_ticket（字符串）、volume | 0 表示全平，但全平数量也不能超过本地单笔上限；受本地 magic 与动作开关限制 |
| cancel | order_ticket（字符串） | 仅配置品种的现存挂单，受本地 magic 与动作开关限制 |
| modify | ticket（持仓字符串）、sl、tp | 仅修改持仓 SL/TP；两个值须显式给出，0 表示清除；首版不修改挂单保护位 |

symbol/side/volume/sl/tp/deviation/position_ticket/order_ticket/ticket 之外禁止注入任意执行参数。EA 自行指定 magic、注释、填单方式。挂单创建不在本首版能力内。

```json
{"type":"command","command_id":"<uuid>","action":"market","symbol":"XAUUSD","side":"buy","volume":0.01,"sl":0,"tp":0,"deviation":20,"expires_at_ms":0,"token":"<token>","account_id":"<login>","server":"<server>","epoch":"<epoch>"}
```

EA 最终检查本地开关、模拟对冲模式、MT5 权限、身份、期限、500ms 命令间隔、品种/持仓归属、最大手数与敞口、spread、slippage、价格网格及止损距离。默认只管理 `InpMagic` 的仓位/挂单；用户可在 EA 参数显式扩大范围。

## 6. 幂等、日志和结果未知

EA 在终端 `MQL5/Files/TongpinLocal/commands-<account hash>.journal` 按账户保存 ID、请求指纹、intent 与 outcome。日志不保存会话 token、配对码或密码；最多 10,000 个不同 ID，容量满后拒绝新交易，不自动删除去重记录。文件按终端独占写入；同一账号多个独立终端不共享去重域。

提交前先记录 intent 并 FileFlush，随后只调用**一次** OrderSend。不做填单方式降级重试。同步 OrderSend 在返回前仍会占用 EA 线程，这是首版已知限制。FileFlush 不是对突然断电/磁盘故障的端到端 exactly-once 保证。

相同 ID、相同规范化交易参数返回既有结果；不同参数返回 COMMAND_ID_CONFLICT。有效解析但被风险拒绝的命令在日志健康时也保存 rejected；报文语法或结构错误属于协议拒绝，不产生交易 intent。日志失败一律禁交易。

```json
{"type":"command_result","command_id":"<uuid>","state":"completed","ok":true,"retcode":10009,"order":"456","deal":"789","price":0,"volume":0.01,"partial":false,"error":"","server_time_ms":0,"instance_id":"<id>","account_id":"<login>","server":"<server>","epoch":"<epoch>","demo":true,"read_only":false,"trade_enabled":true,"capabilities":["market","close","cancel","modify"]}
```

- rejected：本地拒绝或券商明确拒绝；不是成交。
- submitted：券商返回 10008 等接收状态；不是成交。
- completed：明确操作完成；`partial=true` 表示已知部分完成；操作完成不一律等于开仓成交（例如撤单/修改）。
- uncertain：超时、连接问题或从 intent/submitted 崩溃恢复；可能已经执行，禁止自动重发。
- not_found：查询不到本地 intent；同样不触发自动重发。

查询 `{"type":"command_status","command_id":"<uuid>",...auth}` 返回 command_result。可对已知的精确 broker order/deal 核对历史后更新终态；查不到继续保留原不确定状态，禁止用模糊注释或“没有持仓”推断未执行。缓存结果重新包装当前 epoch 与当前 server_time_ms。

`trade` 推送仅用于刷新快照和成交通知，不能仅凭一个交易事件推断整笔命令已全部完成。EA 不会执行任何历史 intent 自动重放。

## 7. 错误与账户变化

错误格式 `{"type":"error","code":"AUTH_REQUIRED","error":"...","request_id":"<optional>"}`。配对错误如 PAIR_CODE/PAIR_LOCKED/PAIR_EXPIRED；数据错误如 BARS_BUSY/HISTORY_UNAVAILABLE；它们不授予任何交易权限。

EA 重启或账号/服务器变化生成新 epoch，撤销旧授权。网页应关闭交易入口并重新配对；旧身份结果不得覆盖新账户状态。首版不支持手机远程连接电脑、云端转发下单或多端自动接管。

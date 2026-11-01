# SyncNote / SyncTrade 共享历史协议 v1

协议名 `syncnote-history.v1`。SyncNote 直接 HTTPS 上传；SyncTrade 通过已配对网页转传用户明确授权的历史。两条路径共享原始 deal 定义与云端重建规则，不共享交易授权，也不会通过本协议接收任何交易指令。

## 1. 历史上传

`POST https://<用户明确配置的网站>/api/mt5/history-sync`，SyncNote 使用 `Authorization: Bearer <采集连接码>`。浏览器代理采用站点为它提供的已认证上传方式，不应把本机 WebSocket token 当作采集码。

```json
{
  "schema":"syncnote-history.v1",
  "account":"<MT5 login string>",
  "server":"<exact broker server name>",
  "account_key":"<sha256 UTF-8(server + newline + account)>",
  "currency":"USD",
  "batch_id":"<stable hash for this exact pending page>",
  "time_basis":"broker_server",
  "server_offset_sec":10800,
  "clock":{"server":1793491200,"utc":1793480400},
  "range":{"from_server":1761955200,"to_server":1793491200},
  "deals":[],
  "checkpoint":{"through_server":1761955199,"last_deal_ticket":"0","window_complete":false,"next_cursor":"<opaque cursor>"}
}
```

示例中的尖括号为占位说明；真实 account_key 是 64 位小写 hex。`range` 是本次固定扫描范围，时间包含两端秒。服务器允许每批最多 200 条，当前 EA 共享页最多 100 条。

账户/服务器标识用于同一网站账户的源绑定，不是 MT5 凭据。禁止本协议携带余额、净值、实时持仓、密码、本机配对码、WebSocket token、下单命令或任意执行脚本。

`server_offset_sec` 为当前观察到的券商服务器墙钟减 UTC；`time_basis` 固定 `broker_server`。所有原始 deal 保留券商时间，云端派生 UTC 需要保留“估算/上下文不完整”状态，不得把当前偏移当作跨 DST 的完整历史时区。

## 2. 原始 deal

```json
{
  "deal_ticket":"123456789012345678",
  "order_ticket":"123456789012345670",
  "position_id":"123456789012345660",
  "time_msc_server":1793491200123,
  "time_server":1793491200,
  "type":0,
  "entry":0,
  "symbol":"XAUUSD",
  "volume":0.01,
  "price":2700.1,
  "profit":0,
  "commission":-0.1,
  "swap":0,
  "fee":0,
  "magic":"0",
  "reason":0,
  "comment":"manual or other EA comment",
  "external_id":""
}
```

deal/order/position/magic 使用十进制字符串，避免 JavaScript 整数精度丢失；order/position 可以为 `"0"`，例如部分资金记录。type、entry、reason 保留 MT5 枚举整数；全部交易来源与品种均导出，不按当前 EA magic 过滤。不筛掉 INOUT、独立手续费、资金变动或其他非买卖 deal。

数值必须有限，错误不替换成零。time_msc_server 是权威时间精度；time_server 是冗余的服务器秒。稳定原始记录键为 `(网站用户,account_key,deal_ticket)`。重复记录 upsert；同 ticket 的费用等字段修正应更新，并触发对应 position 重建。

closed_trades / summary_status 由云端基于原始 deal 派生。客户端可不提供。云端不能把单个反向 deal 一概看作完全平仓：须处理加仓、部分平仓、反转、费用分摊和缺失开仓上下文。无法重建时保留原始记录并给出明确原因。

## 3. ACK 与重试

成功 ACK 至少为：

```json
{"ok":true,"account_key":"<exact key>","batch_id":"<exact batch id>","accepted":100,"changed":100,"closed_trades_updated":12,"summary_warnings":0,"issues":[],"checkpoint":{},"review_job":null}
```

只有 HTTP 200＋三个精确条件 `ok=true`、account_key 相同、batch_id 相同才推进游标。响应字段名重复、JSON 不合法、错账户/错批次都不能推进。只收到 HTTP 200 不足以确认。

SyncNote 在同次待确认页面期间缓存完整 request body，因此 HTTP 重试的 batch_id、clock 与内容保持不变。重启从已确认 checkpoint 重建页面时，当前 clock 可能变化，会产生新的 batch_id；原始记录稳定键保证不会因此生成重复笔记。

网络失败指数退避，最大 300 秒；鉴权或账户绑定拒绝暂停。客户端 checkpoint 只有在服务端 ACK 后持久推进。服务端 ACK 已发出而本机 checkpoint 未成功落盘时，下次重试必须幂等。

`checkpoint.window_complete=true` 表示固定 range 已完整扫描，through_server 必须等于 to_server；false 表示仍有后续页/时间片。next_cursor 必须作为不透明值使用，不可由网页改造后继续；范围变化需重开一个扫描任务。

## 4. 共享只读分页 ABI

`SyncNoteHistory.mqh` 只包含纯 MQL 历史读取；包含的 `SyncNoteJson.mqh` 也不依赖网络、DLL或交易执行。调用者负责身份、同步授权、上传、ACK 与持久 checkpoint。

```cpp
CSyncNoteHistory history;
bool Begin(long from_server, long to_server, string cursor="", int limit=50);
void Pump(int budget=16);
bool Busy();
bool Ready();
bool Failed();
string Error();
string DealsJson();
string NextCursor();
bool HasMore();
long ThroughServer();
long FromServer();
long ToServer();
void Reset();
```

Begin 只校验范围并创建状态，不调用 HistorySelect；from>=1，to<=2100-01-01，范围不超过 3660 天，limit 1–100。to 必须固定，不能每页换成“现在”。

Pump 分阶段：最多一次 HistorySelect；立即复制这个时间片的最多 1024 个 ticket 与毫秒时间；随后跨事件分预算排序、按 ticket 读取及序列化。其他处理逻辑可以在两轮之间调用 HistoryDealSelect/HistoryOrderSelect，因为分页器不跨事件依赖 MT5 的可变选中列表索引。

时间片初始最多一天。空时间片可以跨 Pump 跳过；密度过大在后续 Pump 二分缩小，单秒超过 1024 条返回 DENSITY_LIMIT，绝不跳过。单条消失、时间戳变化、非有限数或账户变化都返回明确错误，调用者以原游标重试或暂停。

排序键是 `(time_msc_server,deal_ticket 数值)`。游标当前编码：

```
snh1|range_from|range_to|slice_from|slice_to|after_time_msc|after_deal_ticket
```

调用者应整体保存，编码是实现细节。它绑定范围与当前片边界，不是可自由平移的数组偏移。初始或周期增量通过时间重叠重扫，补到插入在已越过位置的晚到记录；每日全量配置范围对账补更早修正。券商删除/不再提供的历史无法凭空恢复，不宣称完全镜像券商历史。

预算约束的是自有循环。HistorySelect、HistoryDealSelect、CopyRates 等 MT5 API 仍可能等待终端/券商内部工作，不能把本模块描述为严格无阻塞。SyncTrade 必须先服务本机交易，再在剩余预算中 Pump；全量历史补录适合明确的空闲同步阶段。

## 5. 复盘任务

历史 ACK 可附带：

```json
{"review_job":{"ticket":"deal:<account prefix>:<deal ticket>","symbol":"XAUUSD","opened_server":1793487600,"closed_server":1793491200,"account":"<login>","server":"<server>","source_account_key":"<key>"}}
```

复盘 ticket 是网站不透明标识，最多 120 字符且不能有控制字符；不能把它转为 MT5 ticket。SyncNote 对 job 中如有的账户/服务器/key 作精确绑定检查。根据已确定窗口读取 M1/M5/M15/H1 的前后 30 根，单周期最多 2000 根，再向 `/api/mt5/review` POST：

```json
{"ticket":"deal:<account prefix>:<deal ticket>","account_key":"<key>","account":"<login>","server":"<server>","opened_server":1793487600,"closed_server":1793491200,"charts":{"M1":[],"M5":[],"M15":[],"H1":[]},"errors":{"M1":"","M5":"","M15":"","H1":""}}
```

K 线每根 `[服务器秒,open,high,low,close]`；未换算 UTC。服务端结合保存的交易时间口径处理。range_too_long、symbol_unavailable、history_unavailable 等逐周期返回，不伪造图表。三次历史未就绪尝试后上报明确错误；HTTP 上传失败不回滚历史 ACK，云端保留 pending job 下次继续。

## 6. 两产品的适用边界

- SyncNote：一个无 DLL 的只读采集 EA；MT5 运行即可持续 HTTPS 上传，网页可以关闭。同步请求阻塞它自己的采集线程。
- SyncTrade（SyncNote Pro）：一个本机交易 EA＋已配对网页；网页打开且用户启用历史同步时才异步转传云端，关闭后暂停，下次按固定游标补传。云同步不是交易命令通道。
- 需要交易页面关闭仍后台同步时，可另挂 SyncNote 到另一图表，获得独立 EA 线程；两者仍共享 MT5 的进程与资源，需限流。严格单 EA、低延迟与网页关闭持续云同步三者同时要求时，需要额外设计真正非阻塞的云网络状态机，不能直接拼接同步 WebRequest。

两个 EA 使用共享源码并不表示把交易权限编译进 SyncNote。SyncNote 的依赖树应持续不含本机 socket/DLL/交易执行模块。

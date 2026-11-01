# K 线数据与复盘覆盖方案

复盘图、分享、行情页的 K 线怎么存、打哪来、谁的图用谁的数据。本文是**实施方案**，不是现状描述；
现状见 [架构说明.md](架构说明.md) 的 §4.2（复盘）与 §4.5（历史通道）。

状态：**草案，待实施**（2026-11-01）。

---

## 1. 要解决的问题

现在一笔复盘的四周期 K 线是一整块 JSON，存在 `trade_reviews.payload`：

- 每笔交易自己存一份，**相邻两笔交易重叠的 K 线重复存储**；
- 用户往两边拖动，超出那笔交易窗口（约 ±30 根）就没了；
- 打开别人的分享，只能用他自己传的那一小段；
- 有人提议“把别人的窗口拼到全站基准上”——**不行**，理由见 §3。

目标：

1. 同一个账户的 K 线**随复盘次数自然累积**成一条越来越长的序列，重复的部分不再重复请求、不再重复存；
2. 打开别人的分享时，**整屏只用分享者那套行情**，不拼接、不补偿；
3. 没覆盖到的地方**明确留白**，不拿别的来源冒充；
4. 新增成本可控：老数据不动、老接口不破、EA 第一版不用改。

---

## 2. 设计原则

| 原则 | 含义 |
|---|---|
| **一屏一源** | 同一块画布里，K 线只能来自一个 `feed`。切换是整屏切换，不是逐根替换。 |
| **只落已收盘** | `t + tf <= now` 的 bar 才入库；正在形成的那根不入库、不算覆盖。 |
| **幂等写入** | 主键 `(feed, symbol, tf, t)` upsert，EA 重发、断点续传、重复请求都不产生副作用。 |
| **覆盖显式记录** | 每个 `(feed, symbol, tf)` 维护合并后的已扫区间；只请求缺口。 |
| **失败可重试** | “扫过但 EA 说没数据”和“扫过失败了”是两种状态，后者必须能再试。 |
| **feed 不外泄** | 客户端只说“看哪笔交易/哪条分享”，由服务端解析出 feed；不允许按任意 feed 拉数据。 |

---

## 3. 为什么不能拼接（决策记录）

曾经考虑过“全局基准 + 把分享者画线附近的几根覆盖上去”。否决，原因：

1. **接缝变多且都在关键位置**。一条趋势线 = 一个时间段，替换它覆盖的 K 线会在两端各留一个价差台阶；台阶正好落在用户正在研究的那几根蜡烛旁边。
2. **会改变分析结果，不只是画面**。价格轴、均线、SMC 结构都由同一串 bar 计算。拼接后接缝处的“新高/新低”可能凭空产生，结构标记变成伪信号。
3. **画线锚定在分享者自己的价格上**。同一时间段的低点，在两个券商之间差 20–50 美分是常态；换一套 K 线后，那条线就贴不住了。
4. **定义不清**。“与画线相关的 K 线”无法定义：按价格区间？按时间区间？两个 feeds 的价格区间并不对应。

结论：**可以换，不可以拼。** 整屏切换是唯一自洽的做法。

---

## 4. 概念

### 4.1 feed 与 source（行情来源）

K 线不是某个人的，是**某个券商服务器**的。所以拆成两层：

```
source = 券商服务器           同一服务器 → 同一份行情，可跨账户复用
feed   = account_key = sha256(server + "\n" + account)
         → 指向一个 source
```

| 关系 | 结果 |
|---|---|
| C、F 都在「券商 1」 | C 抓过的 K 线，F 打开自己的复盘可以直接用（同一 `source`） |
| 同一用户在两个券商 | 两个 `source`，互不共享 |
| `Broker-Live` / `Broker-Live2` / `Broker-Demo` | **按不同 source 处理**：实盘/模拟、不同集群的行情可能不同，宁可各存一份 |
| 同名品种不同写法（`XAUUSD` / `XAUUSD.raw` / `GOLD`） | 按 `(source, symbol)` 分开存，需要时人工加别名表 |

`source` 有一个“临时态”，等 EA 上报 `server` 再迁移：

| 阶段 | `source` 形态 | 何时迁移 |
|---|---|---|
| 只知道账户 | `acct:<account_key>` | EA 的 `hello` 上报 `server` 后，合并进 `srv:<server>` |
| 知道券商服务器 | `srv:<server>` | 稳定 |
| 导入的历史包 | 导入时指定（见 §14） | 同上 |

合并只改 `feeds.source` 的指向，`bars` 不必搬（查询时 join）；真要搬也是按主键 upsert 后删旧行。

从哪来：

- 历史通道派生出来的交易，payload 里已有 `source_account_key`（以及 `server`/`account`，有就是已知服务器）；
- 快照通道（`/api/snapshot`）的交易没有，视为 `feed = null`，这类交易**不走本方案**，继续用 `trade_reviews.payload`。

### 4.2 覆盖（coverage）

按 `(source, symbol, tf)` 记录已扫过的时间区间，区间先合并再存；**失败是账户级的**，见下表：

| 状态 | 记录在 | 含义 | 会重试吗 |
|---|---|---|---|
| `have` | `bar_coverage`（source 级） | 请求过，拿到了 K 线 | 不会，同 source 其他账户也不用再抓 |
| `empty` | `bar_coverage`（source 级） | 券商明确没数据（周末、休市、品种未上市） | 不会 |
| `failed` | `bar_attempt`（账户级） | 这次请求失败（终端没本地历史、超时、离线） | **会**：另一个账户或稍后重试，成功即转 `have` |

“没有记录”= 没扫过，下次要用就去请求。

**同券商复用**：`have`/`empty` 是 source 级的并集，C 抓过 F 就不用抓；
bar 值理论上完全一致，若出现差异（两边在不同时刻缓存了同一根 bar），以**后写入**为准并记一次
discrepancy 计数，便于发现“未收盘就入库”这类问题。


---

## 5. 数据模型

```sql
-- 账户 → 行情来源。合并券商时只改这里，不动 bars。
CREATE TABLE IF NOT EXISTS feeds(
  account_key TEXT PRIMARY KEY,      -- sha256(server + "\n" + account)
  source      TEXT NOT NULL,         -- srv:<server> 或临时的 acct:<account_key>
  server      TEXT NOT NULL DEFAULT '',
  account     TEXT NOT NULL DEFAULT '',
  updated     REAL NOT NULL
);

-- 已收盘的 K 线；按 source 存，同券商的不同账户共用同一份
CREATE TABLE IF NOT EXISTS bars(
  source TEXT NOT NULL,        -- 见 feeds.source
  symbol TEXT NOT NULL,
  tf TEXT NOT NULL,            -- M1 / M5 / M15 / H1（与 EA 上传口径一致）
  t INTEGER NOT NULL,          -- 服务器时间秒（bar 开盘）
  o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
  v REAL NOT NULL DEFAULT 0,   -- tick volume
  updated REAL NOT NULL,       -- 入库时间
  PRIMARY KEY(source, symbol, tf, t)
);
CREATE INDEX IF NOT EXISTS idx_bars_range ON bars(source, symbol, tf, t);

-- 已扫区间（合并后），state ∈ have | empty；source 级，跨账户共享
CREATE TABLE IF NOT EXISTS bar_coverage(
  source TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL,
  from_t INTEGER NOT NULL, to_t INTEGER NOT NULL,   -- 闭区间，按周期对齐
  state TEXT NOT NULL,
  updated REAL NOT NULL,
  PRIMARY KEY(source, symbol, tf, from_t)
);

-- 失败重试是账户级的：别人的终端没本地历史，不该拦住你
CREATE TABLE IF NOT EXISTS bar_attempt(
  account_key TEXT NOT NULL, source TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL,
  from_t INTEGER NOT NULL, to_t INTEGER NOT NULL,
  state TEXT NOT NULL,        -- failed | ok
  attempts INTEGER NOT NULL DEFAULT 1,
  updated REAL NOT NULL,
  PRIMARY KEY(account_key, source, symbol, tf, from_t)
);
```

**与既有表的关系**

| 表 | 继续承担什么 |
|---|---|
| `trade_reviews.payload` | 这笔交易**当时**的四周期快照（分享切片的兜底）。不改、不删。 |
| `mt5_history_coverage` | **成交**覆盖，和 K 线覆盖是两回事，不要混用。 |
| `bars` | 新的、可累积的 K 线序列（按 source 共享）。 |

时间口径：`t` 一律是**券商服务器墙钟秒**（与 EA 的 `bar_time` 一致），显示时再按 `server_offset_sec` 转 UTC。
原因：历史成交、复盘窗口、EA 上传都是这个口径，换算只做一次，避免来回转换累积误差。

---

## 6. 数据流

### 6.1 打开复盘（自己的或分享的）

```
前端 /chart?ticket=…  或  ?share=<id>
        │  GET /api/chart/entry  → 入口带 feed（由交易派生，不暴露给前端使用）
        ▼
ReviewProvider 有数据吗？ ── 否 ──→ 前端请求缺口
        │ 是                              │
        ▼                                 ▼
   直接渲染              GET /api/chart/bars?share=…&tf=M1&from=…&to=…
                                          │ 服务端解析 feed + 授权
                                          ▼
                                已知覆盖够吗？ ── 够 ──→ 直接返回 bars
                                          │ 不够
                                          ▼
                            返回 bars + missing:[[from,to],…]
                                          │
              ┌───────────────────────────┴─────────────────────┐
              ▼                                                 ▼
   SyncTrade：浏览器走本机 WS 向 EA 要 bars          SyncNote：EA 自己在下次 tick 领任务
   拿到后 POST /api/mt5/bars-import                 服务端在 ACK 里给 bars_job
              │                                                 │
              └──────────────→ POST /api/mt5/bars（落库 + 写覆盖）←┘
                                          │
                                          ▼
                            再次 GET /api/chart/bars 拿到完整段
```

### 6.2 渲染规则

| 情况 | 表现 |
|---|---|
| 可见范围完全落在 `have` 区间内 | 正常画 K 线 |
| 可见范围有缺口 | 缺口处留白 + 一行提示「分享者只同步到这里」/「这段还没同步」 |
| 整段都没有 | 空白 + 一个「同步这段」按钮（自己）或「分享者还没上传这段」（别人） |
| 分享 | 一律用**分享者的 feed**；收件人的行情不参与这块画布 |

**不做**：任何跨 feed 的逐根替换、价格补偿、接缝平滑。

---

## 7. 接口

### 7.1 新增：`POST /api/mt5/bars`（EA → 服务器）

Bearer 连接码（SyncNote / SyncTrade 通用），或 `website_user_id` 会话（SyncTrade 浏览器代传走 `bars-import`）。

```jsonc
{
  "schema": "syncnote-bars.v1",
  "account": "90012345",
  "server": "Broker-Demo",
  "account_key": "<sha256>",
  "symbol": "XAUUSD",
  "server_offset_sec": 10800,
  "series": {
    "M1": {
      "range": { "from_server": 1700000000, "to_server": 1700086400 },
      "bars": [[1700000000, 2400.1, 2400.4, 2399.8, 2400.2, 12], …],
      "complete": true,          // EA 认为这段已经扫完
      "error": null              // 或 "history_unavailable"
    },
    "M15": { … }
  }
}
```

服务端处理：

1. 校验 `account_key`、时间范围、`bars` 条数（单次单周期 ≤ 2000 根）、单调递增、OHLC 合法；
2. 丢弃 `t + period <= now` 不成立的 bar（未收盘）；
3. upsert 进 `bars`；把 `range` 记为 `have`（`complete && !error`），`error` 记为 `failed`，`bars` 为空且无错误记为 `empty`；
4. 返回每个周期的覆盖摘要 + 下一个建议抓取区间（供 EA 继续）。

### 7.2 新增：`GET /api/chart/bars`

```
GET /api/chart/bars?share=12&tf=M1&from=<server_sec>&to=<server_sec>
GET /api/chart/bars?person=<uid>&ticket=108245&tf=M15&from=…&to=…
```

- 授权规则与 `/api/chart/entry` 完全一致（自己 / 好友可见 / 收到分享）；
- 返回：`{bars:[[t,o,h,l,c,v],…], covered:[[from,to],…], missing:[[from,to],…], feed_label:"Broker-Demo · 90012345"}`；
- `feed_label` 只给显示用（“数据：分享者的行情”），不回 `account_key` 原文以外的任何凭据。

### 7.3 新增：`GET /api/chart/tracks`

给前端「数据轨道」用：一个券商服务器一条轨，返回每条轨在给定窗口内的覆盖段与覆盖率，
当前这笔交易所属的轨标 `active: true` 并排在第一位（前端据此提到最上层）。

`
GET /api/chart/tracks?share=12&from=<server_sec>&to=<server_sec>
GET /api/chart/tracks?person=<uid>&ticket=108245&from=…&to=…
`

授权与 `/api/chart/entry` 相同；不传 `from/to` 由前端按“锚点前 3 天、后 1 天”给出。

### 7.4 扩展：`/api/mt5/review` 的 ACK

在现有 ACK 里追加 `bars_job`（与 `review_job` 同构，一次一个）：

```jsonc
{ "ok": true, "review_job": {…}, "bars_job": { "symbol":"XAUUSD", "tf":"M15", "from_server":…, "to_server":… } }
```

SyncNote 在下次 tick 领这个任务；SyncTrade 忽略它（它的 bars 由浏览器按需拉）。

---

## 8. EA 侧需要什么

| EA | 第一版（P0） | 后续（P2） |
|---|---|---|
| SyncNote | 不改 | 领 `bars_job`，`CopyRates` 取区间，`POST /api/mt5/bars` |
| SyncTrade | 不改（`bars` 请求已有 `from_server/to_server`） | 支持 `before/after` 更大的窗口；前端按缺口自动请求 |

P0 阶段 K 线从哪来：**继续用 `/api/mt5/review` 现有上传**。服务端解析 `charts` 里的四个周期，
按 `M1/M5/M15/H1` 映射成 `bars` 入库并写 `have`。这样第一版零 EA 改动，历史数据也能被回收利用。

### EA 能取到“券商的数据”吗

能，但边界是「终端缓存 + 券商保留深度」，不是无限历史：

- EA 用 `CopyRates(symbol, tf, from, to)` 要数据；终端没有时会向券商服务器请求，
  可能阻塞、也可能先返回部分（`Bars`/`SeriesInfoInteger` 可以判断到底拿到了多少）；
- 券商保留多久因券商而异（M1 通常 1–2 年，H1 更长），超出范围就是 0 根；
- 终端的「图表最多 K 线数」也会限制一次能读多少；
- 拿不到就回 `history_unavailable`，我们记 `failed`，**不冒充完整**。

所以“同券商复用”的收益不止省流量：两个账户能拉到的区间不一定相同（一个补前段、一个补后段），
合并后比任何单个账户都完整。而像 §14 那种 7 年 1 分钟深度，**任何单个 EA 都拉不下来**，
它是长期本地缓存累积出来的——这也是为什么这份历史包值得先导进去。

---

## 9. 覆盖算法

```
请求区间 [a, b]（按周期对齐：a = floor(a/tf)*tf）
已有 = merge(have ∪ empty)
缺口 = [a,b] \ 已有
丢弃长度 < MIN_GAP_BARS*tf 的碎片（MIN_GAP_BARS = 30），避免来回请求
单次请求上限 MAX_BARS = 2000 根，超出按片切分，近期优先
```

合并规则：`[s1,e1]` 与 `[s2,e2]` 相交或相邻（`s2 <= e1 + tf`）即合并。写入时整段重算该 `(feed,symbol,tf)` 的区间表，保持不重叠。

---

## 10. 容量与保留

单笔复盘（4 周期 × 3 天）：

| 周期 | 根数/3 天 | 体积 |
|---|---|---|
| M1 | ~4,300 | |
| M5 | ~860 | |
| M15 | ~290 | |
| H1 | ~72 | |
| 合计 | ~5,500 根 | **≈ 250 KB**（去重前） |

- 1000 笔复盘 ≈ 250 MB（去重后通常更少）；
- 保留策略：`M1` 180 天、`M5` 2 年、`M15` 2 年、`H1` 永久；
- 清理走一个每日任务（与现有 `syncnote` 生命周期一致），或登录时的低优先级 sidetask；
- SQLite 单库到 GB 级仍可用，超过再考虑按月分库。

---

## 11. 失败与边界

| 场景 | 处理 |
|---|---|
| EA 离线 | `failed`？不——没请求到就不写覆盖；前端显示“分析数据未就绪”，不重试风暴（退避 30s） |
| `history_unavailable` | 记 `failed`，下次复盘或点「补齐缺口」重试 |
| 券商修正历史 | 已入库的 bar 允许被后到的同主键数据覆盖（upsert），不需要额外机制 |
| 换账户 / 换券商 | 新 feed，旧数据保留；`account_key` 不同就不共享 |
| DST / 时间偏移 | bar 的 `t` 用**服务器墙钟**，与成交同源；显示层统一转换。不做“跨偏移对齐” |
| 快照通道的交易（无 feed） | 回落到 `trade_reviews.payload`，行为与今天一致 |
| 分享者没上传过任何 bars | 收件人看到空图 + “分享者还没同步这段”，**不用自己的行情顶替** |

---

## 12. 分期

| 期 | 内容 | EA 改动 | 风险 |
|---|---|---|---|
| **P0** | `bars` + `bar_coverage` 建表；从现有 `/api/mt5/review` 的 `charts` 回收入库；`GET /api/chart/bars`；复盘页按该 feed 渲染 + 缺口留白提示 | 无 | 低，向后兼容 |
| 现状（2026-11-02） | P0 后端已落地：`bars`/`bar_coverage`/`bar_attempt`/`feeds` 建表、`bars.bind_feed`、`GET /api/chart/bars`、`GET /api/chart/tracks`、复盘上传回填；7 年 XAUUSD 已导入（333 万根）。前端轨道条与图表都已接：打开复盘时按锚点抓 M1 2±0.5 天 / M5 10±2 天 / M15 30±7 天 / H1 120±30 天，与交易快照按时间戳合并。 |
| **P1** | `POST /api/mt5/bars` + `bars-import`；前端按缺口请求（SyncTrade 走本机 WS） | 无 | 中，需处理并发/去重 |
| **P2** | SyncNote 领 `bars_job`，按时间跨度抓取；窗口从 ±30 根放大到“前 2 天/后 1 天” | 有 | 中，`CopyRates` 可用性要兜底 |
| **P3** | 「补齐缺口」按钮 + 覆盖百分比提示 + 新用户首次 90 天引导 | 无 | 低 |
| **P4** | 行情页（无具体交易）用一份“参考行情 feed”，标注来源 | 无 | 低 |

P0 单独上线也安全：不读 `bars` 时一切照旧（回落到 payload）。

---

## 13. 验收标准

P0 完成后应满足：

1. 同一账户连开三笔相邻交易的复盘，`bars` 里不出现重复行，覆盖区间逐步合并变长；
2. 老用户升级后打开历史复盘：图与升级前**完全一致**（回落 payload 路径未被破坏）；
3. 打开别人的分享：K 线来自分享者；若他只有窗口，拖出去是留白 + 提示，**没有**任何一根来自收件人的行情；
4. 未收盘的那根 bar 不在 `bars` 里；隔一分钟再看，它变成已收盘才入库；
5. 重发同一批 bars 两次，`bars` 行数不变，`updated` 更新；
6. `failed` 区间能在下一次请求时被重新请求（可从日志验证）；
7. 分享切片里的画线，在分享者自己的 bars 上位置不变（像素级回归：同一笔交易前后截图对比）。

P2 完成后追加：

8. 覆盖区间达到“前 2 天/后 1 天”且明显减少留白；
9. `history_unavailable` 时能自动退回小窗口，复盘图仍然出得来。

---

## 14. 已就绪的数据资产（2026-11-01）

本机 `D:\Projects\trade_dashboard\backend\data\market.db` 的 `klines` 表里有多年 XAUUSD 历史，
是 MT5 历次下载累积下来的。已导出并**上传到服务器**：

```
/SyncTrade/data/import/xauusd/         属主 tongpin:tongpin，目录 750 / 文件 640
  ├── MANIFEST.json                     每个文件的行数、区间、sha256
  ├── README.md                         这份数据的来源与约定
  ├── xauusd_1m.csv.gz   2,518,649 行   32.1 MB
  ├── xauusd_5m.csv.gz     504,141 行    7.1 MB
  ├── xauusd_15m.csv.gz    168,213 行    2.6 MB
  ├── xauusd_30m.csv.gz     84,162 行    1.4 MB
  ├── xauusd_1h.csv.gz      42,111 行    0.7 MB
  ├── xauusd_4h.csv.gz      11,139 行    0.2 MB
  └── xauusd_1d.csv.gz       1,874 行    0.04 MB
```

- 覆盖：**2019-08-21 → 2026-10-27**（服务器墙钟），合计约 333 万根，44 MB；
- 时间基：`t` 是**券商服务器墙钟秒**，与本文 §5 的约定一致，导入不需要换算；
- 导出脚本：`tools/export_market_bars.py`（纯标准库，只读源库），可随时重跑；
  导出是**确定性**的（gzip 头 `mtime=0`），同一份源库重跑得到的 sha256 与 `MANIFEST.json` 完全一致；
- 校验：上传后已用 `sha256sum` 与 `MANIFEST.json` 逐文件比对，7/7 一致。

**已导入（2026-11-02）**：3,330,289 根全部进了生产库的 ars，source = srv:EasyTradingOnlineLtd-Server，
eeds 里对应账户 510715；导入时停了约 1 分钟服务，DB 从 0.6 MB 涨到 531 MB（40 GB 盘，占用 8%）。
旧 mt5_links.account_key（WebBridge: 那个占位哈希）已清空，等 EA 第一次上传时按真实 ACCOUNT_SERVER 重绑。

**归属**：已确认这批就是**当前生产账户**的行情。生产库 `mt5_links.account_key` 即该账户的
`sha256(server + "\n" + account)`，导入时按它建 `feeds` 行：

| 阶段 | `source` | 说明 |
|---|---|---|
| 导入时 | `acct:<account_key>` | 只知道账户，先绑在这里；7 年数据立刻可用 |
| EA 上报 `server` 后 | `srv:<server>` | 建新 source 并把 `feeds.source` 指过去，`bars` 不用搬 |
| 同券商其他用户接入 | 同一个 `srv:<server>` | 自动共享这 7 年（见 §4.1、§4.2） |

`account_key` 只在服务器侧的 `feeds` 表里出现，不进仓库、不下发给前端。

## 15. 未决问题

1. `bars` 的 `t` 用服务器墙钟（本文选型）还是入库时就转 UTC？——若选 UTC，成交与 K 线需要各自维护换算，好处是查询更直观。
2. 4 个周期各自独立抓，还是抓 M1 再在服务端聚合？——独立抓与 EA 现有能力一致，但 `M5` 由 5 根 `M1` 聚合会更省；聚合要处理券商空档，风险更高。
3. 覆盖表的 `failed` 是否要指数退避的计数（避免反复打 EA）？
4. 分享给“未关注的人”（未来功能）时，`/api/chart/bars` 的授权要跟着改。

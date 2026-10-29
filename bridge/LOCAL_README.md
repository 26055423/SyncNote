# 本机 EA：自行编译与接入

这是 `TongpinLocal.mq5` 的源码安装说明。它与旧 `WebBridge.mq5 + gateway.py` 相互独立，**不需要启动 Python、本地助手或安装自定义 DLL**。

当前状态：Windows 本机 MetaEditor 离线编译通过；尚未进行真实终端挂载、网页↔EA 配对及模拟下单验收。不要把源码可编译理解为交易链路已实测。首版在 EA 内禁止实盘和净额账户交易；默认所有账户只读。

## 文件

保持以下文件在同一目录，自行查看与编译：

```
TongpinLocal.mq5
TongpinLocalJson.mqh
TongpinLocalSocket.mqh
LOCAL_PROTOCOL.md
LOCAL_README.md
```

网页源码包只包含源码和说明，不提供预编译 EX5，不含凭据。编译结果与日志只留在你自己电脑，不需要上传到网站。

## 安装与首次连接

1. 在 Windows MT5 点击「文件→打开数据文件夹」，把整个目录放到 `MQL5/Experts/TongpinLocal/`。
2. 用该 MT5 自带的 MetaEditor 打开 `TongpinLocal.mq5`，F7 编译，确认零错误。包含文件使用相对路径，无第三方 include。
3. 在 MT5 给配置的品种打开一个独立图表，挂载一个 EA。默认品种 `XAUUSD`；券商带后缀时把 `InpSymbol` 改成精确名称。
4. EA 的「依赖/通用」设置中允许 DLL 导入。只调用 Windows 自带的 `Ws2_32.dll`（本机网络服务）和 `bcrypt.dll`（密码学安全随机数）。这些调用仍有本机程序权限，源码公开不等于可省略审阅。
5. 保持 `InpAllowTrading=false`，先以只读模式验收。EA 仅监听 `127.0.0.1:18765`，无需路由器端口映射，不要改为公网监听；同机只能挂一个实例。
6. 打开 `https://sync-trade.top` 登录你的网站账号，在「本机 MT5」面板点击连接。按浏览器需要授予该站点本机网络访问许可。
7. 输入 EA 图表显示的 8 位配对码；回到 MT5 核对网站来源、账号，再点击图表上的「允许本次连接」。此操作仅授予当前网页会话。
8. 检查账户、品种、bid/ask、持仓和四周期 K 线。历史未准备好时，先在 MT5 打开相应周期加载；网页历史请求按周期串行。

EA 不要求在网站输入 MT5 密码，不调用密码读取接口，不把交易密码发送到网页或云端；网站用户名/密码与 MT5 登录无关。配对前只公开协议、版本和随机实例 ID，不返回账户信息。

## 模拟交易开关

完成只读验收后，在**模拟对冲账户**下把 EA 参数 `InpAllowTrading` 设为 true，并按 MT5 的要求开启 Algo Trading 与 EA 算法交易权限。更改参数会重新初始化 EA，原网页必须重新配对。

EA 的本地约束最终生效：

| 参数 | 默认值与作用 |
|---|---|
| InpAllowedOrigin | `https://sync-trade.top`，单一精确 HTTPS 来源，无路径或通配符 |
| InpSymbol | `XAUUSD`，只允许这个券商品种交易 |
| InpAllowTrading | false；本地显式开启仍只允许模拟对冲账户 |
| InpMaxOrderLots | 0.10；开仓及平仓数量都受此上限限制，大仓需显式分次操作 |
| InpMaxSymbolLots | 1.00；新开仓与该品种已有持仓/挂单的毛敞口总和上限 |
| InpMaxDeviationPoints | 20；券商 points，不是通用 pip |
| InpMaxSpreadPoints | 100；新市场单点差上限，0 表示关闭此额外约束 |
| InpMagic | 26055423；EA 新建订单的 magic |
| InpManageOwnMagicOnly | true；仅允许管理自身 magic 的仓位/挂单 |
| InpAllowClose/Cancel/Modify | true；各动作仍受所有其他本地权限限制 |

支持受控市场单、平仓、撤单、修改持仓 SL/TP。首版不创建挂单，不修改挂单保护位，不支持其他品种、不允许网页执行任意代码，也不开放实盘或净额账户交易。

EA 可以展示账户中其他仓位，但显示出来并不表示有管理权限。把 `InpManageOwnMagicOnly` 改为 false 是用户在本机主动扩大权限的行为。净额账户会混合其他策略/手工仓位，首版仍禁止交易。

## 断线、撤销与结果未知

关闭网页、网络断开、账户切换、EA 重启都会撤销会话令牌。重新连接需要新配对码和 MT5 本地点击确认；不在浏览器持久保存授权、不自动重连下单。可随时在图表点击「撤销授权」。

网页的下单超时不代表失败。遇到 uncertain/submitted，先在 MT5 检查订单与成交历史，或查询原 command_id，切勿直接换一个 ID 再发一次。EA 不自动重发任何交易，也不重放崩溃前的 intent。

去重日志位于终端数据文件夹的 `MQL5/Files/TongpinLocal/commands-<account hash>.journal`。不要在交易结果未核清前删除、编辑或截断该日志；删除会丢失去重依据。不同电脑/不同终端不共享日志。日志损坏、写入失败或达到 10,000 个不同命令的上限时，禁止新交易，需人工审查归档与恢复。

## 验证记录与性能边界

本仓库开发环境使用 `C:\Program Files\MetaTrader 5\MetaEditor64.exe` 编译，当前源码应为零错误、零警告。版本差异仍需用户用自己的 MetaEditor 复查。

尚未验证：EA 实际监听与浏览器 WebSocket 握手、真实配对、账户切换、券商历史时间、模拟交易完整生命周期、端到端延迟、故障注入恢复。所有交易必须先在模拟环境验收；网页可打开或编译通过都不是这些项目的替代证明。

网络每约 15ms 定时处理，但 Windows/MT5 实际调度不保证 1ms；行情展示最多约 10Hz，账户快照约 1Hz。同步 OrderSend、首次已缓存历史读取、日志 FileFlush 仍可能占用 EA 线程。应测量点击→EA 接收、提交→券商回报、端到端 p50/p95/p99，不承诺未经测试的延迟数字。

## 云端与缓存

默认账户/实时行情/交易回报只从本机 EA 发给已配对网页，EA 不连接云端。网页可单独授权将复盘/交易分享上传网站；这属于另一个数据权限，不能由本机配对隐式开启。

Service Worker/PWA 可缓存 UI，但不会让浏览器永久运行，也不能绕过本机访问权限。网页关闭时本机连接停止；经纪商端已经设置成功的止损/止盈由券商执行，不应依赖浏览器后台定时器维持。

完整消息格式见 [LOCAL_PROTOCOL.md](LOCAL_PROTOCOL.md)。

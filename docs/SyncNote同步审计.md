# SyncNote 同步审计（2026-11-06）

交付版本：SyncNote **1.011**；共享历史模块修复同时进入 SyncTrade **1.106**。两款 EA 均使用已安装 MetaEditor 离线编译，结果为 0 errors、0 warnings。编译文件按版本放入用户指定终端的 Experts 子目录，未换载当前图表 EA。网站继续提供对应版本源码包，由服务器根据已部署源码生成。

下载发布需实际读取 `/downloads/syncnote.zip` 与 `/downloads/synctrade.zip`，核对入口版本、全部相对 include、`SOURCE_MANIFEST.json` 哈希及部署提交；健康检查通过不代替下载包检查。

## 已修复

| 问题 | 修复和验证 |
|---|---|
| 新连接先发 K 线请求，尚未绑定账户就被 403 暂停 | 到期成交同步优先，收到本次历史 ACK 后才启动行情；实际 `OnTimer` 函数运行回归 |
| 恢复五年旧回溯，M1 长期占用队列 | 近 7 天、每段最多 2000 根、四周期轮询；不读取旧 v1 行情状态 |
| 空/部分 CopyRates 结果跳过缺口并宣称完成 | 只确认服务端实际接受的行；缺失前缀、内部和尾部保留待补，空窗冷却复查 |
| 标记 done 后不再同步新增 K 线 | 增量独立调度，周末和旧空窗不阻断最新数据 |
| 不同站点或品种复用同一进度 | v2 状态由站点/采集码作用域、账户、券商、品种隔离，并校验 checksum |
| 只看 HTTP 200 就推进 K 线游标 | 校验 ok、周期、请求范围、实际接受数、dropped、complete、state；回包带身份字段时逐项核对 |
| 历史时间属性读取失败被当作旧记录跳过 | 使用 bool getter 并检查选中时间范围，失败保留同一游标 |
| HistorySelect 期间换账户，空结果可能确认窗口 | 查询返回后重新检查绑定；共享修复覆盖两款 EA |
| 只读守卫漏过 CTrade 声明，系统 include 依赖漏包 | SyncNote 拒绝系统 include 和 CTrade 标识符，本地引号 include 递归收集并核对 manifest |
| 直接复盘快照未带成交量 | 上传 tick_volume，与行情轨道的六列 K 线一致 |

## 验证

- `python tests/test_syncnote_bars.py`：9 项，执行实际行情调度核心和 ACK 校验。
- `python tests/test_syncnote_timer.py`：6 项，执行实际主文件 `OnTimer`。
- `python tests/test_ea_history.py`：8 项，执行实际共享历史分页器；两个新增异常场景修前失败、修后通过。
- `python tests/test_local_ea.py`：8 项，实际源码包依赖、hash 与只读守卫。
- `python tests/test_synctrade_commands.py`：15 项，命令与持久日志行为回归；测试夹具适配现有不限额契约，产品交易逻辑未改。
- `python tests/smoke.py`：404 项，隔离合成数据；含 SyncNote Bearer 直传、保守覆盖和身份 ACK。

真实终端挂载、WebRequest 白名单、连接码配对、券商缓存完整性及断线重启仍需运行时验证；本次未把离线编译记作这些项目已验收。SyncNote 保持无 DLL、无 socket、无交易执行函数，SyncTrade 的交易权限与额度行为沿用 1.105。

# 双 EA 修复验收记录

日期：2026-11-02。SyncNote 1.001 / SyncTrade 1.101。

## 修复结果

1. **成交历史能提供重建证据。** 两款 EA 的共享分页模块通过 `HistorySelectByPosition` 查询真实起点，输出起点 ticket、服务器毫秒时间和可用状态。查询结果每页缓存，每次 Pump 最多新增一个持仓查询，最多扫描 1024 条；失败或超限明确标记，不放宽服务器校验。查询改变 MT5 历史选择列表后，仍按之前捕获的 ticket 逐条序列化。账户变化中止该页。
2. **RETURN 部分成交保持未决。** `10010` 在 RETURN 模式下为 submitted，继续跟踪精确券商订单终态；IOC 的剩余数量取消后可作为终止的部分成交。交易命令不自动重发，持久去重日志继续保留。
3. **过期指令在提交前被拦截。** Windows 系统 API 提供真实毫秒 UTC，同时使用接收时的单调计时预算。持久意图写入后、唯一 OrderSend 前再次验证期限，防止日志阻塞或时钟回拨延长指令寿命。到期记录拒绝且不下单。
4. **SyncTrade 会核对较早历史更正。** 网页每 30 秒回查最近一天，每次完整全量核对结束后约 24 小时重扫 365 天。未完成窗口保持固定范围与游标，首批失败后的刷新也恢复原计划；仅最终精确 ACK 后更新全量成功时间，兼容旧 v1 断点。

## 升级

用新源码包自行编译，或使用同目录内的新 EX5 替换旧 EA，按原产品重新挂载。SyncNote 保持无 DLL、无 socket、无交易函数；SyncTrade 仍需允许系统 DLL，包括 Winsock、bcrypt 和提供精确 UTC 的 Kernel32（Windows 8 / Server 2012 及以上）。

SyncNote 1.001 使用新的历史证据断点作用域，首次升级自动重扫配置历史范围，补齐旧版本已上传但没有摘要的成交；不删除旧文件。SyncTrade 的旧浏览器断点先完成当前未完成范围，再补一次完整核对。全量耗时与券商历史密度有关。

不要删除 `TongpinLocal/commands-*.journal` 来重试旧订单。旧版本已经标为 completed 的部分成交结果，不能仅靠升级推断当时的成交策略，应在 MT5 核对实际券商订单。

## 验证方法

- 真实 MetaEditor 离线编译两款 EA：检查新的编译日志和 EX5。
- `python tests/test_ea_history.py`：将当前共享 MQL 源码作最小语言兼容适配后用 C++ 执行，MT5 API 使用合成内存数据；实际 JSON 再进入服务器 `sync_history.ingest`。覆盖开平仓摘要、多持仓及选择列表变化、缓存/查询限额、缺失/超限上下文、范围外起点、大 ticket、同秒分页和账号切换。
- `python tests/test_ea_trade.py`：C++ 直接编译生产安全规则 helper，执行部分成交分类、期限边界、日志延迟、时钟跳变和原生 Windows UTC 检查。不调用 MT5 下单。
- `python tests/test_local_ea.py`：源码包依赖白名单、清单摘要和目录边界。
- `python tests/smoke.py`：网站集成测试，临时生成数据库，不读生产账户。
- `cd web/chart-src; npm run test:local; npm run build`：浏览器协议和周期全量状态机回归、TypeScript 检查及构建。

原生 MQL 行为兼容测试需要开发环境 C++ 编译器；这不是 Python 网站后端的运行依赖。Windows 本次使用 MSVC，MQL 最终以 MetaEditor 编译结果为准。

本次实测结果：SyncNote 与 SyncTrade 均 0 errors / 0 warnings；历史运行回归 6 项、交易安全运行回归 1 项（含 28 个行为断言）和源码打包 3 项全部通过；网站集成 171 项、前端协议/状态机 31 项全部通过，TypeScript 检查和 Vite 构建通过。

## 验收边界

本次完成源码修复、离线行为回归、网站集成回归和编译。未挂载用户终端、未配对浏览器、未发送模拟或真实订单、未部署服务器。真实券商历史可用性、终端 DLL 调用、浏览器连接和模拟订单完整生命周期仍需在终端验证。HistorySelect/HistorySelectByPosition/CopyRates 与 OrderSend 的内部阻塞不属于严格实时保证。

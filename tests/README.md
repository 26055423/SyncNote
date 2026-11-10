# 测试入口

从仓库根目录运行 `python3 tests/run.py`，它依次执行 `test_*.py` 与 `smoke.py`。每套测试使用独立进程，避免集成测试的临时数据库和 `app_server` 模块状态互相影响。

单独执行：`python3 tests/test_group_share.py`。筛选执行：`python3 tests/run.py 'test_*share.py' 'test_journal_templates.py'`。

`smoke.py` 是完整 HTTP 集成检查；`test_*.py` 包括后端、HTTP、EA 源码及 C++ 模拟测试；`cpp/` 是合成的 MT5 边界与编译夹具。EA 模拟测试不能替代真实 MetaEditor 编译和 MT5 验收。

前端测试在 `web/chart-src/tests/`，运行 `npm run test:local`；构建运行 `npm run build`，包含 TypeScript 检查。

`test_architecture.py` 覆盖 import 无副作用、原 version=2 升级、失败回滚、连接关闭、hub 反复启停、旧历史隔离、独立分享与 WAL 备份恢复。直接导入 app_server 的夹具必须调用 `initialize_database()`。前端 `featureHooks.test.mjs` 验证卸载取消、旧账户响应丢弃和看板无重叠轮询。

`python3 tools/capacity_probe.py` 只使用自动清理的合成临时库，不是线上压测。

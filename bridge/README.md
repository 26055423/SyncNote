# 本机组件与 EA 源码

当前产品入口为 `SyncNote.mq5`（只读同步）和 `SyncTrade.mq5`（本机交易）。各自引用的 `.mqh` 与入口放在同一目录，`local_ea.py` 递归收集引用并生成两款公开下载包；SyncNote 的只读校验必须保留。

`SyncNoteLocal.mq5` 与 `LOCAL_README.md` 保留旧本机 EA 的兼容说明。`WebBridge.mq5`、`gateway.py`、`requirements.txt`、`ui/` 和 `fake_ea.py` 属于独立 WebBridge 组件，主服务器不导入 gateway，也不安装其 Python 依赖。

WebBridge 的运行命令、接口和协议说明见 [WEBBRIDGE_README.md](WEBBRIDGE_README.md)。

调整 MQL 文件位置时，必须同时检查相对 `#include`、下载包和测试。服务器镜像复制 MQL 源码与公开文档，通过实际生成两个源码包检查依赖完整性。

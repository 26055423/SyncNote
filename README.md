# 同频 · 交易圈

独立部署、独立账户、独立数据。用于小范围交流交易、查看 MT5 同步记录和整理复盘笔记。

**这是独立开发协作版，不是现用共库网站的数据库备份。** 不包含已有账户、密码、交易记录、会话、密钥、数据库文件及其他网站。

## 包含的功能

- 独立账号登录、管理员邀请注册、个人资料、预设头像与隐私开关。
- 关注交易伙伴、交易看板、交易记录与日历统计、留言和声音提醒。
- 个人交易笔记、分类与四周期图表复盘，行情由自己的 MT5 采集程序上传。
- 复盘图表页 `/chart`：Vela 多窗格 K 线（1 分钟到 1 天），点「复盘」直接落到那笔交易的开仓时间；可在图上画线、标注文字，画线自动保存。
- 复盘作业：把做好的图表复盘发给已关注的交易伙伴，对方看到与你完全一致的图表、画线和标注，只读不可改。
- 管理员验证器二次验证、设备信任、会话撤销与密码修改。

源码版提供 MQ5 采集源码；**不附带 EXE、DMG、EX5 或绑定凭据**。网页使用手动采集安装流程。

## 快速开始

需要 Docker Engine 和 Docker Compose v2。操作都在你自己的服务器上完成：

```sh
git clone https://github.com/ninghui8473-svg/tongpin.git
cd tongpin
cp .env.example .env
docker compose up -d --build
docker compose exec tongpin python bootstrap_admin.py
```

最后一步会交互要求设置管理员密码，没有预设密码，不会从其他服务导入账户。默认管理员用户名为 `admin`，首次初始化前可在自己的 `.env` 中修改 `ADMIN_USERNAME`。

默认只监听服务器自身 `127.0.0.1:18886`。在服务器上访问 `http://localhost:18886/login`；远程浏览器请先配置自己的 HTTPS 反向代理。首次启动自动创建本实例的 SQLite 空库，保存在独立命名卷中；账号与记录仅写入这个卷。

不使用 Docker 时：安装 Python 3.12，先运行 `python bootstrap_admin.py`，然后运行 `python app_server.py`。只使用 Python 标准库，无 pip 运行依赖。默认数据目录为当前项目的 `data/`，已被 Git 忽略。

图表页的构建产物 `web/chart/` 已随仓库提供，直接用 Python 运行即可。改了 `web/chart-src/` 之后需要重新构建（Node 20+）：

```sh
cd web/chart-src
npm ci
npm run build
```

## 发布到自己的域名

在服务器本地 `.env` 中设置 `PUBLIC_ORIGIN=https://自己的域名`、`COOKIE_SECURE=1`，配置好 HTTPS 后运行 `docker compose up -d`。反向代理示例在 [deploy/Caddyfile.example](deploy/Caddyfile.example)，请替换示例域名，并自行安装、配置 Caddy 与 DNS。

默认不信任客户端自行传入的 IP 头。需要真实客户端 IP 限流时，应由自己的入口覆盖相关头，并仅配置精确可信代理地址；不要直接信任整个私有网段或互联网传入的转发头。现有部署示例采用保守的对端地址回退。

## 数据在哪里

程序首次启动创建新数据库。GitHub 中只保存程序里的建表逻辑，不保存数据库文件。Docker 命名卷 `tongpin-data` 只属于本部署，不需要外部 PostgreSQL、统一登录或其他网站。

你的服务器需要自行备份命名卷。升级时不要删除数据卷，不要执行 `docker compose down -v`，除非你明确要永久删除本实例的数据。

## 朋友如何参与修改

你被邀请到私有仓库并接受邀请后即可拉取。推荐每次改动创建一个分支：

```sh
git switch -c feature/my-change
# 修改并测试
python tests/smoke.py
git add <本次修改的文件>
git commit -m "说明本次修改"
git push -u origin feature/my-change
```

然后在 GitHub 发起 Pull Request，由仓库所有者审核合并。合并源码不会自动部署到任何网站；自己的服务器升级由部署者手动执行。详见 [协作说明](docs/协作说明.md)。

## 验证与边界

`python tests/smoke.py` 使用系统临时目录、随机生成密码和新测试账户，验证独立启动、静态资源、登录/退出、两字符注册、邀请、管理员权限、个人资料与跨账户笔记保护。测试结束删除临时数据，不连接其他实例。

本次整理已完成47项接口检查。当前环境未完成 Docker 镜像实际构建、真实 MT5 采集、原生助手编译、目标服务器部署及 HTTPS 实播验收。朋友应在自己的测试服务器验收后再开放访问。

页面资源来自现用同频页面；后端以原独立版本为基础适配独立账号和 SQLite，保留交易与复盘功能，不携带共享身份服务、平台数据库适配器或其他模块。它与现用共库后端是不同部署形态，不应覆盖现有共库服务目录。

## 源码结构

| 路径 | 内容 |
|---|---|
| `web/` | 网页、样式、图标和 MT5 采集源码 |
| `web/chart-src/` | 复盘图表页源码（Vite + React + `@luxalgo/vela`） |
| `web/chart/` | 图表页构建产物，由 `app_server.py` 在 `/chart` 提供 |
| `app_server.py` | 独立 API 与网站服务 |
| `chart.py` | 图表画线存档与复盘作业分享 |
| `auth_security.py`、`challenge_image.py` | 本实例认证与图形验证 |
| `journal.py`、`trade_time.py`、`market.py` | 复盘与时间处理；公共参考行情工具默认不调度 |
| `bootstrap_admin.py` | 交互初始化本实例管理员 |
| `compose.yaml`、`Dockerfile` | 独立容器部署（图表页在构建阶段用 Node 编译，运行时镜像内无 Node） |
| `tests/` | 使用全新临时数据的集成测试 |

[交接范围与数据排除](docs/交接范围.md) · [部署说明](docs/部署说明.md)

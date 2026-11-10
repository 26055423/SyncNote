# 共享资源

`publicChapterPresets.json` 是复盘条目预设的唯一来源：后端 `journal_templates.py` 在运行时读取，前端 `ReviewNotebook.tsx` 在构建时导入。修改后需重建 `web/chart`。

此目录必须随服务器代码部署；后端运行不需要 `web/chart-src` 或 Node。只放可公开、纳入版本管理的静态资源，不放用户数据或凭据。

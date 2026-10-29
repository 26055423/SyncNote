#!/usr/bin/env bash
# 从 GitHub 拉取 SyncNote 更新（公开仓库，HTTPS 无需密钥），有变化才重启，失败回滚。
# 用法：sudo tongpin-pull
set -euo pipefail

GIT="git -C /SyncTrade -c core.hooksPath=/dev/null"
before=$(sudo -u admin $GIT rev-parse --short HEAD)
echo "当前版本：$before"

sudo -u admin $GIT pull --ff-only
after=$(sudo -u admin $GIT rev-parse --short HEAD)

if [ "$before" = "$after" ]; then
  echo "已是最新，无需重启"
  exit 0
fi

systemctl restart tongpin
sleep 3
if curl -fsS -m 5 http://127.0.0.1/api/health >/dev/null; then
  echo "已更新：$before -> $after，服务正常"
else
  echo "健康检查失败，回滚到 $before" >&2
  sudo -u admin $GIT reset --hard "$before"
  systemctl restart tongpin
  exit 1
fi

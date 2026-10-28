#!/usr/bin/env bash
# 同频一键更新：解包 → 换目录 → 保留数据 → 重启 → 健康检查，失败自动回滚。
# 用法：sudo tongpin-deploy /tmp/tongpin-deploy.tar.gz
set -euo pipefail

TGZ="${1:-}"
if [ -z "$TGZ" ] || [ ! -f "$TGZ" ]; then
  echo "用法: sudo tongpin-deploy <tar.gz>" >&2
  exit 2
fi

STAGE=$(mktemp -d /tmp/tongpin-stage.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT

tar xzf "$TGZ" -C "$STAGE"
if [ ! -f "$STAGE/app_server.py" ] || [ ! -f "$STAGE/web/chart/index.html" ]; then
  echo "包里缺少 app_server.py 或 web/chart/index.html，拒绝更新" >&2
  exit 2
fi

systemctl stop tongpin

rm -rf /SyncTrade.new
mkdir -p /SyncTrade.new
cp -a "$STAGE"/. /SyncTrade.new/
chown -R admin:admin /SyncTrade.new
chmod -R a+rX /SyncTrade.new

# 数据目录跟着旧部署走，不随代码包覆盖
mkdir -p /SyncTrade/data
cp -a /SyncTrade/data/. /SyncTrade.new/data/
chown -R tongpin:tongpin /SyncTrade.new/data
chmod 750 /SyncTrade.new/data

mv /SyncTrade /SyncTrade.prev
mv /SyncTrade.new /SyncTrade

if systemctl start tongpin && sleep 2 && curl -fsS -m 5 http://127.0.0.1:18886/api/health >/dev/null; then
  rm -rf /SyncTrade.prev
  echo "更新完成：$(systemctl is-active tongpin)，健康检查通过"
else
  echo "更新后健康检查失败，回滚" >&2
  systemctl stop tongpin || true
  mv /SyncTrade /SyncTrade.broken
  mv /SyncTrade.prev /SyncTrade
  systemctl start tongpin || true
  exit 1
fi

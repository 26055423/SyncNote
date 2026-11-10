#!/usr/bin/env bash
# Fetch → stop → database snapshot → fast-forward → migrate/start → health check.
# Failure restores BOTH code and database. Install this updater before a schema upgrade.
set -euo pipefail

syncnote_git() { sudo -u admin git -C /SyncTrade -c core.hooksPath=/dev/null "$@"; }
if [ -n "$(syncnote_git status --porcelain)" ]; then
  echo '工作树有未提交改动，拒绝自动更新。' >&2
  exit 2
fi
before=$(syncnote_git rev-parse HEAD)
syncnote_git fetch origin
after=$(syncnote_git rev-parse '@{upstream}')
if [ "$before" = "$after" ]; then echo '已是最新，无需重启'; exit 0; fi
syncnote_git merge-base --is-ancestor "$before" "$after"

# Keep the helper outside the checkout so rollback can still use the new helper.
helper=$(mktemp /tmp/syncnote-backup.XXXXXX.py)
syncnote_git show "$after:tools/database_backup.py" > "$helper"
chmod 600 "$helper"
backup="/var/backups/syncnote/board-$(date -u +%Y%m%dT%H%M%SZ)-$before.sqlite3"
install -d -m 700 /var/backups/syncnote
stopped=0
changed=0
saved=0
rollback() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ] && [ "$stopped" -eq 1 ]; then
    echo '更新失败，恢复代码和升级前数据库。' >&2
    systemctl stop syncnote || true
    if [ "$changed" -eq 1 ]; then syncnote_git reset --hard "$before"; fi
    if [ "$saved" -eq 1 ]; then python3 "$helper" "$backup" /SyncTrade/data/board.sqlite3 --restore; fi
    systemctl start syncnote || true
  fi
  rm -f "$helper"
  exit "$result"
}
trap rollback EXIT
systemctl stop syncnote
stopped=1
python3 "$helper" /SyncTrade/data/board.sqlite3 "$backup"
saved=1
changed=1
syncnote_git merge --ff-only "$after"
systemctl start syncnote
for attempt in $(seq 1 30); do
  if curl -fsS -m 2 http://127.0.0.1:18886/api/health >/dev/null; then
    stopped=0
    echo "已更新：$before -> $after；备份：$backup"
    exit 0
  fi
  sleep 1
done
echo '健康检查超时。' >&2
exit 1

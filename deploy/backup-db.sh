#!/usr/bin/env bash
# The database's backups (deploy/systemd/settle-backup.timer), now that it
# lives on this VM rather than Neon:
#   nightly  - a full dump to /var/backups/settle, the last KEEP_DAYS kept
#   weekly   - (Sundays, or with "upload") the newest one copied to Google
#              Drive, folder settle-backups, by rclone's "gdrive" remote -
#              skipped with a note if that hasn't been set up yet
# Restore: pg_restore --no-owner -d "$DATABASE_URL" <file>
set -euo pipefail
DIR=/var/backups/settle
KEEP_DAYS=14
url=$(grep '^DATABASE_URL=' /etc/settle/api.env | cut -d= -f2- | tr -d "\"'")
mkdir -p "$DIR"
f="$DIR/settle-$(date -u +%Y%m%d-%H%M).dump"
/usr/lib/postgresql/17/bin/pg_dump --no-owner --no-privileges -Fc -f "$f.part" "$url"
mv "$f.part" "$f"
echo "backup: $f ($(du -h "$f" | cut -f1))"
find "$DIR" -name 'settle-*.dump' -mtime +"$KEEP_DAYS" -delete

if [ "${1:-}" = upload ] || [ "$(date -u +%u)" = 7 ]; then
  if rclone listremotes 2>/dev/null | grep -q '^gdrive:$'; then
    rclone copy "$f" gdrive:settle-backups/ && echo "backup: copied to Google Drive"
    # Drive keeps the last 8 weekly copies
    rclone lsf gdrive:settle-backups/ --files-only | sort | head -n -8 | while read -r old; do
      rclone deletefile "gdrive:settle-backups/$old"
    done
  else
    echo "backup: Google Drive not set up yet (rclone remote 'gdrive') - kept on the VM only"
  fi
fi

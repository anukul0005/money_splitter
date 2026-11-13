#!/usr/bin/env bash
# The database's backup (deploy/systemd/settle-backup.timer), weekly: a full
# dump to /var/backups/settle and a copy to Google Drive (folder
# settle-backups, rclone's "gdrive" remote). Only the latest is kept in each
# place - the older one is deleted once the new one is safely written there.
# Restore: pg_restore --no-owner -d "$DATABASE_URL" <file>
set -euo pipefail
DIR=/var/backups/settle
url=$(grep '^DATABASE_URL=' /etc/settle/api.env | cut -d= -f2- | tr -d "\"'")
mkdir -p "$DIR"
name="settle-$(date -u +%Y%m%d-%H%M).dump"
/usr/lib/postgresql/17/bin/pg_dump --no-owner --no-privileges -Fc -f "$DIR/$name.part" "$url"
mv "$DIR/$name.part" "$DIR/$name"
echo "backup: $DIR/$name ($(du -h "$DIR/$name" | cut -f1))"
find "$DIR" -maxdepth 1 -name 'settle-*.dump' ! -name "$name" -delete

if rclone listremotes 2>/dev/null | grep -q '^gdrive:$'; then
  rclone copy "$DIR/$name" gdrive:settle-backups/
  echo "backup: copied to Google Drive"
  rclone lsf gdrive:settle-backups/ --files-only | grep -vx "$name" | while read -r old; do
    rclone deletefile "gdrive:settle-backups/$old"
  done
else
  echo "backup: Google Drive not set up (rclone remote 'gdrive') - kept on the VM only"
fi

#!/usr/bin/env bash
# The database's backup (deploy/systemd/settle-backup.timer), weekly: a full
# dump to /var/backups/settle and a copy to Google Drive (folder
# settle-backups, rclone's "gdrive" remote). Only the latest is kept in each
# place - the older one is deleted once the new one is safely written there.
#
# Safety check before replacing: a new backup that looks like data was lost
# (file under 80% of last week's, or a key table down by more than
# max(5 rows, 2%)) doesn't replace anything - both are kept, here and on
# Drive, and the run fails so `systemctl status settle-backup` shows it.
#
# Restore: pg_restore --no-owner -d "$DATABASE_URL" <file>
set -euo pipefail
DIR=/var/backups/settle
KEY_TABLES="users groups expenses payments loans loan_payments"
url=$(grep '^DATABASE_URL=' /etc/settle/api.env | cut -d= -f2- | tr -d "\"'")
psql=/usr/lib/postgresql/17/bin/psql
mkdir -p "$DIR"
name="settle-$(date -u +%Y%m%d-%H%M)"

# the key tables' row counts, kept beside each backup for next week's check
for t in $KEY_TABLES; do
  echo "$t $("$psql" "$url" -tAc "SELECT count(*) FROM $t")"
done > "$DIR/$name.counts"
/usr/lib/postgresql/17/bin/pg_dump --no-owner --no-privileges -Fc -f "$DIR/$name.dump.part" "$url"
mv "$DIR/$name.dump.part" "$DIR/$name.dump"
size=$(stat -c %s "$DIR/$name.dump")
echo "backup: $DIR/$name.dump ($(du -h "$DIR/$name.dump" | cut -f1))"

# last week's, if any
prev=$(ls -t "$DIR"/settle-*.dump 2>/dev/null | grep -v "/$name.dump$" | head -1 || true)
problems=""
if [ -n "$prev" ]; then
  psize=$(stat -c %s "$prev")
  if [ "$size" -lt $(( psize * 80 / 100 )) ]; then
    problems+=" file $(( size / 1024 )) KB vs $(( psize / 1024 )) KB last time;"
  fi
  pcounts="${prev%.dump}.counts"
  if [ -f "$pcounts" ]; then
    while read -r t n; do
      was=$(awk -v t="$t" '$1 == t {print $2}' "$pcounts")
      [ -z "$was" ] && continue
      allowed=$(( was * 2 / 100 )); [ "$allowed" -lt 5 ] && allowed=5
      if [ $(( was - n )) -gt "$allowed" ]; then
        problems+=" $t $was -> $n rows;"
      fi
    done < "$DIR/$name.counts"
  fi
fi

if [ -n "$problems" ]; then
  echo "backup: WARNING - looks like data was lost:$problems keeping last week's backup too (here and on Drive)" >&2
else
  find "$DIR" -maxdepth 1 \( -name 'settle-*.dump' -o -name 'settle-*.counts' \) ! -name "$name.*" -delete
fi

if rclone listremotes 2>/dev/null | grep -q '^gdrive:$'; then
  rclone copy --contimeout 60s --timeout 10m --retries 3 "$DIR/$name.dump" gdrive:settle-backups/
  echo "backup: copied to Google Drive"
  if [ -z "$problems" ]; then
    rclone lsf gdrive:settle-backups/ --files-only | grep -vx "$name.dump" | while read -r old; do
      rclone deletefile "gdrive:settle-backups/$old"
    done
  fi
else
  echo "backup: Google Drive not set up (rclone remote 'gdrive') - kept on the VM only"
fi

[ -z "$problems" ]       # a lost-data warning fails the run, so it shows

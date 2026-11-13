#!/usr/bin/env bash
# Puts the latest main live on the VM: pull, backend packages, frontend build,
# restart. Run on the VM (or by the GitHub workflow): bash /opt/settle/deploy/deploy.sh
set -euo pipefail
APP=/opt/settle
cd "$APP"

if [ "${1:-}" != --pulled ]; then
  echo "== pulling"
  git fetch --quiet origin main
  git reset --hard --quiet origin/main
  # Carry on with the copy just pulled: bash reads a script as it goes, so
  # the rest of this one - replaced on disk by the reset - mustn't be run
  exec bash "$APP/deploy/deploy.sh" --pulled
fi

echo "== backend packages"
"$APP/venv/bin/pip" install --quiet -r backend/requirements.txt

echo "== frontend build"
cd frontend
npm install --silent --no-audit --no-fund
# Same address as the site, so no CORS and no server name baked into the build
VITE_API_URL=/api npx vite build --logLevel warn
rsync -a --delete dist/ /var/www/settle/
cd "$APP"

echo "== restarting"
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
# Scheduled jobs: systemd timers (this VM has no cron)
sudo install -d -o ubuntu -g ubuntu /var/backups/settle      # the database backups (deploy/backup-db.sh)
command -v rclone >/dev/null || sudo apt-get install -y -qq rclone   # their weekly copy to Google Drive
sudo rm -f /etc/cron.d/settle-cron
sudo cp deploy/systemd/* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now --quiet settle-daily.timer settle-tennis.timer settle-charting.timer settle-backup.timer
sudo systemctl reload caddy
sudo systemctl restart settle-api
for i in $(seq 1 30); do
  if curl -fsS --max-time 3 http://127.0.0.1:8000/health >/dev/null 2>&1; then
    echo "== live: $(git log --oneline -1)"
    exit 0
  fi
  sleep 2
done
echo "!! the API didn't come up - journalctl -u settle-api -n 80" >&2
exit 1

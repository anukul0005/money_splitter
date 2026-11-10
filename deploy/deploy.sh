#!/usr/bin/env bash
# Puts the latest main live on the VM: pull, backend packages, frontend build,
# restart. Run on the VM (or by the GitHub workflow): bash /opt/settle/deploy/deploy.sh
set -euo pipefail
APP=/opt/settle
cd "$APP"

echo "== pulling"
git fetch --quiet origin main
git reset --hard --quiet origin/main

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
sudo cp deploy/settle-cron /etc/cron.d/settle-cron && sudo chmod 644 /etc/cron.d/settle-cron
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

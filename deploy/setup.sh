#!/usr/bin/env bash
# One-time setup of a fresh Oracle Cloud Ubuntu VM (22.04 / 24.04), as the
# ubuntu user:
#   curl -fsSL https://raw.githubusercontent.com/anukul0005/money_splitter/main/deploy/setup.sh | bash
# Then fill in /etc/settle/api.env and run: bash /opt/settle/deploy/deploy.sh
set -euo pipefail
REPO=${REPO:-https://github.com/anukul0005/money_splitter.git}
APP=/opt/settle
export DEBIAN_FRONTEND=noninteractive

echo "== packages"
sudo apt-get update -q
sudo apt-get install -yq git python3 python3-venv python3-dev build-essential libpq-dev curl rsync nano procps \
  gnupg debian-keyring debian-archive-keyring apt-transport-https netfilter-persistent iptables-persistent

echo "== node 20"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -yq nodejs
fi

echo "== caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -q && sudo apt-get install -yq caddy
fi

echo "== swap (the small VMs need it to build)"
if [ "$(free -m | awk '/Mem:/{print $2}')" -lt 4000 ] && ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "== firewall: Oracle's Ubuntu image only lets SSH in"
# At the top of INPUT, so they come before the image's catch-all REJECT (the
# Minimal image has fewer rules, so no fixed position would fit both)
for port in 443 80; do
  sudo iptables -C INPUT -p tcp --dport $port -m state --state NEW -j ACCEPT 2>/dev/null \
    || sudo iptables -I INPUT 1 -p tcp --dport $port -m state --state NEW -j ACCEPT
done
sudo netfilter-persistent save

echo "== code"
sudo mkdir -p "$APP" /var/www/settle /etc/settle
sudo chown "$USER": "$APP" /var/www/settle
[ -d "$APP/.git" ] || git clone "$REPO" "$APP"
[ -d "$APP/venv" ] || python3 -m venv "$APP/venv"
"$APP/venv/bin/pip" install --quiet --upgrade pip
chmod +x "$APP"/deploy/*.sh

echo "== services"
if [ ! -f /etc/settle/api.env ]; then
  sudo cp "$APP/deploy/api.env.example" /etc/settle/api.env
fi
sudo chown "$USER": /etc/settle/api.env && chmod 600 /etc/settle/api.env
sudo cp "$APP/deploy/settle-api.service" /etc/systemd/system/
sudo cp "$APP"/deploy/systemd/* /etc/systemd/system/          # scheduled jobs (timers - no cron here)
sudo cp "$APP/deploy/Caddyfile" /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable settle-api caddy settle-daily.timer settle-tennis.timer settle-charting.timer

echo
echo "Done. Next:"
echo "  1. nano /etc/settle/api.env   (paste the values from Render)"
echo "  2. bash $APP/deploy/deploy.sh"

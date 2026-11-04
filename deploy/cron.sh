#!/usr/bin/env bash
# Calls one of the server's /cron jobs locally with the CRON_SECRET from the
# env file - what cron-job.org used to do from outside. Usage: cron.sh daily|tennis
set -euo pipefail
key=$(grep '^CRON_SECRET=' /etc/settle/api.env | cut -d= -f2- | tr -d "\"'")
curl -fsS --max-time 600 "http://127.0.0.1:8000/cron/${1:?daily or tennis}?key=${key}" >/dev/null

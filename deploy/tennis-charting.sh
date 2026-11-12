#!/usr/bin/env bash
# Weekly (deploy/systemd/settle-charting.timer): fetch the Match Charting Project's latest
# point-by-point logs and rebuild the tennis patterns worked out from them -
# early break (tennis_early_break) and pressure at 4-5 (tennis_pressure).
# The results go to ~/settle-data/tennis, outside the checkout a deploy
# resets; the API picks the new files up on its next read, no restart.
set -euo pipefail
APP=/opt/settle
OUT="${TENNIS_DATA_DIR:-$HOME/settle-data/tennis}"
SRC=https://raw.githubusercontent.com/JeffSackmann/tennis_MatchChartingProject/master
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

for f in charting-m-matches.csv charting-w-matches.csv \
         charting-m-points-2010s.csv charting-m-points-2020s.csv \
         charting-w-points-2010s.csv charting-w-points-2020s.csv; do
  curl -fsSL --retry 3 --max-time 600 -o "$TMP/$f" "$SRC/$f"
done

mkdir -p "$OUT"
cd "$APP/backend"
"$APP/venv/bin/python" tennis_early_break.py "$TMP" "$OUT"
"$APP/venv/bin/python" tennis_pressure.py "$TMP" "$OUT"
date -u +%FT%TZ > "$OUT/built_at"

#!/usr/bin/env bash
# Recover the Gemini API key on ANY machine (e.g. a new laptop):
#   1. git clone the repo
#   2. bash secrets/decrypt.sh
#   3. type the passphrase you used when encrypting
# Writes secrets/gemini_api_key.txt (gitignored). Paste that key into Render's
# GEMINI_API_KEY env var and/or backend/.env.
set -euo pipefail
cd "$(dirname "$0")"
IN="gemini_api_key.enc"
OUT="${1:-gemini_api_key.txt}"
if [ ! -f "$IN" ]; then
  echo "No encrypted backup at secrets/$IN"
  exit 1
fi
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -base64 -in "$IN" -out "$OUT"
echo "Recovered key -> secrets/$OUT (gitignored). Do NOT commit this file."

#!/usr/bin/env bash
# Encrypt the Gemini API key into secrets/gemini_api_key.enc - a file that is
# safe to commit to GitHub. Security rests entirely on the passphrase you type:
# it is NOT stored anywhere. Put that passphrase in your password manager; if
# you lose it, the backup cannot be recovered.
#
#   1. Put the key (just the key, one line) in secrets/gemini_api_key.txt
#   2. bash secrets/encrypt.sh
#   3. git add secrets/gemini_api_key.enc && git commit && git push
set -euo pipefail
cd "$(dirname "$0")"
IN="${1:-gemini_api_key.txt}"
OUT="gemini_api_key.enc"
if [ ! -f "$IN" ]; then
  echo "No plaintext key file at secrets/$IN"
  echo "Create it (the key on one line), then run this again."
  exit 1
fi
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -base64 -in "$IN" -out "$OUT"
echo "Wrote secrets/$OUT - safe to commit. Keep your passphrase in a password manager."

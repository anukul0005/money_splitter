# Encrypted secrets backup

This folder backs up the **Gemini API key** (notebook-page reader) on GitHub in
a form that is safe to store there: encrypted with AES-256, using a passphrase
that only you know. The passphrase is **never** in this repo.

| File | Committed? | What it is |
|------|-----------|------------|
| `gemini_api_key.enc` | ✅ yes | the key, encrypted — useless without your passphrase |
| `gemini_api_key.txt` | ❌ never (gitignored) | the plaintext key, only present locally |
| `encrypt.sh` / `decrypt.sh` | ✅ yes | the tools |

## Where the real key lives in production
Render → your backend service → Environment → `GEMINI_API_KEY`. This folder is
only a **backup** so you can recover the key if you lose both your laptop and
the Render value.

## Back up / update the key
```bash
printf '%s' 'YOUR_GEMINI_KEY' > secrets/gemini_api_key.txt   # or paste it in with an editor
bash secrets/encrypt.sh                                       # prompts for a passphrase (twice)
git add secrets/gemini_api_key.enc && git commit -m "Update encrypted Gemini key backup" && git push
```

## Recover the key on a new machine
```bash
git clone <this repo> && cd money_splitter
bash secrets/decrypt.sh          # prompts for the passphrase
cat secrets/gemini_api_key.txt   # your key
```

## Rules
- **Remember the passphrase** (store it in a password manager). Lose it and the
  backup is unrecoverable — that is the whole point of the encryption.
- Use a **strong, unique** passphrase. A weak one can be brute-forced offline by
  anyone who can read this repo.
- Never `git add` the `.txt` file (it is gitignored, but double-check).
- If the key is ever exposed, rotate it at <https://aistudio.google.com/apikey>,
  re-run `encrypt.sh`, and update Render.

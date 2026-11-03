"""One JSON answer from the app's LLM (the same Groq / OpenRouter keys and
fallbacks as statement_extractor), for small writing jobs: tidying a
message, suggesting fields. Raises when no key is set or every provider
fails - callers treat that as "no help this time"."""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

from statement_extractor import GROQ_MODEL, _candidates


def available() -> bool:
    return bool(_candidates())


def chat_json(system: str, user: str, temperature: float = 0.3) -> dict:
    payload = json.dumps({
        "model": GROQ_MODEL,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "response_format": {"type": "json_object"},
        "temperature": temperature,
    }).encode()
    last: Exception | None = None
    for url, key, extra in _candidates():
        req = urllib.request.Request(url, data=payload, method="POST", headers={
            "Authorization": f"Bearer {key}", "Content-Type": "application/json",
            # Groq's Cloudflare front-end blocks urllib's default user agent.
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
                          "Chrome/124.0.0.0 Safari/537.36",
            "Accept": "application/json", **extra,
        })
        for attempt in range(2):
            try:
                with urllib.request.urlopen(req, timeout=40) as resp:
                    data = json.loads(resp.read().decode())
                reply = json.loads(data["choices"][0]["message"]["content"])
                if isinstance(reply, dict):
                    return reply
                raise ValueError("reply isn't an object")
            except urllib.error.HTTPError as e:
                last = e
                wait = float(e.headers.get("retry-after") or 0) if e.code == 429 else 0
                if 0 < wait <= 15 and attempt == 0:
                    time.sleep(wait + 0.5)
                    continue
                break
            except (urllib.error.URLError, KeyError, ValueError, TimeoutError) as e:
                last = e
                break
    raise last or RuntimeError("No AI key configured")

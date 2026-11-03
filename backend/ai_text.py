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


def chat_json(system: str, user: str, temperature: float = 0.3, prefer: int = 0) -> dict:
    """`prefer` picks which key goes first (0 = the first Groq key, 1 = the
    second...); the rest follow as fallbacks, so two calls made side by side
    with prefer 0 and 1 each start on their own key's rate limit."""
    payload = json.dumps({
        "model": GROQ_MODEL,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "response_format": {"type": "json_object"},
        "temperature": temperature,
    }).encode()
    last: Exception | None = None
    keys = _candidates()
    if keys:
        k = prefer % len(keys)
        keys = keys[k:] + keys[:k]
    for url, key, extra in keys:
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


def chat_json_tandem(jobs: list[tuple[str, str]], temperature: float = 0.3) -> list[dict | Exception]:
    """Several (system, user) prompts at once, each started on a different
    key - the two Groq keys working in tandem instead of one after the
    other. Each result is the answer, or the Exception that job ended in."""
    from concurrent.futures import ThreadPoolExecutor

    def run(i_job):
        i, (system, user) = i_job
        try:
            return chat_json(system, user, temperature, prefer=i)
        except Exception as e:
            return e
    with ThreadPoolExecutor(max_workers=max(1, len(jobs))) as pool:
        return list(pool.map(run, enumerate(jobs)))

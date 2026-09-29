"""Structured extraction of a credit card statement's key fields via an
LLM, the same Groq/GPT-OSS-120B setup llm_receipt_parser.py already uses
for receipts - see that file's docstring for why Groq and why this model.

A statement PDF is long and mostly irrelevant (rewards catalogues, terms
and conditions, past transaction listings) - the prompt asks for only the
handful of numbers anyone actually opens the bill to check.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from database import get_settings

GROQ_MODEL = "openai/gpt-oss-120b"

_SYSTEM_PROMPT = """You read raw text extracted from an Indian credit card statement PDF. Extract its key billing fields.

Respond with ONLY a JSON object, no other text, in exactly this shape:
{
  "bank": string or null (the issuing bank's name, e.g. "HDFC Bank", "ICICI Bank", "Axis Bank"),
  "card_last4": string or null (the last 4 digits of the card number, exactly 4 characters),
  "statement_date": string or null (the statement/billing date, as ISO YYYY-MM-DD),
  "due_date": string or null (the payment due date, as ISO YYYY-MM-DD),
  "total_due": number or null (the total amount due / total outstanding for this statement),
  "minimum_due": number or null (the minimum amount due)
}

Rules:
- Use null for anything you cannot confidently read - never guess or invent a value.
- Numbers are plain numbers with no currency symbol or thousands separator.
- If several dates or amounts appear (e.g. a previous statement's figures shown for reference), use only the ones for THIS statement's own billing cycle.
"""


def _candidates() -> list[tuple[str, str, dict]]:
    """(url, api_key, extra_headers) to try in order. Same model everywhere -
    just different accounts/providers, so one being rate-limited doesn't
    stall a whole scan of several emails."""
    settings = get_settings()
    groq_url = "https://api.groq.com/openai/v1/chat/completions"
    out = []
    if settings.groq_api_key:
        out.append((groq_url, settings.groq_api_key, {}))
    if settings.groq_api_key_2:
        out.append((groq_url, settings.groq_api_key_2, {}))
    if settings.openrouter_api_key:
        out.append((
            "https://openrouter.ai/api/v1/chat/completions",
            settings.openrouter_api_key,
            # OpenRouter asks for these on top of the usual headers - they
            # only affect OpenRouter's own leaderboard/analytics, not the
            # request's behaviour.
            {"HTTP-Referer": "https://money-splitter-api.onrender.com", "X-Title": "Money Splitter"},
        ))
    return out


def available() -> bool:
    return bool(_candidates())


def extract(statement_text: str) -> dict:
    """Raises on any failure - not configured, every candidate key/provider
    failing, or a reply that isn't valid JSON in the expected shape. The
    caller decides what a failed extraction means for that statement."""
    candidates = _candidates()
    if not candidates:
        raise RuntimeError("No LLM key configured (GROQ_API_KEY / GROQ_API_KEY_2 / OPENROUTER_API_KEY)")

    # A statement can run to 20+ pages of terms and past transactions; the
    # fields this asks for are always on the first couple of pages, and
    # trimming keeps the request well inside the model's context window.
    text = statement_text[:12000]

    payload = json.dumps({
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0,
    }).encode()

    last_error: Exception | None = None
    data = None
    for url, api_key, extra_headers in candidates:
        req = urllib.request.Request(
            url,
            data=payload,
            method="POST",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                # See llm_receipt_parser.py - Groq's Cloudflare front-end
                # fingerprint-blocks the default urllib user agent.
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                              "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Accept": "application/json",
                **extra_headers,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode())
            break
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:400]
            last_error = RuntimeError(f"{url} rejected the request ({e.code}): {detail}")
            # A 429 (rate limit) or 401/403 (bad/exhausted key) is exactly
            # what the next candidate is for - anything else, still move on
            # rather than failing the whole statement over one provider hiccup.
            continue

    if data is None:
        raise last_error or RuntimeError("No LLM candidate succeeded")

    content = data["choices"][0]["message"]["content"]
    fields = json.loads(content)

    def _num(v):
        return float(v) if isinstance(v, (int, float)) else None

    def _date(v):
        if isinstance(v, str) and len(v) == 10 and v[4] == "-" and v[7] == "-":
            return v
        return None

    last4 = fields.get("card_last4")
    if not (isinstance(last4, str) and len(last4) == 4 and last4.isdigit()):
        last4 = None

    return {
        "bank": fields.get("bank") or None,
        "card_last4": last4,
        "statement_date": _date(fields.get("statement_date")),
        "due_date": _date(fields.get("due_date")),
        "total_due": _num(fields.get("total_due")),
        "minimum_due": _num(fields.get("minimum_due")),
    }

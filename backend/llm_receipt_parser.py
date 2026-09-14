"""Structured extraction of a receipt's fields via an LLM, as an
alternative to receipt_parser.py's own line-by-line regex heuristics.

Uses Groq's OpenAI-compatible chat completions endpoint with GPT-OSS-120B,
an open-weight model Groq hosts and serves fast enough to run inline in a
single scan request. Considerably more robust than regex against a
receipt shaped in a way those rules don't recognise - a different
language, a thermal printer wrapping one item across two physical lines,
an itemised discount, or a total spelled a way no keyword list covers.

Deliberately separate from, not a replacement for, receipt_parser.py's
math/confidence validation: whatever this returns still goes through the
exact same "does this actually add up" check a regex-derived read does
(see receipt_parser._validate_and_score). A fluent, confident-sounding
LLM response is not automatically a correct one - the point of routing
both sources through the same validator is that neither is trusted on its
own say-so.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from database import get_settings

# Groq's naming for the model they host - update here if Groq renames or
# retires it; nothing else in this file should need to change.
GROQ_MODEL = "openai/gpt-oss-120b"

_SYSTEM_PROMPT = """You read raw OCR text from a receipt. Line breaks may be noisy, spacing may be off, and some characters may be misread. Extract its structured content.

Respond with ONLY a JSON object, no other text, in exactly this shape:
{
  "merchant": string or null,
  "date": string or null (the receipt's own printed date, as ISO YYYY-MM-DD; null if none is printed or you are not confident),
  "items": [ { "label": string, "amount": number } ],
  "subtotal": number or null,
  "tax": number or null (every tax/GST/CGST/SGST/VAT line summed together),
  "total": number or null (the final amount actually payable, not the subtotal)
}

Rules:
- "items" is every distinct line item with a price, EXCLUDING subtotal, tax, rounding, and total lines themselves.
- Use null for anything you cannot confidently read - never guess or invent a value.
- Numbers are plain numbers with no currency symbol or thousands separator.
"""


def available() -> bool:
    return bool(get_settings().groq_api_key)


def extract(raw_text: str) -> dict:
    """Raises on any failure - not configured, a network error, a
    non-2xx response, or a reply that isn't valid JSON in the expected
    shape - so the caller (receipt_parser.parse_receipt) can fall back to
    the regex extractor exactly the way one OCR provider's failure falls
    back to the next.
    """
    api_key = get_settings().groq_api_key
    if not api_key:
        raise RuntimeError("GROQ_API_KEY not set")

    payload = json.dumps({
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": raw_text},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0,
    }).encode()

    req = urllib.request.Request(
        "https://api.groq.com/openai/v1/chat/completions",
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            # Groq sits behind Cloudflare, which fingerprint-blocks the
            # default "Python-urllib/3.x" user agent as a bot signature
            # (its own error 1010) before the request ever reaches Groq -
            # a realistic browser-style UA is enough to pass that check.
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:400]
        raise RuntimeError(f"Groq rejected the request ({e.code}): {detail}") from e

    content = data["choices"][0]["message"]["content"]
    fields = json.loads(content)

    def _num(v):
        return float(v) if isinstance(v, (int, float)) else None

    items = []
    for item in fields.get("items") or []:
        label, amount = item.get("label"), _num(item.get("amount"))
        if label and amount is not None:
            items.append({"label": str(label), "amount": amount})

    return {
        "merchant": fields.get("merchant") or None,
        "date": fields.get("date") or None,
        "items": items,
        "subtotal": _num(fields.get("subtotal")),
        "tax": _num(fields.get("tax")),
        "total": _num(fields.get("total")),
    }

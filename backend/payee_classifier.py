"""LLM classification of statement payees the keyword rules can't place:
is paying them spending at all, and if so, what kind.

Same Groq/GPT-OSS-120B setup (and the same key/provider fallbacks) as
statement_extractor.py. One request covers a batch of payees, each sent as
its pattern in this upload - how often, how much, what time of day, how
many on Fridays - never individual transactions. The import stores every
answer as a PayeeLabel, so a payee is only ever asked about once.

Callers must treat failure as normal: classify() raises when no key is
configured or every provider fails, and the import then falls back to the
rules alone.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

from spend_categories import TAXONOMY
from statement_extractor import GROQ_MODEL, _candidates

DECISIONS = ("spending", "p2p", "gambling", "investment", "repayment", "self_transfer")
# GPT-OSS spends output tokens reasoning before it answers; at 40 payees a
# reply came back cut short and unparseable, at 20 it doesn't.
BATCH = 20

_SYSTEM_PROMPT = """You classify payees from an Indian PhonePe (UPI) statement for a personal spending tracker.
For each payee decide whether money paid to them is the user's own spending, and if it is, its category.

The user's rules - follow them exactly:
- Only real purchases of goods and services count as "spending".
- "p2p": money sent to a person that isn't a purchase - friends, family, loans, repayments, returns,
  splitting bills. One-off payments of more than about Rs 200 to a person's name, a masked number
  ("******1234"), a bank account or a phone-number handle are p2p unless the name itself shows a business.
- "gambling": deposits to gaming/betting/trading platforms routed through rotating collection accounts.
  Signs: round amounts (Rs 300, 500, 1000, 5000, 13400...) paid once to unrelated "enterprises",
  agro/infra/tech firms or people, often on Fridays or between 10 pm and 3 am, payee never paid again;
  UPI handles ending in ptyes, kvb, rbl, fbl, iob, idbi with a person or shop name.
- "investment": stocks, mutual funds, trading apps, IPOs.
- "repayment": credit card bills, BNPL / pay-later, loan EMIs.
- "self_transfer": the user's own account or wallet.
- Small repeated amounts (up to about Rs 200) to a person's name are usually a street vendor, tea stall,
  auto driver or kiosk paid on their personal UPI: that is spending - use "Small vendors" /
  "Unspecified" unless the name or pattern shows something more specific.
- Use the name first: a shop, brand, restaurant, pump or chemist's name decides the category.
- If unsure between spending and p2p for a person, prefer p2p for amounts over Rs 200 and spending
  (Small vendors) for amounts up to Rs 200.

Categories (use these exact strings; category and subcategory only when decision is "spending"):
""" + "\n".join(f"- {c}: {', '.join(s)}" for c, s in TAXONOMY.items()) + """

Respond with ONLY a JSON object:
{"results": [{"id": <the payee's id>, "decision": "spending|p2p|gambling|investment|repayment|self_transfer",
  "category": string or null, "subcategory": string or null, "confidence": 0.0-1.0,
  "reason": "a few words"}]}
Return exactly one result per payee id you were given."""


def available() -> bool:
    return bool(_candidates())


def _chat(user_content: str) -> dict:
    payload = json.dumps({
        "model": GROQ_MODEL,
        "messages": [{"role": "system", "content": _SYSTEM_PROMPT},
                     {"role": "user", "content": user_content}],
        "response_format": {"type": "json_object"},
        "temperature": 0,
    }).encode()
    last_error: Exception | None = None
    for url, api_key, extra_headers in _candidates():
        req = urllib.request.Request(url, data=payload, method="POST", headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            # Groq's Cloudflare front-end blocks urllib's default user agent.
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "application/json",
            **extra_headers,
        })
        # A batch is ~3k tokens, so back-to-back batches run into a free-tier
        # key's per-minute limit: wait as long as the 429 says (when short)
        # and retry the same key before moving on to the next one.
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=45) as resp:
                    data = json.loads(resp.read().decode())
                reply = json.loads(data["choices"][0]["message"]["content"])
                if not isinstance(reply, dict) or not isinstance(reply.get("results"), list):
                    # OpenRouter's GPT-OSS sometimes answers with its reasoning
                    # instead of the requested shape.
                    raise ValueError("reply has no results list")
                return reply
            except urllib.error.HTTPError as e:
                last_error = e
                wait = float(e.headers.get("retry-after") or 0) if e.code == 429 else 0
                if 0 < wait <= 60 and attempt < 2:
                    time.sleep(wait + 0.5)
                    continue
                break           # bad key, or a long wait: next provider
            except (urllib.error.URLError, KeyError, ValueError, TimeoutError) as e:
                last_error = e  # unreachable or bad reply: next provider
                break
    raise last_error or RuntimeError("No LLM key configured")


def _clean(r: dict) -> dict | None:
    decision = r.get("decision")
    if decision not in DECISIONS:
        return None
    cat, sub = r.get("category"), r.get("subcategory")
    if decision == "spending":
        if cat not in TAXONOMY:
            cat, sub = "Other", "Unclassified merchant"
        elif sub not in TAXONOMY[cat]:
            sub = TAXONOMY[cat][0]
    else:
        cat = sub = None
    try:
        conf = max(0.0, min(1.0, float(r.get("confidence", 0))))
    except (TypeError, ValueError):
        conf = 0.0
    return {"decision": decision, "category": cat, "subcategory": sub, "confidence": conf,
            "reason": str(r.get("reason") or "")[:200]}


def classify(payees: list[dict]) -> dict[str, dict]:
    """payees: [{"key", "name", "count", "total", "median", "min", "max",
    "hour", "fridays", "first", "last"}] -> {key: {decision, category,
    subcategory, confidence, reason}}. Payees the model skips or answers
    malformed are simply absent from the result, and so is a batch whose
    request fails - unless every batch fails, which raises."""
    out: dict[str, dict] = {}
    failures: list[Exception] = []
    for start in range(0, len(payees), BATCH):
        batch = payees[start:start + BATCH]
        lines = [
            f'{i}. "{p["name"]}" - {p["count"]} payment(s), total Rs {p["total"]:.0f}, '
            f'typical Rs {p["median"]:.0f} (Rs {p["min"]:.0f}-{p["max"]:.0f}), around {p["hour"]:02d}:00, '
            f'{p["fridays"]} on a Friday, {p["first"]} to {p["last"]}'
            for i, p in enumerate(batch)
        ]
        try:
            reply = _chat("Payees:\n" + "\n".join(lines))
        except Exception as e:  # one batch failing must not lose the others
            failures.append(e)
            continue
        for r in reply.get("results", []):
            try:
                p = batch[int(r.get("id"))]
            except (TypeError, ValueError, IndexError):
                continue
            cleaned = _clean(r)
            if cleaned:
                out[p["key"]] = cleaned
    if failures and not out:
        raise failures[-1]
    return out

"""A credit card bill's detailed breakup, read from its statement PDF
(GET/POST /credit-cards/bills/{id}/details).

  1. the bill's own email (saved when the bill was found) -> its PDF,
     unlocked with the saved bank passwords
  2. the statement summary (previous balance, payments, purchases, fees,
     interest, total due...) from the first pages, via the LLM
  3. every transaction, page by page in chunks, via the LLM
  4. each spend categorised with the app's own taxonomy (the same AI
     categoriser expenses use, keyword rules as the fallback)
  5. totals by category, the biggest merchants, and a check that the
     transactions add up to the bill

Runs in a background thread (a long statement is several AI calls) and is
saved on the bill (details_json), so it's read once and opens instantly
after. The statement text goes to the same LLM providers the bill amount
already does; nothing is stored beyond the parsed result.
"""
from __future__ import annotations

import json
import re
import threading
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

CHUNK = 7000            # characters of statement text per transactions call
_status: dict[int, dict] = {}       # bill id -> {"status": "reading"|"error", "error"}
_lock = threading.Lock()

_SUMMARY_PROMPT = """You read the text of an Indian credit card statement PDF. Extract the statement summary.
Respond with ONLY a JSON object:
{"previous_balance": number|null, "payments_credits": number|null, "purchases_debits": number|null,
 "fees_charges": number|null, "interest": number|null, "taxes": number|null, "total_due": number|null,
 "minimum_due": number|null, "due_date": "YYYY-MM-DD"|null, "period_from": "YYYY-MM-DD"|null,
 "period_to": "YYYY-MM-DD"|null, "credit_limit": number|null, "available_limit": number|null,
 "reward_points": number|null}
Plain numbers, no currency symbols or commas. null for anything not clearly stated - never guess."""

_TXN_PROMPT = """You read part of the text of an Indian credit card statement PDF. List every transaction line in it.
Respond with ONLY a JSON object: {"transactions": [{"date": "YYYY-MM-DD", "description": string,
 "amount": number, "type": "debit"|"credit", "kind": "purchase"|"payment"|"refund"|"cashback"|"fee"|"interest"|"tax"|"emi"|"other"}]}
Rules:
- amount is positive; type says the direction ("Cr"/"credit"/payments/refunds are credit).
- Only real transaction rows from this statement - not summary totals, not reward point tables, not offers, not EMI schedules for future months.
- Keep the description as printed (merchant and place), without the reference numbers.
- If this part has no transactions, return {"transactions": []}."""


def _ask(system: str, text: str, max_tokens: int = 6000) -> dict:
    import expense_classifier as ec
    from statement_extractor import GROQ_MODEL
    payload = json.dumps({"model": GROQ_MODEL, "temperature": 0, "max_tokens": max_tokens,
                          "response_format": {"type": "json_object"},
                          "messages": [{"role": "system", "content": system}, {"role": "user", "content": text}]}).encode()
    last: Exception | None = None
    for url, key, extra in ec._providers():
        req = urllib.request.Request(url, data=payload, method="POST", headers={
            "Authorization": f"Bearer {key}", "Content-Type": "application/json", "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            **extra})
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                return json.loads(json.loads(resp.read().decode())["choices"][0]["message"]["content"])
        except (urllib.error.URLError, KeyError, ValueError, TimeoutError) as e:
            last = e
    raise last or RuntimeError("No LLM key configured")


def _chunks(text: str) -> list[str]:
    out, cur = [], []
    size = 0
    for line in text.splitlines():
        if size + len(line) > CHUNK and cur:
            out.append("\n".join(cur))
            cur, size = [], 0
        cur.append(line)
        size += len(line) + 1
    if cur:
        out.append("\n".join(cur))
    return out


def _num(v):
    return round(float(v), 2) if isinstance(v, (int, float)) else None


# Words that say where or what kind of company, not which merchant - left
# out so "Decathlon Sports Gurgaon" and "Decathlon Noida" group together.
_NOISE = {
    "pvt", "ltd", "limited", "private", "india", "in", "ind", "co", "company", "corp", "llp", "inc", "the",
    "systems", "services", "solutions", "technologies", "retail", "store", "stores", "payments", "online",
    "gurgaon", "gurugram", "delhi", "new", "noida", "bangalore", "bengaluru", "mumbai", "pune", "hyderabad",
    "chennai", "kolkata", "ghaziabad", "faridabad", "indirapuram", "jaipur", "lucknow", "chandigarh", "ahmedabad",
}


def merchant(desc: str) -> str:
    """A short merchant name for grouping: no reference numbers, places,
    company suffixes or payment-gateway prefixes."""
    d = re.sub(r"^(upi|pos|ecom|nfc|www\.|razorpay\*?|payu\*?|paytm\*?|bbps)[\s/*-]*", "", desc.strip(), flags=re.I)
    d = re.sub(r"[\d#*/_.-]{3,}.*$", "", d)
    words = [w for w in re.split(r"[\s,]+", d) if w and not w.isdigit() and w.lower() not in _NOISE][:2]
    return " ".join(words).title() or desc[:30].title()


def _categorise(txns: list[dict]) -> None:
    import expense_classifier as ec
    from spend_categories import categorize
    spends = [t for t in txns if t["type"] == "debit" and t["kind"] in ("purchase", "emi", "other")]
    names = sorted({t["description"] for t in spends})
    answer: dict[str, tuple[str, str | None]] = {}
    for start in range(0, len(names), 20):
        batch = names[start:start + 20]
        items = [{"id": i, "description": n, "notes": "", "amount": next(t["amount"] for t in spends if t["description"] == n),
                  "group": "credit card statement"} for i, n in enumerate(batch)]
        try:
            for r in ec._chat(items).get("results", []):
                if isinstance(r, dict) and isinstance(r.get("id"), int) and r["id"] < len(batch):
                    answer[batch[r["id"]]] = ec._clean(r.get("category"), r.get("subcategory"))
        except Exception as e:
            print(f"[card_details] categoriser unavailable, using rules: {e}")
    for t in txns:
        if t["type"] == "credit":
            t["category"], t["subcategory"] = "Payments & refunds", None
        elif t["kind"] in ("fee", "interest", "tax"):
            t["category"], t["subcategory"] = "Card fees & interest", t["kind"].title()
        else:
            got = answer.get(t["description"]) or categorize(t["description"], t["amount"])
            t["category"], t["subcategory"] = got[0], got[1]


def read_statement(text: str) -> dict:
    summary = _ask(_SUMMARY_PROMPT, text[:9000], 1500)
    summary = {k: (_num(v) if k not in ("due_date", "period_from", "period_to") else v)
               for k, v in summary.items()}
    txns = []
    for part in _chunks(text):
        for t in (_ask(_TXN_PROMPT, part).get("transactions") or []):
            amt = _num(t.get("amount"))
            if not amt or not t.get("description"):
                continue
            txns.append({"date": t.get("date") if isinstance(t.get("date"), str) else None,
                         "description": str(t["description"]).strip()[:120], "amount": abs(amt),
                         "type": "credit" if t.get("type") == "credit" else "debit",
                         "kind": t.get("kind") if t.get("kind") in ("purchase", "payment", "refund", "cashback", "fee",
                                                                    "interest", "tax", "emi", "other") else "other"})
    _categorise(txns)
    txns.sort(key=lambda t: (t["date"] or "", -t["amount"]))

    debits = round(sum(t["amount"] for t in txns if t["type"] == "debit"), 2)
    credits = round(sum(t["amount"] for t in txns if t["type"] == "credit"), 2)
    by_cat = defaultdict(lambda: [0.0, 0])
    by_merchant = defaultdict(lambda: [0.0, 0])
    for t in txns:
        if t["type"] == "debit" and t["category"] != "Card fees & interest":
            by_cat[t["category"]][0] += t["amount"]
            by_cat[t["category"]][1] += 1
            by_merchant[merchant(t["description"])][0] += t["amount"]
            by_merchant[merchant(t["description"])][1] += 1
    fees = round(sum(t["amount"] for t in txns if t["category"] == "Card fees & interest"), 2)
    spent = round(debits - fees, 2)

    # previous balance - payments/credits + debits = total due, when the
    # statement states the pieces: says whether the list is complete.
    check = None
    prev, total = summary.get("previous_balance"), summary.get("total_due")
    if prev is not None and total is not None:
        expected = round(prev - credits + debits, 2)
        check = {"expected": expected, "total_due": total, "ok": abs(expected - total) <= 2}
    return {
        "summary": summary,
        "transactions": txns,
        "totals": {"spent": spent, "fees": fees, "debits": debits, "credits": credits, "count": len(txns)},
        "by_category": [{"category": c, "amount": round(v[0], 2), "count": v[1],
                         "share": round(v[0] / spent * 100, 1) if spent else 0}
                        for c, v in sorted(by_cat.items(), key=lambda x: -x[1][0])],
        "top_merchants": [{"name": m, "amount": round(v[0], 2), "count": v[1]}
                          for m, v in sorted(by_merchant.items(), key=lambda x: -x[1][0])[:6]],
        "check": check,
        "read_at": datetime.now(timezone.utc).isoformat(),
    }


def status(bill_id: int) -> dict | None:
    with _lock:
        return dict(_status[bill_id]) if bill_id in _status else None


def start(user_id: int, bill_id: int) -> None:
    with _lock:
        if _status.get(bill_id, {}).get("status") == "reading":
            return
        _status[bill_id] = {"status": "reading", "step": "Opening the statement email…"}
    threading.Thread(target=_run, args=(user_id, bill_id), daemon=True).start()


def _step(bill_id: int, text: str) -> None:
    with _lock:
        _status[bill_id] = {"status": "reading", "step": text}


def _run(user_id: int, bill_id: int) -> None:
    import secret_box
    from database import get_session_factory
    from models import BankPassword, CreditCardStatement, GmailConnection
    from statement_sync import _extract_pdf_text, _first_pdf_attachment, _gmail_service
    db = get_session_factory()()
    try:
        bill = db.get(CreditCardStatement, bill_id)
        conn = db.query(GmailConnection).filter(GmailConnection.user_id == user_id).first()
        if not bill or not conn:
            raise RuntimeError("Gmail isn't connected" if bill else "Bill not found")
        service = _gmail_service(conn)
        msg = service.users().messages().get(userId="me", id=bill.gmail_message_id, format="full").execute()
        pdf = _first_pdf_attachment(service, bill.gmail_message_id, msg.get("payload", {}))
        if not pdf:
            raise RuntimeError("This bill's email has no PDF statement attached, so there's no breakup to read")
        _step(bill_id, "Unlocking the PDF…")
        passwords = [p for p in (secret_box.decrypt(b.password_encrypted) for b in
                                 db.query(BankPassword).filter(BankPassword.user_id == user_id)) if p]
        from models import CreditCard
        card = db.get(CreditCard, bill.card_id) if bill.card_id else None
        if card:
            from card_bills import passwords_for
            passwords = passwords_for(card, passwords)
        text = _extract_pdf_text(pdf, passwords)
        if not text or len(text.strip()) < 100:
            raise RuntimeError("The PDF couldn't be opened with the saved passwords")
        _step(bill_id, f"Reading {len(_chunks(text))} part(s) of the statement…")
        details = read_statement(text)
        bill.details_json = json.dumps(details)
        db.commit()
        with _lock:
            _status.pop(bill_id, None)
    except Exception as e:
        print(f"[card_details] bill {bill_id}: {e}")
        with _lock:
            _status[bill_id] = {"status": "error", "error": str(e)[:300]}
    finally:
        db.close()

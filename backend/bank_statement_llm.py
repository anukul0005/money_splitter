"""Any bank's account statement PDF (HDFC, SBI, ICICI, Axis, Kotak, ...)
read into StatementTxn rows by an LLM - the fallback statement_import's
parse_statement uses when the PDF isn't one of the payment-app formats it
parses itself.

Banks lay their statements out every which way, and one bank changes its
layout now and then, so instead of a parser per bank the statement's text
goes to the same Groq-hosted model the receipts and card bills use (see
llm_receipt_parser.py), a page or two at a time, and comes back as rows.
Only the transaction lines matter; balances, headers and terms are ignored.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.error
import urllib.request
from datetime import date

from database import get_settings
from llm_receipt_parser import GROQ_MODEL

CHUNK_LINES = 120          # statement lines per request - a page or two

_PROMPT = """You read Indian bank account statements. You get some lines of one statement's text (columns run together; a transaction may wrap over two lines). Return JSON:
{"bank": string or null, "account": string or null (the statement owner's account number as printed, masked or not), "transactions": [{"date": "YYYY-MM-DD", "time": "HH:MM" or null, "payee": string, "amount": number, "kind": "Debit" or "Credit", "ref": string or null}]}
Rules:
- One entry per transaction row; skip opening/closing balance lines, totals, headers, page footers and anything that isn't a transaction.
- "amount" is the withdrawal (Debit) or deposit (Credit) amount - never the running balance. Positive, no commas or currency signs.
- "payee" is who the money went to or came from, in plain words, taken from the narration: "UPI/DR/412345678901/ZOMATO LTD/YESB/..." -> "Zomato Ltd"; "POS 4591XXXX AMAZON PAY" -> "Amazon Pay"; "NEFT DR-HDFC0001-RAHUL SHARMA" -> "Rahul Sharma"; an ATM withdrawal -> "ATM cash withdrawal"; a transfer to the owner's own account -> "Self transfer" followed by its masked number.
- "ref" is the UPI / NEFT / IMPS / cheque reference number in the row, if any.
- Dates as printed (DD/MM/YY, DD-Mon-YYYY, ...) converted to YYYY-MM-DD; Indian statements put the day first.
- If these lines hold no transactions, return an empty list."""


def available() -> bool:
    return bool(get_settings().groq_api_key)


def _ask(text: str) -> dict:
    api_key = get_settings().groq_api_key
    payload = json.dumps({
        "model": GROQ_MODEL,
        "messages": [{"role": "system", "content": _PROMPT}, {"role": "user", "content": text}],
        "response_format": {"type": "json_object"},
        "temperature": 0,
    }).encode()
    for attempt in range(4):
        req = urllib.request.Request(
            "https://api.groq.com/openai/v1/chat/completions", data=payload, method="POST",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json",
                     # the same user agent llm_receipt_parser sends (Cloudflare blocks urllib's)
                     "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                                   "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                     "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                data = json.loads(resp.read().decode())
            return json.loads(data["choices"][0]["message"]["content"])
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 3:            # the free tier's per-minute limit: wait it out
                wait = float(e.headers.get("retry-after") or 20)
                time.sleep(min(wait, 60))
                continue
            raise RuntimeError(f"Groq rejected the request ({e.code}): {e.read().decode(errors='replace')[:300]}") from e
    raise RuntimeError("Groq kept refusing (rate limit)")


def parse_bank_pdf(lines: list[str], progress=None) -> list:
    """StatementTxn rows for a bank statement's text lines. Raises ValueError
    when it isn't one (or the LLM isn't configured), like the other parsers."""
    from statement_import import StatementTxn
    if not available():
        raise ValueError("Reading bank statements needs the AI key (GROQ_API_KEY), which isn't set.")
    chunks = [lines[i:i + CHUNK_LINES] for i in range(0, len(lines), CHUNK_LINES)]
    rows, bank, account = [], None, None
    for k, chunk in enumerate(chunks):
        got = _ask("\n".join(chunk))
        bank = bank or got.get("bank")
        account = account or got.get("account")
        rows += got.get("transactions") or []
        if progress:
            progress(k + 1, len(chunks))
    if not rows:
        raise ValueError("No transactions found - this doesn't look like a bank statement.")
    acct = re.sub(r"[^0-9Xx*]", "", account or "").upper()
    out, seen = [], set()
    for r in rows:
        try:
            d = date.fromisoformat(str(r.get("date"))[:10])
            amount = round(float(r.get("amount")), 2)
        except (TypeError, ValueError):
            continue
        kind = "Credit" if str(r.get("kind", "")).lower().startswith("c") else "Debit"
        payee = " ".join(str(r.get("payee") or "").split())[:120] or "Bank transaction"
        if amount <= 0:
            continue
        ref = re.sub(r"\s", "", str(r.get("ref") or ""))[:40]
        # A stable id, so the same statement uploaded twice adds nothing new
        key = ref or hashlib.sha1(f"{d}|{amount}|{payee.lower()}|{kind}".encode()).hexdigest()[:16]
        if (key, kind, amount) in seen:                   # a row repeated across two chunks
            continue
        seen.add((key, kind, amount))
        t = r.get("time")
        out.append(StatementTxn(
            date=d.isoformat(), time=t if isinstance(t, str) and re.fullmatch(r"\d{2}:\d{2}", t) else None,
            merchant=payee, txn_id=f"bank:{key}", kind=kind, amount=amount,
            instrument=acct, source=bank or "Bank statement"))
    if not out:
        raise ValueError("No transactions found - this doesn't look like a bank statement.")
    return out

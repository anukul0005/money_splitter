"""Each credit card's bill amount, read from Gmail on the day the bill is
generated (POST /credit-cards/fetch).

The user adds their cards once - bank, last 4 digits, the day of the month
the bill is generated. For each card and each of its last N bill dates:

  1. search Gmail for that bank's emails from the bill date to a week after
     (banks send the statement the same day or a few days later) - only
     that bank's sending domains, not every PDF that says "statement"
  2. rank what comes back: a statement subject, "credit card", the card's
     last 4 digits; account statements, loans, alerts and offers lose
  3. read the amount from the best email - its own text first (most banks
     put the total due in the email), else its PDF, unlocked with the saved
     bank passwords - via the LLM, told which bank, card and bill date
  4. check it: the right card (last 4, when both are known), a statement
     date within 10 days of the bill date, an amount present
  5. save one bill per card per month (CreditCardStatement.period)

A month whose bill is already saved is skipped.
"""
from __future__ import annotations

import base64
import calendar
import html as html_lib
import json
import re
from datetime import date, timedelta

# Bank -> Gmail sending domains. Banks are moving to .bank.in addresses,
# so both old and new are listed. "Other bank" searches every sender.
BANKS: dict[str, list[str]] = {
    "SBI Card": ["sbicard.com", "sbi.bank.in", "sbicard.bank.in"],
    "HDFC Bank": ["hdfcbank.net", "hdfcbank.com", "hdfc.bank.in", "hdfcbank.bank.in"],
    "ICICI Bank": ["icicibank.com", "icici.bank.in", "icicibank.bank.in"],
    "Axis Bank": ["axisbank.com", "axis.bank.in", "axisbank.bank.in"],
    "Kotak Mahindra Bank": ["kotak.com", "kotak.bank.in", "kotakbank.com"],
    "Jupiter (CSB Bank)": ["jupiter.money", "csb.co.in", "csb.bank.in"],
    "Union Bank of India": ["unionbankofindia.co.in", "unionbankofindia.bank.in", "unionbank.bank.in"],
    "IDFC FIRST Bank": ["idfcfirstbank.com", "idfcfirst.bank.in"],
    "AU Small Finance Bank": ["aubank.in", "au.bank.in"],
    "RBL Bank": ["rblbank.com", "rbl.bank.in"],
    "Yes Bank": ["yesbank.in", "yes.bank.in"],
    "IndusInd Bank": ["indusind.com", "indusind.bank.in"],
    "Federal Bank": ["federalbank.co.in", "federal.bank.in", "scapia.cards"],
    "Bank of Baroda (BOBCARD)": ["bobcard.co.in", "bobfinancial.com", "bankofbaroda.bank.in"],
    "Standard Chartered": ["sc.com"],
    "American Express": ["americanexpress.com", "aexp.com", "welcome.americanexpress.com"],
    "OneCard": ["getonecard.app"],
    "Other bank": [],
}

SEARCH_DAYS_AFTER = 7       # the statement email can lag the bill date by a few days
CHECK_DAYS = 10             # a statement dated further than this from the bill date is another cycle
MAX_CANDIDATES = 3          # emails read (LLM calls) per card per month, best first

_GOOD = [("statement", 4), ("credit card", 3), ("card statement", 2), ("e-statement", 2),
         ("total amount due", 3), ("amount due", 2), ("billing", 1)]
_BAD = ["account statement", "savings", "loan", "emi conversion", "fixed deposit", "demat", "mutual fund",
        "payment received", "payment of", "thank you for your payment", "transaction alert", "otp",
        "offer", "reward", "cashback", "upgrade", "insurance", "pre-approved", "limit enhancement"]


def bill_date(day: int, year: int, month: int) -> date:
    """The bill date in that month - day 31 in a 30-day month is the 30th."""
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


def recent_bill_dates(day: int, today: date, n: int) -> list[date]:
    """The last n bill dates on or before today, newest first."""
    out, y, m = [], today.year, today.month
    while len(out) < n:
        d = bill_date(day, y, m)
        if d <= today:
            out.append(d)
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)
    return out


def card_name(card) -> str:
    return " ".join(x for x in (card.bank, card.label, f"••{card.last4}" if card.last4 else None) if x)


def _query(card, d: date) -> str:
    domains = BANKS.get(card.bank) or []
    who = f"from:({' OR '.join(domains)})" if domains else '("credit card" statement)'
    start, end = d - timedelta(days=1), d + timedelta(days=SEARCH_DAYS_AFTER + 1)
    return f"{who} after:{start:%Y/%m/%d} before:{end:%Y/%m/%d}"


def _header(msg: dict, name: str) -> str:
    for h in msg.get("payload", {}).get("headers", []):
        if h.get("name", "").lower() == name:
            return h.get("value", "")
    return ""


def _score(card, subject: str, snippet: str, has_pdf: bool) -> int:
    text = f"{subject} {snippet}".lower()
    s = sum(w for k, w in _GOOD if k in text)
    s -= sum(5 for k in _BAD if k in subject.lower())
    if card.last4 and card.last4 in text:
        s += 4
    if has_pdf:
        s += 1
    return s


def _has_pdf(part: dict) -> bool:
    if part.get("filename", "").lower().endswith(".pdf"):
        return True
    return any(_has_pdf(p) for p in part.get("parts", []) or [])


def _body_text(part: dict) -> str:
    """The email's own text: text/plain if there is one, else text/html with
    the tags taken out."""
    plain, rich = [], []

    def walk(p):
        mime, data = p.get("mimeType", ""), p.get("body", {}).get("data")
        if data and not p.get("filename"):
            raw = base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")
            (plain if mime == "text/plain" else rich if mime == "text/html" else []).append(raw)
        for sub in p.get("parts", []) or []:
            walk(sub)

    walk(part)
    if plain:
        return "\n".join(plain)
    text = "\n".join(rich)
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", text)
    text = re.sub(r"(?i)<br\s*/?>|</(p|div|tr|td|li|h\d)>", "\n", text)
    text = html_lib.unescape(re.sub(r"<[^>]+>", " ", text))
    return re.sub(r"[ \t\xa0]+", " ", re.sub(r"\n\s*\n+", "\n", text)).strip()


def _check(card, d: date, f: dict) -> str | None:
    """Why an extraction isn't this card's bill for this date, or None if it is."""
    if f.get("total_due") is None:
        return "no amount"
    if card.last4 and f.get("card_last4") and f["card_last4"] != card.last4:
        return f"another card (••{f['card_last4']})"
    if f.get("statement_date"):
        try:
            if abs((date.fromisoformat(f["statement_date"]) - d).days) > CHECK_DAYS:
                return f"another billing cycle ({f['statement_date']})"
        except ValueError:
            pass
    return None


def find_bill(service, card, d: date, passwords: list[str]) -> dict:
    """Search, rank, read and check - the bill for `card` generated on `d`.
    {"status": "found", fields..., message} or {"status": "not_found", "why"}."""
    import statement_extractor
    from statement_sync import _extract_pdf_text, _first_pdf_attachment

    resp = service.users().messages().list(userId="me", q=_query(card, d), maxResults=25).execute()
    ids = [m["id"] for m in resp.get("messages", [])]
    if not ids:
        return {"status": "not_found", "why": f"no email from {card.bank} between {d:%d %b} and "
                                              f"{d + timedelta(days=SEARCH_DAYS_AFTER):%d %b}"}
    cands = []
    for mid in ids:
        msg = service.users().messages().get(userId="me", id=mid, format="full").execute()
        subject, snippet = _header(msg, "subject"), msg.get("snippet", "")
        has_pdf = _has_pdf(msg.get("payload", {}))
        cands.append((_score(card, subject, snippet, has_pdf), mid, msg, subject, has_pdf))
    cands.sort(key=lambda c: -c[0])

    hint = (f"bank {card.bank}" + (f", card ending {card.last4}" if card.last4 else "")
            + f", bill generated on {d.isoformat()}")
    why = []
    for score, mid, msg, subject, has_pdf in cands[:MAX_CANDIDATES]:
        if score <= 0:
            break
        tries = [("email", lambda: _body_text(msg.get("payload", {})))]
        if has_pdf:
            tries.append(("pdf", lambda: _extract_pdf_text(
                _first_pdf_attachment(service, mid, msg.get("payload", {})) or b"", passwords)))
        for source, get_text in tries:
            text = get_text()
            if not text or len(text.strip()) < 40:
                if source == "pdf":
                    why.append(f"'{subject[:60]}': PDF couldn't be opened - check the bank's password")
                continue
            try:
                f = statement_extractor.extract(text, hint)
            except Exception as e:
                why.append(f"'{subject[:60]}': couldn't read it ({str(e)[:80]})")
                continue
            problem = _check(card, d, f)
            if problem is None:
                return {"status": "found", **f, "message_id": mid, "subject": subject[:300],
                        "from": _header(msg, "from")[:200], "source": source}
            why.append(f"'{subject[:60]}' ({source}): {problem}")
    return {"status": "not_found", "why": "; ".join(why[:3]) or "no statement email in that week"}


def fetch_for_user(db, user_id: int, months: int, today: date, progress) -> list[dict]:
    """Every card's last `months` bills. Months already saved are skipped."""
    import secret_box
    from models import BankPassword, CreditCard, CreditCardStatement, GmailConnection
    from statement_sync import _gmail_service

    conn = db.query(GmailConnection).filter(GmailConnection.user_id == user_id).first()
    if not conn:
        raise RuntimeError("Gmail isn't connected for this account")
    passwords = [p for p in (secret_box.decrypt(b.password_encrypted) for b in
                             db.query(BankPassword).filter(BankPassword.user_id == user_id)) if p]
    service = _gmail_service(conn)
    cards = db.query(CreditCard).filter(CreditCard.user_id == user_id).order_by(CreditCard.bill_day).all()
    jobs = [(c, d) for c in cards for d in recent_bill_dates(c.bill_day, today, months)]
    progress(total=len(jobs), done=0, found=0, skipped=0, failed=0)
    results, found, skipped, failed = [], 0, 0, 0
    for i, (card, d) in enumerate(jobs, start=1):
        period = d.strftime("%Y-%m")
        row = {"card_id": card.id, "card": card_name(card), "bill_date": d.isoformat(), "period": period}
        have = (db.query(CreditCardStatement)
                .filter(CreditCardStatement.card_id == card.id, CreditCardStatement.period == period).first())
        if have:
            skipped += 1
            results.append({**row, "status": "already_saved", "total_due": have.total_due})
        else:
            try:
                r = find_bill(service, card, d, passwords)
            except Exception as e:
                r = {"status": "not_found", "why": f"Gmail search failed ({str(e)[:100]})"}
            if r["status"] == "found" and db.query(CreditCardStatement).filter(
                    CreditCardStatement.gmail_message_id == r["message_id"]).first():
                r = {"status": "not_found", "why": "that email is already saved as another card's bill"}
            if r["status"] == "found":
                db.add(CreditCardStatement(
                    user_id=user_id, card_id=card.id, period=period, bank=card.bank,
                    card_last4=r.get("card_last4") or card.last4,
                    statement_date=r.get("statement_date") or d.isoformat(), due_date=r.get("due_date"),
                    total_due=r.get("total_due"), minimum_due=r.get("minimum_due"),
                    gmail_message_id=r["message_id"], email_subject=r["subject"], email_from=r["from"],
                    source=r["source"], raw_extract=json.dumps({k: r.get(k) for k in (
                        "bank", "card_last4", "statement_date", "due_date", "total_due", "minimum_due")}),
                ))
                db.commit()
                found += 1
                results.append({**row, "status": "found", "total_due": r.get("total_due"), "source": r["source"]})
            else:
                failed += 1
                results.append({**row, "status": "not_found", "why": r.get("why")})
        progress(done=i, found=found, skipped=skipped, failed=failed, results=results)
    return results

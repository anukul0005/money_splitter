"""Card purchases turned into EMIs, so passing one on carries the bank's
real cost.

A purchase converted to an EMI shows on the bill as the plain purchase
("#SAMSUNGINDIAELECTRONIC IN 29,686.64"), but what's actually paid back is
the bank's instalments: interest each month, GST on that interest, and a
processing fee. The bank says exactly what in a booking email (SBI: "Details
of Merchant EMI booked on your SBI Credit Card": amount, rate, tenure, fee,
EMI, first EMI date) with the repayment schedule attached as a PDF.

scan() reads those emails into CardEmiBooking (from the daily card sync, or
on request); bookings_for_bill() matches them to a bill's lines (same amount,
purchase dated within a few days); plan() turns one into what someone it's
passed on to pays back: each instalment with its GST, the fee and its GST on
the first, each due the card's `pass_on_gap` days before the bank's own due
date. With no schedule in the email, estimate() works the instalments out
with the standard EMI formula - which can be a few rupees off the bank's,
since banks charge the first month's interest by the actual days.
"""
from __future__ import annotations

import json
import re
from datetime import date, timedelta

GST = 0.18                      # on EMI interest and the processing fee
MATCH_DAYS = 6                  # a booking's purchase date vs the bill line's
SCAN_DAYS = 200
_RS = r"(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d+)?)"
_QUERY = ('("EMI booked" OR "EMI booking" OR "booked on your" OR "converted into EMI" OR "converted to EMI" '
          'OR "Flexipay booked" OR "amortization schedule" OR "amortisation schedule") newer_than:{days}d')


def _num(s: str | None) -> float | None:
    try:
        return float(s.replace(",", "")) if s else None
    except ValueError:
        return None


def _dmy(m) -> str | None:
    try:
        return date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
    except (ValueError, AttributeError):
        return None


def parse_booking(text: str) -> dict | None:
    """The booking's terms from its email, or None when it isn't one."""
    t = " ".join((text or "").split())
    get = lambda rx: re.search(rx, t, re.I)
    # what went on EMI (the booking) - may be part of the purchase (the transaction)
    booked = get(r"(?:booking|loan|principal)\s*amount\s*[:\-]?\s*" + _RS)
    txn = get(r"transaction\s*amount\s*[:\-]?\s*" + _RS)
    amount = booked or txn
    tenure = get(r"tenure\s*[:\-]?\s*0*(\d{1,2})\s*months?")
    if not (amount and tenure):
        return None
    rate = get(r"(?:rate\s*of\s*interest|interest\s*rate|r\.?o\.?i\.?)[^\d%]{0,25}([\d.]+)\s*%")
    fee = get(r"processing\s*fee[^:\d]{0,40}:?\s*" + _RS)
    emi = get(r"(?:EMI|MRA)\s*amount\s*[:\-]?\s*" + _RS)
    return {"amount": _num(amount.group(1)), "txn_amount": _num((txn or amount).group(1)), "tenure": int(tenure.group(1)),
            "rate_pct": float(rate.group(1)) if rate else None,
            "processing_fee": _num(fee.group(1)) if fee else 0.0,
            "emi_amount": _num(emi.group(1)) if emi else None,
            "txn_date": _dmy(get(r"transaction\s*date[^:\d]{0,20}:?\s*(\d{2})/(\d{2})/(\d{4})")),
            "first_emi_date": _dmy(get(r"first\s*(?:EMI|instal+ment)\s*date[^:\d]{0,20}:?\s*(\d{2})/(\d{2})/(\d{4})"))}


_ROW = re.compile(r"^\s*(\d{1,2})\s+(\d{2})/(\d{2})/(\d{4})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})"
                  r"\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})", re.M)


def parse_schedule(text: str) -> list[dict]:
    """The bank's repayment schedule: one row per instalment - number, the
    statement it's billed on, EMI, interest, principal, balance, tax."""
    rows = []
    for m in _ROW.finditer(text or ""):
        when = date(int(m.group(4)), int(m.group(3)), int(m.group(2))).isoformat()
        rows.append({"n": int(m.group(1)), "date": when, "emi": _num(m.group(5)), "interest": _num(m.group(6)),
                     "principal": _num(m.group(7)), "tax": _num(m.group(9))})
    # only a run 1, 2, 3 ... counts
    return rows if rows and [r["n"] for r in rows] == list(range(1, len(rows) + 1)) else []


def _add_months(d: date, n: int) -> date:
    import calendar
    y, m = divmod(d.month - 1 + n, 12)
    y, m = d.year + y, m + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def estimate(amount: float, rate_pct: float, tenure: int, first: str) -> list[dict]:
    """The standard reducing-balance EMI when the bank's schedule isn't to hand."""
    r = (rate_pct or 0) / 1200
    emi = amount / tenure if r == 0 else amount * r / (1 - (1 + r) ** -tenure)
    bal, rows, start = amount, [], date.fromisoformat(first)
    for n in range(1, tenure + 1):
        interest = round(bal * r, 2)
        principal = round(bal if n == tenure else emi - interest, 2)
        bal = round(bal - principal, 2)
        rows.append({"n": n, "date": _add_months(start, n - 1).isoformat(), "emi": round(principal + interest, 2),
                     "interest": interest, "principal": principal, "tax": round(interest * GST, 2)})
    return rows


def _bank_of(sender: str) -> str | None:
    s = (sender or "").lower()
    for key, name in (("sbicard", "SBI Card"), ("hdfc", "HDFC Bank"), ("icici", "ICICI Bank"), ("axis", "Axis Bank"),
                      ("kotak", "Kotak"), ("hsbc", "HSBC Bank"), ("idfc", "IDFC First"), ("yesbank", "Yes Bank"),
                      ("indusind", "IndusInd"), ("rbl", "RBL Bank"), ("americanexpress", "American Express"), ("sc.com", "Standard Chartered")):
        if key in s:
            return name
    return None


def scan(db, user_id: int, service=None, passwords: list[str] | None = None, days: int = SCAN_DAYS) -> int:
    """New EMI booking emails into CardEmiBooking. Returns how many were added."""
    import card_bills
    from models import CardEmiBooking
    from statement_sync import _extract_pdf_text, best_statement_pdf
    if service is None:
        service, passwords = card_bills.gmail_for(db, user_id)
    passwords = passwords or []
    have = {g for (g,) in db.query(CardEmiBooking.gmail_message_id).filter(CardEmiBooking.user_id == user_id)}
    resp = service.users().messages().list(userId="me", q=_QUERY.format(days=days), maxResults=50).execute()
    added = 0
    for m in resp.get("messages", []):
        if m["id"] in have:
            continue
        msg = service.users().messages().get(userId="me", id=m["id"], format="full").execute()
        terms = parse_booking(card_bills._body_text(msg.get("payload", {})) or msg.get("snippet", ""))
        if not terms or not terms["amount"]:
            continue
        rows = []
        if card_bills._has_pdf(msg.get("payload", {})):
            try:
                pdf = best_statement_pdf(service, m["id"], msg.get("payload", {}), passwords)
                rows = parse_schedule(_extract_pdf_text(pdf, passwords)) if pdf else []
            except Exception as e:                       # the email's terms still count
                print(f"[card_emi] schedule PDF: {e}")
        if rows and abs(sum(r["principal"] for r in rows) - terms["amount"]) > 2:
            rows = []                                    # a schedule that isn't this booking's
        source = "schedule" if rows else "estimate"
        if not rows and terms["rate_pct"] is not None and terms["first_emi_date"]:
            rows = estimate(terms["amount"], terms["rate_pct"], terms["tenure"], terms["first_emi_date"])
        db.add(CardEmiBooking(user_id=user_id, gmail_message_id=m["id"], bank=_bank_of(card_bills._header(msg, "from")),
                              schedule_json=json.dumps(rows) if rows else None, source=source, **terms))
        added += 1
    db.commit()
    return added


def bookings_for_bill(db, user_id: int, txns: list[dict]) -> dict[str, "object"]:
    """line -> its CardEmiBooking: a debit of the booking's amount, dated
    within MATCH_DAYS of the purchase. Each booking goes to one line."""
    from models import CardEmiBooking
    books = db.query(CardEmiBooking).filter(CardEmiBooking.user_id == user_id).all()
    out, used = {}, set()
    for i, t in enumerate(txns):
        if t.get("type") != "debit" or t.get("memo") or t.get("kind") not in (None, "purchase", "other"):
            continue
        for b in books:
            if b.id in used or abs((t.get("amount") or 0) - (b.txn_amount or b.amount)) > 1:
                continue
            try:
                if b.txn_date and t.get("date") and abs((date.fromisoformat(t["date"]) - date.fromisoformat(b.txn_date)).days) > MATCH_DAYS:
                    continue
            except ValueError:
                pass
            out[str(i)] = b
            used.add(b.id)
            break
    return out


def _bank_due(billed: date, due_day: int | None, due_gap: int | None) -> date:
    """The card's payment due date for a statement: the next `due_day` after
    it (the day-of-month its bills are due on), else statement + usual gap."""
    import calendar
    if due_day:
        y, m = billed.year, billed.month
        for _ in range(2):
            d = date(y, m, min(due_day, calendar.monthrange(y, m)[1]))
            if d > billed:
                return d
            y, m = (y, m + 1) if m < 12 else (y + 1, 1)
    return billed + timedelta(days=due_gap if due_gap is not None else 20)


def plan(b, due_gap: int | None, pass_on_gap: int, due_day: int | None = None) -> dict:
    """What someone this EMI is passed on to pays back, instalment by
    instalment: EMI + GST on its interest (+ the processing fee and its GST
    on the first), each due `pass_on_gap` days before the bank's due date
    (the statement it's billed on + the card's usual `due_gap`)."""
    rows = json.loads(b.schedule_json) if b.schedule_json else []
    fee = round((b.processing_fee or 0) * (1 + GST), 2)
    # part of the purchase not converted: billed in full, so due with the first
    outside = round(max((b.txn_amount or b.amount) - b.amount, 0), 2)
    first_due = (_bank_due(date.fromisoformat(rows[0]["date"]), due_day, due_gap)
                 - timedelta(days=max(0, pass_on_gap or 0))) if rows else None
    out = []
    for k, r in enumerate(rows):
        extra = (fee + outside) if k == 0 else 0
        out.append({"n": r["n"], "billed": r["date"], "due": _add_months(first_due, k).isoformat(),
                    "emi": r["emi"], "interest": r["interest"], "tax": r["tax"], "fee": fee if k == 0 else 0,
                    "outside": outside if k == 0 else 0, "amount": round(r["emi"] + r["tax"] + extra, 2)})
    interest = round(sum(r["interest"] for r in rows), 2)
    tax = round(sum(r["tax"] for r in rows), 2)
    return {"booking_id": b.id, "bank": b.bank, "amount": b.amount, "outside": outside, "rate_pct": b.rate_pct, "tenure": b.tenure,
            "source": b.source, "interest": interest, "tax": tax, "fee": fee,
            "total": round(sum(x["amount"] for x in out), 2), "instalments": out}

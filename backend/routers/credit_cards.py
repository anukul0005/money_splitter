"""Credit Cards: the user's cards (bank, last 4, the day the bill is
generated, its own statement PDF password), the older per-bank PDF
passwords, and each card's bills read from Gmail on those days - see
card_bills.py. Lives alongside /loans as its own section of the same page.
"""
from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import card_bills
import secret_box
import statement_sync
from auth import current_user
from database import get_db
from models import BankPassword, CardPayment, CreditCard, CreditCardStatement, GmailConnection, User

router = APIRouter(prefix="/credit-cards", tags=["credit-cards"])


class SetBankPassword(BaseModel):
    bank: str
    password: str


@router.get("/banks", response_model=list[dict])
def list_banks(db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """Bank names only - the password itself is never sent back once set."""
    rows = db.query(BankPassword).filter(BankPassword.user_id == caller.id).all()
    return [{"bank": r.bank, "updated_at": r.updated_at} for r in rows]


@router.post("/banks", response_model=dict, status_code=201)
def set_bank_password(payload: SetBankPassword, db: Session = Depends(get_db),
                      caller: User = Depends(current_user)):
    bank = payload.bank.strip()
    if not bank or not payload.password:
        raise HTTPException(400, "Bank name and password are required")

    row = (
        db.query(BankPassword)
        .filter(BankPassword.user_id == caller.id, BankPassword.bank.ilike(bank))
        .first()
    )
    encrypted = secret_box.encrypt(payload.password)
    if row:
        row.password_encrypted = encrypted
    else:
        db.add(BankPassword(user_id=caller.id, bank=bank, password_encrypted=encrypted))
    db.commit()
    return {"bank": bank, "saved": True}


@router.get("/banks/{bank}/password", response_model=dict)
def reveal_bank_password(bank: str, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """The caller's own saved password, decrypted - only when they tap Show."""
    row = (db.query(BankPassword)
           .filter(BankPassword.user_id == caller.id, BankPassword.bank.ilike(bank)).first())
    if not row:
        raise HTTPException(404, "No saved password by that name")
    return {"bank": row.bank, "password": secret_box.decrypt(row.password_encrypted)}


@router.delete("/banks/{bank}", status_code=204)
def delete_bank_password(bank: str, db: Session = Depends(get_db),
                         caller: User = Depends(current_user)):
    row = (
        db.query(BankPassword)
        .filter(BankPassword.user_id == caller.id, BankPassword.bank.ilike(bank))
        .first()
    )
    if row:
        db.delete(row)
        db.commit()


# ── cards and their bills ─────────────────────────────────────────────────
class CardIn(BaseModel):
    bank: str
    label: str | None = None
    last4: str | None = None
    bill_day: int


def _clean_card(payload: CardIn) -> dict:
    if payload.bank not in card_bills.BANKS:
        raise HTTPException(400, "Pick a bank from the list")
    if not 1 <= payload.bill_day <= 31:
        raise HTTPException(400, "Bill day must be between 1 and 31")
    last4 = (payload.last4 or "").strip() or None
    if last4 and not (len(last4) == 4 and last4.isdigit()):
        raise HTTPException(400, "Last 4 digits must be 4 numbers")
    return {"bank": payload.bank, "label": (payload.label or "").strip()[:60] or None,
            "last4": last4, "bill_day": payload.bill_day}


def _cycle(r: CreditCardStatement) -> tuple[str | None, str | None]:
    """The billing period a bill covers: the statement's own (read with its
    details), else the previous bill date to the day before this one's -
    how the banks here run it (SBI's 21 Oct bill: 21 Sep to 20 Oct)."""
    import json
    if r.details_json:
        try:
            sm = json.loads(r.details_json).get("summary") or {}
            if sm.get("period_from") and sm.get("period_to"):
                return sm["period_from"], sm["period_to"]
        except ValueError:
            pass
    if not r.statement_date:
        return None, None
    try:
        d = date.fromisoformat(r.statement_date)
    except ValueError:
        return None, None
    y, m = (d.year, d.month - 1) if d.month > 1 else (d.year - 1, 12)
    import calendar
    start = date(y, m, min(d.day, calendar.monthrange(y, m)[1]))
    return start.isoformat(), (d - timedelta(days=1)).isoformat()


def _spend_month(r: CreditCardStatement) -> str | None:
    """The month a bill's spending is from - where the middle of its billing
    period falls, not the month it was generated: ICICI's 6 Oct bill (6 Sep -
    5 Oct) is September's, SBI's 21 Oct one (21 Sep - 20 Oct) October's."""
    a, b = _cycle(r)
    if not (a and b):
        return r.period
    lo, hi = date.fromisoformat(a), date.fromisoformat(b)
    return (lo + (hi - lo) / 2).strftime("%Y-%m")


def _bill_out(r: CreditCardStatement, payments: list[CardPayment], latest: bool) -> dict:
    paid = round(sum(p.amount for p in payments), 2)
    cycle_from, cycle_to = _cycle(r)
    return {"cycle_from": cycle_from, "cycle_to": cycle_to, "spend_month": _spend_month(r),"payments": [{"id": p.id, "amount": p.amount, "paid_on": p.paid_on} for p in payments],
            "paid": paid, "remaining": round(max((r.total_due or 0) - paid, 0), 2) if r.total_due is not None else None,
            "can_pay": latest, "has_details": bool(r.details_json), "id": r.id, "card_id": r.card_id, "period": r.period, "bank": r.bank, "card_last4": r.card_last4,
            "statement_date": r.statement_date, "due_date": r.due_date, "total_due": r.total_due,
            "minimum_due": r.minimum_due, "email_subject": r.email_subject, "source": r.source,
            "extracted_at": r.extracted_at}


def _own_card(db: Session, card_id: int, caller: User) -> CreditCard:
    card = db.query(CreditCard).filter(CreditCard.id == card_id, CreditCard.user_id == caller.id).first()
    if not card:
        raise HTTPException(404, "Card not found")
    return card


@router.get("/bank-options", response_model=list[str])
def bank_options(caller: User = Depends(current_user)):
    return list(card_bills.BANKS)


@router.get("/cards", response_model=list[dict])
def list_cards(db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """Each card with its saved bills (newest month first) and next bill date."""
    today = date.today()
    out = []
    for c in db.query(CreditCard).filter(CreditCard.user_id == caller.id).order_by(CreditCard.bill_day, CreditCard.id):
        bills = (db.query(CreditCardStatement).filter(CreditCardStatement.card_id == c.id)
                 .order_by(CreditCardStatement.period.desc()).all())
        pays: dict[int, list[CardPayment]] = {}
        for p in (db.query(CardPayment).filter(CardPayment.statement_id.in_([b.id for b in bills]))
                  .order_by(CardPayment.paid_on, CardPayment.id)):
            pays.setdefault(p.statement_id, []).append(p)
        last = card_bills.recent_bill_dates(c.bill_day, today, 1)[0]
        y, m = (last.year, last.month + 1) if last.month < 12 else (last.year + 1, 1)
        out.append({"id": c.id, "bank": c.bank, "label": c.label, "last4": c.last4, "bill_day": c.bill_day,
                    "has_password": bool(c.pdf_password_encrypted),
                    "name": card_bills.card_name(c), "last_bill": last.isoformat(),
                    "next_bill": card_bills.bill_date(c.bill_day, y, m).isoformat(),
                    "bills": [_bill_out(b, pays.get(b.id, []), i == 0) for i, b in enumerate(bills)]})
    return out


@router.post("/cards", response_model=dict, status_code=201)
def add_card(payload: CardIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    card = CreditCard(user_id=caller.id, **_clean_card(payload))
    db.add(card)
    db.commit()
    return {"id": card.id}


@router.put("/cards/{card_id}", response_model=dict)
def update_card(card_id: int, payload: CardIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    card = _own_card(db, card_id, caller)
    fields = _clean_card(payload)
    if (fields["bill_day"], fields["bank"], fields["last4"]) != (card.bill_day, card.bank, card.last4):
        # Found on the old day / bank / card - fetch again with the new one.
        db.query(CreditCardStatement).filter(CreditCardStatement.card_id == card.id).delete()
    for k, v in fields.items():
        setattr(card, k, v)
    db.commit()
    return {"id": card.id}


class CardPasswordIn(BaseModel):
    password: str | None = None


@router.get("/cards/{card_id}/password", response_model=dict)
def reveal_card_password(card_id: int, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """This card's own PDF password, decrypted - only when the owner taps Show."""
    card = _own_card(db, card_id, caller)
    return {"password": secret_box.decrypt(card.pdf_password_encrypted) if card.pdf_password_encrypted else None}


@router.put("/cards/{card_id}/password", response_model=dict)
def set_card_password(card_id: int, payload: CardPasswordIn, db: Session = Depends(get_db),
                      caller: User = Depends(current_user)):
    """Set or change this card's PDF password; empty removes it. A breakup
    that failed for want of it can then be read again."""
    card = _own_card(db, card_id, caller)
    pw = payload.password or ""
    card.pdf_password_encrypted = secret_box.encrypt(pw) if pw else None
    db.commit()
    return {"has_password": bool(pw)}


@router.delete("/cards/{card_id}", status_code=204)
def delete_card(card_id: int, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    card = _own_card(db, card_id, caller)
    db.query(CreditCardStatement).filter(CreditCardStatement.card_id == card.id).delete()
    db.delete(card)
    db.commit()


@router.delete("/bills/{bill_id}", status_code=204)
def delete_bill(bill_id: int, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """A wrong bill - removing it lets the next fetch look for that month again."""
    row = db.query(CreditCardStatement).filter(CreditCardStatement.id == bill_id,
                                               CreditCardStatement.user_id == caller.id).first()
    if row:
        db.delete(row)
        db.commit()


class PaymentIn(BaseModel):
    amount: float
    paid_on: str | None = None


@router.post("/bills/{bill_id}/payments", response_model=dict, status_code=201)
def record_payment(bill_id: int, payload: PaymentIn, db: Session = Depends(get_db),
                   caller: User = Depends(current_user)):
    """A full or part payment against one bill - whichever billing cycle it
    paid off (the form asks), so each bill's paid-vs-billed stays true."""
    bill = db.query(CreditCardStatement).filter(CreditCardStatement.id == bill_id,
                                                CreditCardStatement.user_id == caller.id).first()
    if not bill:
        raise HTTPException(404, "Bill not found")
    amount = round(payload.amount, 2)
    if amount <= 0:
        raise HTTPException(400, "Amount must be more than zero")
    paid_on = payload.paid_on or date.today().isoformat()
    try:
        date.fromisoformat(paid_on)
    except ValueError:
        raise HTTPException(400, "Date must be YYYY-MM-DD")
    row = CardPayment(statement_id=bill.id, user_id=caller.id, amount=amount, paid_on=paid_on)
    db.add(row)
    db.commit()
    return {"id": row.id}


@router.delete("/payments/{payment_id}", status_code=204)
def delete_payment(payment_id: int, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    row = db.query(CardPayment).filter(CardPayment.id == payment_id, CardPayment.user_id == caller.id).first()
    if row:
        db.delete(row)
        db.commit()


def _own_bill(db: Session, bill_id: int, caller: User) -> CreditCardStatement:
    bill = db.query(CreditCardStatement).filter(CreditCardStatement.id == bill_id,
                                                CreditCardStatement.user_id == caller.id).first()
    if not bill:
        raise HTTPException(404, "Bill not found")
    return bill


def _transfers(db: Session, bill_id: int, caller: User) -> dict:
    from models import Loan
    out: dict[str, list] = {}
    for l in db.query(Loan).filter(Loan.card_ref.like(f"bill:{bill_id}:%")).order_by(Loan.id):
        if l.lender.lower() == caller.name.lower():
            out.setdefault(l.card_ref.rsplit(":", 1)[1], []).append(
                {"loan_id": l.id, "to": l.borrower, "amount": l.principal})
    return out


_EMI = __import__("re").compile(r"\bEMI\b\D{0,3}0*(\d{1,2})\s*/\s*0*(\d{1,2})", __import__("re").I)


def _emi_covered(db: Session, bill: CreditCardStatement, caller: User) -> dict:
    """line -> {loan_id, to, at, of}: this bill's "EMI 02/03" when "EMI 01/03" of
    the same plan (same card, same instalment amount, same length) was passed
    on from an earlier bill - its loan already holds every instalment, so the
    line isn't to be passed on again."""
    import json
    from models import Loan
    if not bill.details_json or not bill.card_id:
        return {}
    try:
        txns = json.loads(bill.details_json).get("transactions") or []
    except ValueError:
        return {}
    here = [(i, _EMI.search(t.get("description") or ""), t) for i, t in enumerate(txns)]
    here = [(i, m, t) for i, m, t in here if m and int(m.group(1)) > 1]
    if not here:
        return {}
    out: dict[str, dict] = {}
    src_cache: dict[int, list] = {}
    for l in db.query(Loan).filter(Loan.card_ref.like("bill:%"), Loan.emi_plan.isnot(None)).order_by(Loan.id):
        if l.lender.lower() != caller.name.lower():
            continue
        try:
            sid, idx = (int(v) for v in l.card_ref.split(":")[1:3])
        except ValueError:
            continue
        if sid not in src_cache:
            src = db.get(CreditCardStatement, sid)
            ok = src and src.card_id == bill.card_id and src.details_json and (src.period or "") < (bill.period or "")
            src_cache[sid] = (json.loads(src.details_json).get("transactions") or []) if ok else []
        if idx >= len(src_cache[sid]):
            continue
        st = src_cache[sid][idx]
        sm = _EMI.search(st.get("description") or "")
        if not sm:
            continue
        for i, m, t in here:
            if (m.group(2) == sm.group(2) and int(m.group(1)) > int(sm.group(1))
                    and abs((t.get("amount") or 0) - (st.get("amount") or 0)) < 1 and str(i) not in out):
                out[str(i)] = {"loan_id": l.id, "to": l.borrower, "at": int(m.group(1)), "of": int(m.group(2))}
    return out


class LineCategory(BaseModel):
    category: str
    subcategory: str | None = None


@router.get("/insights", response_model=dict)
def insights(month: str | None = None, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """Every card's spending in one month (the month the spending is from -
    _spend_month), merchant by merchant: the biggest merchants and the most
    visited, categories, and the biggest single spends, each split by card.
    Only the lines that are the bills' own count (card_details.assemble), with
    merchants filed by hand taking their category."""
    import json
    from collections import defaultdict
    import card_details
    rows = (db.query(CreditCardStatement, CreditCard)
            .join(CreditCard, CreditCard.id == CreditCardStatement.card_id)
            .filter(CreditCardStatement.user_id == caller.id, CreditCardStatement.details_json.isnot(None)).all())
    by_month: dict[str, list] = defaultdict(list)
    for bill, card in rows:
        by_month[_spend_month(bill)].append((bill, card))
    months = sorted((m for m in by_month if m), reverse=True)
    month = month if month in by_month else (months[0] if months else None)
    out = {"months": months, "month": month, "cards": [], "total": 0, "merchants": [], "frequent": [],
           "categories": [], "biggest": []}
    if not month:
        return out
    merchants: dict[str, dict] = {}
    cats: dict[str, dict] = {}
    spends = []
    cards = {}
    for bill, card in by_month[month]:
        saved = json.loads(bill.details_json)
        ts = saved.get("transactions") or []
        card_details.rerule(ts)
        card_details.apply_known(ts, card_details.known_categories(db, ts, caller.name))
        card_details.assemble(saved.get("summary") or {}, ts, saved.get("read_at"), _cycle(bill))
        cards[card.id] = card_bills.card_name(card)
        for t in ts:
            if t.get("excluded") or t["type"] != "debit" or t.get("category") == "Card fees & interest":
                continue
            amt = t["amount"]
            key = card_details.shown_key(t)
            m = merchants.setdefault(key, {"name": card_details.shown_name(t), "amount": 0.0, "known": bool(t.get("category_by") in ("you", "shared")),
                                           "count": 0, "by_card": defaultdict(float), "category": t.get("category")})
            m["amount"] += amt
            m["count"] += 1
            m["by_card"][card.id] += amt
            c = cats.setdefault(t.get("category") or "Other", {"amount": 0.0, "count": 0, "by_card": defaultdict(float)})
            c["amount"] += amt
            c["count"] += 1
            c["by_card"][card.id] += amt
            spends.append({"date": t.get("date"), "name": card_details.shown_name(t), "amount": amt,
                           "card_id": card.id, "category": t.get("category")})
    fix = lambda d: {k: round(v, 2) for k, v in d.items()}
    out["cards"] = [{"id": k, "name": v} for k, v in cards.items()]
    out["total"] = round(sum(x["amount"] for x in spends), 2)
    out["merchants"] = [{**m, "amount": round(m["amount"], 2), "by_card": fix(m["by_card"])}
                        for m in sorted(merchants.values(), key=lambda m: -m["amount"])[:10]]
    out["frequent"] = [{**m, "amount": round(m["amount"], 2), "by_card": fix(m["by_card"])}
                       for m in sorted(merchants.values(), key=lambda m: (-m["count"], -m["amount"])) if m["count"] > 1][:6]
    out["categories"] = [{"name": k, "amount": round(v["amount"], 2), "count": v["count"], "by_card": fix(v["by_card"])}
                         for k, v in sorted(cats.items(), key=lambda kv: -kv[1]["amount"])]
    out["biggest"] = sorted(spends, key=lambda x: -x["amount"])[:5]
    out["merchant_count"] = len(merchants)
    return out


@router.get("/categories", response_model=dict)
def categories(caller: User = Depends(current_user)):
    """The categories a card spend can be filed under."""
    from spend_categories import TAXONOMY
    return {"categories": {c: subs for c, subs in TAXONOMY.items()}}


@router.post("/bills/{bill_id}/lines/{line}/category", response_model=dict)
def set_line_category(bill_id: int, line: int, payload: LineCategory, db: Session = Depends(get_db),
                      caller: User = Depends(current_user)):
    """File one spend yourself. The merchant goes into the shared merchant
    memory (merchant_memory.learn): everyone's bills and statement imports
    file it so from then on, and no AI is asked about it again. A card swipe
    is a business, so it's shared even when its name reads like a person's;
    a UPI line to a person's name stays the filer's own."""
    import json
    import re
    import card_details
    import merchant_memory
    from spend_categories import TAXONOMY
    if payload.category not in TAXONOMY or (payload.subcategory and payload.subcategory not in TAXONOMY[payload.category]):
        raise HTTPException(400, "Pick a category from the list")
    bill = _own_bill(db, bill_id, caller)
    details = json.loads(bill.details_json or "{}")
    txns = details.get("transactions") or []
    if not 0 <= line < len(txns):
        raise HTTPException(404, "No such line on this bill")
    t = txns[line]
    t["category"], t["subcategory"], t["category_by"] = payload.category, payload.subcategory, "you"
    bill.details_json = json.dumps(details)
    merchant_memory.learn(db, card_details.merchant_name(t["description"]), payload.category, payload.subcategory,
                          caller.name, shared=not re.match(r"\s*upi", t["description"], re.I))
    db.commit()
    return {"ok": True, "merchant": card_details.merchant_name(t["description"])}


@router.get("/bills/{bill_id}/details", response_model=dict)
def bill_details(bill_id: int, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """The bill's breakup from its PDF: "ready" with the details, "reading"
    (with the current step) while a read is running, "error", or "none"
    when it hasn't been read yet - see card_details.py."""
    import json
    import card_details
    bill = _own_bill(db, bill_id, caller)
    card = db.get(CreditCard, bill.card_id) if bill.card_id else None
    head = {"bill": {"id": bill.id, "period": bill.period, "spend_month": _spend_month(bill), "card": card_bills.card_name(card) if card else bill.bank,
                     "total_due": bill.total_due, "minimum_due": bill.minimum_due, "due_date": bill.due_date,
                     "statement_date": bill.statement_date},
            # Lines passed on to someone as a loan: line -> [{loan_id, to, amount}]
            "transfers": _transfers(db, bill.id, caller),
            # Later instalments of an EMI already passed on from an earlier bill
            "emi_covered": _emi_covered(db, bill, caller)}
    live = card_details.status(bill.id)
    if live and live["status"] == "reading":
        return {**head, **live}
    if bill.details_json:
        # Re-assembled each time it's shown: only the lines that are this bill's
        # count (card_details.reconcile) - bills read before that fix included
        saved = json.loads(bill.details_json)
        card_details.rerule(saved.get("transactions") or [])
        ts = saved.get("transactions") or []
        card_details.apply_known(ts, card_details.known_categories(db, ts, caller.name))
        fresh = card_details.assemble(saved.get("summary") or {}, saved.get("transactions") or [],
                                      saved.get("read_at"), _cycle(bill))
        saved.pop("source_text", None)
        fresh.pop("source_text", None)
        return {**head, "status": "ready", **saved, **fresh}
    return {**head, **(live or {"status": "none"})}


@router.post("/bills/{bill_id}/details", response_model=dict, status_code=202)
def read_bill_details(bill_id: int, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """Read (or re-read) the bill's PDF in the background."""
    import card_details
    bill = _own_bill(db, bill_id, caller)
    card_details.start(caller.id, bill.id)
    return {"started": True}


@router.post("/cards/{card_id}/fetch-month", response_model=dict)
def fetch_month(card_id: int, period: str, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """One card's bill for one month ("YYYY-MM"): the saved one, or searched
    in Gmail on that month's bill date now. A future bill date is refused."""
    import re as _re
    card = _own_card(db, card_id, caller)
    if not _re.fullmatch(r"\d{4}-\d{2}", period or ""):
        raise HTTPException(400, "Month must be YYYY-MM")
    y, m = map(int, period.split("-"))
    if not 1 <= m <= 12:
        raise HTTPException(400, "Month must be YYYY-MM")
    d = card_bills.bill_date(card.bill_day, y, m)
    if d > date.today():
        raise HTTPException(400, f"This bill is generated on {d:%d %b %Y} - it isn't out yet")
    try:
        service, passwords = card_bills.gmail_for(db, caller.id)
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    return card_bills.fetch_one(db, caller.id, card, d, service, passwords)


@router.post("/fetch", response_model=dict, status_code=202)
def fetch(months: int = 2, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """Each card's last `months` bills from Gmail, in the background - the
    page polls /scan/progress. Months already saved are skipped."""
    if not 1 <= months <= 12:
        raise HTTPException(400, "Months must be 1-12")
    if not db.query(GmailConnection).filter(GmailConnection.user_id == caller.id).first():
        raise HTTPException(400, "Gmail isn't connected for this account")
    if not db.query(CreditCard).filter(CreditCard.user_id == caller.id).first():
        raise HTTPException(400, "Add your cards and their bill dates first")
    try:
        statement_sync.start_card_fetch(caller.id, months, date.today())
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    return {"started": True}


@router.get("/scan/progress", response_model=dict)
def scan_progress(caller: User = Depends(current_user)):
    return statement_sync.get_progress(caller.id)

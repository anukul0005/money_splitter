"""Credit Cards: the user's cards (bank, last 4, the day the bill is
generated), bank statement passwords, and each card's bills read from
Gmail on those days - see card_bills.py. Lives alongside /loans as its own
section of the same page.
"""
from __future__ import annotations

from datetime import date

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


def _bill_out(r: CreditCardStatement, payments: list[CardPayment], latest: bool) -> dict:
    paid = round(sum(p.amount for p in payments), 2)
    return {"payments": [{"id": p.id, "amount": p.amount, "paid_on": p.paid_on} for p in payments],
            "paid": paid, "remaining": round(max((r.total_due or 0) - paid, 0), 2) if r.total_due is not None else None,
            "can_pay": latest, "id": r.id, "card_id": r.card_id, "period": r.period, "bank": r.bank, "card_last4": r.card_last4,
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
    """A full or part payment against a card's latest bill. Older months are
    closed - their payments, if any, stay as they were."""
    bill = db.query(CreditCardStatement).filter(CreditCardStatement.id == bill_id,
                                                CreditCardStatement.user_id == caller.id).first()
    if not bill:
        raise HTTPException(404, "Bill not found")
    latest = (db.query(CreditCardStatement).filter(CreditCardStatement.card_id == bill.card_id)
              .order_by(CreditCardStatement.period.desc()).first())
    if not latest or latest.id != bill.id:
        raise HTTPException(400, "Payments can only be recorded against the card's latest bill")
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

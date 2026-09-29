"""Credit Cards: bank statement passwords, and the extracted bills those
passwords unlock. Lives alongside /loans as its own section of the same
page - see statement_sync.py for the actual Gmail scan + extraction.
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import secret_box
import statement_sync
from auth import current_user
from database import get_db
from models import BankPassword, CreditCardStatement, GmailConnection, User

router = APIRouter(prefix="/credit-cards", tags=["credit-cards"])

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _valid_date(value: str | None) -> str | None:
    if value and not _DATE_RE.match(value):
        raise HTTPException(400, "Dates must be in YYYY-MM-DD form")
    return value


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


@router.get("/statements", response_model=list[dict])
def list_statements(db: Session = Depends(get_db), caller: User = Depends(current_user)):
    rows = (
        db.query(CreditCardStatement)
        .filter(CreditCardStatement.user_id == caller.id)
        .order_by(CreditCardStatement.due_date.desc().nullslast(),
                  CreditCardStatement.extracted_at.desc())
        .all()
    )
    return [
        {
            "id": r.id,
            "bank": r.bank,
            "card_last4": r.card_last4,
            "statement_date": r.statement_date,
            "due_date": r.due_date,
            "total_due": r.total_due,
            "minimum_due": r.minimum_due,
            "extracted_at": r.extracted_at,
        }
        for r in rows
    ]


@router.post("/scan", response_model=dict, status_code=202)
def scan(after: str | None = None, before: str | None = None,
        db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """Kicks off a scan in the background and returns immediately - a real
    scan (Gmail search + PDF unlock + an LLM call per email) can take well
    over the length of one HTTP request. The frontend polls /scan/progress
    for what's happening instead of blocking on this call.

    `after`/`before` (YYYY-MM-DD) narrow the Gmail search to a date window -
    each bank bills on its own predictable few days of the month, so a
    person who knows those days can search just that window instead of
    scanning everything. Leaving both blank falls back to the last 9 months.

    The obvious, immediate failures (not connected, no bank passwords) are
    still checked synchronously here so they show up as a normal error
    right away rather than only in the progress poll."""
    after, before = _valid_date(after), _valid_date(before)
    if not db.query(GmailConnection).filter(GmailConnection.user_id == caller.id).first():
        raise HTTPException(400, "Gmail isn't connected for this account")
    if not db.query(BankPassword).filter(BankPassword.user_id == caller.id).first():
        raise HTTPException(400, "Add at least one bank's password before scanning")
    try:
        statement_sync.start_sync(caller.id, after=after, before=before)
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    return {"started": True}


@router.get("/scan/progress", response_model=dict)
def scan_progress(caller: User = Depends(current_user)):
    return statement_sync.get_progress(caller.id)

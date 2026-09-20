"""Loans, borrowings and recurring shared bills.

Kept out of the group ledger on purpose: a loan isn't a group expense and a
subscription isn't a one-off. What people owe through here still reaches
Home's You Owe / Owed to You totals - see GET /loans/, whose `totals` the
frontend adds to the group-derived ones.
"""
from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from auth import current_user, is_member
from database import get_db
from loan_calc import outstanding
from models import Group, Loan, LoanPayment, RecurringBill, RecurringCharge, User

router = APIRouter(prefix="/loans", tags=["loans"])


def _known_people(db: Session, caller: User) -> dict[str, str]:
    """lower-name -> display name of everyone who shares a group with the
    caller (and the caller). Loans and bills can only name these people -
    otherwise anyone could put a debt in front of a stranger."""
    people = {caller.name.lower(): caller.name}
    for g in db.query(Group).all():
        if is_member(g, caller):
            for m in g.members:
                people.setdefault(m.name.lower(), m.name)
    return people


def _same(a: str, b: str) -> bool:
    return a.strip().lower() == b.strip().lower()


class LoanCreate(BaseModel):
    role: str                  # "lent" (caller is the lender) | "borrowed"
    other: str
    amount: float
    start_date: Optional[str] = None
    due_date: str
    interest: bool = False
    note: Optional[str] = None

    @field_validator("amount")
    @classmethod
    def positive(cls, v):
        if v <= 0:
            raise ValueError("amount must be positive")
        return round(v, 2)

    @field_validator("role")
    @classmethod
    def role_ok(cls, v):
        if v not in ("lent", "borrowed"):
            raise ValueError("role must be 'lent' or 'borrowed'")
        return v


class RepayIn(BaseModel):
    amount: float
    date: Optional[str] = None

    @field_validator("amount")
    @classmethod
    def positive(cls, v):
        if v <= 0:
            raise ValueError("amount must be positive")
        return round(v, 2)


class BillCreate(BaseModel):
    title: str
    amount: float
    members: list[str]         # the other people sharing it; the caller pays
    day_of_month: int = 1

    @field_validator("amount")
    @classmethod
    def positive(cls, v):
        if v <= 0:
            raise ValueError("amount must be positive")
        return round(v, 2)


def _iso(s: str, what: str) -> str:
    try:
        return date.fromisoformat(s).isoformat()
    except (TypeError, ValueError):
        raise HTTPException(400, f"{what} must be a date (YYYY-MM-DD)")


def _loan_out(loan: Loan) -> dict:
    o = outstanding(loan)
    return {
        "id": loan.id, "lender": loan.lender, "borrower": loan.borrower,
        "principal": loan.principal, "has_interest": loan.has_interest,
        "rate_pct": loan.rate_pct, "start_date": loan.start_date,
        "due_date": loan.due_date, "note": loan.note, **o,
        "paid": o["total_due"] <= 0.01,
        "payments": [{"id": p.id, "amount": p.amount, "date": p.date} for p in loan.payments],
    }


def _bill_out(bill: RecurringBill) -> dict:
    return {
        "id": bill.id, "title": bill.title, "amount": bill.amount, "payer": bill.payer,
        "members": [m for m in bill.members.split(",") if m],
        "day_of_month": bill.day_of_month, "active": bill.active,
        "charges": [
            {"id": c.id, "period": c.period, "member": c.member, "share": c.share,
             "paid": c.paid, "paid_on": c.paid_on}
            for c in sorted(bill.charges, key=lambda c: (c.period, c.member), reverse=True)
        ],
    }


@router.get("/", response_model=dict)
def list_all(db: Session = Depends(get_db), caller: User = Depends(current_user)):
    me = caller.name
    loans = [l for l in db.query(Loan).all() if _same(l.lender, me) or _same(l.borrower, me)]
    bills = [b for b in db.query(RecurringBill).filter(RecurringBill.active == True).all()  # noqa: E712
             if _same(b.payer, me) or any(_same(m, me) for m in b.members.split(","))]

    owe: dict[str, float] = {}    # what the caller owes, by person
    owed: dict[str, float] = {}   # what the caller is owed, by person
    loan_rows = []
    for l in loans:
        row = _loan_out(l)
        loan_rows.append(row)
        due = row["total_due"]
        if due > 0.01:
            if _same(l.borrower, me):
                owe[l.lender] = owe.get(l.lender, 0) + due
            else:
                owed[l.borrower] = owed.get(l.borrower, 0) + due
    for b in bills:
        for c in b.charges:
            if c.paid:
                continue
            if _same(c.member, me):
                owe[b.payer] = owe.get(b.payer, 0) + c.share
            elif _same(b.payer, me):
                owed[c.member] = owed.get(c.member, 0) + c.share

    return {
        "loans": sorted(loan_rows, key=lambda r: (r["paid"], r["due_date"])),
        "bills": [_bill_out(b) for b in bills],
        "totals": {
            "owe": round(sum(owe.values()), 2), "owed": round(sum(owed.values()), 2),
            "owe_people": sorted(owe), "owed_people": sorted(owed),
        },
    }


@router.post("/", response_model=dict, status_code=201)
def create_loan(payload: LoanCreate, db: Session = Depends(get_db),
                caller: User = Depends(current_user)):
    people = _known_people(db, caller)
    other = people.get(payload.other.strip().lower())
    if not other or _same(other, caller.name):
        raise HTTPException(400, "Pick someone you share a group with")
    start = _iso(payload.start_date or date.today().isoformat(), "Start date")
    due = _iso(payload.due_date, "Due date")
    lender, borrower = (caller.name, other) if payload.role == "lent" else (other, caller.name)
    loan = Loan(lender=lender, borrower=borrower, principal=payload.amount,
                has_interest=payload.interest, rate_pct=3.6, start_date=start,
                due_date=due, note=payload.note, created_by=caller.name)
    db.add(loan)
    db.commit()
    db.refresh(loan)
    return _loan_out(loan)


def _loan_for(db: Session, loan_id: int, caller: User) -> Loan:
    loan = db.query(Loan).filter(Loan.id == loan_id).first()
    if not loan or not (_same(loan.lender, caller.name) or _same(loan.borrower, caller.name)):
        raise HTTPException(404, "Loan not found")
    return loan


@router.post("/{loan_id}/payments", response_model=dict)
def repay(loan_id: int, payload: RepayIn, db: Session = Depends(get_db),
          caller: User = Depends(current_user)):
    loan = _loan_for(db, loan_id, caller)
    when = _iso(payload.date or date.today().isoformat(), "Date")
    db.add(LoanPayment(loan_id=loan.id, amount=payload.amount, date=when))
    db.commit()
    db.refresh(loan)
    return _loan_out(loan)


@router.delete("/{loan_id}", status_code=204)
def delete_loan(loan_id: int, db: Session = Depends(get_db),
                caller: User = Depends(current_user)):
    loan = _loan_for(db, loan_id, caller)
    db.delete(loan)
    db.commit()


@router.post("/bills", response_model=dict, status_code=201)
def create_bill(payload: BillCreate, db: Session = Depends(get_db),
                caller: User = Depends(current_user)):
    """The caller is the one paying the bill; the other members get billed
    their equal share every month."""
    people = _known_people(db, caller)
    members = {caller.name.lower(): caller.name}
    for raw in payload.members:
        n = people.get(raw.strip().lower())
        if not n:
            raise HTTPException(400, f"{raw} isn't someone you share a group with")
        members[n.lower()] = n
    if len(members) < 2:
        raise HTTPException(400, "A shared bill needs at least one other person")
    if not 1 <= payload.day_of_month <= 28:
        raise HTTPException(400, "Day of month must be 1-28")
    bill = RecurringBill(title=payload.title.strip(), amount=payload.amount, payer=caller.name,
                         members=",".join(members.values()), day_of_month=payload.day_of_month)
    db.add(bill)
    db.commit()
    db.refresh(bill)
    return _bill_out(bill)


@router.post("/bills/charges/{charge_id}/paid", response_model=dict)
def mark_charge_paid(charge_id: int, db: Session = Depends(get_db),
                     caller: User = Depends(current_user)):
    """Only whoever paid the bill can say a share of it has been paid back -
    the person owing it can't clear their own debt."""
    c = db.query(RecurringCharge).filter(RecurringCharge.id == charge_id).first()
    if not c or not _same(c.bill.payer, caller.name):
        raise HTTPException(404, "Charge not found")
    c.paid = not c.paid
    c.paid_on = date.today().isoformat() if c.paid else None
    db.commit()
    return {"id": c.id, "paid": c.paid, "paid_on": c.paid_on}


@router.delete("/bills/{bill_id}", status_code=204)
def stop_bill(bill_id: int, db: Session = Depends(get_db),
              caller: User = Depends(current_user)):
    bill = db.query(RecurringBill).filter(RecurringBill.id == bill_id).first()
    if not bill or not _same(bill.payer, caller.name):
        raise HTTPException(404, "Bill not found")
    bill.active = False
    db.commit()

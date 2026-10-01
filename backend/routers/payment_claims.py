"""Payer-says-paid, payee-confirms.

Paying through a UPI app (see the frontend's PayViaUpi) leaves this server
with no idea whether money actually moved - the deep link never reports
back. So the payer files a claim, and only the person being paid can turn it
into a recorded payment. Rejecting it records nothing.

Confirming reuses the exact code paths a hand-recorded repayment uses
(loans.repay, loans.repay_bill, payments.create_payment_auto), so balances,
activity and notifications behave the same as if the payee had typed it in.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from auth import current_user
from database import get_db
from emailer import send_notice
from loan_calc import outstanding
from models import Loan, LoanPayment, PaymentClaim, RecurringBill, User

router = APIRouter(prefix="/payment-claims", tags=["payment-claims"])

KINDS = ("loan", "bill", "balance")


def _same(a: str, b: str) -> bool:
    return (a or "").strip().lower() == (b or "").strip().lower()


class ClaimCreate(BaseModel):
    payee: str
    amount: float
    kind: str
    ref_id: Optional[int] = None
    note: Optional[str] = None

    @field_validator("amount")
    @classmethod
    def positive(cls, v):
        if v <= 0:
            raise ValueError("amount must be positive")
        return round(v, 2)

    @field_validator("kind")
    @classmethod
    def kind_ok(cls, v):
        if v not in KINDS:
            raise ValueError(f"kind must be one of {', '.join(KINDS)}")
        return v


def _out(c: PaymentClaim) -> dict:
    return {
        "id": c.id, "payer": c.payer, "payee": c.payee, "amount": c.amount,
        "kind": c.kind, "ref_id": c.ref_id, "note": c.note, "status": c.status,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "when": _when(c),
    }


_IST = timezone(timedelta(hours=5, minutes=30))


def _when(c: PaymentClaim) -> str:
    """When the payer said they paid, in IST - "2 Oct 2026, 3:12 PM" - so the
    payee can find the matching entry in their own UPI app's history. A
    fixed offset rather than zoneinfo: India has no DST, and this doesn't
    then depend on the server having a tz database installed."""
    if not c.created_at:
        return "just now"
    t = c.created_at.astimezone(_IST)
    hour = t.hour % 12 or 12
    return f"{t.day} {t:%b %Y}, {hour}:{t:%M} {'AM' if t.hour < 12 else 'PM'} IST"


def _what(c: PaymentClaim, db: Session) -> str:
    """Plain-English "for what" - shown on the payee's card and in the notice."""
    if c.kind == "loan":
        return "loan repayment"
    if c.kind == "bill":
        bill = db.query(RecurringBill).filter(RecurringBill.id == c.ref_id).first()
        return bill.title if bill else "shared bill"
    return "settling up"


@router.post("/", response_model=dict, status_code=201)
def create_claim(payload: ClaimCreate, db: Session = Depends(get_db),
                 caller: User = Depends(current_user)):
    payee_user = db.query(User).filter(User.name.ilike(payload.payee.strip())).first()
    if not payee_user:
        raise HTTPException(400, f"{payload.payee} has no account to confirm this - "
                                 "record the repayment yourself from Loans instead")
    if _same(payee_user.name, caller.name):
        raise HTTPException(400, "You can't pay yourself")

    if payload.kind == "loan":
        loan = db.query(Loan).filter(Loan.id == payload.ref_id).first()
        if not loan or not _same(loan.borrower, caller.name) or not _same(loan.lender, payee_user.name):
            raise HTTPException(404, "Loan not found")
    elif payload.kind == "bill":
        bill = db.query(RecurringBill).filter(RecurringBill.id == payload.ref_id).first()
        members = (bill.members.split(",") if bill else [])
        if not bill or not _same(bill.payer, payee_user.name) or not any(_same(m, caller.name) for m in members):
            raise HTTPException(404, "Bill not found")

    claim = PaymentClaim(
        payer=caller.name, payee=payee_user.name, amount=payload.amount,
        kind=payload.kind, ref_id=payload.ref_id if payload.kind != "balance" else None,
        note=(payload.note or "").strip()[:200] or None, status="pending",
    )
    db.add(claim)
    db.commit()
    db.refresh(claim)

    what = _what(claim, db)
    send_notice(
        db, payee_user.name, f"{caller.name} says they paid you ₹{claim.amount:,.2f}",
        [f"{caller.name} says they sent you ₹{claim.amount:,.2f} by UPI ({what}).",
         f"Marked as paid: {_when(claim)} - look for a payment around then in your UPI app's history.",
         "Tap the button below - SplitEasy will ask you Yes (it arrived) or No (it didn't) "
         "before anything else. Nothing is recorded until you answer."],
        f"Did ₹{claim.amount:,.0f} from {caller.name} arrive? Paid {_when(claim)}",
        # The confirm prompt is app-wide (PaymentClaimsInbox blocks every
        # page until it's answered), so any in-app URL lands on it - this
        # one just names what it's for.
        url="/?confirm=payment",
        button_label="Confirm or reject this payment",
    )
    return _out(claim)


@router.get("/incoming", response_model=list[dict])
def incoming(db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """Claims waiting on the caller to confirm - the payee's cards."""
    rows = (db.query(PaymentClaim)
            .filter(PaymentClaim.status == "pending", PaymentClaim.payee.ilike(caller.name))
            .order_by(PaymentClaim.created_at).all())
    return [{**_out(c), "what": _what(c, db)} for c in rows]


@router.get("/outgoing", response_model=list[dict])
def outgoing(db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """The caller's own claims still waiting on someone else."""
    rows = (db.query(PaymentClaim)
            .filter(PaymentClaim.status == "pending", PaymentClaim.payer.ilike(caller.name))
            .order_by(PaymentClaim.created_at).all())
    return [{**_out(c), "what": _what(c, db)} for c in rows]


def _pending_for_payee(db: Session, claim_id: int, caller: User) -> PaymentClaim:
    c = db.query(PaymentClaim).filter(PaymentClaim.id == claim_id).first()
    if not c or not _same(c.payee, caller.name):
        raise HTTPException(404, "Claim not found")
    if c.status != "pending":
        raise HTTPException(409, f"Already {c.status}")
    return c


def _apply_to_loans(db: Session, payer: str, payee: str, amount: float) -> float:
    """Pay down payer→payee loans, oldest first. Returns how much was applied."""
    loans = sorted(
        (l for l in db.query(Loan).all() if _same(l.borrower, payer) and _same(l.lender, payee)),
        key=lambda l: (l.start_date or "", l.id),
    )
    remaining = amount
    today = date.today().isoformat()
    for l in loans:
        if remaining <= 0.01:
            break
        due = outstanding(l)["total_due"]
        if due <= 0.01:
            continue
        part = round(min(due, remaining), 2)
        db.add(LoanPayment(loan_id=l.id, amount=part, date=today))
        remaining -= part
    db.commit()
    return round(amount - remaining, 2)


@router.post("/{claim_id}/confirm", response_model=dict)
def confirm(claim_id: int, background_tasks: BackgroundTasks,
            db: Session = Depends(get_db), caller: User = Depends(current_user)):
    c = _pending_for_payee(db, claim_id, caller)

    from routers import loans as loans_router
    from routers import payments as payments_router
    from schemas import PaymentAuto

    # loans.repay / repay_bill / create_payment_auto each already notify the
    # other side, so only the loans-fallback path below needs its own notice.
    notify_payer = False

    if c.kind == "loan":
        loans_router.repay(c.ref_id, loans_router.RepayIn(amount=c.amount), db=db, caller=caller)
    elif c.kind == "bill":
        bill = db.query(RecurringBill).filter(RecurringBill.id == c.ref_id).first()
        if not bill:
            raise HTTPException(404, "Bill not found")

        def unpaid() -> float:
            return sum(ch.share for ch in bill.charges if _same(ch.member, c.payer) and not ch.paid)

        before = unpaid()
        loans_router.repay_bill(c.ref_id, loans_router.BillRepayIn(member=c.payer, amount=c.amount),
                                db=db, caller=caller)
        db.refresh(bill)
        # A bill only tracks whole monthly shares - an amount smaller than
        # the oldest one clears nothing, and "confirmed" with no change to
        # the balance would be a lie.
        if unpaid() >= before - 0.01:
            raise HTTPException(400, f"₹{c.amount:,.2f} doesn't cover a full month's share of "
                                     f"{bill.title}, so there's nothing to mark paid - tap No and "
                                     "ask them to pay the full share")
    else:
        # A Balances-page claim is against the pair's net. A shared group is
        # where that normally lives; someone you only have loans with (no
        # group in common) gets it applied to those loans instead.
        try:
            payments_router.create_payment_auto(
                PaymentAuto(from_member=c.payer, to_member=c.payee, amount=c.amount,
                            date=date.today().isoformat(), note=c.note or "Paid via UPI"),
                background_tasks, db=db, caller=caller,
            )
        except HTTPException as e:
            if e.status_code != 400:
                raise
            if _apply_to_loans(db, c.payer, c.payee, c.amount) <= 0:
                raise HTTPException(400, f"Nothing open between {c.payer} and you to apply this to")
            notify_payer = True

    c.status = "confirmed"
    c.resolved_at = datetime.now(timezone.utc)
    db.commit()

    if notify_payer:
        send_notice(
            db, c.payer, f"{caller.name} confirmed your ₹{c.amount:,.2f}",
            [f"{caller.name} confirmed receiving ₹{c.amount:,.2f} ({_what(c, db)}), "
             f"marked paid {_when(c)}. It's now recorded."],
            f"{caller.name} confirmed ₹{c.amount:,.0f} - recorded",
            url="/",
        )
    return _out(c)


@router.post("/{claim_id}/reject", response_model=dict)
def reject(claim_id: int, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    c = _pending_for_payee(db, claim_id, caller)
    c.status = "rejected"
    c.resolved_at = datetime.now(timezone.utc)
    db.commit()
    send_notice(
        db, c.payer, f"{caller.name} didn't receive your ₹{c.amount:,.2f}",
        [f"{caller.name} says the ₹{c.amount:,.2f} you marked as paid on {_when(c)} "
         f"({_what(c, db)}) hasn't arrived, so nothing was recorded. "
         "Check your UPI app's history around that time before trying again."],
        f"{caller.name} didn't receive ₹{c.amount:,.0f} - not recorded",
        url="/",
    )
    return _out(c)


@router.post("/{claim_id}/cancel", response_model=dict)
def cancel(claim_id: int, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """The payer withdrawing their own claim (e.g. tapped it by mistake)."""
    c = db.query(PaymentClaim).filter(PaymentClaim.id == claim_id).first()
    if not c or not _same(c.payer, caller.name):
        raise HTTPException(404, "Claim not found")
    if c.status != "pending":
        raise HTTPException(409, f"Already {c.status}")
    c.status = "cancelled"
    c.resolved_at = datetime.now(timezone.utc)
    db.commit()
    return _out(c)

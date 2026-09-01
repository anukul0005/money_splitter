from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from activity import record_activity
from database import get_db
from emailer import notify_group_activity
from models import Group, Payment
from schemas import PaymentAuto, PaymentCreate, PaymentOut

router = APIRouter(prefix="/payments", tags=["payments"])


def _INR(v: float) -> str:
    return f"₹{v:,.0f}"


@router.get("/group/{group_id}", response_model=list[PaymentOut])
def list_payments(group_id: int, db: Session = Depends(get_db)):
    return (
        db.query(Payment)
        .filter(Payment.group_id == group_id)
        .order_by(Payment.date.desc(), Payment.id.desc())
        .all()
    )


@router.get("/between", response_model=list[dict])
def payments_between(a: str, b: str, db: Session = Depends(get_db)):
    """Every payment in either direction between two people, newest first.

    Carries the group name and the exact time it was recorded, so a friend's
    page can show who paid whom and when.
    """
    al, bl = a.strip().lower(), b.strip().lower()
    rows = (
        db.query(Payment)
        .filter(
            or_(
                and_(func.lower(Payment.from_member) == al, func.lower(Payment.to_member) == bl),
                and_(func.lower(Payment.from_member) == bl, func.lower(Payment.to_member) == al),
            )
        )
        .all()
    )
    groups = {g.id: g.name for g in db.query(Group).all()}
    out = [{
        "id": p.id,
        "group_id": p.group_id,
        "group_name": groups.get(p.group_id, ""),
        "from_member": p.from_member,
        "to_member": p.to_member,
        "amount": p.amount,
        "date": p.date,
        "note": p.note,
        "recorded_at": p.created_at.isoformat() if p.created_at else None,
    } for p in rows]
    out.sort(key=lambda r: (r["recorded_at"] or "", r["id"]), reverse=True)
    return out


@router.post("/auto", response_model=list[PaymentOut], status_code=201)
def create_payment_auto(payload: PaymentAuto, db: Session = Depends(get_db)):
    """Record a transfer without naming a group — the debt decides where it lands.

    A payment settles a debt, and a debt already lives in specific groups, so
    asking the user which one is asking them to repeat what the balances
    already know. We look up what `from_member` still owes `to_member` across
    every active shared group and pay those down largest-first, splitting the
    amount across groups when one group doesn't cover it. Anything left over
    after all debts are cleared goes on the largest of them as an advance.
    """
    from routers.stats import _pairwise_group_debts

    frm, to = payload.from_member.strip(), payload.to_member.strip()
    if frm.lower() == to.lower():
        raise HTTPException(400, "A payment needs two different people")
    if payload.amount <= 0:
        raise HTTPException(400, "Enter an amount greater than zero")

    # (group, what frm still owes to here), biggest debt first
    owed: list[tuple[Group, float]] = []
    shared: list[Group] = []
    for g in db.query(Group).filter(Group.is_historical == False).all():  # noqa: E712
        names = {m.name.lower(): m.name for m in g.members}
        if frm.lower() not in names or to.lower() not in names:
            continue
        shared.append(g)
        for (debtor, creditor), amt in _pairwise_group_debts(g).items():
            if debtor.lower() == frm.lower() and creditor.lower() == to.lower():
                owed.append((g, amt))

    if not shared:
        raise HTTPException(400, f"{frm} and {to} have no active group in common")
    owed.sort(key=lambda x: -x[1])

    # Spread the payment over the outstanding debts, largest first
    allocations: list[tuple[Group, float]] = []
    left = round(payload.amount, 2)
    for g, amt in owed:
        if left <= 0.01:
            break
        take = round(min(left, amt), 2)
        allocations.append((g, take))
        left = round(left - take, 2)

    if left > 0.01:
        # Overpayment, or nothing outstanding at all: park the remainder on the
        # group with the largest debt, or the only shared group if there's one.
        if allocations:
            g, amt = allocations[-1]
            allocations[-1] = (g, round(amt + left, 2))
        elif len(shared) == 1:
            allocations.append((shared[0], left))
        else:
            raise HTTPException(
                400,
                f"{frm} doesn't owe {to} anything right now, and they share "
                f"{len(shared)} groups — open the group to record this one.",
            )

    recorder = (payload.recorded_by or "").strip() or frm
    out = []
    for g, amt in allocations:
        names = {m.name.lower(): m.name for m in g.members}
        payment = Payment(
            group_id=g.id,
            from_member=names[frm.lower()],
            to_member=names[to.lower()],
            amount=amt,
            date=payload.date,
            note=payload.note,
        )
        db.add(payment)
        summary = f"{payment.from_member} paid {payment.to_member} {_INR(amt)}"
        record_activity(db, g, recorder, "recorded a payment", summary)
        out.append((payment, g, summary))

    db.commit()
    for p, _, _ in out:
        db.refresh(p)

    for _, g, summary in out:
        try:
            notify_group_activity(g, recorder, "recorded a payment", summary)
        except Exception as e:
            print(f"[email] payment notification failed: {e}")

    return [p for p, _, _ in out]


@router.post("/", response_model=PaymentOut, status_code=201)
def create_payment(payload: PaymentCreate, db: Session = Depends(get_db)):
    group = db.query(Group).filter(Group.id == payload.group_id).first()
    if not group:
        raise HTTPException(404, "Group not found")

    member_names = {m.name.lower(): m.name for m in group.members}
    frm = payload.from_member.strip()
    to = payload.to_member.strip()

    if frm.lower() not in member_names:
        raise HTTPException(400, f"{frm} is not a member of this group")
    if to.lower() not in member_names:
        raise HTTPException(400, f"{to} is not a member of this group")
    if frm.lower() == to.lower():
        raise HTTPException(400, "A payment needs two different people")

    payment = Payment(
        group_id=group.id,
        # store the canonical member spelling so balances always match up
        from_member=member_names[frm.lower()],
        to_member=member_names[to.lower()],
        amount=payload.amount,
        date=payload.date,
        note=payload.note,
    )
    db.add(payment)

    # The actor is whoever entered it; the summary says whose debt it settles.
    # Those differ whenever one member records a payment on another's behalf.
    recorder = (payload.recorded_by or "").strip() or payment.from_member
    summary = f"{payment.from_member} paid {payment.to_member} {_INR(payment.amount)}"
    record_activity(db, group, recorder, "recorded a payment", summary)

    db.commit()
    db.refresh(payment)

    try:
        notify_group_activity(group, recorder, "recorded a payment", summary)
    except Exception as e:
        print(f"[email] payment notification failed: {e}")

    return payment


@router.delete("/{payment_id}", status_code=204)
def delete_payment(payment_id: int, db: Session = Depends(get_db)):
    payment = db.query(Payment).filter(Payment.id == payment_id).first()
    if not payment:
        raise HTTPException(404, "Payment not found")

    group = db.query(Group).filter(Group.id == payment.group_id).first()
    summary = f"{payment.from_member} → {payment.to_member} {_INR(payment.amount)}"
    record_activity(db, group, payment.from_member, "deleted a payment", summary)

    db.delete(payment)
    db.commit()

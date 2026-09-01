from fastapi import APIRouter, Depends, HTTPException
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
def payments_between(a: str, b: str, viewer: str = "", db: Session = Depends(get_db)):
    """Payments involving `b`, as seen from `a`'s friend page. Newest first.

    Restricting this to transfers between exactly `a` and `b` hid real
    settlements: Shubhi paying Anubhav ₹640 never appeared on Anukul's page for
    Shubhi, even though that payment is what cleared Shubhi's balance in a
    group all three share. So we return every payment where `b` is on either
    side, limited to groups the viewer belongs to — the viewer can only ever
    see money movement inside their own groups.

    `viewer` defaults to `a` and exists so the membership check stays explicit.
    """
    al, bl = a.strip().lower(), b.strip().lower()
    watcher = (viewer.strip() or a.strip()).lower()

    all_groups = db.query(Group).all()
    groups = {g.id: g.name for g in all_groups}
    # Groups the viewer is actually in — everything else is none of their business
    visible = {
        g.id for g in all_groups
        if watcher in {m.name.lower() for m in g.members}
    }

    rows = [
        p for p in db.query(Payment).all()
        if p.group_id in visible
        and bl in (p.from_member.lower(), p.to_member.lower())
    ]
    # `al` is unused as a filter on purpose: the viewer wants this friend's
    # settlement history in their shared groups, not just their own half of it.
    del al

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


@router.post("/auto", response_model=PaymentOut, status_code=201)
def create_payment_auto(payload: PaymentAuto, db: Session = Depends(get_db)):
    """Record a transfer without naming a group — the debt decides where it lands.

    One transfer is one record. A payment still has to be attached to a group
    (that's what the settlement engine nets against), so we attach the whole
    amount to the group where `from_member` owes `to_member` the most, rather
    than carving it into a row per group. The pair's overall balance comes out
    identical either way; a single row is what the user actually did.
    """
    from routers.stats import _pairwise_group_debts

    frm, to = payload.from_member.strip(), payload.to_member.strip()
    if frm.lower() == to.lower():
        raise HTTPException(400, "A payment needs two different people")

    best: tuple[Group, float] | None = None   # group with the largest debt frm -> to
    shared: list[Group] = []
    for g in db.query(Group).filter(Group.is_historical == False).all():  # noqa: E712
        names = {m.name.lower() for m in g.members}
        if frm.lower() not in names or to.lower() not in names:
            continue
        shared.append(g)
        for (debtor, creditor), amt in _pairwise_group_debts(g).items():
            if debtor.lower() == frm.lower() and creditor.lower() == to.lower():
                if best is None or amt > best[1]:
                    best = (g, amt)

    if not shared:
        raise HTTPException(400, f"{frm} and {to} have no active group in common")

    if best is not None:
        group = best[0]
    elif len(shared) == 1:
        group = shared[0]
    else:
        raise HTTPException(
            400,
            f"{frm} doesn't owe {to} anything right now, and they share "
            f"{len(shared)} groups — open the group to record this one.",
        )

    names = {m.name.lower(): m.name for m in group.members}
    payment = Payment(
        group_id=group.id,
        from_member=names[frm.lower()],
        to_member=names[to.lower()],
        amount=round(payload.amount, 2),
        date=payload.date,
        note=payload.note,
    )
    db.add(payment)

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

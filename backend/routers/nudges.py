"""The Balances page bell: send someone a "settle up" reminder by email and
app push.

The amount is worked out here, not taken from the page - the same netting
the page does (utils/balances.js): every shared group (stats.
compute_friend_balances) plus open loans and unpaid shares of active
recurring bills. So a reminder can only ever quote the real balance.

Owed to you: the recipient gets a payment reminder with your UPI ID.
You owe: the recipient gets a heads-up that you know and will settle.
One reminder per person every COOLDOWN, so nobody gets pinged repeatedly.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import current_user
from database import get_db
from emailer import send_nudge
from loan_calc import outstanding
from models import Loan, Nudge, RecurringBill, UpiId, User

router = APIRouter(prefix="/nudges", tags=["nudges"])

COOLDOWN = timedelta(hours=12)


def _same(a: str | None, b: str | None) -> bool:
    return (a or "").strip().lower() == (b or "").strip().lower()


def balance_with(db: Session, me: str, other: str) -> tuple[float, list[tuple[str, float]]]:
    """Net between `me` and `other` (> 0: they owe me) and what it's made of,
    each part signed the same way."""
    from routers.stats import compute_friend_balances
    items: list[tuple[str, float]] = []
    for f in compute_friend_balances(db, me):
        if _same(f["name"], other):
            # The per-group figures are before payments; the friend total is
            # after them - the difference is shown as payments made.
            for g in f["groups"]:
                items.append((g["name"] or "Group", g["net"]))
            paid = f["net"] - sum(g["net"] for g in f["groups"])
            if abs(paid) > 0.01:
                items.append(("Payments already made", paid))
    for l in db.query(Loan).all():
        if not ((_same(l.lender, me) and _same(l.borrower, other)) or (_same(l.lender, other) and _same(l.borrower, me))):
            continue
        due = outstanding(l)["total_due"]
        if due > 0.01:
            items.append((f"Loan{' - ' + l.note if l.note else ''}", due if _same(l.lender, me) else -due))
    for b in db.query(RecurringBill).filter(RecurringBill.active == True).all():  # noqa: E712
        if _same(b.payer, me):
            due = sum(c.share for c in b.charges if _same(c.member, other) and not c.paid)
            if due > 0.01:
                items.append((f"Bill - {b.title}", due))
        elif _same(b.payer, other):
            due = sum(c.share for c in b.charges if _same(c.member, me) and not c.paid)
            if due > 0.01:
                items.append((f"Bill - {b.title}", -due))
    return round(sum(v for _, v in items), 2), items


class NudgeIn(BaseModel):
    name: str


@router.get("/recent", response_model=dict)
def recent(db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """When the caller last reminded each person (last 30 days), by
    lower-cased name - for the "reminded 2 h ago" line on each card."""
    since = datetime.now(timezone.utc) - timedelta(days=30)
    out: dict[str, str] = {}
    for n in (db.query(Nudge).filter(Nudge.sender.ilike(caller.name), Nudge.sent_at >= since)
              .order_by(Nudge.sent_at)):
        out[n.recipient.strip().lower()] = n.sent_at.isoformat()
    return out


@router.post("", response_model=dict)
def send(payload: NudgeIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    other = (payload.name or "").strip()
    if not other or _same(other, caller.name):
        raise HTTPException(400, "Pick someone else to remind")

    last = (db.query(Nudge).filter(Nudge.sender.ilike(caller.name), Nudge.recipient.ilike(other))
            .order_by(Nudge.sent_at.desc()).first())
    if last and last.sent_at and datetime.now(timezone.utc) - last.sent_at < COOLDOWN:
        left = COOLDOWN - (datetime.now(timezone.utc) - last.sent_at)
        hours = max(int(left.total_seconds() // 3600), 1)
        raise HTTPException(429, f"You reminded {other} recently - you can again in about {hours} h")

    net, items = balance_with(db, caller.name, other)
    if abs(net) < 1:
        raise HTTPException(400, f"You and {other} are settled up - nothing to remind about")

    target = db.query(User).filter(User.name.ilike(other)).first()
    if not target:
        raise HTTPException(400, f"{other} doesn't have an account in the app yet, so there's nowhere to send it")
    they_owe = net > 0
    # From the recipient's side: what they owe is positive in a reminder.
    their_items = [(label, v if they_owe else -v) for label, v in items]
    upi = [u.upi_id for u in db.query(UpiId).filter(UpiId.user_id == caller.id)] if they_owe else []
    channels = send_nudge(db, target.email, target.name, caller.name, they_owe, abs(net), their_items, upi)
    if not channels:
        raise HTTPException(400, f"{target.name} has no email or app notifications set up yet")

    db.add(Nudge(sender=caller.name, recipient=target.name, they_owe=they_owe, amount=abs(net), channels=",".join(channels)))
    db.commit()
    return {"name": target.name, "amount": abs(net), "they_owe": they_owe, "channels": channels,
            "sent_at": datetime.now(timezone.utc).isoformat()}

"""A transfer recorded from the dashboard, settled where each debt lives.

The dashboard's figure for a person is one number netted from every shared
group, open loan and unpaid bill share (frontend utils/balances.js). A
payment recorded against that number used to land whole in the one group
owing the most. Two things went wrong:
  - the loan and the bill shares it paid stayed open on their own screens,
    and the groups it overpaid showed the payer as owed;
  - in a group of more than two, the settle-up maths re-routes an
    overpayment through other members' debts, so part of it vanished from
    between the two people altogether. Utkarsh paid Anukul the Rs 6,467.92
    the dashboard showed; it went into "19 sep 26", where he owed about
    Rs 1,939, and Rs 1,247 of it stopped counting between them.

settle() spreads the transfer instead, each piece no larger than the debt
it pays:
  1. whatever the receiver owes the payer anywhere is netted off first - a
     payment the other way in that group, their bill shares marked paid,
     their loan repaid - against the payer's debts of the same kind only
     (group against group...), so no bill or loan is marked paid by
     anything but the cash itself;
  2. the payer's unpaid recurring-bill shares - always first, whatever the
     amount: oldest month first, the last one reached part-paid (₹165 of a
     ₹167 month leaves ₹2 due on it);
  3. their loans, by due date;
  4. each group where they owe, by exactly what's owed there;
  5. anything left is an overpayment, held as credit in a two-person group
     where possible, where it can't leak to anyone else.
Every piece carries one settlement_ref, so undo() reverses the lot - the
payment list shows it as one entry (routers/payments.payments_between).
"""
from __future__ import annotations

import uuid
from datetime import date as _date

from fastapi import HTTPException

from models import (ChargePayment, Group, Loan, LoanPayment, Payment, RecurringBill, RecurringCharge, User,
                    pay_charge, recheck_charge)


def _same(a: str | None, b: str | None) -> bool:
    return (a or "").strip().lower() == (b or "").strip().lower()


def _shared_groups(db, caller: User, frm: str, to: str) -> list[Group]:
    """The groups the dashboard's figure comes from (stats.compute_friend_
    balances): active, shared, the caller's - with both people in them."""
    from auth import caller_groups
    out = []
    for g in caller_groups(db, caller, shared_only=True, active_only=True):
        names = {m.name.lower() for m in g.members}
        if frm.lower() in names and to.lower() in names:
            out.append(g)
    return out


def _credit_group(groups: list[Group]) -> Group:
    """Where an overpayment waits as credit: a group of just the two, where
    the settle-up maths can't hand it to a third member; else the busiest."""
    from routers.payments import _busiest_group
    pairs = [g for g in groups if len(g.members) == 2]
    return _busiest_group(pairs or groups)


def settle(db, caller: User, frm: str, to: str, amount: float, when: str | None,
           note: str | None) -> Payment:
    """Record frm paying to `amount`, spread as above. Returns the piece that
    stands for the whole transfer in lists (amount = its part; the transfer
    itself is settlement_amount). The caller commits."""
    from loan_calc import outstanding
    from routers.stats import _pairwise_group_debts

    if _same(frm, to):
        raise HTTPException(400, "A payment needs two different people")
    groups = _shared_groups(db, caller, frm, to)
    if not groups:
        raise HTTPException(400, f"{frm} and {to} have no active group in common")
    when = when or _date.today().isoformat()
    ref = uuid.uuid4().hex
    amount = round(float(amount), 2)
    party = _same(caller.name, frm) or _same(caller.name, to)
    rows: list[Payment] = []

    def pay(g: Group, a: str, b: str, amt: float, primary: bool) -> Payment:
        names = {m.name.lower(): m.name for m in g.members}
        p = Payment(group_id=g.id, from_member=names[a.lower()], to_member=names[b.lower()],
                    amount=round(amt, 2), date=when, settlement_ref=ref,
                    settlement_amount=amount if primary else None,
                    note=note if primary else f"Netted in {frm}'s ₹{amount:,.0f} payment to {to}")
        db.add(p)
        rows.append(p)
        return p

    owed_by_payer, owed_by_receiver = [], []      # (order, kind, obj, amount)
    for g in groups:
        d = _pairwise_group_debts(g)
        net = sum(v for (a, b), v in d.items() if _same(a, frm) and _same(b, to)) \
            - sum(v for (a, b), v in d.items() if _same(a, to) and _same(b, frm))
        if net > 0.01:
            owed_by_payer.append(((3, -net), "group", g, net))
        elif net < -0.01:
            owed_by_receiver.append(((3, net), "group", g, -net))
    if party:   # loans and bills are only theirs to settle
        for c in (db.query(RecurringCharge).join(RecurringBill)      # active bills, as /loans/ counts them
                  .filter(RecurringCharge.paid == False, RecurringBill.active == True).all()):  # noqa: E712
            if c.due <= 0.01:
                continue
            if _same(c.member, frm) and _same(c.bill.payer, to):
                owed_by_payer.append(((1, c.period), "charge", c, c.due))
            elif _same(c.member, to) and _same(c.bill.payer, frm):
                owed_by_receiver.append(((1, c.period), "charge", c, c.due))
        for l in db.query(Loan).all():
            due = outstanding(l)["total_due"]
            if due <= 0.01:
                continue
            if _same(l.borrower, frm) and _same(l.lender, to):
                owed_by_payer.append(((2, l.due_date or ""), "loan", l, due))
            elif _same(l.borrower, to) and _same(l.lender, frm):
                owed_by_receiver.append(((2, l.due_date or ""), "loan", l, due))

    def clear(kind, obj, amt, payer, receiver, primary):
        if kind == "group":
            pay(obj, payer, receiver, amt, primary)
        elif kind == "charge":
            pay_charge(obj, amt, when, ref)       # a month can be part-paid: ₹165 of ₹167
        else:
            db.add(LoanPayment(loan_id=obj.id, amount=round(amt, 2), date=when, settlement_ref=ref))

    # Recurring bills come first, whatever the amount - oldest month first,
    # the last one reached part-paid - then loans, then groups.
    first = lambda x: x[0]

    # Debts the other way are netted off - but each against the payer's
    # debts of the same kind: group against group, bill against bill, loan
    # against loan. Only the cash itself pays across kinds. Pooling the two
    # let a ₹334 payment mark ₹767 of Netflix paid, funded by what Anukul
    # owed Anubhav in other groups.
    for _, kind, obj, amt in sorted(owed_by_receiver, key=lambda x: x[0]):
        clear(kind, obj, amt, to, frm, False)
    credit: dict[str, float] = {}
    for _, kind, _o, amt in owed_by_receiver:
        credit[kind] = credit.get(kind, 0) + amt
    todo = [list(x) for x in sorted(owed_by_payer, key=first)]   # [order, kind, obj, still owed]

    def take(item, budget: float) -> float:
        """Pay `item` out of `budget`; returns how much it used."""
        _, kind, obj, amt = item
        if amt <= 0.01 or budget <= 0.01:
            return 0.0
        part = round(min(budget, amt), 2)
        clear(kind, obj, part, frm, to, True)
        item[3] = round(amt - part, 2)
        return part

    for item in todo:                         # 1. netting, kind by kind
        credit[item[1]] = credit.get(item[1], 0) - take(item, credit.get(item[1], 0))
    spare = sum(v for v in credit.values() if v > 0.01)
    for item in todo:                         # 2. the other person owed more of a kind than
        spare -= take(item, spare)            #    they're owed in it: still netted, books balance
    cash = amount
    for item in todo:                         # 3. the cash
        cash -= take(item, cash)
    left = cash + spare
    if left > 0.01:
        pay(_credit_group(groups), frm, to, left, True)
    if not any(p.settlement_amount is not None for p in rows):
        # Paid only loans and bills: a zero piece still stands for the
        # transfer in the group payment lists, and carries its ref.
        pay(_credit_group(groups), frm, to, 0.0, True)
    db.flush()
    return min((p for p in rows if p.settlement_amount is not None), key=lambda p: p.id)


def undo(db, ref: str) -> None:
    """Take a settlement back entirely: its group payments go, the loan
    repayments it made go, the bill shares it paid are unpaid again."""
    db.query(Payment).filter(Payment.settlement_ref == ref).delete(synchronize_session="fetch")
    db.query(LoanPayment).filter(LoanPayment.settlement_ref == ref).delete(synchronize_session="fetch")
    for cp in db.query(ChargePayment).filter(ChargePayment.settlement_ref == ref).all():
        charge = cp.charge
        charge.payments.remove(cp)
        recheck_charge(charge)
    for c in db.query(RecurringCharge).filter(RecurringCharge.settlement_ref == ref).all():
        c.paid, c.paid_on, c.settlement_ref = False, None, None     # paid whole, before part-payments
    db.flush()


def describe(db, ref: str) -> str:
    """What a settlement covered, for the activity feed."""
    pays = db.query(Payment).filter(Payment.settlement_ref == ref).all()
    groups = {p.group_id for p in pays if p.amount > 0.01}
    loans = db.query(LoanPayment).filter(LoanPayment.settlement_ref == ref).count()
    bills = len({cp.charge_id for cp in db.query(ChargePayment).filter(ChargePayment.settlement_ref == ref)}) \
        + db.query(RecurringCharge).filter(RecurringCharge.settlement_ref == ref).count()
    parts = []
    if groups:
        parts.append(f"{len(groups)} group{'s' if len(groups) != 1 else ''}")
    if loans:
        parts.append("a loan" if loans == 1 else f"{loans} loans")
    if bills:
        parts.append(f"{bills} bill share{'s' if bills != 1 else ''}")
    return ", ".join(parts)

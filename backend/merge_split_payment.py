"""Collapse a transfer that the old auto-allocator split across several groups.

    ../venv/Scripts/python.exe merge_split_payment.py 9 10          # dry run
    ../venv/Scripts/python.exe merge_split_payment.py 9 10 --apply

The first id given is the survivor's group anchor only in the sense that the
row with the LARGEST amount is kept — that matches what /payments/auto does
now (attach the whole amount to the group with the biggest debt). The others
are deleted and their activity rows go with them.

Refuses to apply unless the pair's overall net is unchanged, since collapsing
rows must move money between groups without creating or destroying any.
"""

from __future__ import annotations

import sys

from database import get_session_factory
from models import Activity, Payment


def pair_net(db, a: str, b: str) -> float:
    """What b owes a across everything, via the live settlement engine."""
    from routers.stats import get_friends

    for f in get_friends(name=a, db=db):
        if f["name"].lower() == b.lower():
            return round(f["net"], 2)
    return 0.0


def main() -> int:
    ids = [int(x) for x in sys.argv[1:] if x.isdigit()]
    apply = "--apply" in sys.argv
    if len(ids) < 2:
        print(__doc__)
        return 1

    db = get_session_factory()()
    rows = db.query(Payment).filter(Payment.id.in_(ids)).all()
    if len(rows) != len(ids):
        print(f"! only found {len(rows)} of {len(ids)} payments")
        return 1

    pairs = {(r.from_member.lower(), r.to_member.lower()) for r in rows}
    if len(pairs) != 1:
        print(f"! these payments are not all between the same two people: {pairs}")
        return 1

    frm, to = rows[0].from_member, rows[0].to_member
    total = round(sum(r.amount for r in rows), 2)
    keep = max(rows, key=lambda r: r.amount)
    drop = [r for r in rows if r.id != keep.id]

    before = pair_net(db, frm, to)
    print(f"{frm} -> {to}")
    for r in rows:
        mark = "KEEP" if r.id == keep.id else "DROP"
        print(f"  {mark} id={r.id} group={r.group_id} ₹{r.amount:,.2f}")
    print(f"  merged into id={keep.id} at ₹{total:,.2f}")
    print(f"  net before: {before}")

    if not apply:
        print("\ndry run — pass --apply to write")
        return 0

    acts = (
        db.query(Activity)
        .filter(Activity.verb == "recorded a payment")
        .filter(Activity.group_id.in_([r.group_id for r in rows]))
        .all()
    )
    tag = f"{frm} paid {to} "
    mine = [a for a in acts if (a.summary or "").startswith(tag)]

    keep_act = next((a for a in mine if a.group_id == keep.group_id), None)
    for a in mine:
        if a is not keep_act:
            print(f"  removing activity id={a.id} ({a.summary})")
            db.delete(a)
    if keep_act:
        keep_act.summary = f"{frm} paid {to} ₹{total:,.0f}"
        print(f"  activity id={keep_act.id} -> {keep_act.summary}")

    keep.amount = total
    for r in drop:
        db.delete(r)
    db.flush()
    db.expire_all()

    after = pair_net(db, frm, to)
    print(f"  net after : {after}")
    if abs(after - before) > 0.01:
        db.rollback()
        print("! net changed — rolled back, nothing written")
        return 1

    db.commit()
    print("applied")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

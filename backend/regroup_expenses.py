"""Regroup a group's expenses by who actually bears them.

    cd backend
    ../venv/Scripts/python.exe regroup_expenses.py 49                     # dry run
    ../venv/Scripts/python.exe regroup_expenses.py 49 --fix-date 12=2026-08-28
    ../venv/Scripts/python.exe regroup_expenses.py 49 --apply             # write

Each expense belongs with the people who actually carry it: everyone with a
non-zero share, plus the payer (who is owed the money even at a zero share).
Expenses are then filed under (that member set + the expense's own date), in
"28 Aug 26" naming, creating the group when it doesn't already exist.

Safety: moving an expense between groups must never change anyone's overall
position, only which group it is attributed to. Every run recomputes each
affected person's net across ALL groups before and after, and rolls back if
any figure moves by more than a paisa.
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import datetime

from database import get_session_factory
from models import Group, Member
from routers.settlements import _calculate
from routers.stats import _expense_participants, _member_share

TOLERANCE = 0.01


def label(d) -> str | None:
    try:
        return datetime.fromisoformat(str(d)[:10]).strftime("%d %b %y")
    except Exception:
        return None


def bearers(expense, member_names: list[str]) -> tuple[str, ...]:
    """Everyone who carries part of this expense, plus whoever paid."""
    found = set()
    for p in _expense_participants(expense, member_names):
        share = _member_share(expense, p)
        if share is not None and abs(share) > TOLERANCE:
            found.add(p.strip())
    if expense.paid_by:
        found.add(expense.paid_by.strip())
    return tuple(sorted(found))


def global_net(db, people: set[str]) -> dict[str, float]:
    """Each person's net across every group — the invariant we protect."""
    totals = {p: 0.0 for p in people}
    for g in db.query(Group).all():
        for b in _calculate(g).balances:
            key = b.member.strip()
            if key in totals:
                totals[key] += b.net
    return {k: round(v, 2) for k, v in totals.items()}


def find_or_create(db, members: tuple[str, ...], name: str, template: Group) -> tuple[Group, bool]:
    """An existing group with exactly these members and this name, else a new one."""
    want = tuple(sorted(m.lower() for m in members))
    for g in db.query(Group).all():
        have = tuple(sorted(m.name.strip().lower() for m in g.members))
        if have == want and g.name.strip().lower() == name.strip().lower():
            return g, False

    created = Group(
        name=name,
        description=f"Split out of \"{template.name}\" by who bore the expense",
        emoji=template.emoji or "💰",
        is_historical=template.is_historical,
        category=template.category,
    )
    db.add(created)
    db.flush()
    for m in members:
        db.add(Member(group_id=created.id, name=m))
    db.flush()
    return created, True


def main() -> int:
    if len(sys.argv) < 2 or not sys.argv[1].isdigit():
        print(__doc__)
        return 1

    gid = int(sys.argv[1])
    apply = "--apply" in sys.argv
    fixes: dict[int, str] = {}
    for i, a in enumerate(sys.argv):
        if a == "--fix-date":
            eid, _, newdate = sys.argv[i + 1].partition("=")
            fixes[int(eid)] = newdate

    db = get_session_factory()()
    src = db.query(Group).filter(Group.id == gid).first()
    if not src:
        print(f"No group {gid}")
        return 1

    names = [m.name for m in src.members]
    src_set = tuple(sorted(n.strip() for n in names))
    people = set()

    if fixes:
        print("Date corrections:")
        for e in src.expenses:
            if e.id in fixes:
                print(f"  {e.title or e.category}: {e.date} -> {fixes[e.id]}")
                e.date = fixes[e.id]
        db.flush()

    plan: dict[tuple, list] = defaultdict(list)
    for e in src.expenses:
        key = bearers(e, names)
        people.update(key)
        if len(key) < 2:
            plan[("SOLO", key)].append(e)
            continue
        plan[(key, label(e.date))].append(e)

    print(f'\nSource: grp{src.id} "{src.name}"  members={names}\n')
    for (key, lab), exps in sorted(plan.items(), key=lambda x: str(x[0])):
        if key == "SOLO":
            print(f"  SOLO ({', '.join(lab)}) — left untouched:")
        elif key == src_set and (lab or "").lower() == src.name.strip().lower():
            print(f'  STAYS in grp{src.id} "{src.name}"  {list(key)}:')
        else:
            print(f'  -> "{lab}"  {list(key)}:')
        for e in exps:
            print(f"       [{e.id}] {str(e.title or e.category)[:30]:32s} ₹{e.amount:9.2f}  {str(e.date)[:10]}")

    before = global_net(db, people)

    if not apply:
        db.rollback()
        print("\nDry run — nothing written. Re-run with --apply.")
        return 0

    print("\nApplying…")
    moved = 0
    for (key, lab), exps in plan.items():
        if key == "SOLO":
            continue
        # Already exactly where it belongs: right people, right date name.
        if key == src_set and (lab or "").lower() == src.name.strip().lower():
            continue
        dest, is_new = find_or_create(db, key, lab or src.name, src)
        if dest.id == src.id:
            continue
        for e in exps:
            e.group_id = dest.id
            # split_json may still carry a 0 for someone not in the destination;
            # dropping it is lossless and keeps the group's breakdown clean.
            if e.split_json:
                try:
                    sj = json.loads(e.split_json)
                    keep = {k: v for k, v in sj.items()
                            if k.strip() in key or abs(float(v)) > TOLERANCE}
                    if keep != sj:
                        e.split_json = json.dumps(keep)
                except Exception:
                    pass
            moved += 1
        print(f'   {"created" if is_new else "reused "} grp{dest.id} "{dest.name}" {list(key)} <- {len(exps)} expense(s)')

    db.flush()
    # Reassigning group_id does not update the already-loaded group.expenses
    # collections, so without this the verification counts moved expenses in
    # both the old and the new group and reports a phantom imbalance.
    db.expire_all()
    after = global_net(db, people)

    print("\nInvariant — each person's net across ALL groups:")
    ok = True
    for p in sorted(people):
        b, a = before[p], after[p]
        flag = "OK " if abs(b - a) <= TOLERANCE else "CHANGED"
        if abs(b - a) > TOLERANCE:
            ok = False
        print(f"   {flag} {p:10s} before {b:10.2f}   after {a:10.2f}")

    if not ok:
        db.rollback()
        print("\nABORTED — balances moved. Nothing was written.")
        return 1

    db.commit()
    print(f"\nCommitted. {moved} expense(s) moved.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

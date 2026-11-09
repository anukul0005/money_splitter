"""Everything between the caller and one person, as a passbook: each group,
loan, recurring-bill share and payment on its date, with the running
balance after it, ending at the figure the dashboard shows for them
(frontend utils/balances.js: shared active groups + open loans + unpaid
shares of active bills).

A dashboard settle-up (settle_up.py) is one line - the cash that moved -
with what it cleared listed under it (groups, loans, bill shares); its
pieces don't show again on their own. Amounts are signed from the caller's
side: + the person owes the caller more, - less (or the caller owes them).
"""
from __future__ import annotations

from collections import defaultdict

from loan_calc import outstanding
from models import ChargePayment, Group, Loan, LoanPayment, Payment, RecurringBill, User


def _same(a: str | None, b: str | None) -> bool:
    return (a or "").strip().lower() == (b or "").strip().lower()


def _when(dt) -> str:
    return dt.isoformat() if dt else ""


def statement(db, caller: User, other: str) -> dict:
    from auth import caller_groups
    from routers.stats import _pairwise_group_debts
    from settle_up import started

    me = caller.name
    lines: list[dict] = []
    # settlement ref -> its line, filled in as its pieces turn up
    settles: dict[str, dict] = {}
    drift = 0.0          # group payments that don't show as a line (others' payments re-routed, rounding)

    def pair_net(debts: dict) -> float:
        return sum(v for (a, b), v in debts.items() if _same(a, other) and _same(b, me)) \
            - sum(v for (a, b), v in debts.items() if _same(a, me) and _same(b, other))

    def settle_line(ref: str) -> dict:
        if ref not in settles:
            settles[ref] = {"kind": "settle", "date": "", "at": "", "amount": 0.0, "label": "",
                            "covers": {"groups": 0, "loans": [], "bills": 0}}
        return settles[ref]

    # ── groups ──
    groups = [g for g in caller_groups(db, caller, shared_only=True, active_only=True)
              if any(_same(m.name, other) for m in g.members) and any(_same(m.name, me) for m in g.members)]
    group_ids = {g.id for g in groups}
    for g in groups:
        frozen = round(pair_net(_pairwise_group_debts(g, include_payments=False)), 2)
        live = round(pair_net(_pairwise_group_debts(g)), 2)
        if abs(frozen) > 0.01:
            lines.append({"kind": "group", "date": started(g), "at": _when(g.created_at), "amount": frozen,
                          "label": g.name, "group_id": g.id})
        shown = 0.0
        for p in db.query(Payment).filter(Payment.group_id == g.id).all():
            if _same(p.from_member, other) and _same(p.to_member, me):
                eff = -p.amount
            elif _same(p.from_member, me) and _same(p.to_member, other):
                eff = p.amount
            else:
                continue
            shown += eff
            if p.settlement_ref:
                s = settle_line(p.settlement_ref)
                s["amount"] += eff
                if p.amount > 0.01:
                    s["covers"]["groups"] += 1
                if p.settlement_amount is not None:
                    s.update(date=p.date or "", at=_when(p.created_at), cash=p.settlement_amount,
                             payer=p.from_member, payment_id=p.id, note=p.note)
            else:
                lines.append({"kind": "payment", "date": p.date or "", "at": _when(p.created_at), "amount": eff,
                              "label": g.name, "group_id": g.id, "payment_id": p.id,
                              "payer": p.from_member, "note": p.note})
        drift += (live - frozen) - shown

    # ── loans ──
    for l in db.query(Loan).all():
        if _same(l.lender, me) and _same(l.borrower, other):
            sign = 1
        elif _same(l.lender, other) and _same(l.borrower, me):
            sign = -1
        else:
            continue
        paid = sum(p.amount for p in l.payments)
        owed = round(outstanding(l)["total_due"] + paid, 2)        # principal, plus any interest it ran up
        lines.append({"kind": "loan", "date": l.start_date or (l.created_at.date().isoformat() if l.created_at else ""),
                      "at": _when(l.created_at), "amount": sign * owed, "label": l.note or "",
                      "loan_id": l.id, "principal": l.principal, "interest": round(owed - l.principal, 2),
                      "due_date": l.due_date, "open": outstanding(l)["total_due"] > 0.01})
        for p in l.payments:
            eff = -sign * p.amount
            ref = p.settlement_ref or ""
            if ref and not ref.startswith("setoff:"):
                s = settle_line(ref)
                s["amount"] += eff
                s["covers"]["loans"].append({"loan_id": l.id, "amount": p.amount, "mine": sign < 0,
                                             "principal": l.principal})
            else:
                lines.append({"kind": "setoff" if ref else "repay", "date": p.date or "", "at": _when(p.created_at),
                              "amount": eff, "loan_id": l.id, "principal": l.principal, "mine": sign < 0,
                              "label": ""})

    # ── recurring bills (active ones, as the dashboard counts them) ──
    for b in db.query(RecurringBill).filter(RecurringBill.active == True).all():   # noqa: E712
        if _same(b.payer, me):
            sign, whose = 1, other
        elif _same(b.payer, other):
            sign, whose = -1, me
        else:
            continue
        for c in b.charges:
            if not _same(c.member, whose):
                continue
            day = f"{c.period}-{min(b.day_of_month or 1, 28):02d}"
            lines.append({"kind": "bill", "date": day, "at": _when(c.created_at), "amount": sign * c.share,
                          "label": f"{b.title} · {c.period}", "bill_id": b.id})
            for cp in c.payments:
                if cp.settlement_ref:
                    s = settle_line(cp.settlement_ref)
                    s["amount"] -= sign * cp.amount
                    s["covers"]["bills"] += 1
                else:
                    lines.append({"kind": "bill_paid", "date": cp.date or "", "at": _when(cp.created_at),
                                  "amount": -sign * cp.amount, "label": b.title, "bill_id": b.id})
            if c.paid and not c.payments:
                if c.settlement_ref:
                    s = settle_line(c.settlement_ref)
                    s["amount"] -= sign * c.share
                    s["covers"]["bills"] += 1
                else:
                    lines.append({"kind": "bill_paid", "date": c.paid_on or day, "at": "",
                                  "amount": -sign * c.share, "label": b.title, "bill_id": b.id})

    for s in settles.values():
        if s.get("cash") is None:                 # its lead piece is in a group no longer counted
            s["cash"] = abs(s["amount"])
        lines.append(s)

    # Loan set-offs come in pairs that cancel - one line for the pair
    pairs = defaultdict(list)
    rest = []
    for x in lines:
        (pairs[(x["date"], abs(round(x["amount"], 2)))] if x["kind"] == "setoff" else rest).append(x)
    for (d, amt), xs in pairs.items():
        rest.append({"kind": "setoff", "date": d, "at": xs[0]["at"], "amount": round(sum(x["amount"] for x in xs), 2),
                     "cash": amt, "label": ""})
    lines = rest

    # What the dashboard shows for this person
    from routers.stats import compute_friend_balances
    now = next((f["net"] for f in compute_friend_balances(db, me) if _same(f["name"], other)), 0.0)
    for l in db.query(Loan).all():
        if _same(l.lender, me) and _same(l.borrower, other):
            now += outstanding(l)["total_due"]
        elif _same(l.lender, other) and _same(l.borrower, me):
            now -= outstanding(l)["total_due"]
    for b in db.query(RecurringBill).filter(RecurringBill.active == True).all():   # noqa: E712
        for c in b.charges:
            if _same(b.payer, me) and _same(c.member, other):
                now += c.due
            elif _same(b.payer, other) and _same(c.member, me):
                now -= c.due
    now = round(now, 2)

    order = {"group": 0, "loan": 0, "bill": 0, "payment": 1, "repay": 1, "bill_paid": 1, "settle": 2, "setoff": 3}
    lines.sort(key=lambda x: (x["date"] or "", x["at"] or "", order.get(x["kind"], 1)))
    run = 0.0
    for x in lines:
        x["amount"] = round(x["amount"], 2)
        run += x["amount"]
        x["balance"] = round(run, 2)
    gap = round(now - run, 2)
    if abs(gap) >= 1:
        # Payments in a group that the settle-up maths routed through other
        # members, and paisa rounding - real, but no one line of their own
        lines.append({"kind": "adjust", "date": "", "at": "", "amount": gap, "balance": now, "label": ""})
    lines = [x for x in lines if abs(x["amount"]) >= 0.01 or x["kind"] in ("settle", "setoff")]
    return {"name": other, "me": me, "now": now, "lines": lines, "unexplained": round(drift, 2)}

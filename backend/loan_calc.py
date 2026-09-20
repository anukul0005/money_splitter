"""What a Loan actually costs today - derived, never stored.

The rule: no interest at all if the money is back by the due date. After
it, every full month that passes adds `rate_pct` percent to whatever is
still outstanding at that month's checkpoint (compounding), and repaying
before a checkpoint keeps that month's interest off the repaid part.
Interest-free loans never grow: what's owed is just principal minus
repayments, and the "loan" is only ever a payment record.
"""
from __future__ import annotations

import calendar
import json
from datetime import date


def add_months(d: date, n: int) -> date:
    y, m = divmod(d.year * 12 + (d.month - 1) + n, 12)
    m += 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def _d(s: str) -> date:
    return date.fromisoformat(s)


def emi_plan(loan) -> list[dict]:
    """The loan's EMI plan as [{"pct": .., "date": "YYYY-MM-DD"}], oldest
    first - empty for a loan that isn't on EMIs."""
    raw = getattr(loan, "emi_plan", None)
    if not raw:
        return []
    try:
        plan = json.loads(raw)
    except ValueError:
        return []
    return sorted(plan, key=lambda x: x["date"])


def _outstanding_emi(loan, plan: list[dict], as_of: date) -> dict:
    """An EMI loan: the principal is split into instalments (each a % of
    it, each with its own date). Repayments clear the oldest open
    instalment first. Once an instalment's date has passed with money
    still owing on it, that balance grows by rate_pct on each monthly
    charge day (`interest_day`), compounding - only if the loan has
    interest at all.
    """
    principal = float(loan.principal)
    rate = float(loan.rate_pct) / 100.0
    insts = [{"date": _d(x["date"]), "pct": float(x["pct"]),
              "amount": round(principal * float(x["pct"]) / 100.0, 2)} for x in plan]
    for i in insts:
        i["balance"] = i["amount"]
    pays = sorted(((_d(p.date), float(p.amount)) for p in loan.payments), key=lambda x: x[0])
    paid_total = sum(a for _, a in pays)

    events: list[tuple[date, int, float]] = [(d, 0, a) for d, a in pays if d <= as_of]
    charges = 0
    if loan.has_interest:
        day = int(getattr(loan, "interest_day", None) or insts[0]["date"].day)
        m = insts[0]["date"].replace(day=1)
        while m <= as_of:
            t = date(m.year, m.month, min(day, calendar.monthrange(m.year, m.month)[1]))
            if insts[0]["date"] < t <= as_of:
                events.append((t, 1, 0.0))
            m = add_months(m, 1)
    events.sort(key=lambda e: (e[0], e[1]))

    for when, kind, amt in events:
        if kind == 0:
            left = amt
            for i in insts:
                take = min(left, i["balance"])
                i["balance"] -= take
                left -= take
                if left <= 0:
                    break
        else:
            hit = False
            for i in insts:
                if i["date"] < when and i["balance"] > 0.005:
                    i["balance"] *= (1 + rate)
                    hit = True
            charges += 1 if hit else 0

    total_due = max(round(sum(i["balance"] for i in insts), 2), 0.0)
    remaining_principal = max(round(principal - paid_total, 2), 0.0)
    open_ = [i for i in insts if i["balance"] > 0.01]
    return {
        "principal_remaining": remaining_principal,
        "interest": max(round(total_due - remaining_principal, 2), 0.0),
        "total_due": total_due,
        "months_overdue": charges,
        "next_due_date": open_[0]["date"].isoformat() if open_ else None,
        "installments": [
            {"pct": i["pct"], "date": i["date"].isoformat(), "amount": i["amount"],
             "balance": round(max(i["balance"], 0.0), 2),
             "paid": i["balance"] <= 0.01,
             "overdue": i["balance"] > 0.01 and i["date"] < as_of}
            for i in insts
        ],
    }


def outstanding(loan, as_of: date | None = None) -> dict:
    as_of = as_of or date.today()
    plan = emi_plan(loan)
    if plan:
        return _outstanding_emi(loan, plan, as_of)
    principal = float(loan.principal)
    pays = sorted(((_d(p.date), float(p.amount)) for p in loan.payments), key=lambda x: x[0])
    paid_total = sum(a for _, a in pays)
    remaining_principal = max(round(principal - paid_total, 2), 0.0)

    if not loan.has_interest:
        return {"principal_remaining": remaining_principal, "interest": 0.0,
                "total_due": remaining_principal, "months_overdue": 0,
                "next_due_date": loan.due_date if remaining_principal > 0.01 else None,
                "installments": []}

    due = _d(loan.due_date)
    rate = float(loan.rate_pct) / 100.0
    balance = principal - sum(a for d, a in pays if d <= due)
    months = 0
    prev = due
    while True:
        cp = add_months(due, months + 1)
        if cp > as_of:
            break
        balance -= sum(a for d, a in pays if prev < d <= cp)
        if balance > 0:
            balance *= (1 + rate)
        prev = cp
        months += 1
    balance -= sum(a for d, a in pays if d > prev)

    total_due = max(round(balance, 2), 0.0)
    interest = max(round(total_due - remaining_principal, 2), 0.0)
    return {"principal_remaining": remaining_principal, "interest": interest,
            "total_due": total_due, "months_overdue": months,
            "next_due_date": loan.due_date if total_due > 0.01 else None,
            "installments": []}

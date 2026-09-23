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
    still owing on it, that balance grows by rate_pct for every full month
    since its date, compounding - only if the loan has interest at all.

    An instalment may carry `opening_balance` + `opening_date`: a manual
    reconciliation to a real, hand-tracked figure as of that date (used
    when this formula's rounding has drifted from what was actually
    agreed with the other person). Interest then resumes compounding
    monthly from that balance and date instead of from the raw
    pct-of-principal amount - a one-off fix-up for a specific loan, not
    a change to how new loans are calculated.
    """
    principal = float(loan.principal)
    rate = float(loan.rate_pct) / 100.0
    insts = []
    for x in plan:
        amount = round(principal * float(x["pct"]) / 100.0, 2)
        override = x.get("opening_date") is not None and x.get("opening_balance") is not None
        insts.append({
            "date": _d(x["date"]),
            "pct": float(x["pct"]),
            "amount": amount,
            "balance": round(float(x["opening_balance"]), 2) if override else amount,
            "anchor": _d(x["opening_date"]) if override else _d(x["date"]),
            "override_date": _d(x["opening_date"]) if override else None,
        })
    pays = sorted(((_d(p.date), float(p.amount)) for p in loan.payments), key=lambda x: x[0])
    paid_total = sum(a for _, a in pays)

    # Payments, and - for an interest-bearing loan - one charge per EMI on
    # each monthly anniversary of THAT EMI's own anchor date (its date +
    # 1 month, + 2 months, ... or, once reconciled, its opening_date +
    # 1 month, + 2 months, ...). So an EMI that fell due earlier has been
    # charged more times than a later one, and a loan taken earlier,
    # being due earlier, costs more than one taken later.
    events: list[tuple[date, int, int, float]] = [(d, 0, -1, a) for d, a in pays if d <= as_of]
    if loan.has_interest:
        for idx, inst in enumerate(insts):
            k = 1
            while add_months(inst["anchor"], k) <= as_of:
                events.append((add_months(inst["anchor"], k), 1, idx, 0.0))
                k += 1
    events.sort(key=lambda e: (e[0], e[1]))

    charged = [0] * len(insts)
    for when, kind, idx, amt in events:
        if kind == 0:
            left = amt
            for i in insts:
                # A payment already reflected in a reconciled opening
                # balance must not be subtracted again.
                if i["override_date"] and when <= i["override_date"]:
                    continue
                take = min(left, i["balance"])
                i["balance"] -= take
                left -= take
                if left <= 0:
                    break
        elif insts[idx]["balance"] > 0.005:
            insts[idx]["balance"] *= (1 + rate)
            charged[idx] += 1
    charges = max(charged) if charged else 0

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

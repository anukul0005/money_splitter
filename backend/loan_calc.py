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
from datetime import date


def add_months(d: date, n: int) -> date:
    y, m = divmod(d.year * 12 + (d.month - 1) + n, 12)
    m += 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def _d(s: str) -> date:
    return date.fromisoformat(s)


def outstanding(loan, as_of: date | None = None) -> dict:
    as_of = as_of or date.today()
    principal = float(loan.principal)
    pays = sorted(((_d(p.date), float(p.amount)) for p in loan.payments), key=lambda x: x[0])
    paid_total = sum(a for _, a in pays)
    remaining_principal = max(round(principal - paid_total, 2), 0.0)

    if not loan.has_interest:
        return {"principal_remaining": remaining_principal, "interest": 0.0,
                "total_due": remaining_principal, "months_overdue": 0}

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
            "total_due": total_due, "months_overdue": months}

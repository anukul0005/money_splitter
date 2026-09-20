"""The daily jobs behind loans and recurring bills (see routers/cron.py).

1. Recurring bills: on a bill's day of the month, each member other than
   the payer is charged an equal share and told about it. Keyed on the
   month, not the exact day - a bill whose day has passed without being
   billed (the pinger was down that day) is caught up on the next run, and
   `last_billed` makes a repeated ping the same day a no-op.
2. Loan reminders: the borrower is reminded 3 days before the due date, on
   it, and then on the same day of every month while it's still unpaid.
"""
from __future__ import annotations

from datetime import date, timedelta

from emailer import send_notice
from loan_calc import outstanding
from models import Loan, RecurringBill, RecurringCharge


def run_bills(db, today: date) -> dict:
    period = today.strftime("%Y-%m")
    billed, failed = [], []
    for bill in db.query(RecurringBill).filter(RecurringBill.active == True).all():  # noqa: E712
        if bill.last_billed == period or today.day < bill.day_of_month:
            continue
        try:
            members = [m for m in bill.members.split(",") if m]
            share = round(bill.amount / len(members), 2)
            debtors = [m for m in members if m.lower() != bill.payer.lower()]
            for m in debtors:
                db.add(RecurringCharge(bill_id=bill.id, period=period, member=m, share=share))
            bill.last_billed = period
            db.commit()
            billed.append(bill.title)
            for m in debtors:
                send_notice(
                    db, m, f"{bill.title}: ₹{share:,.2f} due to {bill.payer}",
                    [f"Your share of {bill.title} for this month is ₹{share:,.2f} "
                     f"(₹{bill.amount:,.2f} split {len(members)} ways). "
                     f"Please pay {bill.payer}."],
                    f"Your share of {bill.title}: ₹{share:,.2f} to {bill.payer}",
                )
        except Exception as e:  # pragma: no cover - one bad bill must not sink the run
            db.rollback()
            failed.append(f"{bill.title}: {e}")
    return {"bills_charged": billed, "bills_failed": failed}


def _is_reminder_day(due: date, today: date) -> bool:
    if today == due - timedelta(days=3) or today == due:
        return True
    return today > due and today.day == min(due.day, 28)


def run_loan_reminders(db, today: date) -> dict:
    iso = today.isoformat()
    reminded, failed = [], []
    for loan in db.query(Loan).all():
        if loan.last_reminded == iso:
            continue
        due = date.fromisoformat(loan.due_date)
        owed = outstanding(loan, today)
        if owed["total_due"] <= 0.01 or not _is_reminder_day(due, today):
            continue
        try:
            if today < due:
                when = f"due on {due.strftime('%d %b %Y')}"
            elif today == due:
                when = "due today"
            else:
                when = f"overdue since {due.strftime('%d %b %Y')}"
            extra = ""
            if loan.has_interest and owed["interest"] > 0:
                extra = (f" That includes ₹{owed['interest']:,.2f} interest "
                         f"({loan.rate_pct:g}% a month, compounding).")
            elif loan.has_interest and today <= due:
                extra = f" Pay by the due date and no interest is charged; after it, {loan.rate_pct:g}% a month is added."
            send_notice(
                db, loan.borrower, f"Reminder: ₹{owed['total_due']:,.2f} owed to {loan.lender}",
                [f"You owe {loan.lender} ₹{owed['total_due']:,.2f}, {when}.{extra}"],
                f"You owe {loan.lender} ₹{owed['total_due']:,.2f} ({when})",
            )
            loan.last_reminded = iso
            db.commit()
            reminded.append(f"{loan.borrower}->{loan.lender}")
        except Exception as e:  # pragma: no cover
            db.rollback()
            failed.append(f"loan {loan.id}: {e}")
    return {"loan_reminders_sent": reminded, "loan_reminders_failed": failed}

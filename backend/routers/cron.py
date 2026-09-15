"""The one thing an external scheduler is allowed to trigger.

This app has no scheduler of its own - nothing in the process runs on a
timer, and Render's free web service can sleep when idle, which rules out
an in-process one anyway (a job due while the service is asleep just never
fires). A free external cron pinger hits GET /cron/daily once a day
instead; the ping itself is enough to wake the service if it was asleep.

Secured by a plain shared secret (`key`) rather than a user's login token,
since the caller here is a scheduler, not a person - `key` is compared
against CRON_SECRET (see database.Settings), and an empty configured
secret refuses every request rather than leaving this open by default in
an environment nobody has set one up for yet.
"""
from __future__ import annotations

import calendar
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db, get_settings
from emailer import send_birthday_wish, notify_group_memory, send_debt_reminder
from models import Expense, Group, User

router = APIRouter(prefix="/cron", tags=["cron"])


def _check_key(key: str) -> None:
    secret = get_settings().cron_secret
    if not secret or key != secret:
        # 404, not 401/403: telling an unauthenticated caller this endpoint
        # exists at all is itself a small leak for something meant to be
        # invisible to anyone but the one pinger that knows the secret.
        raise HTTPException(404, "Not found")


@router.get("/daily", response_model=dict)
def run_daily(key: str = "", db: Session = Depends(get_db)):
    """Everything that needs to happen once a day: birthdays, "on this day
    last year" expense memories, and - on the 1st of the month only - a
    reminder to whoever currently owes someone money.

    Idempotent per calendar day via `last_birthday_wish_sent` /
    `last_memory_sent` / `last_debt_reminder_sent`: a pinger that retries,
    or fires twice by accident, does not mail the same person or group
    twice. Never lets one broken address or one failed lookup stop the
    rest of the run - any one of these emails is exactly the sort of thing
    that must not go silently unsent for everyone because one row was bad.
    """
    _check_key(key)
    from routers.stats import top_transaction_partners

    today = date.today()
    mmdd = today.strftime("%m-%d")
    iso_today = today.isoformat()

    # A Feb 29 birthday has no real anniversary on a non-leap year - born
    # on it, matched against today's own date, would only ever get an
    # email once every four years. Treated as Feb 28 instead on a year
    # that has no 29th, the common convention for a leap-day birthday.
    birthdays_today = [mmdd]
    if mmdd == "02-28" and not calendar.isleap(today.year):
        birthdays_today.append("02-29")

    sent, skipped_no_email, failed = [], [], []
    for user in db.query(User).filter(User.birthday.in_(birthdays_today)).all():
        if user.last_birthday_wish_sent == iso_today:
            continue
        if not user.email:
            skipped_no_email.append(user.name)
            continue
        try:
            top_partners = top_transaction_partners(db, user, limit=4)
            # Years since birth_year, not "how many birthdays have they had" -
            # the two agree today by construction, since this only runs on
            # the day that matches `birthday`.
            age = today.year - user.birth_year if user.birth_year else None
            send_birthday_wish(user.email, user.name, top_partners, age=age)
            user.last_birthday_wish_sent = iso_today
            db.commit()
            sent.append(user.name)
        except Exception as e:  # pragma: no cover - one bad row must not sink the run
            db.rollback()
            failed.append(f"{user.name}: {e}")

    # "On this day last year" - an exact ISO-string match against last
    # year's same month/day. A Feb 29 today simply matches nothing on a
    # year that had no such date, which is correct: there is no memory to
    # recall from a day that never happened.
    try:
        last_year_today = today.replace(year=today.year - 1).isoformat()
    except ValueError:
        last_year_today = None

    memory_groups, memory_failed = [], []
    if last_year_today:
        matches = db.query(Expense).filter(Expense.date == last_year_today).all()
        by_group: dict[int, list[Expense]] = {}
        for e in matches:
            by_group.setdefault(e.group_id, []).append(e)

        for group_id, exps in by_group.items():
            group = db.get(Group, group_id)
            if not group or group.last_memory_sent == iso_today:
                continue
            try:
                notify_group_memory(db, group, exps)
                group.last_memory_sent = iso_today
                db.commit()
                memory_groups.append(group.name)
            except Exception as e:  # pragma: no cover - one bad group must not sink the run
                db.rollback()
                memory_failed.append(f"{group.name}: {e}")

    # Monthly dues reminder - the 1st of the month only, not every day,
    # since a person who owes ₹500 on the 3rd doesn't need to hear about it
    # 28 more times before the next 1st. Computed per user with
    # stats.compute_friend_balances - the exact same numbers the Friends
    # page shows, so this email can never disagree with what someone sees
    # when they open the app to check.
    debt_reminders_sent, debt_reminders_failed = [], []
    if today.day == 1:
        from routers.stats import compute_friend_balances

        for user in db.query(User).filter(User.email.isnot(None)).all():
            if user.last_debt_reminder_sent == iso_today:
                continue
            try:
                balances = compute_friend_balances(db, user.name)
                # Negative net is money `user` owes that friend - see
                # compute_friend_balances/get_friends for the sign
                # convention. A user owing nobody gets no email at all;
                # this is a reminder to pay, not a monthly statement.
                debts = [(b["name"], -b["net"]) for b in balances if b["net"] < -0.01]
                if not debts:
                    continue
                send_debt_reminder(user.email, user.name, debts)
                user.last_debt_reminder_sent = iso_today
                db.commit()
                debt_reminders_sent.append(user.name)
            except Exception as e:  # pragma: no cover - one bad row must not sink the run
                db.rollback()
                debt_reminders_failed.append(f"{user.name}: {e}")

    return {"date": iso_today, "birthdays_today": sent,
            "skipped_no_email": skipped_no_email, "failed": failed,
            "memories_sent": memory_groups, "memories_failed": memory_failed,
            "debt_reminders_sent": debt_reminders_sent,
            "debt_reminders_failed": debt_reminders_failed}

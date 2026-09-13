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
from emailer import send_birthday_wish
from models import User

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
    """Everything that needs to happen once a day, today just birthdays.

    Idempotent per calendar day via `last_birthday_wish_sent`: a pinger
    that retries, or fires twice by accident, does not mail the same
    person twice. Never lets one broken address or one failed lookup stop
    the rest of the run - a birthday email is exactly the kind of thing
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
            send_birthday_wish(user.email, user.name, top_partners)
            user.last_birthday_wish_sent = iso_today
            db.commit()
            sent.append(user.name)
        except Exception as e:  # pragma: no cover - one bad row must not sink the run
            db.rollback()
            failed.append(f"{user.name}: {e}")

    return {"date": iso_today, "birthdays_today": sent,
            "skipped_no_email": skipped_no_email, "failed": failed}

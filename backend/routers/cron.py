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
import json
import threading
from datetime import datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db, get_session_factory, get_settings
from emailer import send_birthday_wish, notify_group_memory, send_debt_reminder, send_daily_summary
from models import Expense, Group, JobRun, User

router = APIRouter(prefix="/cron", tags=["cron"])

# India has no daylight saving, so a fixed offset is exact.
IST = timezone(timedelta(hours=5, minutes=30))


def _check_key(key: str) -> None:
    secret = get_settings().cron_secret
    if not secret or key != secret:
        # 404, not 401/403: telling an unauthenticated caller this endpoint
        # exists at all is itself a small leak for something meant to be
        # invisible to anyone but the one pinger that knows the secret.
        raise HTTPException(404, "Not found")


@router.get("/daily", response_model=dict)
def run_daily(key: str = "", db: Session = Depends(get_db)):
    """The external pinger's entry point - see daily_jobs."""
    _check_key(key)
    return _run_and_record(db, "cron")


@router.get("/tennis", response_model=dict)
def run_tennis(key: str = "", db: Session = Depends(get_db)):
    """Hourly: fresh ATP/WTA results for Betting analytics (tennis_sync's
    light refresh - yesterday and today only). Does nothing if the last
    refresh was under an hour ago."""
    _check_key(key)
    from sqlalchemy import text
    import tennis_sync
    last = db.execute(text("SELECT value FROM tennis_meta WHERE key = 'last_update'")).scalar()
    return {"last_update": last, "started": tennis_sync.refresh_if_stale(last)}


# ── catch-up ──────────────────────────────────────────────────────────────
# Render's free plan sleeps the server when idle, and its edge sometimes
# refuses the pinger's wake-up call outright (429 "hibernate-rate-limited")
# - the request never reaches us, so a day's birthdays and memories were
# silently skipped. So the server doesn't depend on the pinger: whenever it
# is awake after DUE (anyone opening the app wakes it) and today's run
# hasn't happened, it runs it itself in the background. Every part of
# daily_jobs sends at most once per person/group per day, so the pinger and
# the catch-up can't double-send.
DUE = time(12, 30)
_done_for: str | None = None        # IST date this process knows is done
_running = threading.Lock()


def _run_and_record(db: Session, source: str) -> dict:
    global _done_for
    result = daily_jobs(db)
    row = db.get(JobRun, "daily") or JobRun(name="daily")
    row.last_date, row.source, row.result = result["date"], source, json.dumps(result)[:4000]
    db.add(row)
    db.commit()
    _done_for = result["date"]
    return result


def _catch_up() -> None:
    global _done_for
    if not _running.acquire(blocking=False):
        return
    db = get_session_factory()()
    try:
        today = datetime.now(IST).date().isoformat()
        row = db.get(JobRun, "daily")
        if row and row.last_date == today:
            _done_for = today
            return
        result = _run_and_record(db, "catch-up")
        print(f"[cron] catch-up ran today's daily jobs: {result}")
    except Exception as e:  # never let this break a request
        print(f"[cron] catch-up failed: {e}")
    finally:
        db.close()
        _running.release()


def maybe_catch_up() -> None:
    """Cheap enough for every request: a date compare until the day's run
    is due and not yet known to be done, then one background thread."""
    now = datetime.now(IST)
    if now.time() < DUE or _done_for == now.date().isoformat() or _running.locked():
        return
    threading.Thread(target=_catch_up, daemon=True).start()


def daily_jobs(db: Session) -> dict:
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
    from routers.stats import top_transaction_partners

    # India's date, not the server's: Render runs on UTC, which is still the
    # day before until 05:30 IST - a ping in that window would send every
    # birthday and memory a day late. The pinger fires at 12:30 IST.
    today = datetime.now(IST).date()
    mmdd = today.strftime("%m-%d")
    iso_today = today.isoformat()

    # A Feb 29 birthday has no real anniversary on a non-leap year - born
    # on it, matched against today's own date, would only ever get an
    # email once every four years. Treated as Feb 28 instead on a year
    # that has no 29th, the common convention for a leap-day birthday.
    birthdays_today = [mmdd]
    if mmdd == "02-28" and not calendar.isleap(today.year):
        birthdays_today.append("02-29")

    # No longer skipped for having no email: send_birthday_wish sends
    # whichever of email/push this person actually has, and an account
    # with neither configured just gets a silent no-op on both - no
    # separate "nobody to notify" branch needed here.
    sent, skipped_no_email, failed = [], [], []
    for user in db.query(User).filter(User.birthday.in_(birthdays_today)).all():
        if user.last_birthday_wish_sent == iso_today:
            continue
        if not user.email:
            skipped_no_email.append(user.name)   # informational only - push may still reach them
        try:
            top_partners = top_transaction_partners(db, user, limit=4)
            # Years since birth_year, not "how many birthdays have they had" -
            # the two agree today by construction, since this only runs on
            # the day that matches `birthday`.
            age = today.year - user.birth_year if user.birth_year else None
            send_birthday_wish(db, user.email, user.name, top_partners, age=age)
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

        # Every user, not just ones with an email - send_debt_reminder
        # sends whichever of email/push this person actually has.
        for user in db.query(User).all():
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
                send_debt_reminder(db, user.email, user.name, debts)
                user.last_debt_reminder_sent = iso_today
                db.commit()
                debt_reminders_sent.append(user.name)
            except Exception as e:  # pragma: no cover - one bad row must not sink the run
                db.rollback()
                debt_reminders_failed.append(f"{user.name}: {e}")

    # Recurring shared bills and loan reminders - see loan_jobs.py
    from loan_jobs import run_bills, run_loan_reminders
    loan_summary = {**run_bills(db, today), **run_loan_reminders(db, today)}

    # Credit card bills due by today: fetched from Gmail, unlocked, read -
    # in the background, see card_autosync.py.
    import card_autosync
    card_autosync.start(today)

    # Yesterday's and today's ATP/WTA results for Betting analytics - see tennis_sync.py.
    import tennis_sync
    tennis_sync.start(today)

    # New 1xbet history emails for My bets - see bet_history.py. One Gmail
    # search per connected inbox; an email already read is skipped.
    import bet_history
    from models import BettingGmailConnection
    for (uid,) in db.query(BettingGmailConnection.user_id).all():
        try:
            bet_history.start_sync(uid)
        except RuntimeError:
            pass                                  # one already running

    # Yesterday's spending, for whoever turned it on (User.daily_summary).
    from daily_summary import summarise
    summaries_sent, summaries_failed = [], []
    for user in db.query(User).filter(User.daily_summary == True).all():  # noqa: E712
        if user.last_daily_summary_sent == iso_today:
            continue
        try:
            send_daily_summary(db, user.email, user.name, summarise(db, user, today - timedelta(days=1)))
            user.last_daily_summary_sent = iso_today
            db.commit()
            summaries_sent.append(user.name)
        except Exception as e:  # pragma: no cover - one bad row must not sink the run
            db.rollback()
            summaries_failed.append(f"{user.name}: {e}")

    return {"date": iso_today, "birthdays_today": sent, **loan_summary, "card_sync": "started", "tennis_sync": "started",
            "daily_summaries_sent": summaries_sent, "daily_summaries_failed": summaries_failed,
            "skipped_no_email": skipped_no_email, "failed": failed,
            "memories_sent": memory_groups, "memories_failed": memory_failed,
            "debt_reminders_sent": debt_reminders_sent,
            "debt_reminders_failed": debt_reminders_failed}

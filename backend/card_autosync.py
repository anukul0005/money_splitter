"""Credit card bills fetched, unlocked and read with nobody pressing a button.

Once a day (routers/cron.daily_jobs), for everyone with Gmail connected and
cards added: each card whose bill date has come round gets the same three
steps the Credit Cards page does by hand -
  1. find the statement email for that bill date and save the bill
     (card_bills.fetch_one - the total due and due date),
  2. unlock its PDF with the card's saved password,
  3. read every transaction from it (card_details.read_bill).
A bill's email can lag its date by days, so a bill not found yet - or
found but not readable yet - is tried again each day for RETRY_DAYS after
its bill date, then left for the page's own buttons. A bill already saved
and read is never touched again. The owner is told when a new bill lands.
"""
from __future__ import annotations

import threading
from datetime import date, datetime, timezone

RETRY_DAYS = 10
_running = threading.Lock()


def _due(card, today: date) -> list[date]:
    """This card's bill dates still worth trying: the latest one(s) on or
    before today, within RETRY_DAYS."""
    import card_bills
    return [d for d in card_bills.recent_bill_dates(card.bill_day, today, 2) if (today - d).days <= RETRY_DAYS]


def _tell(db, owner: str, card: str, bill, details: dict | None, error: str | None) -> None:
    from emailer import send_notice
    due = f"₹{bill.total_due:,.2f}" if bill.total_due is not None else "Your bill"
    when = f" due {bill.due_date}" if bill.due_date else ""
    lines = [f"{card}: {due}{when} - fetched from your email automatically."]
    if details:
        t = details.get("totals", {})
        lines.append(f"{t.get('count', 0)} transactions read, ₹{t.get('spent', 0):,.2f} spent"
                     + (f", ₹{t.get('fees', 0):,.2f} in fees and interest" if t.get("fees") else "") + ".")
        if details.get("check") and not details["check"]["ok"]:
            lines.append("The transactions don't quite add up to the bill - open it to check.")
    elif error:
        lines.append(f"Its PDF couldn't be read yet ({error}). It'll be tried again tomorrow; "
                     "adding the card's PDF password on the Credit Cards page fixes most of these.")
    send_notice(db, owner, f"{card} bill: {due}{when}", lines, f"{card}: {due}{when}")


def sync_user(db, user_id: int, today: date) -> list[dict]:
    """Every due bill of this user's cards: fetched, read, owner told."""
    import card_bills
    import card_details
    from models import CreditCard, CreditCardStatement, GmailConnection, User

    cards = db.query(CreditCard).filter(CreditCard.user_id == user_id).all()
    jobs = [(c, d) for c in cards for d in _due(c, today)]
    if not jobs:
        return []
    owner = db.get(User, user_id)
    service, passwords = card_bills.gmail_for(db, user_id)
    out = []
    for card, d in jobs:
        r = card_bills.fetch_one(db, user_id, card, d, service, passwords)
        if r["status"] not in ("found", "already_saved"):
            out.append({"card": r["card"], "period": r["period"], "status": "not_yet", "why": r.get("why")})
            continue
        bill = db.get(CreditCardStatement, r["bill_id"])
        details, error = None, None
        if not bill.details_json:
            try:
                details = card_details.read_bill(db, user_id, bill.id)
            except Exception as e:
                db.rollback()
                error = str(e)[:200]
        new = r["status"] == "found"
        if new or details:           # a new bill, or one finally read today
            try:
                _tell(db, owner.name, card_bills.card_name(card), bill, details, error)
            except Exception as e:   # pragma: no cover - telling must not stop the sync
                print(f"[card_autosync] notice failed: {e}")
        out.append({"card": r["card"], "period": r["period"], "status": "new" if new else "saved",
                    "read": bool(details) or bool(bill.details_json and not error), "error": error})
    conn = db.query(GmailConnection).filter(GmailConnection.user_id == user_id).first()
    if conn:
        conn.last_synced_at = datetime.now(timezone.utc)
        db.commit()
    return out


def run_all(today: date) -> dict:
    """sync_user for everyone with Gmail connected and a card. One run at a
    time; one person's failure (Gmail access revoked, say) never stops the
    rest."""
    if not _running.acquire(blocking=False):
        return {"skipped": "already running"}
    from database import get_session_factory
    from models import CreditCard, GmailConnection
    db = get_session_factory()()
    summary = {}
    try:
        users = {c.user_id for c in db.query(GmailConnection).all()} \
              & {c.user_id for c in db.query(CreditCard).all()}
        for uid in sorted(users):
            try:
                summary[uid] = sync_user(db, uid, today)
            except Exception as e:
                db.rollback()
                summary[uid] = f"failed: {str(e)[:200]}"
        print(f"[card_autosync] {today}: {summary}")
        return summary
    finally:
        db.close()
        _running.release()


def start(today: date) -> None:
    """run_all in the background - reading a statement is minutes of LLM
    calls, which the daily cron request mustn't wait on."""
    threading.Thread(target=run_all, args=(today,), daemon=True, name="card-autosync").start()

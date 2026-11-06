import dataclasses
import json
import threading
import time
import uuid
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session
from auth import caller_groups, current_user, is_member, member_group
from database import get_db
from models import BankPassword, Group, Expense, Loan, Member, PayeeLabel, StatementSkip, User
from schemas import ExpenseCreate, ExpenseOut
from emailer import notify_group_activity_bg
from activity import record_activity
from spend_categories import UNCLASSIFIED, categorize, tea_stall_overpaid
from statement_import import StatementLocked, is_self_transfer, own_accounts, parse_statement, time_bucket
import expense_classifier
import merchant_memory
import payee_classifier

router = APIRouter(prefix="/expenses", tags=["expenses"])


def _queue_conversion_check(background_tasks: BackgroundTasks, expense, caller_name: str) -> None:
    """Stage 5's other half of _index below: this expense might be the real
    drink a past recommendation was hoping for. Checked against whoever is
    saving the expense, not necessarily `paid_by` - a recommendation is shown
    to a logged-in person, and it's their action, not the split's payer
    field, that a conversion should follow.

    Backgrounded, not called inline - it used to run before every save
    returned, and building _catalog_short_names' cache the first time (a
    pass over the whole price catalogue) cost 85-230ms added to every
    single expense save, whether or not the expense even named a drink.
    See check_conversions_bg's own docstring.
    """
    from routers.recommend import _text, check_conversions_bg
    background_tasks.add_task(
        check_conversions_bg, caller_name, _text(expense), expense.id, expense.date,
    )


def _index(db, expense) -> None:
    """Put this expense into the knowledge base, or take it out.

    Wrapped because indexing is a side effect of saving an expense and must
    never be the reason somebody cannot record what they spent. A failure here
    costs one row in a retrieval index that a reindex will repair; a failure
    raised costs the user their expense.
    """
    try:
        from knowledge import index_expense
        index_expense(db, expense)
    except Exception as e:  # pragma: no cover - never worth failing a save
        print(f"[knowledge] indexing expense {expense.id} failed: {e}")


def _index_bg(expense_id: int) -> None:
    """_index, run after the response has gone back - embedding an expense
    is a remote call that took ~7s on its own, and every save (food/drink
    ones, which is most of them) sat waiting on it. Opens its own session
    for the same reason notify_group_activity_bg does: the request's is
    already closed by the time a background task runs. The index is a
    retrieval aid, so it being a few seconds behind a save costs nothing."""
    from database import get_session_factory
    db = get_session_factory()()
    try:
        expense = db.query(Expense).filter(Expense.id == expense_id).first()
        if expense is not None:
            _index(db, expense)
            db.commit()
    except Exception as e:  # pragma: no cover - never worth failing anything
        db.rollback()
        print(f"[knowledge] backgrounded indexing of expense {expense_id} failed: {e}")
    finally:
        db.close()


def _compute_individual(amount: float, divider: int) -> float:
    return round(amount / divider, 2) if divider > 0 else amount


def _summary(expense: Expense) -> str:
    """One line for the activity feed and the email that follows it - both
    read this same string, so a note added here shows up in both places at
    once rather than needing to be threaded through separately."""
    line = f"{expense.title or expense.category or 'Expense'}: ₹{expense.amount:,.0f} paid by {expense.paid_by}"
    note = (expense.notes or "").strip()
    if note:
        # An inline separator, not a newline: the activity feed renders this
        # in a single <span> with no whitespace-pre styling, so a "\n" here
        # would just collapse into a run-on space instead of a real line break.
        line += f" · Note: {note}"
    return line


@router.get("/group/{group_id}", response_model=list[ExpenseOut])
def list_expenses(group_id: int, db: Session = Depends(get_db),
                  caller: User = Depends(current_user)):
    member_group(group_id, caller, db, with_history=False)   # 404s for anyone outside the group
    return db.query(Expense).filter(Expense.group_id == group_id).order_by(Expense.date, Expense.id).all()


def _places(db: Session, group_ids: list[int], limit: int = 300) -> list[str]:
    """The descriptions and venues the user's expenses use, commonest first -
    what the chat box matches a misheard name against. Statement-import
    noise ("UPI/DR/4512...") is left out: long, numbery strings."""
    if not group_ids:
        return []
    rows = []
    for col in (Expense.venue, Expense.title):
        rows += (db.query(col, func.count()).filter(Expense.group_id.in_(group_ids), col.isnot(None))
                 .group_by(col).order_by(func.count().desc()).limit(limit).all())
    tally: dict[str, list] = {}
    for name, n in rows:
        s = " ".join(str(name).split())
        if not s or len(s) > 40 or len(s.split()) > 5 or sum(c.isdigit() for c in s) > 2 or "/" in s:
            continue
        key = s.lower()
        if key in tally:
            tally[key][1] += n
        else:
            tally[key] = [s, n]
    return [s for s, _ in sorted(tally.values(), key=lambda x: -x[1])][:limit]


class UnderstandIn(BaseModel):
    text: str
    group_id: int | None = None        # the group picked on the form, if any
    group_ids: list[int] | None = None  # the groups the form offers
    draft: dict | None = None          # what the form already holds


@router.post("/understand")
def understand_expense(payload: UnderstandIn, db: Session = Depends(get_db),
                       caller: User = Depends(current_user)):
    """Add Expense's chat box: one message read into the form's fields
    (expense_chat). Nothing is saved here."""
    import expense_chat
    if not payload.text.strip():
        raise HTTPException(400, "Say what was spent")
    offered = set(payload.group_ids or [])
    mine = [g for g in caller_groups(db, caller, history=False, active_only=True)
            if not offered or g.id in offered]
    # How recently each was used - the latest expense in it (else the group's own id)
    last = dict(db.query(Expense.group_id, func.max(Expense.id))
                .filter(Expense.group_id.in_([g.id for g in mine])).group_by(Expense.group_id).all())
    groups = [{"id": g.id, "name": g.name, "members": [m.name for m in g.members],
               "last": last.get(g.id) or 0} for g in mine]
    try:
        return expense_chat.understand(payload.text, caller.name, groups,
                                       payload.group_id, payload.draft or {},
                                       _places(db, [g.id for g in mine]))
    except Exception as e:
        print(f"[expense_chat] understand failed: {e}")
        raise HTTPException(502, "Couldn't read that just now - try again, or fill the form in")


@router.post("/transcribe")
def transcribe_expense(file: UploadFile = File(...), db: Session = Depends(get_db),
                       caller: User = Depends(current_user)):
    """Add Expense's mic: a short voice clip turned into text."""
    import expense_chat
    audio = file.file.read()
    if not audio:
        raise HTTPException(400, "No sound was recorded")
    if len(audio) > 10 * 1024 * 1024:
        raise HTTPException(413, "That recording is too long - keep it under a minute")
    # Their people and places, so the transcript spells them their way
    mine = caller_groups(db, caller, history=False, active_only=True)
    people = {}
    for g in mine:
        for m in g.members:
            if m.name.lower() != caller.name.lower():
                people[m.name] = people.get(m.name, 0) + 1
    words = sorted(people, key=lambda n: -people[n])[:15] + _places(db, [g.id for g in mine], 60)[:25]
    try:
        text = expense_chat.transcribe(audio, file.content_type or "audio/webm", words)
    except Exception as e:
        print(f"[expense_chat] transcribe failed: {e}")
        raise HTTPException(502, "Couldn't hear that just now - try again, or type it")
    return {"text": text}


@router.post("/", response_model=ExpenseOut, status_code=201)
def create_expense(payload: ExpenseCreate, background_tasks: BackgroundTasks,
                   db: Session = Depends(get_db),
                   caller: User = Depends(current_user)):
    group = member_group(payload.group_id, caller, db, with_history=False)
    title = (payload.title or "").strip() or None

    # The form sends no category: the LLM works it out from the description
    # and notes after the response (expense_classifier). One sent anyway -
    # another client - is kept as the user's. With no description yet (and
    # no notes) there's nothing to work it out from: it waits uncategorised,
    # highlighted in the group, until one is added.
    given = bool(payload.category)
    wordless = not title and not (payload.notes or "").strip()
    individual = payload.individual_amount or _compute_individual(payload.amount, payload.divider)
    expense = Expense(
        group_id=payload.group_id,
        date=payload.date,
        category=payload.category if given else None,
        subcategory=payload.subcategory if given else None,
        category_source="user" if given else (None if wordless else "pending"),
        receipt_json=payload.receipt_json,
        title=title,
        amount=payload.amount,
        paid_by=payload.paid_by,
        participants=payload.participants,
        divider=payload.divider,
        individual_amount=individual,
        split_json=payload.split_json,
        payment_mode=payload.payment_mode,
        notes=payload.notes,
        txn_time=payload.txn_time,
        time_bucket=time_bucket(payload.txn_time),
    )
    db.add(expense)
    db.flush()

    summary = _summary(expense)
    # Who did it comes from the token; the summary says who paid
    record_activity(db, group, caller.name, "added an expense", summary)

    db.commit()
    db.refresh(expense)

    # Notification first: background tasks run in the order added, and
    # indexing takes several seconds - queued ahead of it, a restart or
    # deploy landing in that window killed the process before anyone was
    # told anything. See _index_bg for why indexing is deferred at all.
    background_tasks.add_task(
        notify_group_activity_bg, group.id, expense.paid_by, "added a new expense", summary,
    )
    if not given and not wordless:
        background_tasks.add_task(expense_classifier.enqueue, expense.id)
    background_tasks.add_task(_index_bg, expense.id)
    _queue_conversion_check(background_tasks, expense, caller.name)

    return expense


@router.put("/{expense_id}", response_model=ExpenseOut)
def update_expense(expense_id: int, payload: ExpenseCreate, background_tasks: BackgroundTasks,
                   db: Session = Depends(get_db),
                   caller: User = Depends(current_user)):
    expense = db.query(Expense).filter(Expense.id == expense_id).first()
    if not expense:
        raise HTTPException(404, "Expense not found")
    group = member_group(expense.group_id, caller, db, with_history=False)

    title = (payload.title or "").strip() or None
    wordless = not title and not (payload.notes or "").strip()

    individual = payload.individual_amount or _compute_individual(payload.amount, payload.divider)
    expense.date = payload.date
    # Changed description or notes: the category is worked out again from
    # the new text (expense_classifier). Unchanged text keeps what it has,
    # unless this caller sent a category of its own.
    norm = lambda v: (v or "").strip().lower()
    reclassify = (norm(payload.title) != norm(expense.title)
                  or norm(payload.notes) != norm(expense.notes)
                  or not expense.category)    # never categorised: do it now
    if wordless:
        # Still no description: nothing to categorise from yet.
        reclassify = False
        if expense.category_source != "user":
            expense.category = expense.subcategory = expense.category_source = None
            expense.parts = []
    elif reclassify:
        # New text, new categorising: old category slices no longer apply.
        expense.category = expense.subcategory = None
        expense.parts = []
        expense.category_source = "pending"
    elif "category" in payload.model_fields_set and payload.category != expense.category:
        expense.category, expense.subcategory = payload.category, payload.subcategory
        expense.category_source = "user"
    expense.title = title
    # The edit form doesn't resend the scan; only a client that does replaces it.
    if "receipt_json" in payload.model_fields_set:
        expense.receipt_json = payload.receipt_json
    expense.amount = payload.amount
    expense.paid_by = payload.paid_by
    expense.participants = payload.participants
    expense.divider = payload.divider
    expense.individual_amount = individual
    expense.split_json = payload.split_json
    expense.payment_mode = payload.payment_mode
    expense.notes = payload.notes
    # Only overwritten when a time is actually sent - an edit form that
    # doesn't show the field must not wipe a time an import filled in.
    if payload.txn_time is not None:
        expense.txn_time = payload.txn_time
        expense.time_bucket = time_bucket(payload.txn_time)
    # settled_by is intentionally not reset on edit
    if expense.category_source == "user":
        # A category picked by hand on a statement payment teaches what its
        # payee is; a rewritten description does so once it's categorised.
        merchant_memory.learn_from(db, expense)
        merchant_memory.fill_venue(db, expense)

    summary = _summary(expense)
    record_activity(db, group, caller.name, "edited an expense", summary)

    refiled = [i for i in merchant_memory.touched(db) if i != expense.id]
    db.commit()
    db.refresh(expense)
    if refiled:
        background_tasks.add_task(_index_many_bg, refiled)

    # Notification first, then the slow work - tasks run in the order added,
    # and a restart during the ~7s embedding call used to kill the process
    # before the notification was ever sent.
    background_tasks.add_task(
        notify_group_activity_bg, group.id, caller.name, "edited an expense", summary,
    )
    # Re-index after the response: an edit can change the amount, the date,
    # or whether this is food at all, and a stale vector would keep
    # answering the old question - but the ~7s embedding call is not
    # something the person saving should wait on.
    if reclassify:
        background_tasks.add_task(expense_classifier.enqueue, expense.id)
    background_tasks.add_task(_index_bg, expense.id)
    _queue_conversion_check(background_tasks, expense, caller.name)

    return expense


@router.delete("/{expense_id}", status_code=204)
def delete_expense(expense_id: int, background_tasks: BackgroundTasks,
                   db: Session = Depends(get_db),
                   caller: User = Depends(current_user)):
    expense = db.query(Expense).filter(Expense.id == expense_id).first()
    if not expense:
        raise HTTPException(404, "Expense not found")

    group = member_group(expense.group_id, caller, db, with_history=False)
    summary = f"{expense.title or expense.category or 'Expense'}: ₹{expense.amount:,.0f}"
    record_activity(db, group, caller.name, "deleted an expense", summary)

    db.delete(expense)
    db.commit()

    background_tasks.add_task(
        notify_group_activity_bg, group.id, caller.name, "deleted an expense", summary,
    )


_MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]


def _days_apart(a: str, b: str | None) -> int | None:
    """Whole days between two ISO dates, or None when either can't be read
    (expense dates are free-form strings, not every one is ISO)."""
    from datetime import date
    try:
        return abs((date.fromisoformat(a) - date.fromisoformat((b or "")[:10])).days)
    except ValueError:
        return None


def _closest(pool: list, t, date_of, amount_of):
    """The entry of `pool` that is this statement line: within ₹1 of its
    amount (a hand-entered 407 for a 407.42 payment) and dated the same day
    or one either side (entered the next morning), nearest date first.

    Matching on amount, not on the date alone, is the point - a shared
    dinner on the 20th says nothing about the Airbnb and fuel paid that same
    day, and the old date-level skip silently dropped both."""
    best, best_gap = None, None
    for item in pool:
        if abs(amount_of(item) - t.amount) > 1.0:
            continue
        gap = _days_apart(t.date, date_of(item))
        if gap is None or gap > 1:
            continue
        if best is None or gap < best_gap:
            best, best_gap = item, gap
    return best


# Payees whose debits aren't spending, so never a monthly expense: money
# put away, and repayments of credit already taken (the spending happened
# when the credit was used). Matched on the merchant name with spaces and
# dashes removed - PhonePe spells iLoan four different ways in one month.
_INVESTMENT_PAYEES = (
    # nextbillion: Nextbillion Technology, the company behind Groww
    "indmoney", "groww", "nextbillion", "angelone", "indstocks", "wintwealth",
    "iponse", "indianclearingcorporation",
)
# Credit card bills (paid directly or through CRED/MobiKwik), pay-later and
# BNPL apps, and loan EMIs.
_CREDIT_REPAYMENT_PAYEES = (
    "iloancredit", "credclub", "credccbp", "ccbp", "billpaidcreditcard",
    "snapmint", "simpl", "paytmpostpaid", "flipkartpaylater", "slicepay",
    "zipcash", "olafinancialservices", "axisecoll", "shriramtransportfina",
    # Paytm statements: a card bill paid to a ccbillpayment UPI id is named
    # "Credit card bill via ..." (statement_import.parse_paytm_pdf).
    "creditcardbill",
)
# Too short to match as a substring ("cred" is inside "credit").
_CREDIT_REPAYMENT_EXACT = {"cred"}


HIDDEN_PERSON = "Hidden person"


def _norm(name: str) -> str:
    """A payee name with case, spaces and punctuation dropped - PhonePe
    writes "DIVYANK  CHAUDHARY" and "Divyank Chaudhary" for one person."""
    return "".join(ch for ch in (name or "").lower() if ch.isalnum())


def _payee_in(merchant: str, payees: tuple[str, ...]) -> bool:
    key = _norm(merchant)
    return any(p in key for p in payees)


def is_investment(merchant: str) -> bool:
    return _payee_in(merchant, _INVESTMENT_PAYEES)


def is_credit_repayment(merchant: str) -> bool:
    return _norm(merchant) in _CREDIT_REPAYMENT_EXACT or _payee_in(merchant, _CREDIT_REPAYMENT_PAYEES)


# Categories that say "the rules couldn't place this payee" - the ones the
# LLM is asked about.
_UNPLACED = ("Small vendors", "One-off payments", "Other")


def _payee_facts(key: str, ts: list) -> dict:
    """One payee's pattern in this upload, as payee_classifier takes it."""
    from datetime import date as _date
    amounts = [t.amount for t in ts]
    hours = [int(t.time[:2]) for t in ts if t.time] or [12]
    return {"key": key, "name": ts[0].merchant, "count": len(ts), "total": sum(amounts),
            "median": statistics.median(amounts), "min": min(amounts), "max": max(amounts),
            "hour": int(statistics.median(hours)),
            "fridays": sum(_date.fromisoformat(t.date).weekday() == 4 for t in ts),
            "first": min(t.date for t in ts), "last": max(t.date for t in ts)}


def _refs(txn_ref: str | None) -> list[str]:
    """An expense paid in parts carries every part's transaction id,
    comma-joined - see _split_matches."""
    return [r for r in (txn_ref or "").split(",") if r]


def _split_matches(leftover: list, pool: list):
    """One expense paid to the same payee in 2-3 UPI payments on one day -
    ₹1,000 then ₹1,500 for a ₹2,500 bill, because of a per-payment limit or
    a payment that failed halfway. No single payment matches the expense, so
    without this both parts get added on top of the shared expense.

    Same payee and same day only: summing any payments of the day would
    find some combination for almost every amount and pair unrelated
    spending. Yields (parts, expense); everything it yields is removed from
    `leftover` and `pool`."""
    from itertools import combinations
    from types import SimpleNamespace

    by_payee: dict[tuple, list] = {}
    for t in leftover:
        by_payee.setdefault((t.date, t.merchant.lower()), []).append(t)

    for (day, _), same in by_payee.items():
        if len(same) < 2 or len(same) > 8:
            continue
        for size in (2, 3):
            for parts in combinations(same, size):
                if any(p not in leftover for p in parts):
                    continue
                whole = SimpleNamespace(date=day, amount=round(sum(p.amount for p in parts), 2))
                exp = _closest(pool, whole, lambda e: e.date, lambda e: e.amount)
                if exp is None:
                    continue
                pool.remove(exp)
                for p in parts:
                    leftover.remove(p)
                yield list(parts), exp


def _index_many_bg(expense_ids: list[int]) -> None:
    """_index_bg over a whole import, one session, one after another - a
    statement can add hundreds of rows and each food/drink one is a remote
    embedding call, so this must never run inline."""
    for eid in expense_ids:
        _index_bg(eid)


@router.get("/monthly/{group_id}/skipped", response_model=dict)
def monthly_skipped(group_id: int, db: Session = Depends(get_db),
                    caller: User = Depends(current_user)):
    """The investments and payments to people from imported statements
    that fall in this monthly group's month - what the import left out of
    the group but the month still includes."""
    group = member_group(group_id, caller, db, with_history=False)
    parts = group.name.upper().split()
    if (len(parts) != 4 or " ".join(parts[:2]) != "MONTHLY EXPENSES"
            or parts[2] not in _MONTH_ABBR or not parts[3].isdigit()):
        raise HTTPException(400, "Only a monthly expenses group has these.")
    month = f"{parts[3]}-{_MONTH_ABBR.index(parts[2]) + 1:02d}"
    rows = (db.query(StatementSkip)
            .filter(func.lower(StatementSkip.user_name) == caller.name.lower(),
                    StatementSkip.date.like(f"{month}-%"))
            .order_by(StatementSkip.date.desc(), StatementSkip.time.desc())
            .all())
    out = {"month": month, "investments": [], "people": []}
    for s in rows:
        out["investments" if s.kind == "investment" else "people"].append({
            "id": s.id, "date": s.date, "time": s.time, "merchant": s.merchant,
            "amount": s.amount, "reason": s.reason, "source": s.source,
        })
    return out


def _locked_detail(e: StatementLocked) -> dict:
    """The 400 body for a locked PDF: a code the app shows a password box
    for, rather than only a message."""
    return {"code": "password_wrong" if e.wrong else "password_required", "message": str(e)}


@router.post("/import-statement", response_model=dict)
@router.post("/import-csv", response_model=dict)   # old path, for a frontend still cached
def import_statement(background_tasks: BackgroundTasks,
                     file: UploadFile = File(...),
                     password: str = Form(""),
                     db: Session = Depends(get_db),
                     caller: User = Depends(current_user)):
    """Import a statement in one request - see run_import. The app uses
    the import-jobs endpoints below instead, which report progress."""
    # A plain def, so FastAPI runs all of this in a worker thread. It was
    # async, which ran every query - hundreds of round trips to the
    # database on a big statement - on the event loop itself. While it ran,
    # no other request could finish and give its connection back, so the
    # pool (15) filled and everything else timed out after 30s.
    try:
        result, created_ids = run_import(db, caller, file.file.read(), password or None,
                                         saved_passwords=_statement_passwords(db, caller.id))
    except StatementLocked as e:
        raise HTTPException(400, _locked_detail(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    if created_ids:
        background_tasks.add_task(_index_many_bg, created_ids)
    return result


def run_import(db: Session, caller: User, raw: bytes, password: str | None = None,
               progress=None, saved_passwords: list[str] | None = None,
               bank_llm=True) -> tuple[dict, list[int]]:
    """Fill the caller's month-wise "MONTHLY EXPENSES <MON> <YEAR>" groups
    from a payment-app statement - PhonePe CSV, Google Pay PDF, or any
    other type statement_import knows. Returns (summary, ids of the
    expenses created - to index for search). `password` opens a locked
    PDF - without one, `saved_passwords` (the caller's remembered
    statement passwords) are tried; `progress(stage, fraction)` hears how
    far along it is. Raises StatementLocked / ValueError for a file it
    can't read.

    Per debit line:
      1. already imported (its transaction id is on an expense anywhere the
         caller is a member) -> skipped, so uploading the same file twice
         is harmless;
      2. not spending at all -> skipped: an investment (INDmoney, Groww...),
         a credit repayment (card bills, CRED, BNPL/pay-later, loan EMIs -
         the spending happened when the credit was used), money moved to one of the
         caller's own accounts or wallet (see is_self_transfer), or a payee
         on the caller's excluded_payees list (friends paid back or lent to);
      3. the same payment already in the app - same amount (to ₹1), same
         day or one either side, each entry matched at most once:
         a. an expense in a monthly group -> MERGED into it: time, payment
            mode, and the merchant name fill whatever was left blank,
            nothing entered by hand is overwritten;
         b. an expense the caller paid in a shared group -> LINKED (it takes
            the transaction id, nothing else changes), not added again;
         c. a settle-up Payment the caller made, money the caller lent, or
            a repayment of a loan the caller took -> skipped, moving money
            to a friend isn't spending it;
      4. still unmatched, 2-3 payments to one payee on one day that add up
         to such an expense -> treated as that expense paid in parts (see
         _split_matches), merged/linked like 3a/3b;
      5. what's left is checked against the caller's payee labels, then the
         keyword rules (spend_categories), then - for payees neither places
         - the LLM (payee_classifier), whose answers become labels. Anything
         labelled p2p, gambling, investment, repayment or self-transfer is
         skipped with its reason, as is a one-off payment to a person the
         LLM couldn't decide (the user's rule: that's P2P);
      6. otherwise -> created in that month's monthly group (made if it
         doesn't exist yet) with its category. A date already having other
         expenses doesn't hide the rest of that day's payments.
    Credits ("Received from ...") are ignored - this fills expenses.
    """
    step = progress or (lambda stage, fraction: None)
    step("Reading the statement", 0.0)
    read = lambda done, total: step("Reading the statement", 0.30 * done / total)
    tries = [password] if password else [None, *(saved_passwords or [])]
    for i, pw in enumerate(tries):
        try:
            source, txns = parse_statement(raw, pw, read, bank_llm=bank_llm)
            break
        except StatementLocked:
            if i == len(tries) - 1:
                # Typed and wrong -> "wrong"; nothing typed (saved ones
                # included) -> ask for it.
                raise StatementLocked(wrong=bool(password)) from None
    used_saved = not password and i > 0
    step(f"Matching {len(txns)} {source} payments with your entries", 0.30)

    mine = caller_groups(db, caller)
    existing_refs = {r for g in mine for e in g.expenses for r in _refs(e.txn_ref)}
    monthly = {
        g.name.upper(): g for g in mine
        if g.name.upper().startswith("MONTHLY EXPENSES")
        and len(g.members) == 1
    }
    me = caller.name.lower()

    # What each statement line may already be. Lists, so a match can be
    # removed - two ₹60 payments on one day need two ₹60 entries, not one.
    monthly_pool = [e for g in monthly.values() for e in g.expenses if not e.txn_ref]
    shared_pool = [
        e for g in mine if g not in monthly.values() for e in g.expenses
        if not e.txn_ref and (e.paid_by or "").lower() == me
    ]
    transfer_pool = [
        (p.date, p.amount, f"settle-up to {p.to_member} ({g.name})")
        for g in mine for p in g.payments if (p.from_member or "").lower() == me
    ]
    for loan in db.query(Loan).all():
        if (loan.lender or "").lower() == me:
            transfer_pool.append((loan.start_date, loan.principal, f"loan to {loan.borrower}"))
        elif (loan.borrower or "").lower() == me:
            transfer_pool += [(lp.date, lp.amount, f"loan repayment to {loan.lender}")
                              for lp in loan.payments]

    merged, linked, transfers, investments, repayments, dup, credits = 0, [], [], [], [], 0, 0
    self_transfers, friends = [], []
    own = own_accounts(txns)
    try:
        entries = json.loads(caller.excluded_payees or "[]")
    except (ValueError, TypeError):
        entries = []
    # "txn:<id>" entries exclude one payment rather than a whole payee - for
    # a payee who is also paid for real spending (a bike dealer that later
    # does the servicing).
    excluded_txns = {e[4:] for e in entries if e.startswith("txn:")}
    # "hidden:<name>" excludes a payee like a plain entry, but the app never
    # shows the name: what it skips is recorded as "Hidden person" (someone
    # removed from the app whose old payments should still be left out).
    hidden = {_norm(e[7:]) for e in entries if e.startswith("hidden:")}
    excluded = {_norm(e[7:] if e.startswith("hidden:") else e)
                for e in entries if not e.startswith("txn:")}
    leftover = []
    # Investments and money sent to people: not spending, but kept so the
    # month's group can show them (StatementSkip).
    skips: list[tuple[str, object, str]] = []

    def merge(exp, parts) -> None:
        """Fill an existing monthly-group entry's blanks from its payment(s)."""
        first = parts[0]
        exp.txn_ref = ",".join(p.txn_id for p in parts if p.txn_id) or None
        # The person's own description on a statement payee: what that
        # payee is, for every later import (merchant_memory). Learnt now if
        # the description is already categorised, else by the categoriser.
        if not exp.merchant:
            exp.merchant = first.merchant[:200]
        merchant_memory.recognise_place(db, exp)   # a known place the AI missed
        merchant_memory.learn_from(db, exp)
        merchant_memory.fill_venue(db, exp)   # "lunch" at a place someone named
        if first.time and not exp.txn_time:
            exp.txn_time = first.time
            exp.time_bucket = time_bucket(first.time)
        if not exp.payment_mode:
            exp.payment_mode = "upi"
        if not exp.title:
            exp.title = first.merchant
        elif first.merchant.lower() not in (exp.title or "").lower() \
                and first.merchant.lower() not in (exp.notes or "").lower():
            exp.notes = (f"{exp.notes} · " if exp.notes else "") + f"{first.source}: {first.merchant}"

    def link(exp, parts) -> None:
        exp.txn_ref = ",".join(p.txn_id for p in parts if p.txn_id) or None
        # As in merge: the payer's description teaches what the payee is.
        if not exp.merchant:
            exp.merchant = parts[0].merchant[:200]
        merchant_memory.recognise_place(db, exp)
        merchant_memory.learn_from(db, exp)
        merchant_memory.fill_venue(db, exp)
        how = f" - paid in {len(parts)} parts" if len(parts) > 1 else ""
        for p in parts:
            linked.append({"date": p.date, "merchant": p.merchant, "amount": p.amount,
                           "matched": f"{exp.title or exp.category or 'Expense'} "
                                      f"(₹{exp.amount:,.2f}, {exp.group.name}{how})"})

    ordered = sorted(txns, key=lambda x: (x.date, x.time or ""))
    for n, t in enumerate(ordered, 1):
        if n % 25 == 0:
            step(f"Matching {len(txns)} {source} payments with your entries", 0.30 + 0.20 * n / len(ordered))
        if t.kind != "Debit":
            credits += 1
            continue
        if t.txn_id and t.txn_id in existing_refs:
            dup += 1
            continue
        if t.txn_id:
            existing_refs.add(t.txn_id)   # a debit repeated within the file counts once
        if is_investment(t.merchant):
            investments.append({"date": t.date, "merchant": t.merchant, "amount": t.amount})
            skips.append(("investment", t, "investment"))
            continue
        if is_credit_repayment(t.merchant):
            repayments.append({"date": t.date, "merchant": t.merchant, "amount": t.amount})
            continue
        if is_self_transfer(t, own):
            self_transfers.append({"date": t.date, "merchant": t.merchant, "amount": t.amount})
            continue
        if _norm(t.merchant) in excluded or t.txn_id in excluded_txns:
            if _norm(t.merchant) in hidden:
                t = dataclasses.replace(t, merchant=HIDDEN_PERSON)
            friends.append({"date": t.date, "merchant": t.merchant, "amount": t.amount})
            skips.append(("people", t, "excluded payee"))
            continue

        candidate = _closest(monthly_pool, t, lambda e: e.date, lambda e: e.amount)
        if candidate is not None:
            monthly_pool.remove(candidate)
            merge(candidate, [t])
            merged += 1
            continue

        shared = _closest(shared_pool, t, lambda e: e.date, lambda e: e.amount)
        if shared is not None:
            shared_pool.remove(shared)
            link(shared, [t])
            continue

        transfer = _closest(transfer_pool, t, lambda x: x[0], lambda x: x[1])
        if transfer is not None:
            transfer_pool.remove(transfer)
            transfers.append({"date": t.date, "merchant": t.merchant, "amount": t.amount,
                              "matched": transfer[2]})
            skips.append(("people", t, transfer[2]))
            continue

        leftover.append(t)

    # Only after every single payment has had its chance: a part must not
    # take an expense some other payment matches exactly.
    for parts, exp in list(_split_matches(leftover, monthly_pool)):
        merge(exp, parts)
        merged += 1
    for parts, exp in list(_split_matches(leftover, shared_pool)):
        link(exp, parts)

    # What each remaining payee is: the caller's own labels first, then the
    # keyword rules, then - only for payees neither can place - the LLM,
    # whose answers are saved as labels so a payee is asked about once.
    labels = {lab.payee_key: lab for lab in
              db.query(PayeeLabel).filter(func.lower(PayeeLabel.user_name) == me).all()}
    # What people have taught by describing a payment to the payee by hand
    # (merchant_memory) - anyone's, for a business. Beats the LLM's and the
    # rules' guesses; only the caller's own explicit answer beats it.
    taught = merchant_memory.labels_for(db, {_norm(t.merchant) for t in leftover}, caller.name)
    unknown: dict[str, list] = defaultdict(list)
    for t in leftover:
        key = _norm(t.merchant)
        if tea_stall_overpaid(t.amount, t.merchant):
            continue                  # decided below, whatever anyone says - not worth an LLM call
        if key and key not in labels and not merchant_memory.fits(taught.get(key), t.amount) \
                and categorize(t.merchant, t.amount)[0] in _UNPLACED:
            unknown[key].append(t)
    llm = {"asked": len(unknown), "answered": 0, "error": None}
    if unknown and payee_classifier.available():
        try:
            batches = -(-len(unknown) // payee_classifier.BATCH)
            ai = lambda done: f"Categorising {len(unknown)} new payees with AI (batch {min(done + 1, batches)} of {batches})"
            step(ai(0), 0.50)
            answers = payee_classifier.classify(
                [_payee_facts(k, ts) for k, ts in unknown.items()],
                progress=lambda done, total: step(ai(done), 0.50 + 0.40 * done / total))
        except Exception as e:  # the LLM is a help, never a reason an import fails
            answers, llm["error"] = {}, str(e)[:200]
        for key, a in answers.items():
            lab = PayeeLabel(user_name=caller.name, payee_key=key, payee=unknown[key][0].merchant,
                             decision=a["decision"], category=a["category"], subcategory=a["subcategory"],
                             source="llm", note=a["reason"])
            db.add(lab)
            labels[key] = lab
        llm["answered"] = len(answers)
    elif unknown:
        llm["error"] = "No LLM key configured"

    not_spending, keep = [], []
    for t in leftover:
        lab = labels.get(_norm(t.merchant))
        line = {"date": t.date, "merchant": t.merchant, "amount": t.amount}
        if tea_stall_overpaid(t.amount, t.merchant) and not (lab is not None and lab.source == "user"):
            # More than a tea stall is ever paid: not tea, and no place to
            # eat - unclassified, over any label's or the LLM's view.
            keep.append((t, *UNCLASSIFIED, "import", None))
            continue
        mem = taught.get(_norm(t.merchant))
        if merchant_memory.fits(mem, t.amount) and (lab is None or lab.source != "user"):
            keep.append((t, mem.category, mem.subcategory, "merchant", mem.venue))
            continue
        if lab is not None and lab.decision != "spending":
            why = lab.decision.replace("_", " ") + (f" - {lab.note}" if lab.source == "llm" and lab.note else "")
            not_spending.append({**line, "reason": why, "by": lab.source})
            if lab.decision in ("p2p", "investment"):
                skips.append(("people" if lab.decision == "p2p" else "investment", t, why))
            continue
        if lab is not None:
            keep.append((t, lab.category, lab.subcategory, "import", None))
            continue
        cat, sub = categorize(t.merchant, t.amount)
        if cat == "One-off payments":
            # The user's rule: a one-off payment to a person or masked number
            # is P2P unless something says otherwise.
            not_spending.append({**line, "reason": "p2p - one-off payment to a person", "by": "rules"})
            skips.append(("people", t, "one-off payment to a person"))
            continue
        keep.append((t, cat, sub, "import", None))

    step("Saving", 0.92)
    created: list[Expense] = []
    groups_created: list[str] = []
    for t, category, subcategory, cat_source, venue in keep:
        y, m = t.date[:4], int(t.date[5:7])
        gname = f"MONTHLY EXPENSES {_MONTH_ABBR[m - 1]} {y}"
        group = monthly.get(gname)
        if group is None:
            group = Group(name=gname, description="", emoji="💰", category="personal")
            db.add(group)
            db.flush()
            db.add(Member(group_id=group.id, name=caller.name))
            db.flush()
            db.refresh(group)
            monthly[gname] = group
            groups_created.append(gname)

        exp = Expense(
            group_id=group.id, date=t.date, category=category, subcategory=subcategory,
            # A place someone named is shown by that name, not the payee's.
            category_source=cat_source, title=venue or t.merchant, merchant=t.merchant[:200], venue=venue,
            amount=t.amount, paid_by=caller.name, participants=None, divider=1,
            individual_amount=t.amount, payment_mode="upi", notes=None,
            txn_time=t.time, time_bucket=time_bucket(t.time), txn_ref=t.txn_id or None,
        )
        db.add(exp)
        created.append(exp)

    # Re-uploading a statement must not list a payment twice.
    def skip_key(date, merchant, amount, txn_id):
        return txn_id or f"{date}|{_norm(merchant)}|{round(amount, 2)}"
    seen = {skip_key(s.date, s.merchant, s.amount, s.txn_id) for s in
            db.query(StatementSkip).filter(func.lower(StatementSkip.user_name) == me).all()}
    for kind, t, reason in skips:
        k = skip_key(t.date, t.merchant, t.amount, t.txn_id)
        if k in seen:
            continue
        seen.add(k)
        db.add(StatementSkip(user_name=caller.name, kind=kind, date=t.date, time=t.time,
                             merchant=t.merchant, amount=t.amount, txn_id=t.txn_id or None,
                             reason=reason, source=t.source))

    # The last point an import can still be cancelled - nothing above is
    # committed yet, so stopping here leaves no trace.
    step("Saving", 0.97)
    # Ids read before the commit: afterwards each expense is expired, and
    # reading .id would cost one SELECT per row.
    db.flush()
    # Re-indexed afterwards with the new rows: earlier payments a label
    # learnt during this import re-filed or named (merchant_memory).
    created_ids = [e.id for e in created]
    created_ids += [i for i in merchant_memory.touched(db) if i not in set(created_ids)]
    db.commit()

    return {
        "created": len(created),
        "merged": merged,
        "skipped_already_imported": dup,
        # Each one names what it matched, so a wrong pairing can be spotted
        # rather than an amount just going missing.
        "linked_to_shared": linked,
        "skipped_as_transfers": transfers,
        "skipped_investments": investments,
        "skipped_credit_repayments": repayments,
        "skipped_self_transfers": self_transfers,
        "skipped_excluded_payees": friends,
        # Each with the reason: the caller's label, the LLM's ("by": "llm"),
        # or the one-off-payment rule.
        "skipped_not_spending": not_spending,
        "llm": llm,
        "credits_ignored": credits,
        "groups_created": groups_created,
        "source": source,
        "used_saved_password": used_saved,
    }, created_ids


# ── remembered statement passwords ─────────────────────────────────────────
# Kept in bank_passwords (encrypted, like a card statement's) under
# "statement:<app>" - one per payment app, since each app's statements
# are locked with that person's own fixed password.
_STATEMENT_PREFIX = "statement:"


def _statement_passwords(db: Session, user_id: int) -> list[str]:
    from secret_box import decrypt
    rows = (db.query(BankPassword)
            .filter(BankPassword.user_id == user_id,
                    BankPassword.bank.like(f"{_STATEMENT_PREFIX}%")).all())
    return [pw for pw in (decrypt(r.password_encrypted) for r in rows) if pw]


def _remember_statement_password(db: Session, user_id: int, app: str, password: str) -> None:
    from secret_box import encrypt
    bank = f"{_STATEMENT_PREFIX}{app}"
    row = (db.query(BankPassword)
           .filter(BankPassword.user_id == user_id, BankPassword.bank == bank).first())
    if row:
        row.password_encrypted = encrypt(password)
    else:
        db.add(BankPassword(user_id=user_id, bank=bank, password_encrypted=encrypt(password)))
    db.commit()


@router.get("/statement-passwords", response_model=list)
def list_statement_passwords(db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """Which apps' statement passwords are remembered - names only; the
    password itself only through .../password, when they tap Show."""
    rows = (db.query(BankPassword)
            .filter(BankPassword.user_id == caller.id,
                    BankPassword.bank.like(f"{_STATEMENT_PREFIX}%")).all())
    return sorted(({"app": r.bank[len(_STATEMENT_PREFIX):], "updated_at": r.updated_at} for r in rows),
                  key=lambda r: r["app"].lower())


@router.get("/statement-passwords/{app}/password", response_model=dict)
def reveal_statement_password(app: str, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    from secret_box import decrypt
    row = (db.query(BankPassword)
           .filter(BankPassword.user_id == caller.id, BankPassword.bank == f"{_STATEMENT_PREFIX}{app}").first())
    if not row:
        raise HTTPException(404, "No saved password for that app")
    return {"app": app, "password": decrypt(row.password_encrypted) or ""}


class StatementPasswordIn(BaseModel):
    password: str


@router.put("/statement-passwords/{app}", response_model=dict)
def set_statement_password(app: str, payload: StatementPasswordIn, db: Session = Depends(get_db),
                           caller: User = Depends(current_user)):
    """Add or change an app's statement password by hand."""
    app = app.strip()
    if not app or len(app) > 40 or not payload.password:
        raise HTTPException(400, "App and password are required")
    _remember_statement_password(db, caller.id, app, payload.password)
    return {"app": app, "saved": True}


@router.delete("/statement-passwords/{app}", response_model=dict)
def forget_statement_password(app: str, db: Session = Depends(get_db),
                              caller: User = Depends(current_user)):
    db.query(BankPassword).filter(BankPassword.user_id == caller.id,
                                  BankPassword.bank == f"{_STATEMENT_PREFIX}{app}").delete()
    db.commit()
    return {"ok": True}


# ── import jobs: the same import, with progress ───────────────────────────
# A statement can take a minute (pages to read, an AI call per 20 payees),
# so the app starts the import as a job and polls it for a progress bar.
# Jobs live in this process's memory: the API runs as one process (see
# render.yaml's startCommand), and a job is only needed while it's polled.
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


class _Cancelled(Exception):
    pass


_LOG_LINES = 40


def _job_log(job_id: str, message: str) -> None:
    """A line in the job's activity log - what the progress panel lists, so
    a slow step reads as working rather than stuck."""
    with _jobs_lock:
        log = _jobs[job_id].setdefault("log", [])
        log.append({"at": time.time(), "text": message})
        del log[:-_LOG_LINES]


def _job_update(job_id: str, **fields) -> None:
    with _jobs_lock:
        job = _jobs[job_id]
        if job.get("cancel"):
            raise _Cancelled()
        if fields.get("stage") and fields["stage"] != job.get("logged_stage"):
            job["logged_stage"] = fields["stage"]
            log = job.setdefault("log", [])
            log.append({"at": time.time(), "text": fields["stage"]})
            del log[:-_LOG_LINES]
        job.update(fields)


def _job_finish(job_id: str, error: dict) -> None:
    with _jobs_lock:
        _jobs[job_id].update(status="error", error=error)


def _run_job(job_id: str, user_id: int, raw: bytes, password: str | None,
             remember: bool = False) -> None:
    import job_notes
    from database import get_session_factory
    db = get_session_factory()()
    job_notes.listen(lambda m: _job_log(job_id, m))
    try:
        caller = db.get(User, user_id)
        result, created_ids = run_import(
            db, caller, raw, password,
            lambda stage, fraction: _job_update(job_id, stage=stage, progress=round(fraction, 3)),
            saved_passwords=_statement_passwords(db, user_id))
        if password and remember:
            # Only now: the password is known to open this app's statements.
            try:
                _remember_statement_password(db, user_id, result["source"], password)
                result["password_saved"] = True
            except Exception as e:  # remembering is a convenience, never a failed import
                print(f"[import] couldn't save statement password: {e!r}")
        with _jobs_lock:
            _jobs[job_id].update(status="done", stage="Done", progress=1.0, result=result)
    except _Cancelled:
        # run_import commits only at its very end, so rolling back leaves
        # nothing of this statement behind.
        db.rollback()
        with _jobs_lock:
            _jobs[job_id].update(status="cancelled", stage="Cancelled")
        return
    except StatementLocked as e:
        _job_finish(job_id, error=_locked_detail(e))
        return
    except ValueError as e:
        _job_finish(job_id, error={"code": "unreadable", "message": str(e)})
        return
    except Exception as e:  # never leave the app polling a job that died
        print(f"[import] job {job_id} failed: {e!r}")
        _job_finish(job_id, error={"code": "failed", "message": "The import failed - please try again."})
        return
    finally:
        job_notes.listen(None)
        db.close()
    if created_ids:
        _index_many_bg(created_ids)


@router.post("/import-jobs", response_model=dict)
def start_import_job(file: UploadFile = File(...), password: str = Form(""),
                     remember: bool = Form(False),
                     caller: User = Depends(current_user)):
    """Start importing a statement in the background; poll
    GET /expenses/import-jobs/{job_id} for its progress and result."""
    raw = file.file.read()
    job_id = uuid.uuid4().hex
    now = time.time()
    with _jobs_lock:
        # Forget jobs nobody has looked at for an hour.
        for k in [k for k, j in _jobs.items() if now - j["touched"] > 3600]:
            del _jobs[k]
        _jobs[job_id] = {"user_id": caller.id, "status": "running", "stage": "Starting",
                         "progress": 0.0, "touched": now}
    threading.Thread(target=_run_job, args=(job_id, caller.id, raw, password or None, remember),
                     daemon=True).start()
    return {"job_id": job_id}


# ── mail sync: the same import, for statements found in Gmail ─────────────
# PhonePe / Paytm / Google Pay statement emails (mail_statements.py), each
# attachment imported as if uploaded - saved passwords tried first; a
# statement still locked is reported, and the next sync with a password
# typed in opens it (and remembers it, if asked). Its result is the
# imports' results added together, plus what the sync found ("mail").

def _add_results(total: dict, r: dict) -> None:
    for k, v in r.items():
        if isinstance(v, bool) or k == "source":
            continue
        if isinstance(v, (int, float)):
            total[k] = total.get(k, 0) + v
        elif isinstance(v, list):
            total.setdefault(k, []).extend(v)
        elif k == "llm" and isinstance(v, dict):
            t = total.setdefault("llm", {})
            t["asked"] = t.get("asked", 0) + (v.get("asked") or 0)
            if v.get("error"):
                t["error"] = v["error"]


def _run_mail_job(job_id: str, user_id: int, password: str | None, remember: bool, days: int) -> None:
    import job_notes
    import mail_statements
    from database import get_session_factory
    from models import GmailConnection, MailStatement
    db = get_session_factory()()
    job_notes.listen(lambda m: _job_log(job_id, m))
    created_all = []
    try:
        caller = db.get(User, user_id)
        conn = db.query(GmailConnection).filter(GmailConnection.user_id == user_id).first()
        _job_update(job_id, stage=f"Searching {conn.gmail_address or 'your Gmail'} for statement emails "
                                  f"from the last {days} day{'' if days == 1 else 's'}", progress=0.02)
        service, ids = mail_statements.find(conn, days)
        done = {m for (m,) in db.query(MailStatement.gmail_message_id).filter(MailStatement.user_id == user_id).all()}
        todo = [m for m in ids if m not in done]
        _job_log(job_id, f"Found {len(ids)} statement email{'' if len(ids) == 1 else 's'}"
                         + (f" - {len(ids) - len(todo)} already imported, {len(todo)} to read" if len(todo) < len(ids) else ""))
        saved = [*_statement_passwords(db, user_id),
                 *(pw for pw in (_decrypt(r.password_encrypted) for r in
                                 db.query(BankPassword).filter(BankPassword.user_id == user_id).all()) if pw)]
        total = {"source": "", "used_saved_password": False}
        mail = {"emails": len(ids), "already": len(ids) - len(todo), "imported": [], "locked": [], "unreadable": 0,
                "password_saved": False, "days": days}
        apps = []
        for n, mid in enumerate(todo):
            head = f"Email {n + 1} of {len(todo)}"
            share = lambda stage, f, n=n, head=head: _job_update(
                job_id, stage=f"{head} · {stage}", progress=round(0.05 + 0.95 * (n + f) / len(todo), 3))
            share("downloading", 0)
            subject, files = mail_statements.attachments(service, mid)
            _job_log(job_id, f"📧 {head}: {subject or '(no subject)'}"
                             + (f" - {len(files)} file{'s' if len(files) > 1 else ''}" if files else " - no statement file"))
            status, source = "unreadable", None
            for name, raw in files:
                try:
                    try:
                        # A PDF of no known layout goes to the slow AI bank reader
                        # only if it is one of these apps' at all - not every PDF
                        # these senders mail is a statement.
                        result, created = run_import(db, caller, raw, None, share, saved_passwords=saved,
                                                     bank_llm=_mentions_app)
                    except StatementLocked:
                        if not password:
                            raise
                        result, created = run_import(db, caller, raw, password, share, bank_llm=_mentions_app)
                        if remember:
                            _remember_statement_password(db, user_id, result["source"], password)
                            mail["password_saved"] = True
                        saved.append(password)
                except StatementLocked:
                    status = "locked"
                    mail["locked"].append({"subject": subject or name, "file": name})
                    _job_log(job_id, f"🔒 {name} is locked - none of the saved passwords open it")
                    continue
                except ValueError:
                    _job_log(job_id, f"✗ {name}: not a statement the app can read - skipped")
                    continue
                except _Cancelled:
                    raise
                except Exception as e:         # the AI down, say: try this email again next sync
                    print(f"[mail-sync] {name} failed: {e!r}")
                    db.rollback()
                    status = "retry" if status != "imported" else status
                    _job_log(job_id, f"⚠ {name} couldn't be read just now - it'll be tried again next sync")
                    continue
                status, source = "imported", result["source"]
                created_all += created
                _add_results(total, result)
                total["used_saved_password"] |= bool(result.get("used_saved_password"))
                mail["imported"].append({"subject": subject or name, "file": name, "source": source,
                                         "created": result.get("created", 0)})
                _job_log(job_id, f"✓ {source} statement: {result.get('created', 0)} new expense"
                                 f"{'' if result.get('created', 0) == 1 else 's'} added")
                if source not in apps:
                    apps.append(source)
            if status not in ("locked", "retry"):   # those are tried again next time
                db.add(MailStatement(user_id=user_id, gmail_message_id=mid, status=status, source=source))
                db.commit()
            if status == "unreadable":
                mail["unreadable"] += 1
        total["source"] = " + ".join(apps)
        total["mail"] = mail
        conn.mail_synced_at = datetime.now(timezone.utc)
        db.commit()
        if mail["locked"] and not mail["imported"]:
            _job_finish(job_id, error={"code": "password_wrong" if password else "password_required",
                                       "message": (f"{len(mail['locked'])} statement{'s' if len(mail['locked']) > 1 else ''} "
                                                   f"in your mail need{'' if len(mail['locked']) > 1 else 's'} a password"
                                                   + (" - that one didn't open it." if password else ".")),
                                       "mail": mail})
            return
        with _jobs_lock:
            _jobs[job_id].update(status="done", stage="Done", progress=1.0, result=total)
    except _Cancelled:
        db.rollback()
        with _jobs_lock:
            _jobs[job_id].update(status="cancelled", stage="Cancelled")
    except Exception as e:
        print(f"[mail-sync] job {job_id} failed: {e!r}")
        if _gmail_expired(e):
            _job_finish(job_id, error={"code": "gmail_expired",
                                       "message": "Gmail access has expired - connect Gmail again to sync."})
        else:
            _job_finish(job_id, error={"code": "failed", "message": "Couldn't read your mail - try again, or reconnect Gmail."})
    finally:
        job_notes.listen(None)
        db.close()
    if created_all:
        _index_many_bg(created_all)


def _mentions_app(lines: list[str]) -> bool:
    text = " ".join(lines[:80]).lower()
    return any(w in text for w in ("phonepe", "paytm", "google pay", "gpay"))


def _gmail_expired(e: Exception) -> bool:
    """Google refused the saved access (revoked, or lapsed - an unverified
    app's access lasts a week), or it can't be read: only connecting Gmail
    again fixes it."""
    try:
        from google.auth.exceptions import RefreshError
        if isinstance(e, RefreshError):
            return True
    except ImportError:
        pass
    text = str(e).lower()
    return "invalid_grant" in text or "unreadable" in text or "unauthorized" in text


@router.get("/mail-sync-status", response_model=dict)
def mail_sync_status(db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """The Gmail behind the statement sync: which inbox, when it last
    synced, and whether Google still accepts the saved access (checked
    live - access lapses, and only a reconnect brings it back)."""
    import mail_statements
    from models import GmailConnection
    conn = db.query(GmailConnection).filter(GmailConnection.user_id == caller.id).first()
    if not conn:
        return {"connected": False}
    expired = None                     # None: couldn't tell (Google unreachable)
    try:
        mail_statements.check(conn)
        expired = False
    except Exception as e:
        if _gmail_expired(e):
            expired = True
        else:
            print(f"[mail-sync] status check failed: {e!r}")
    return {"connected": True, "gmail_address": conn.gmail_address, "expired": expired,
            "mail_synced_at": conn.mail_synced_at, "connected_at": conn.connected_at}


def _decrypt(s):
    from secret_box import decrypt
    return decrypt(s)


@router.post("/mail-sync-jobs", response_model=dict)
def start_mail_sync(password: str = Form(""), remember: bool = Form(False), days: int = Form(4),
                    db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """Look through the caller's Gmail for payment-app statements and import
    them; poll GET /expenses/import-jobs/{job_id} like an upload."""
    from models import GmailConnection
    if not db.query(GmailConnection).filter(GmailConnection.user_id == caller.id).first():
        raise HTTPException(400, {"code": "gmail_not_connected", "message": "Connect your Gmail first."})
    job_id = uuid.uuid4().hex
    now = time.time()
    with _jobs_lock:
        for k in [k for k, j in _jobs.items() if now - j["touched"] > 3600]:
            del _jobs[k]
        if any(j["user_id"] == caller.id and j["status"] == "running" and j.get("mail") for j in _jobs.values()):
            raise HTTPException(409, "A mail sync is already running.")
        _jobs[job_id] = {"user_id": caller.id, "status": "running", "stage": "Starting",
                         "progress": 0.0, "touched": now, "mail": True}
    # days: how far back to look - a few days by default (fast); the person
    # picks a longer look-back when they want older statements.
    threading.Thread(target=_run_mail_job, args=(job_id, caller.id, password or None, remember, max(1, min(days, 400))),
                     daemon=True).start()
    return {"job_id": job_id}


@router.post("/import-jobs/{job_id}/cancel", response_model=dict)
def cancel_import_job(job_id: str, caller: User = Depends(current_user)):
    """Stop an import that's still running. It stops at its next progress
    step (a page, a batch of payees) and saves nothing; one already saving
    or finished can't be undone this way."""
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None or job["user_id"] != caller.id:
            raise HTTPException(404, "No such import.")
        if job["status"] == "running":
            job["cancel"] = True
        return {"status": job["status"]}


@router.get("/import-jobs/{job_id}", response_model=dict)
def import_job_status(job_id: str, caller: User = Depends(current_user)):
    """{status: running|done|error, stage, progress 0-1, result | error}."""
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None or job["user_id"] != caller.id:
            raise HTTPException(404, "No such import - it may have finished over an hour ago.")
        job["touched"] = time.time()
        out = {k: v for k, v in job.items() if k not in ("user_id", "touched", "cancel", "mail", "logged_stage")}
        out["log"] = list(job.get("log", []))
        out["now"] = time.time()          # so the app can say "for 40s" whatever the phone's clock says
        return out

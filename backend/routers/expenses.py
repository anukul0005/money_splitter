import json
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session
from auth import current_user, is_member, member_group
from database import get_db
from models import Group, Expense, Member, User
from schemas import ExpenseCreate, ExpenseOut
from emailer import notify_group_activity_bg
from activity import record_activity
from statement_import import parse_phonepe_csv, time_bucket

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


@router.post("/", response_model=ExpenseOut, status_code=201)
def create_expense(payload: ExpenseCreate, background_tasks: BackgroundTasks,
                   db: Session = Depends(get_db),
                   caller: User = Depends(current_user)):
    group = member_group(payload.group_id, caller, db, with_history=False)

    individual = payload.individual_amount or _compute_individual(payload.amount, payload.divider)
    expense = Expense(
        group_id=payload.group_id,
        date=payload.date,
        category=payload.category,
        title=payload.title,
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

    individual = payload.individual_amount or _compute_individual(payload.amount, payload.divider)
    expense.date = payload.date
    expense.category = payload.category
    expense.title = payload.title
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

    summary = _summary(expense)
    record_activity(db, group, caller.name, "edited an expense", summary)

    db.commit()
    db.refresh(expense)

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


def _index_many_bg(expense_ids: list[int]) -> None:
    """_index_bg over a whole import, one session, one after another - a
    statement can add hundreds of rows and each food/drink one is a remote
    embedding call, so this must never run inline."""
    for eid in expense_ids:
        _index_bg(eid)


@router.post("/import-csv", response_model=dict)
async def import_statement(background_tasks: BackgroundTasks,
                           file: UploadFile = File(...),
                           db: Session = Depends(get_db),
                           caller: User = Depends(current_user)):
    """Fill the caller's month-wise "MONTHLY EXPENSES <MON> <YEAR>" groups
    from a PhonePe statement CSV.

    Per debit line, in this order:
      1. already imported (same transaction id anywhere the caller is a
         member) -> skipped, so uploading the same file twice is harmless;
      2. same date and same amount as an expense already in that month's
         monthly group -> MERGED into it: time, payment mode, and the
         merchant name fill whatever was left blank, nothing entered by
         hand is overwritten;
      3. the date already has expenses in ANY of the caller's groups ->
         skipped, that day is treated as already accounted for;
      4. otherwise -> created in that month's monthly group (made if it
         doesn't exist yet).
    Credits ("Received from ...") are ignored - this fills expenses.
    """
    raw = await file.read()
    try:
        txns = parse_phonepe_csv(raw)
    except ValueError as e:
        raise HTTPException(400, str(e))

    mine = [g for g in db.query(Group).all() if is_member(g, caller)]
    existing_dates = {e.date for g in mine for e in g.expenses if e.date}
    existing_refs = {e.txn_ref for g in mine for e in g.expenses if e.txn_ref}
    monthly = {
        g.name.upper(): g for g in mine
        if g.name.upper().startswith("MONTHLY EXPENSES")
        and len(g.members) == 1
    }

    created, merged, dup, skipped_dates, credits = [], 0, 0, set(), 0
    groups_created: list[str] = []
    skipped_by_date = 0

    for t in sorted((x for x in txns), key=lambda x: (x.date, x.time or "")):
        if t.kind != "Debit":
            credits += 1
            continue
        if t.txn_id and t.txn_id in existing_refs:
            dup += 1
            continue

        y, m = t.date[:4], int(t.date[5:7])
        gname = f"MONTHLY EXPENSES {_MONTH_ABBR[m - 1]} {y}"
        group = monthly.get(gname)

        candidate = None
        if group is not None:
            candidate = next(
                (e for e in group.expenses
                 if e.date == t.date and abs(e.amount - t.amount) < 0.01 and not e.txn_ref),
                None,
            )
        if candidate is not None:
            candidate.txn_ref = t.txn_id
            if t.time and not candidate.txn_time:
                candidate.txn_time = t.time
                candidate.time_bucket = time_bucket(t.time)
            if not candidate.payment_mode:
                candidate.payment_mode = "upi"
            if not candidate.title:
                candidate.title = t.merchant
            elif t.merchant.lower() not in (candidate.title or "").lower()                     and t.merchant.lower() not in (candidate.notes or "").lower():
                candidate.notes = (f"{candidate.notes} · " if candidate.notes else "") + f"PhonePe: {t.merchant}"
            existing_refs.add(t.txn_id)
            merged += 1
            continue

        if t.date in existing_dates:
            skipped_dates.add(t.date)
            skipped_by_date += 1
            continue

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
            group_id=group.id, date=t.date, category=None, title=t.merchant,
            amount=t.amount, paid_by=caller.name, participants=None, divider=1,
            individual_amount=t.amount, payment_mode="upi", notes=None,
            txn_time=t.time, time_bucket=time_bucket(t.time), txn_ref=t.txn_id or None,
        )
        db.add(exp)
        created.append(exp)
        existing_refs.add(t.txn_id)

    db.commit()
    if created:
        background_tasks.add_task(_index_many_bg, [e.id for e in created])

    return {
        "created": len(created),
        "merged": merged,
        "skipped_already_imported": dup,
        "skipped_transactions_on_accounted_dates": skipped_by_date,
        "accounted_dates": sorted(skipped_dates),
        "credits_ignored": credits,
        "groups_created": groups_created,
    }

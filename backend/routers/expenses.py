import json
import statistics
from collections import defaultdict
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from sqlalchemy import func
from sqlalchemy.orm import Session
from auth import caller_groups, current_user, is_member, member_group
from database import get_db
from models import Group, Expense, Loan, Member, PayeeLabel, User
from schemas import ExpenseCreate, ExpenseOut
from emailer import notify_group_activity_bg
from activity import record_activity
from spend_categories import categorize
from statement_import import is_self_transfer, own_accounts, parse_phonepe_csv, time_bucket
import expense_classifier
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


@router.post("/", response_model=ExpenseOut, status_code=201)
def create_expense(payload: ExpenseCreate, background_tasks: BackgroundTasks,
                   db: Session = Depends(get_db),
                   caller: User = Depends(current_user)):
    group = member_group(payload.group_id, caller, db, with_history=False)
    if not (payload.title or "").strip():
        raise HTTPException(400, "Add a description - it's what the expense gets categorised from")

    # The form sends no category: the LLM works it out from the description
    # and notes after the response (expense_classifier). One sent anyway -
    # another client - is kept as the user's.
    given = bool(payload.category)
    individual = payload.individual_amount or _compute_individual(payload.amount, payload.divider)
    expense = Expense(
        group_id=payload.group_id,
        date=payload.date,
        category=payload.category if given else None,
        subcategory=payload.subcategory if given else None,
        category_source="user" if given else "pending",
        receipt_json=payload.receipt_json,
        title=payload.title.strip(),
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
    if not given:
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

    if not (payload.title or "").strip():
        raise HTTPException(400, "Add a description - it's what the expense gets categorised from")

    individual = payload.individual_amount or _compute_individual(payload.amount, payload.divider)
    expense.date = payload.date
    # Changed description or notes: the category is worked out again from
    # the new text (expense_classifier). Unchanged text keeps what it has,
    # unless this caller sent a category of its own.
    norm = lambda v: (v or "").strip().lower()
    reclassify = (norm(payload.title) != norm(expense.title)
                  or norm(payload.notes) != norm(expense.notes)
                  or not expense.category)    # never categorised: do it now
    if reclassify:
        # New text, new categorising: old category slices no longer apply.
        expense.category = expense.subcategory = None
        expense.parts = []
        expense.category_source = "pending"
    elif "category" in payload.model_fields_set and payload.category != expense.category:
        expense.category, expense.subcategory = payload.category, payload.subcategory
        expense.category_source = "user"
    expense.title = payload.title.strip()
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
)
# Too short to match as a substring ("cred" is inside "credit").
_CREDIT_REPAYMENT_EXACT = {"cred"}


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


@router.post("/import-csv", response_model=dict)
def import_statement(background_tasks: BackgroundTasks,
                     file: UploadFile = File(...),
                     db: Session = Depends(get_db),
                     caller: User = Depends(current_user)):
    """Fill the caller's month-wise "MONTHLY EXPENSES <MON> <YEAR>" groups
    from a PhonePe statement CSV.

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
    # A plain def, so FastAPI runs all of this in a worker thread. It was
    # async, which ran every query below - hundreds of round trips to the
    # database on a big statement - on the event loop itself. While it ran,
    # no other request could finish and give its connection back, so the
    # pool (15) filled and everything else timed out after 30s.
    raw = file.file.read()
    try:
        txns = parse_phonepe_csv(raw)
    except ValueError as e:
        raise HTTPException(400, str(e))

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
    excluded = {_norm(e) for e in entries if not e.startswith("txn:")}
    leftover = []

    def merge(exp, parts) -> None:
        """Fill an existing monthly-group entry's blanks from its payment(s)."""
        first = parts[0]
        exp.txn_ref = ",".join(p.txn_id for p in parts if p.txn_id) or None
        if first.time and not exp.txn_time:
            exp.txn_time = first.time
            exp.time_bucket = time_bucket(first.time)
        if not exp.payment_mode:
            exp.payment_mode = "upi"
        if not exp.title:
            exp.title = first.merchant
        elif first.merchant.lower() not in (exp.title or "").lower() \
                and first.merchant.lower() not in (exp.notes or "").lower():
            exp.notes = (f"{exp.notes} · " if exp.notes else "") + f"PhonePe: {first.merchant}"

    def link(exp, parts) -> None:
        exp.txn_ref = ",".join(p.txn_id for p in parts if p.txn_id) or None
        how = f" - paid in {len(parts)} parts" if len(parts) > 1 else ""
        for p in parts:
            linked.append({"date": p.date, "merchant": p.merchant, "amount": p.amount,
                           "matched": f"{exp.title or exp.category or 'Expense'} "
                                      f"(₹{exp.amount:,.2f}, {exp.group.name}{how})"})

    for t in sorted(txns, key=lambda x: (x.date, x.time or "")):
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
            continue
        if is_credit_repayment(t.merchant):
            repayments.append({"date": t.date, "merchant": t.merchant, "amount": t.amount})
            continue
        if is_self_transfer(t, own):
            self_transfers.append({"date": t.date, "merchant": t.merchant, "amount": t.amount})
            continue
        if _norm(t.merchant) in excluded or t.txn_id in excluded_txns:
            friends.append({"date": t.date, "merchant": t.merchant, "amount": t.amount})
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
    unknown: dict[str, list] = defaultdict(list)
    for t in leftover:
        key = _norm(t.merchant)
        if key and key not in labels and categorize(t.merchant, t.amount)[0] in _UNPLACED:
            unknown[key].append(t)
    llm = {"asked": len(unknown), "answered": 0, "error": None}
    if unknown and payee_classifier.available():
        try:
            answers = payee_classifier.classify([_payee_facts(k, ts) for k, ts in unknown.items()])
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
        if lab is not None and lab.decision != "spending":
            why = lab.decision.replace("_", " ") + (f" - {lab.note}" if lab.source == "llm" and lab.note else "")
            not_spending.append({**line, "reason": why, "by": lab.source})
            continue
        if lab is not None:
            keep.append((t, lab.category, lab.subcategory))
            continue
        cat, sub = categorize(t.merchant, t.amount)
        if cat == "One-off payments":
            # The user's rule: a one-off payment to a person or masked number
            # is P2P unless something says otherwise.
            not_spending.append({**line, "reason": "p2p - one-off payment to a person", "by": "rules"})
            continue
        keep.append((t, cat, sub))

    created: list[Expense] = []
    groups_created: list[str] = []
    for t, category, subcategory in keep:
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
            category_source="import", title=t.merchant,
            amount=t.amount, paid_by=caller.name, participants=None, divider=1,
            individual_amount=t.amount, payment_mode="upi", notes=None,
            txn_time=t.time, time_bucket=time_bucket(t.time), txn_ref=t.txn_id or None,
        )
        db.add(exp)
        created.append(exp)

    # Ids read before the commit: afterwards each expense is expired, and
    # reading .id would cost one SELECT per row.
    db.flush()
    created_ids = [e.id for e in created]
    db.commit()
    if created_ids:
        background_tasks.add_task(_index_many_bg, created_ids)

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
    }

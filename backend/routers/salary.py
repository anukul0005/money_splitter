"""The salary dashboard (GET /salary/dashboard): each month's pay set
against where it went - spent, invested, or still there.

  spent = monthly expenses (the caller's own monthly groups)
        + the caller's share in shared groups
        + credit card spends not already in the app: a card line the
          caller also entered as a credit-card expense, or passed on to
          someone as a loan, isn't counted twice
        + recurring bills (the caller's share)
        + loan repayments the caller made
  invested = investments the statement imports set aside (StatementSkip,
             kind "investment") + ones entered by hand (ManualInvestment -
             what the PhonePe statement can't see: SIPs from the bank, EPF...)
  left = salary - spent - invested

Only for someone who has entered their salary (Account page); the same
salary is used for every month shown.
"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import caller_groups, current_user
from database import get_db
from models import (CreditCardStatement, Expense, Loan, ManualInvestment, RecurringBill, RecurringCharge,
                    SalaryCardSkip, StatementSkip, User)


def line_key(statement_id: int, t: dict | None = None) -> str:
    """A card line's name for SalaryCardSkip - stable across reads of the bill."""
    if t is None:
        return f"{statement_id}:bill"
    return f"{statement_id}:{(t.get('date') or '')[:10]}:{float(t.get('amount') or 0):.2f}:{(t.get('description') or '')[:120]}"

router = APIRouter(prefix="/salary", tags=["salary"])

KINDS = ["Mutual funds / SIP", "Stocks", "FD / RD", "PPF / EPF", "NPS", "Gold", "Insurance", "Crypto", "Other"]

# What a statement's investment payee is, by name.
_KIND_WORDS = [
    ("NPS", r"\bnps\b|pension"),
    ("PPF / EPF", r"\bppf\b|\bepf\b|provident"),
    ("Insurance", r"\blic\b|insurance|policy|premium"),
    ("Gold", r"gold|mmtc|augmont"),
    ("Crypto", r"crypto|coindcx|wazirx|coinswitch|bitcoin"),
    ("FD / RD", r"fixed deposit|\bfd\b|recurring deposit|\brd\b"),
    ("Mutual funds / SIP", r"\bsip\b|mutual|\bmf\b|\bamc\b|fund|clearing corp|iccl|bse star|cams|kfin"),
    ("Stocks", r"zerodha|upstox|angel|dhan|kite|stock|securities|broking|groww|indmoney|smallcase"),
]

# The 50/30/20 split: what has to be paid, and what is chosen.
NEEDS = {"Groceries", "Transport", "Housing", "Bills & Utilities", "Health", "Education", "Loan repayments"}


def _kind_of(name: str) -> str:
    low = (name or "").lower()
    return next((k for k, rx in _KIND_WORDS if re.search(rx, low)), "Other")


def _ym_range(end: str, n: int) -> list[str]:
    y, m = map(int, end.split("-"))
    out = []
    for i in range(n - 1, -1, -1):
        t = y * 12 + (m - 1) - i
        out.append(f"{t // 12}-{t % 12 + 1:02d}")
    return out


def _manual_out(r: ManualInvestment) -> dict:
    return {"id": r.id, "month": r.month, "end_month": r.end_month, "recurring": bool(r.recurring),
            "amount": r.amount, "kind": r.kind, "note": r.note}


def _manual_in_month(r: ManualInvestment, ym: str) -> bool:
    if r.recurring:
        return r.month <= ym and (not r.end_month or ym <= r.end_month)
    return r.month == ym


@router.get("/dashboard", response_model=dict)
def dashboard(months: int = 12, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    if not caller.monthly_salary:
        raise HTTPException(400, {"code": "no_salary", "message": "Enter your monthly salary on the Account page first."})
    from routers.stats import _history_category, get_history
    from spend_categories import categorize

    today = date.today()
    cur = f"{today.year}-{today.month:02d}"
    yms = _ym_range(cur, max(3, min(months, 36)))
    want = set(yms)
    me = caller.name.lower()

    blank = lambda: {"monthly": 0.0, "groups": 0.0, "cards": 0.0, "recurring": 0.0, "repayments": 0.0}
    spend = {ym: blank() for ym in yms}
    cats = {ym: defaultdict(float) for ym in yms}
    top_groups = {ym: defaultdict(float) for ym in yms}

    # ── expenses: the History page's own rows (group, month, category, total, share) ──
    hist = get_history(db=db, caller=caller)
    gmeta = {g["id"]: g for g in hist["groups"]}
    for gid, ym, cat, total, share, *_ in hist["rows"]:
        if ym not in want or not share:
            continue
        g = gmeta.get(gid, {})
        solo = len(g.get("members", [])) <= 1
        spend[ym]["monthly" if solo else "groups"] += share
        cats[ym][cat] += share
        if not solo:
            top_groups[ym][gid] += share

    # ── credit cards: each bill's lines by the month they were spent ──
    card_gross = defaultdict(float)
    card_cats = {ym: defaultdict(float) for ym in yms}
    skipped = {k for (k,) in db.query(SalaryCardSkip.line_key).filter(SalaryCardSkip.user_id == caller.id)}
    marked = defaultdict(float)                     # lines the caller marked "already counted"
    marked_cats = {ym: defaultdict(float) for ym in yms}
    unbroken = defaultdict(int)          # bills with no breakup: counted at their total
    for s in db.query(CreditCardStatement).filter(CreditCardStatement.user_id == caller.id):
        details = None
        if s.details_json:
            try:
                details = json.loads(s.details_json)
            except ValueError:
                details = None
        lines = (details or {}).get("transactions") or []
        if lines:
            for t in lines:
                if t.get("excluded") or t.get("type") != "debit" or not t.get("date"):
                    continue
                ym = t["date"][:7]
                if ym in want:
                    card_gross[ym] += float(t.get("amount") or 0)
                    card_cats[ym][t.get("category") or "Other"] += float(t.get("amount") or 0)
                    if line_key(s.id, t) in skipped:
                        marked[ym] += float(t.get("amount") or 0)
                        marked_cats[ym][_history_category(t.get("category"))] += float(t.get("amount") or 0)
        else:
            ym = s.period or (s.statement_date or "")[:7]
            if ym in want and s.total_due:
                card_gross[ym] += s.total_due
                card_cats[ym]["Card bill (no breakup)"] += s.total_due
                unbroken[ym] += 1
                if line_key(s.id) in skipped:
                    marked[ym] += s.total_due
                    marked_cats[ym]["Card bill (no breakup)"] += s.total_due
    # Already counted elsewhere: card-paid expenses the caller paid (the whole
    # bill went on the card; their share is counted above, the rest is owed
    # back), and card lines passed on to someone as a loan.
    overlap = defaultdict(float)
    overlap_cats = {ym: defaultdict(float) for ym in yms}
    gids = [g["id"] for g in hist["groups"]]
    if gids:
        for d, amount, cat in (db.query(Expense.date, Expense.amount, Expense.category)
                               .filter(Expense.group_id.in_(gids), Expense.payment_mode == "credit_card")
                               .filter(Expense.paid_by.ilike(caller.name))):
            if d and d[:7] in want:
                overlap[d[:7]] += amount or 0
                overlap_cats[d[:7]][_history_category(cat)] += amount or 0
    passed = defaultdict(float)
    for ln in db.query(Loan).filter(Loan.card_ref.isnot(None), Loan.lender.ilike(caller.name)):
        if ln.start_date[:7] in want:
            passed[ln.start_date[:7]] += ln.principal
    for ym in yms:
        gross = card_gross[ym]
        net = max(0.0, gross - overlap[ym] - passed[ym] - marked[ym])
        spend[ym]["cards"] = net
        if gross:
            # The entered expenses come off their own category first; what
            # still doesn't match is taken off every category evenly.
            left = defaultdict(float)
            for c, v in card_cats[ym].items():
                left[c if c in ("Card fees & interest", "Card bill (no breakup)") else _history_category(c)] += v
            for src in (overlap_cats[ym], marked_cats[ym]):
                for c, v in src.items():
                    if c in left:
                        left[c] = max(0.0, left[c] - v)
            rest = sum(left.values())
            f = net / rest if rest else 0
            for c, v in left.items():
                cats[ym][c] += v * f

    # ── recurring bills: the caller's share, as payer or as a member ──
    for ch in db.query(RecurringCharge).filter(RecurringCharge.member.ilike(caller.name)):
        if ch.period in want:
            spend[ch.period]["recurring"] += ch.share
            cats[ch.period][_history_category(categorize(ch.bill.title, ch.share)[0])] += ch.share
    for bill in db.query(RecurringBill).filter(RecurringBill.payer.ilike(caller.name)):
        members = [m for m in bill.members.split(",") if m]
        own = round(bill.amount / max(len(members), 1), 2)
        for period in {c.period for c in bill.charges}:
            if period in want:
                spend[period]["recurring"] += own
                cats[period][_history_category(categorize(bill.title, own)[0])] += own

    # ── loan repayments the caller made ──
    for ln in db.query(Loan).filter(Loan.borrower.ilike(caller.name)):
        for p in ln.payments:
            if p.date[:7] in want:
                spend[p.date[:7]]["repayments"] += p.amount
                cats[p.date[:7]]["Loan repayments"] += p.amount

    # ── investments ──
    auto = []
    for s in (db.query(StatementSkip)
              .filter(StatementSkip.user_name.ilike(caller.name), StatementSkip.kind == "investment")
              .order_by(StatementSkip.date.desc())):
        if s.date[:7] in want:
            auto.append({"id": s.id, "date": s.date, "merchant": s.merchant, "amount": s.amount,
                         "kind": _kind_of(s.merchant), "source": s.source})
    manual = db.query(ManualInvestment).filter(ManualInvestment.user_id == caller.id) \
        .order_by(ManualInvestment.month.desc(), ManualInvestment.id.desc()).all()

    out = {}
    for ym in yms:
        sp = {k: round(v, 2) for k, v in spend[ym].items()}
        a = [x for x in auto if x["date"][:7] == ym]
        m = [r for r in manual if _manual_in_month(r, ym)]
        by_kind = defaultdict(float)
        for x in a:
            by_kind[x["kind"]] += x["amount"]
        for r in m:
            by_kind[r.kind] += r.amount
        c = {k: round(v, 2) for k, v in sorted(cats[ym].items(), key=lambda kv: -kv[1]) if v >= 1}
        out[ym] = {
            "spend": sp,
            "spent": round(sum(sp.values()), 2),
            "invest": {"auto": round(sum(x["amount"] for x in a), 2),
                       "manual": round(sum(r.amount for r in m), 2),
                       "by_kind": {k: round(v, 2) for k, v in sorted(by_kind.items(), key=lambda kv: -kv[1])}},
            "cats": c,
            "needs": round(sum(v for k, v in c.items() if k in NEEDS), 2),
            "cards": {"gross": round(card_gross[ym], 2), "already_entered": round(overlap[ym], 2),
                      "passed_on": round(passed[ym], 2), "marked": round(marked[ym], 2),
                      "bills_without_breakup": unbroken[ym]},
            "groups": [{"id": gid, "name": gmeta[gid]["name"], "emoji": gmeta[gid]["emoji"], "value": round(v, 2)}
                       for gid, v in sorted(top_groups[ym].items(), key=lambda kv: -kv[1])[:5] if gid in gmeta],
        }
        out[ym]["invested"] = round(out[ym]["invest"]["auto"] + out[ym]["invest"]["manual"], 2)

    return {
        "salary": caller.monthly_salary, "salary_day": caller.salary_day, "today": today.isoformat(),
        "months": yms, "by_month": out, "kinds": KINDS,
        "needs_categories": sorted(NEEDS),     # everything else in "cats" is a want
        "investments": {"auto": auto, "manual": [_manual_out(r) for r in manual]},
    }


class ManualInvestmentIn(BaseModel):
    month: str
    amount: float
    kind: str
    recurring: bool = False
    end_month: str | None = None
    note: str | None = None


def _check(p: ManualInvestmentIn) -> None:
    ym = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
    if not ym.match(p.month) or (p.end_month and not ym.match(p.end_month)):
        raise HTTPException(400, "Pick a month")
    if p.end_month and p.end_month < p.month:
        raise HTTPException(400, "The last month can't be before the first")
    if not (0 < p.amount < 1e9):
        raise HTTPException(400, "Enter an amount")
    if p.kind not in KINDS:
        raise HTTPException(400, "Pick what kind of investment it is")


@router.post("/investments", response_model=dict, status_code=201)
def add_investment(payload: ManualInvestmentIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    _check(payload)
    r = ManualInvestment(user_id=caller.id, month=payload.month, amount=round(payload.amount, 2),
                         kind=payload.kind, recurring=payload.recurring,
                         end_month=payload.end_month if payload.recurring else None,
                         note=(payload.note or "").strip()[:200] or None)
    db.add(r)
    db.commit()
    return _manual_out(r)


@router.put("/investments/{inv_id}", response_model=dict)
def edit_investment(inv_id: int, payload: ManualInvestmentIn, db: Session = Depends(get_db),
                    caller: User = Depends(current_user)):
    _check(payload)
    r = db.query(ManualInvestment).filter(ManualInvestment.id == inv_id, ManualInvestment.user_id == caller.id).first()
    if not r:
        raise HTTPException(404, "No such investment")
    r.month, r.amount, r.kind, r.recurring = payload.month, round(payload.amount, 2), payload.kind, payload.recurring
    r.end_month = payload.end_month if payload.recurring else None
    r.note = (payload.note or "").strip()[:200] or None
    db.commit()
    return _manual_out(r)


@router.delete("/investments/{inv_id}", status_code=204)
def delete_investment(inv_id: int, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    db.query(ManualInvestment).filter(ManualInvestment.id == inv_id, ManualInvestment.user_id == caller.id).delete()
    db.commit()


# ── what a "where the money went" line is made of ──────────────────────────

SOURCES = ("monthly", "groups", "cards", "recurring", "repayments")


@router.get("/items", response_model=dict)
def items(month: str, source: str, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """The expenses behind one line of the dashboard for one month - the same
    rules as /dashboard, so they add up to its figure: {items: [{date, title,
    detail, amount}], less: [...things taken off (cards)], total}."""
    if source not in SOURCES or not re.match(r"^\d{4}-(0[1-9]|1[0-2])$", month):
        raise HTTPException(400, "Pick a month and a line")
    from routers.stats import _member_share, get_history
    me = caller.name.lower()
    out, less = [], []

    if source in ("monthly", "groups", "cards"):
        hist = get_history(db=db, caller=caller)
        groups = {g["id"]: g for g in hist["groups"]}
        gids = list(groups)

    if source in ("monthly", "groups") and gids:
        solo = source == "monthly"
        ids = [gid for gid, g in groups.items() if (len(g["members"]) <= 1) == solo]
        for e in (db.query(Expense).filter(Expense.group_id.in_(ids or [-1]), Expense.date.like(f"{month}%"))
                  .order_by(Expense.date.desc())):
            share = float(e.amount or 0) if solo else (_member_share(e, me) or 0.0)
            if share < 0.005:
                continue
            g = groups[e.group_id]
            title = e.title or e.merchant or e.category or "Expense"
            detail = [x for x in (e.category, None if solo else f"{g['emoji'] or ''} {g['name']}".strip()) if x]
            if not solo and abs(share - (e.amount or 0)) >= 0.5:
                detail.append(f"your share of Rs {e.amount:,.0f}")
            row = {"date": (e.date or "")[:10], "title": title, "detail": " · ".join(detail), "amount": round(share, 2)}
            if solo:
                row.update(id=e.id, payee=e.merchant or e.title or "")    # can be moved to P2P / investments
            out.append(row)

    elif source == "cards":
        from card_bills import card_name
        skipped = {k for (k,) in db.query(SalaryCardSkip.line_key).filter(SalaryCardSkip.user_id == caller.id)}
        from models import CreditCard
        cards = {c.id: c for c in db.query(CreditCard).filter(CreditCard.user_id == caller.id)}
        for s in db.query(CreditCardStatement).filter(CreditCardStatement.user_id == caller.id):
            card = card_name(cards[s.card_id]) if s.card_id in cards else s.bank
            try:
                details = json.loads(s.details_json) if s.details_json else None
            except ValueError:
                details = None
            lines = (details or {}).get("transactions") or []
            if lines:
                for t in lines:
                    if t.get("excluded") or t.get("type") != "debit" or not (t.get("date") or "").startswith(month):
                        continue
                    key = line_key(s.id, t)
                    row = {"date": t["date"][:10], "title": t.get("description") or "Card spend",
                           "detail": " · ".join(x for x in (card, t.get("category")) if x),
                           "amount": round(float(t.get("amount") or 0), 2), "key": key}
                    out.append(row)
                    if key in skipped:
                        less.append({**row, "detail": "you marked it already counted", "marked": True})
            elif (s.period or (s.statement_date or "")[:7]) == month and s.total_due:
                key = line_key(s.id)
                row = {"date": s.statement_date or "", "title": f"{card} bill", "detail": "not broken down yet - counted in full",
                       "amount": round(s.total_due, 2), "key": key}
                out.append(row)
                if key in skipped:
                    less.append({**row, "detail": "you marked it already counted", "marked": True})
        if gids:
            for e in (db.query(Expense).filter(Expense.group_id.in_(gids), Expense.payment_mode == "credit_card",
                                               Expense.paid_by.ilike(caller.name), Expense.date.like(f"{month}%"))):
                less.append({"date": (e.date or "")[:10], "title": e.title or e.merchant or "Card expense",
                             "detail": f"already counted in {groups[e.group_id]['name']}", "amount": round(e.amount or 0, 2)})
        for ln in db.query(Loan).filter(Loan.card_ref.isnot(None), Loan.lender.ilike(caller.name),
                                        Loan.start_date.like(f"{month}%")):
            less.append({"date": ln.start_date, "title": ln.note or "Card spend passed on",
                         "detail": f"passed on to {ln.borrower} as a loan", "amount": round(ln.principal, 2)})

    elif source == "recurring":
        for ch in db.query(RecurringCharge).filter(RecurringCharge.member.ilike(caller.name), RecurringCharge.period == month):
            out.append({"date": month, "title": ch.bill.title, "detail": f"your share · {ch.bill.payer} pays it",
                        "amount": round(ch.share, 2)})
        for bill in db.query(RecurringBill).filter(RecurringBill.payer.ilike(caller.name)):
            if any(c.period == month for c in bill.charges):
                members = [m for m in bill.members.split(",") if m]
                out.append({"date": month, "title": bill.title,
                            "detail": f"your share of Rs {bill.amount:,.0f} · you pay it",
                            "amount": round(bill.amount / max(len(members), 1), 2)})

    elif source == "repayments":
        for ln in db.query(Loan).filter(Loan.borrower.ilike(caller.name)):
            for p in ln.payments:
                if p.date.startswith(month):
                    out.append({"date": p.date, "title": f"Repaid {ln.lender}", "detail": ln.note or "loan repayment",
                                "amount": round(p.amount, 2)})

    gross = round(sum(x["amount"] for x in out), 2)
    taken = round(sum(x["amount"] for x in less), 2)
    total = max(0.0, round(gross - taken, 2)) if source == "cards" else gross
    out.sort(key=lambda x: (-x["amount"], x["date"]))
    less.sort(key=lambda x: -x["amount"])
    return {"month": month, "source": source, "items": out, "less": less, "gross": gross, "total": total}


class CardSkipIn(BaseModel):
    key: str
    counted: bool = True           # True: already counted elsewhere - leave it out; False: count it again


@router.post("/card-skips", response_model=dict)
def card_skip(payload: CardSkipIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """Mark a card spend as already counted (in a group, say) - or count it again."""
    key = (payload.key or "").strip()[:300]
    sid = key.split(":", 1)[0]
    if not sid.isdigit() or not db.query(CreditCardStatement.id).filter(
            CreditCardStatement.id == int(sid), CreditCardStatement.user_id == caller.id).first():
        raise HTTPException(404, "No such card spend")
    row = db.query(SalaryCardSkip).filter(SalaryCardSkip.user_id == caller.id, SalaryCardSkip.line_key == key).first()
    if payload.counted and not row:
        db.add(SalaryCardSkip(user_id=caller.id, line_key=key))
    elif not payload.counted and row:
        db.delete(row)
    db.commit()
    return {"key": key, "counted": payload.counted}


# ── moving a monthly expense out: it was money to a person, or an investment ──
# What the statement rules missed: the expense leaves the monthly group and
# joins that month's "to people" / investments (StatementSkip) - the same
# place an import puts what it recognises. With `remember`, the payee is
# labelled so later imports skip it on their own (PayeeLabel, source "user").

class MoveIn(BaseModel):
    expense_id: int
    kind: str                 # "people" (P2P) | "investment"
    remember: bool = False


def _own_solo_expense(db: Session, caller: User, expense_id: int) -> Expense:
    from models import Group
    e = db.get(Expense, expense_id)
    g = db.get(Group, e.group_id) if e else None
    if not e or not g or len(g.members) != 1 or g.members[0].name.lower() != caller.name.lower():
        raise HTTPException(404, "Only your own monthly expenses can be moved")
    return e


@router.post("/move", response_model=dict)
def move_expense(payload: MoveIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    from models import PayeeLabel
    from routers.expenses import _norm
    if payload.kind not in ("people", "investment"):
        raise HTTPException(400, "P2P or investment")
    e = _own_solo_expense(db, caller, payload.expense_id)
    payee = (e.merchant or e.title or "Payment")[:200]
    undo = {"group_id": e.group_id, "date": e.date, "title": e.title, "merchant": e.merchant, "amount": e.amount,
            "category": e.category, "subcategory": e.subcategory, "txn_time": e.txn_time, "txn_ref": e.txn_ref,
            "payment_mode": e.payment_mode, "notes": e.notes}
    skip = StatementSkip(user_name=caller.name, kind=payload.kind, date=(e.date or "")[:10], time=e.txn_time,
                         merchant=payee, amount=e.amount, txn_id=e.txn_ref,
                         reason="moved here by you from monthly expenses", source="manual")
    db.add(skip)
    db.delete(e)
    label = None
    key = _norm(payee)
    if payload.remember and key:
        decision = "p2p" if payload.kind == "people" else "investment"
        label = db.query(PayeeLabel).filter(PayeeLabel.user_name.ilike(caller.name), PayeeLabel.payee_key == key).first()
        if label:
            undo["label_was"] = {"decision": label.decision, "category": label.category,
                                 "subcategory": label.subcategory, "source": label.source}
            label.decision, label.category, label.subcategory, label.source = decision, None, None, "user"
        else:
            label = PayeeLabel(user_name=caller.name, payee_key=key, payee=payee, decision=decision, source="user",
                               note="moved from monthly expenses")
            db.add(label)
            undo["label_new"] = True
    db.commit()
    return {"skip_id": skip.id, "kind": payload.kind, "remembered": bool(label), "undo": undo}


class MoveBackIn(BaseModel):
    skip_id: int
    undo: dict


@router.post("/move-back", response_model=dict)
def move_back(payload: MoveBackIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """Undo a move: the expense is back in its monthly group, the payee label as it was."""
    from models import Group, PayeeLabel
    from routers.expenses import _norm
    skip = db.get(StatementSkip, payload.skip_id)
    if not skip or skip.user_name.lower() != caller.name.lower():
        raise HTTPException(404, "Nothing to undo")
    u = payload.undo or {}
    g = db.get(Group, int(u.get("group_id") or 0))
    if not g or len(g.members) != 1 or g.members[0].name.lower() != caller.name.lower():
        raise HTTPException(404, "That monthly group is gone")
    e = Expense(group_id=g.id, date=u.get("date") or skip.date, title=u.get("title"), merchant=u.get("merchant"),
                amount=skip.amount, paid_by=caller.name, participants=None, divider=1, individual_amount=skip.amount,
                category=u.get("category"), subcategory=u.get("subcategory"), category_source="user",
                txn_time=u.get("txn_time"), txn_ref=u.get("txn_ref"), payment_mode=u.get("payment_mode"),
                notes=u.get("notes"))
    db.add(e)
    db.delete(skip)
    key = _norm(skip.merchant)
    label = db.query(PayeeLabel).filter(PayeeLabel.user_name.ilike(caller.name), PayeeLabel.payee_key == key).first()
    if label and u.get("label_new"):
        db.delete(label)
    elif label and u.get("label_was"):
        w = u["label_was"]
        label.decision, label.category, label.subcategory, label.source = (w.get("decision"), w.get("category"),
                                                                          w.get("subcategory"), w.get("source"))
    db.commit()
    return {"ok": True, "expense_id": e.id}


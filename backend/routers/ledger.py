"""Notebook pages: photograph a handwritten page of shared expenses, review
what was read, save it as expenses - see ledger_reader.py.

Each row becomes one expense with each person's share as a custom split.
The page records what each person spent, not money anyone owes, so every
share is marked as covered by the person it belongs to (settled_by): the
group shows who spent what, and nobody owes anybody.

A printed bill photographed here is different: no per-person columns, one
person paid. Each line item becomes its own ordinary group expense, split
equally between the members chosen (save_bill).
"""
from __future__ import annotations

import json

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

import expense_classifier
from activity import record_activity
from auth import current_user, member_group
from database import get_db
from models import Expense, LedgerHint, User

router = APIRouter(prefix="/ledger", tags=["ledger"])


def _hints(db: Session, user_id: int, group_id: int) -> tuple[dict, dict]:
    rows = db.query(LedgerHint).filter(LedgerHint.user_id == user_id).all()
    columns = {h.key: h.value for h in rows if h.kind == "column" and h.group_id == group_id}
    words = {h.key: h.value for h in sorted(rows, key=lambda h: h.updated_at or 0, reverse=True) if h.kind == "word"}
    return columns, words


def _remember(db: Session, user_id: int, group_id: int | None, kind: str, key: str, value: str) -> None:
    key, value = key.strip()[:200], value.strip()[:200]
    if not key or not value or key == value:
        return
    row = (db.query(LedgerHint)
           .filter(LedgerHint.user_id == user_id, LedgerHint.group_id == group_id,
                   LedgerHint.kind == kind, LedgerHint.key == key).first())
    if row:
        row.value = value
    else:
        db.add(LedgerHint(user_id=user_id, group_id=group_id, kind=kind, key=key, value=value))


@router.post("/read", response_model=dict)
def read_ledger_page(group_id: int = Form(...), file: UploadFile = File(...),
                     db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """What's on the page, for the review screen - nothing is saved. Column
    headings come back mapped to members: as learned for this group, else
    by the member whose name starts with that letter."""
    import ledger_reader
    group = member_group(group_id, caller, db, with_history=False)
    members = [m.name for m in group.members]
    columns, words = _hints(db, caller.id, group.id)
    try:
        page = ledger_reader.read_page(file.file.read(), columns, words)
    except RuntimeError as e:
        # No key, Gemini down or over its quota - nothing a better photo fixes.
        raise HTTPException(503, str(e)[:200])
    except Exception as e:
        raise HTTPException(502, f"Couldn't read that page - try a sharper, straighter photo. ({str(e)[:150]})")
    if page.get("kind") == "bill":
        # A printed bill has no per-person columns: each line item becomes
        # its own group expense, paid by one member and split the usual way
        # (/ledger/save-bill).
        if not page.get("items"):
            raise HTTPException(502, "That looks like a bill, but its items couldn't be read - try a sharper photo.")
        return {**page, "members": members}
    mapping = {}
    for col in page["share_columns"]:
        guess = columns.get(col)
        if not guess:
            letter = col.strip().strip(".")[:1].lower()
            starts = [m for m in members if m.lower().startswith(letter)] if letter else []
            guess = starts[0] if len(starts) == 1 else None
        mapping[col] = guess if guess in members else None
    return {**page, "members": members, "mapping": mapping}


class LedgerRow(BaseModel):
    title: str
    total: float
    shares: dict[str, float]          # member -> amount
    read_as: str | None = None        # the item as the page reader read it, if the person changed it


class LedgerSave(BaseModel):
    group_id: int
    date: str | None = None
    rows: list[LedgerRow]
    columns: dict[str, str] = {}      # column heading -> member, to remember for this group


@router.post("/save", response_model=dict)
def save_ledger_page(payload: LedgerSave, background_tasks: BackgroundTasks,
                     db: Session = Depends(get_db), caller: User = Depends(current_user)):
    group = member_group(payload.group_id, caller, db, with_history=False)
    members = {m.name.lower(): m.name for m in group.members}
    created = []
    for r in payload.rows:
        shares = {}
        for name, amt in r.shares.items():
            if amt and amt > 0:
                if name.lower() not in members:
                    raise HTTPException(400, f"{name} isn't in this group")
                shares[members[name.lower()]] = round(float(amt), 2)
        title = (r.title or "").strip()
        if not title or not shares:
            continue
        total = round(sum(shares.values()), 2)
        if abs(total - r.total) > 1:
            raise HTTPException(400, f'"{title}": shares add up to {total:,.0f}, not {r.total:,.0f}')
        payer = max(shares, key=shares.get)
        others = [n for n in shares if n != payer]
        e = Expense(
            group_id=group.id, date=payload.date, title=title[:200], amount=total,
            paid_by=payer, participants=",".join(shares), divider=len(shares),
            individual_amount=round(total / len(shares), 2),
            split_json=json.dumps(shares), settled_by=json.dumps(others),
            category_source="pending", notes="From a notebook page - each person's own share, nobody owes",
        )
        db.add(e)
        created.append(e)
        if r.read_as:
            _remember(db, caller.id, None, "word", r.read_as, title)
    if not created:
        raise HTTPException(400, "Nothing to save")
    for col, name in payload.columns.items():
        if name and name.lower() in members:
            _remember(db, caller.id, group.id, "column", col, members[name.lower()])
    db.flush()
    ids = [e.id for e in created]
    record_activity(db, group, caller.name, "added expenses from a notebook page",
                    f"{len(ids)} expenses, ₹{sum(e.amount for e in created):,.0f}")
    db.commit()
    for i in ids:
        background_tasks.add_task(expense_classifier.enqueue, i)
    return {"created": len(ids), "total": round(sum(e.amount for e in created), 2), "expense_ids": ids}


class BillItem(BaseModel):
    title: str
    amount: float


class BillSave(BaseModel):
    group_id: int
    date: str | None = None
    merchant: str | None = None
    paid_by: str
    participants: list[str]           # who each item is split between, equally
    items: list[BillItem]


@router.post("/save-bill", response_model=dict)
def save_bill(payload: BillSave, background_tasks: BackgroundTasks,
              db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """A printed bill read off a notebook-page photo: each line item its own
    ordinary group expense - one payer, split equally between the chosen
    members, who then owe their share as with any expense. Categorised one
    by one, so a bill of groceries and a kitchen tool files them apart."""
    group = member_group(payload.group_id, caller, db, with_history=False)
    members = {m.name.lower(): m.name for m in group.members}
    payer = members.get(payload.paid_by.strip().lower())
    if not payer:
        raise HTTPException(400, f"{payload.paid_by} isn't in this group")
    parts = []
    for name in payload.participants:
        if name.strip().lower() not in members:
            raise HTTPException(400, f"{name} isn't in this group")
        if members[name.strip().lower()] not in parts:
            parts.append(members[name.strip().lower()])
    if not parts:
        raise HTTPException(400, "Choose who the bill is split between")
    merchant = (payload.merchant or "").strip()[:150]
    created = []
    for it in payload.items:
        title = (it.title or "").strip()
        if not title or not it.amount or it.amount <= 0:
            continue
        amount = round(float(it.amount), 2)
        e = Expense(
            group_id=group.id, date=payload.date, title=title[:200], amount=amount,
            paid_by=payer, participants=",".join(parts), divider=len(parts),
            individual_amount=round(amount / len(parts), 2),
            category_source="pending",
            notes=f"From a {merchant} bill" if merchant else "From a bill",
        )
        db.add(e)
        created.append(e)
    if not created:
        raise HTTPException(400, "Nothing to save")
    db.flush()
    ids = [e.id for e in created]
    total = round(sum(e.amount for e in created), 2)
    record_activity(db, group, caller.name, "added expenses from a bill",
                    f"{len(ids)} items{f' from {merchant}' if merchant else ''}, ₹{total:,.0f} paid by {payer}")
    db.commit()
    for i in ids:
        background_tasks.add_task(expense_classifier.enqueue, i)
    return {"created": len(ids), "total": total, "expense_ids": ids}

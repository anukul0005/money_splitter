"""Treats: someone not in the group paid for it (models.GroupTreat).

Shreya got the drinks - ₹3,000 for you and Anjali. Nobody in the group paid,
so it isn't an expense and never touches balances, settle-up, stats or the
salary dashboard. It's kept on the group as a reminder - who treated whom,
and each person's share if it was split - until it's marked returned.
"""
from __future__ import annotations

import json
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from activity import record_activity
from auth import current_user, member_group
from database import get_db
from models import GroupTreat, User

router = APIRouter(prefix="/treats", tags=["treats"])


class TreatIn(BaseModel):
    group_id: int | None = None
    by_name: str
    amount: float
    title: str | None = None
    date: str | None = None
    members: list[str] | None = None      # who was treated; none -> everyone in the group
    split: bool = False
    notes: str | None = None


class ReturnIn(BaseModel):
    returned: bool = True
    on: str | None = None
    note: str | None = None


def _out(t: GroupTreat, names: list[str]) -> dict:
    try:
        who = json.loads(t.members) if t.members else None
    except ValueError:
        who = None
    who = who or names
    return {
        "id": t.id, "group_id": t.group_id, "by_name": t.by_name, "title": t.title,
        "amount": t.amount, "date": t.date, "members": who, "split": bool(t.split),
        "share": round(t.amount / max(1, len(who)), 2) if t.split else None,
        "notes": t.notes, "returned_on": t.returned_on, "returned_note": t.returned_note,
        "created_by": t.created_by,
    }


def _clean(payload: TreatIn, group) -> dict:
    by = " ".join((payload.by_name or "").split())[:100]
    if not by:
        raise HTTPException(400, "Say who treated you")
    names = [m.name for m in group.members]
    if by.lower() in {n.lower() for n in names}:
        raise HTTPException(400, f"{by} is in this group - add it as an expense they paid instead")
    if not payload.amount or payload.amount <= 0:
        raise HTTPException(400, "Enter a valid amount")
    who = None
    if payload.members:
        lower = {n.lower(): n for n in names}
        who = []
        for n in payload.members:
            real = lower.get((n or "").strip().lower())
            if not real:
                raise HTTPException(400, f"{n} isn't in this group")
            if real not in who:
                who.append(real)
        if not who:
            raise HTTPException(400, "Pick who was treated")
        if len(who) == len(names):
            who = None
    return {
        "by_name": by, "amount": round(float(payload.amount), 2),
        "title": (payload.title or "").strip()[:200] or None,
        "date": (payload.date or "")[:20] or date.today().isoformat(),
        "members": json.dumps(who) if who else None, "split": bool(payload.split),
        "notes": (payload.notes or "").strip() or None,
    }


def _line(t: GroupTreat) -> str:
    return f"{t.title or 'a treat'}: ₹{t.amount:,.0f} paid by {t.by_name} (not in the group)"


@router.get("/group/{group_id}")
def list_treats(group_id: int, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    group = member_group(group_id, caller, db, with_history=False)
    names = [m.name for m in group.members]
    rows = (db.query(GroupTreat).filter(GroupTreat.group_id == group_id)
            .order_by(GroupTreat.date.desc(), GroupTreat.id.desc()).all())
    return [_out(t, names) for t in rows]


@router.post("/", status_code=201)
def add_treat(payload: TreatIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    if not payload.group_id:
        raise HTTPException(400, "Pick a group")
    group = member_group(payload.group_id, caller, db, with_history=False)
    t = GroupTreat(group_id=group.id, created_by=caller.name, **_clean(payload, group))
    db.add(t)
    db.flush()
    record_activity(db, group, caller.name, "noted a treat", _line(t))
    db.commit()
    db.refresh(t)
    return _out(t, [m.name for m in group.members])


def _own(treat_id: int, db, caller):
    t = db.get(GroupTreat, treat_id)
    if t is None:
        raise HTTPException(404, "Not found")
    return t, member_group(t.group_id, caller, db, with_history=False)


@router.put("/{treat_id}")
def edit_treat(treat_id: int, payload: TreatIn, db: Session = Depends(get_db),
               caller: User = Depends(current_user)):
    t, group = _own(treat_id, db, caller)
    for k, v in _clean(payload, group).items():
        setattr(t, k, v)
    db.commit()
    return _out(t, [m.name for m in group.members])


@router.post("/{treat_id}/returned")
def mark_returned(treat_id: int, payload: ReturnIn, db: Session = Depends(get_db),
                  caller: User = Depends(current_user)):
    t, group = _own(treat_id, db, caller)
    if payload.returned:
        t.returned_on = (payload.on or "")[:20] or date.today().isoformat()
        t.returned_note = (payload.note or "").strip()[:200] or None
        record_activity(db, group, caller.name, "returned a treat", f"{t.by_name}'s {t.title or 'treat'} (₹{t.amount:,.0f})")
    else:
        t.returned_on = t.returned_note = None
    db.commit()
    return _out(t, [m.name for m in group.members])


@router.delete("/{treat_id}", status_code=204)
def delete_treat(treat_id: int, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    t, group = _own(treat_id, db, caller)
    record_activity(db, group, caller.name, "removed a treat", _line(t))
    db.delete(t)
    db.commit()

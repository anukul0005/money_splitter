"""Notes: anything worth keeping, as a table whose columns its owner names
(models.NoteTable). Private, or shared with people: anyone on the app it's
shared with can see and edit it; a name not on the app is just noted."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from auth import caller_groups, current_user, is_member, member_group
from database import get_db
from models import Group, NoteTable, User

router = APIRouter(prefix="/notes", tags=["notes"])

MAX_COLS, MAX_ROWS, MAX_CELL = 20, 1000, 2000


class NoteIn(BaseModel):
    title: str
    columns: list[str]
    people: list[str] | None = None       # names - on the app or not
    group_id: int | None = None
    rows: list[dict | list] | None = None


class NoteEdit(BaseModel):
    title: str | None = None
    columns: list[str] | None = None
    rows: list[dict | list] | None = None
    people: list[str] | None = None


def _people(db: Session, raw: list[str], owner: str) -> list[dict]:
    """Each name as the app knows it if someone there has it, otherwise as
    typed (not on the app); the owner and repeats left out."""
    out, seen = [], {owner.lower()}
    for n in raw:
        n = " ".join(str(n or "").split())[:100]
        if not n or n.lower() in seen:
            continue
        u = db.query(User).filter(func.lower(User.name) == n.lower()).first()
        name = u.name if u else n
        seen.add(name.lower())
        out.append({"name": name, "on_app": bool(u)})
    if len(out) > 50:
        raise HTTPException(400, "Share with at most 50 people")
    return out


def _shared(n: NoteTable) -> list[dict]:
    try:
        return json.loads(n.shared_with) if n.shared_with else []
    except ValueError:
        return []


def _cols(raw: list[str]) -> list[str]:
    out = []
    for c in raw:
        c = " ".join(str(c or "").split())[:60]
        if c and c.lower() not in {x.lower() for x in out}:
            out.append(c)
    if not out:
        raise HTTPException(400, "Give the table at least one column")
    if len(out) > MAX_COLS:
        raise HTTPException(400, f"At most {MAX_COLS} columns")
    return out


def _stored(n: NoteTable) -> list[dict]:
    """The note's rows as [{id, cells, by, at}]. Rows from before who added
    them was kept (plain lists, or at=None) have no known author: `by` is a
    guess - the owner - that anyone in the note can correct (_rows)."""
    out = []
    for i, r in enumerate(json.loads(n.rows_json or "[]")):
        out.append(r if isinstance(r, dict) else {"id": f"r{i}", "cells": r, "by": n.owner, "at": None})
    return out


def _rows(raw: list, n: int, old: list[dict], caller: str, names: set[str] = frozenset()) -> list[dict]:
    """The rows sent, each [{id, cells}] (or a bare list of cells): a row the
    note already has keeps who added it and when; a new one is the caller's.
    Who added a row is only taken from what's sent for a row from before
    that was recorded (at=None) - and then only someone in the note
    (`names`, lower-case)."""
    if len(raw) > MAX_ROWS:
        raise HTTPException(400, f"At most {MAX_ROWS} rows")
    known = {r["id"]: r for r in old}
    now = datetime.now(timezone.utc).isoformat()
    out = []
    for i, r in enumerate(raw):
        if isinstance(r, dict):
            rid, cells = str(r.get("id") or "")[:40], r.get("cells") or []
        else:            # an older client: rows by position
            rid, cells = (old[i]["id"] if i < len(old) else ""), r
        cells = [str(c if c is not None else "")[:MAX_CELL] for c in cells][:n]
        prev = known.get(rid)
        if not rid or rid in {x["id"] for x in out}:
            rid = uuid.uuid4().hex[:12]
        by = prev["by"] if prev else caller
        if prev and prev.get("at") is None and isinstance(r, dict):
            want = " ".join(str(r.get("by") or "").split())
            if want and want.lower() in names:
                by = want
        out.append({"id": rid, "cells": cells + [""] * (n - len(cells)),
                    "by": by, "at": prev["at"] if prev else now})
    return out


def _out(n: NoteTable, groups: dict[int, str], full: bool = True) -> dict:
    cols = json.loads(n.columns_json or "[]")
    rows = _stored(n)
    d = {"id": n.id, "title": n.title, "owner": n.owner, "columns": cols, "count": len(rows),
         "group_id": n.group_id, "group": groups.get(n.group_id) if n.group_id else None,
         "people": _shared(n),
         "updated_at": n.updated_at, "updated_by": n.updated_by}
    if full:
        d["rows"] = rows
    return d


def _note(db: Session, note_id: int, caller: User) -> NoteTable:
    n = db.get(NoteTable, note_id)
    if n is None:
        raise HTTPException(404, "Note not found")
    if n.owner.lower() == caller.name.lower():
        return n
    if any(p.get("on_app") and p["name"].lower() == caller.name.lower() for p in _shared(n)):
        return n
    if n.group_id:
        g = db.get(Group, n.group_id)
        if g is not None and is_member(g, caller):
            return n
    raise HTTPException(404, "Note not found")


def _group_names(db, caller) -> dict[int, str]:
    return {g.id: g.name for g in caller_groups(db, caller, history=False, discussions=True)}


@router.get("")
def list_notes(db: Session = Depends(get_db), caller: User = Depends(current_user)):
    groups = _group_names(db, caller)
    me = caller.name.lower()
    # shared_with is JSON text - narrowed in SQL by the name, then checked exactly
    rows = (db.query(NoteTable)
            .filter(or_(func.lower(NoteTable.owner) == me, NoteTable.group_id.in_(list(groups) or [-1]),
                        func.lower(NoteTable.shared_with).contains(me)))
            .order_by(NoteTable.updated_at.desc()).all())
    rows = [n for n in rows if n.owner.lower() == me or n.group_id in groups
            or any(p.get("on_app") and p["name"].lower() == me for p in _shared(n))]
    return [_out(n, groups, full=False) for n in rows]


@router.post("", status_code=201)
def create_note(payload: NoteIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    title = " ".join((payload.title or "").split())[:200]
    if not title:
        raise HTTPException(400, "Give the note a name")
    if payload.group_id:
        member_group(payload.group_id, caller, db, with_history=False)
    cols = _cols(payload.columns)
    people = _people(db, payload.people or [], caller.name)
    n = NoteTable(owner=caller.name, group_id=payload.group_id or None, title=title,
                  shared_with=json.dumps(people) if people else None,
                  columns_json=json.dumps(cols), rows_json=json.dumps(_rows(payload.rows or [], len(cols), [], caller.name)),
                  updated_by=caller.name)
    db.add(n)
    db.commit()
    db.refresh(n)
    return _out(n, _group_names(db, caller))


@router.get("/{note_id}")
def get_note(note_id: int, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    return _out(_note(db, note_id, caller), _group_names(db, caller))


@router.patch("/{note_id}")
def edit_note(note_id: int, payload: NoteEdit, db: Session = Depends(get_db),
              caller: User = Depends(current_user)):
    n = _note(db, note_id, caller)
    if payload.title is not None:
        t = " ".join(payload.title.split())[:200]
        if not t:
            raise HTTPException(400, "Give the note a name")
        n.title = t
    if payload.people is not None:
        if n.owner.lower() != caller.name.lower():
            raise HTTPException(403, f"Only {n.owner} can change who it's shared with")
        people = _people(db, payload.people, n.owner)
        n.shared_with = json.dumps(people) if people else None
    cols = json.loads(n.columns_json)
    if payload.columns is not None:
        cols = _cols(payload.columns)
        n.columns_json = json.dumps(cols)
    if payload.rows is not None or payload.columns is not None:
        old = _stored(n)
        rows = payload.rows if payload.rows is not None else old
        names = {n.owner.lower()} | {p["name"].lower() for p in _shared(n)}
        n.rows_json = json.dumps(_rows(rows, len(cols), old, caller.name, names))
    n.updated_at, n.updated_by = datetime.now(timezone.utc), caller.name
    db.commit()
    db.refresh(n)
    return _out(n, _group_names(db, caller))


@router.delete("/{note_id}", status_code=204)
def delete_note(note_id: int, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    n = _note(db, note_id, caller)
    if n.owner.lower() != caller.name.lower():
        raise HTTPException(403, f"Only {n.owner} can delete this note")
    db.delete(n)
    db.commit()

"""Notes: anything worth keeping, as a table whose columns its owner names
(models.NoteTable). Private, or shared with one of the owner's groups - then
everyone in that group can see and edit it."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from auth import caller_groups, current_user, is_member, member_group
from database import get_db
from models import Group, NoteTable, User

router = APIRouter(prefix="/notes", tags=["notes"])

MAX_COLS, MAX_ROWS, MAX_CELL = 20, 1000, 2000


class NoteIn(BaseModel):
    title: str
    columns: list[str]
    group_id: int | None = None
    rows: list[list[str]] | None = None


class NoteEdit(BaseModel):
    title: str | None = None
    columns: list[str] | None = None
    rows: list[list[str]] | None = None


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


def _rows(raw: list[list[str]], n: int) -> list[list[str]]:
    if len(raw) > MAX_ROWS:
        raise HTTPException(400, f"At most {MAX_ROWS} rows")
    out = []
    for r in raw:
        cells = [str(c if c is not None else "")[:MAX_CELL] for c in (r or [])][:n]
        out.append(cells + [""] * (n - len(cells)))
    return out


def _out(n: NoteTable, groups: dict[int, str], full: bool = True) -> dict:
    cols = json.loads(n.columns_json or "[]")
    rows = json.loads(n.rows_json or "[]")
    d = {"id": n.id, "title": n.title, "owner": n.owner, "columns": cols, "count": len(rows),
         "group_id": n.group_id, "group": groups.get(n.group_id) if n.group_id else None,
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
    rows = (db.query(NoteTable)
            .filter(or_(NoteTable.owner.ilike(caller.name), NoteTable.group_id.in_(list(groups) or [-1])))
            .order_by(NoteTable.updated_at.desc()).all())
    return [_out(n, groups, full=False) for n in rows]


@router.post("", status_code=201)
def create_note(payload: NoteIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    title = " ".join((payload.title or "").split())[:200]
    if not title:
        raise HTTPException(400, "Give the note a name")
    if payload.group_id:
        member_group(payload.group_id, caller, db, with_history=False)
    cols = _cols(payload.columns)
    n = NoteTable(owner=caller.name, group_id=payload.group_id or None, title=title,
                  columns_json=json.dumps(cols), rows_json=json.dumps(_rows(payload.rows or [], len(cols))),
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
    cols = json.loads(n.columns_json)
    if payload.columns is not None:
        cols = _cols(payload.columns)
        n.columns_json = json.dumps(cols)
    if payload.rows is not None or payload.columns is not None:
        rows = payload.rows if payload.rows is not None else json.loads(n.rows_json or "[]")
        n.rows_json = json.dumps(_rows(rows, len(cols)))
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

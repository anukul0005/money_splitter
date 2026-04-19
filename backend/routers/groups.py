from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from database import get_db
from models import Group, Member, Expense
from schemas import GroupCreate, GroupOut, GroupSummary, GroupUpdate

router = APIRouter(prefix="/groups", tags=["groups"])


@router.get("/", response_model=list[GroupSummary])
def list_groups(db: Session = Depends(get_db)):
    groups = db.query(Group).all()
    rows = []
    for g in groups:
        total = sum(e.amount for e in g.expenses)
        dates = [e.date for e in g.expenses if e.date]
        # Sort key: latest expense date if available, else group creation date
        sort_key = max(dates) if dates else (g.created_at.date().isoformat() if g.created_at else "1970-01-01")
        rows.append((sort_key, GroupSummary(
            id=g.id,
            name=g.name,
            emoji=g.emoji,
            is_historical=g.is_historical,
            category=g.category,
            member_count=len(g.members),
            expense_count=len(g.expenses),
            total_amount=round(total, 2),
            member_names=[m.name for m in g.members],
            created_at=g.created_at,
        )))
    rows.sort(key=lambda x: x[0], reverse=True)
    return [s for _, s in rows]


@router.post("/", response_model=GroupOut, status_code=201)
def create_group(payload: GroupCreate, db: Session = Depends(get_db)):
    group = Group(
        name=payload.name,
        description=payload.description,
        emoji=payload.emoji,
        is_historical=payload.is_historical,
        category=payload.category,
    )
    db.add(group)
    db.flush()

    for name in payload.members:
        db.add(Member(group_id=group.id, name=name.strip()))

    db.commit()
    db.refresh(group)
    return group


@router.get("/{group_id}", response_model=GroupOut)
def get_group(group_id: int, db: Session = Depends(get_db)):
    group = db.query(Group).filter(Group.id == group_id).first()
    if not group:
        raise HTTPException(404, "Group not found")
    return group


@router.patch("/{group_id}", response_model=GroupOut)
def update_group(group_id: int, payload: GroupUpdate, db: Session = Depends(get_db)):
    group = db.query(Group).filter(Group.id == group_id).first()
    if not group:
        raise HTTPException(404, "Group not found")

    if payload.name is not None:
        group.name = payload.name
    if payload.description is not None:
        group.description = payload.description
    if payload.emoji is not None:
        group.emoji = payload.emoji
    if payload.is_historical is not None:
        group.is_historical = payload.is_historical
    if payload.category is not None:
        group.category = payload.category

    # Remove members by ID
    for mid in payload.members_remove:
        m = db.query(Member).filter(Member.id == mid, Member.group_id == group_id).first()
        if m:
            db.delete(m)

    # Add new members (skip duplicates case-insensitively)
    db.flush()
    existing_names = {m.name.lower() for m in db.query(Member).filter(Member.group_id == group_id).all()}
    for name in payload.members_add:
        stripped = name.strip()
        if stripped and stripped.lower() not in existing_names:
            db.add(Member(group_id=group_id, name=stripped))
            existing_names.add(stripped.lower())

    db.commit()
    db.refresh(group)
    return group


@router.delete("/{group_id}", status_code=204)
def delete_group(group_id: int, db: Session = Depends(get_db)):
    group = db.query(Group).filter(Group.id == group_id).first()
    if not group:
        raise HTTPException(404, "Group not found")
    db.delete(group)
    db.commit()

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from database import get_db
from models import Group, Member, Expense
from schemas import GroupCreate, GroupOut, GroupSummary

router = APIRouter(prefix="/groups", tags=["groups"])


@router.get("/", response_model=list[GroupSummary])
async def list_groups(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Group).order_by(Group.created_at.desc()))
    groups = result.scalars().all()

    summaries = []
    for g in groups:
        total = sum(e.amount for e in g.expenses)
        summaries.append(GroupSummary(
            id=g.id,
            name=g.name,
            emoji=g.emoji,
            is_historical=g.is_historical,
            member_count=len(g.members),
            expense_count=len(g.expenses),
            total_amount=round(total, 2),
            created_at=g.created_at,
        ))
    return summaries


@router.post("/", response_model=GroupOut, status_code=201)
async def create_group(payload: GroupCreate, db: AsyncSession = Depends(get_db)):
    group = Group(
        name=payload.name,
        description=payload.description,
        emoji=payload.emoji,
        is_historical=payload.is_historical,
    )
    db.add(group)
    await db.flush()

    for name in payload.members:
        db.add(Member(group_id=group.id, name=name.strip()))

    await db.commit()
    await db.refresh(group)
    return group


@router.get("/{group_id}", response_model=GroupOut)
async def get_group(group_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Group).where(Group.id == group_id))
    group = result.scalar_one_or_none()
    if not group:
        raise HTTPException(404, "Group not found")
    return group


@router.delete("/{group_id}", status_code=204)
async def delete_group(group_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Group).where(Group.id == group_id))
    group = result.scalar_one_or_none()
    if not group:
        raise HTTPException(404, "Group not found")
    await db.delete(group)
    await db.commit()

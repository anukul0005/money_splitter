from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from database import get_db
from models import Group, Expense
from schemas import ExpenseCreate, ExpenseOut

router = APIRouter(prefix="/expenses", tags=["expenses"])


def _compute_individual(amount: float, divider: int) -> float:
    return round(amount / divider, 2) if divider > 0 else amount


@router.get("/group/{group_id}", response_model=list[ExpenseOut])
async def list_expenses(group_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Expense).where(Expense.group_id == group_id).order_by(Expense.date, Expense.id)
    )
    return result.scalars().all()


@router.post("/", response_model=ExpenseOut, status_code=201)
async def create_expense(payload: ExpenseCreate, db: AsyncSession = Depends(get_db)):
    # verify group exists
    g = await db.execute(select(Group).where(Group.id == payload.group_id))
    if not g.scalar_one_or_none():
        raise HTTPException(404, "Group not found")

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
        notes=payload.notes,
    )
    db.add(expense)
    await db.commit()
    await db.refresh(expense)
    return expense


@router.put("/{expense_id}", response_model=ExpenseOut)
async def update_expense(expense_id: int, payload: ExpenseCreate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Expense).where(Expense.id == expense_id))
    expense = result.scalar_one_or_none()
    if not expense:
        raise HTTPException(404, "Expense not found")

    individual = payload.individual_amount or _compute_individual(payload.amount, payload.divider)

    expense.date = payload.date
    expense.category = payload.category
    expense.title = payload.title
    expense.amount = payload.amount
    expense.paid_by = payload.paid_by
    expense.participants = payload.participants
    expense.divider = payload.divider
    expense.individual_amount = individual
    expense.notes = payload.notes

    await db.commit()
    await db.refresh(expense)
    return expense


@router.delete("/{expense_id}", status_code=204)
async def delete_expense(expense_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Expense).where(Expense.id == expense_id))
    expense = result.scalar_one_or_none()
    if not expense:
        raise HTTPException(404, "Expense not found")
    await db.delete(expense)
    await db.commit()

import json
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from database import get_db
from models import Group, Expense
from schemas import ExpenseCreate, ExpenseOut, SettleRequest

router = APIRouter(prefix="/expenses", tags=["expenses"])


def _compute_individual(amount: float, divider: int) -> float:
    return round(amount / divider, 2) if divider > 0 else amount


@router.get("/group/{group_id}", response_model=list[ExpenseOut])
def list_expenses(group_id: int, db: Session = Depends(get_db)):
    return db.query(Expense).filter(Expense.group_id == group_id).order_by(Expense.date, Expense.id).all()


@router.post("/", response_model=ExpenseOut, status_code=201)
def create_expense(payload: ExpenseCreate, db: Session = Depends(get_db)):
    if not db.query(Group).filter(Group.id == payload.group_id).first():
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
        split_json=payload.split_json,
        notes=payload.notes,
    )
    db.add(expense)
    db.commit()
    db.refresh(expense)
    return expense


@router.put("/{expense_id}", response_model=ExpenseOut)
def update_expense(expense_id: int, payload: ExpenseCreate, db: Session = Depends(get_db)):
    expense = db.query(Expense).filter(Expense.id == expense_id).first()
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
    expense.split_json = payload.split_json
    expense.payment_mode = payload.payment_mode
    expense.notes = payload.notes
    # settled_by is intentionally not reset on edit

    db.commit()
    db.refresh(expense)
    return expense


@router.patch("/{expense_id}/settle", response_model=ExpenseOut)
def settle_expense(expense_id: int, payload: SettleRequest, db: Session = Depends(get_db)):
    expense = db.query(Expense).filter(Expense.id == expense_id).first()
    if not expense:
        raise HTTPException(404, "Expense not found")

    settled: list[str] = []
    if expense.settled_by:
        try:
            settled = json.loads(expense.settled_by)
        except Exception:
            settled = []

    member = payload.member.strip()
    if payload.settled:
        if member not in settled:
            settled.append(member)
    else:
        settled = [m for m in settled if m != member]

    expense.settled_by = json.dumps(settled)
    db.commit()
    db.refresh(expense)
    return expense


@router.delete("/{expense_id}", status_code=204)
def delete_expense(expense_id: int, db: Session = Depends(get_db)):
    expense = db.query(Expense).filter(Expense.id == expense_id).first()
    if not expense:
        raise HTTPException(404, "Expense not found")
    db.delete(expense)
    db.commit()

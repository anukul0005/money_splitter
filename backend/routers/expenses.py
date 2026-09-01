import json
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from auth import current_user, member_group
from database import get_db
from models import Group, Expense, User
from schemas import ExpenseCreate, ExpenseOut
from emailer import notify_group_activity
from activity import record_activity

router = APIRouter(prefix="/expenses", tags=["expenses"])


def _compute_individual(amount: float, divider: int) -> float:
    return round(amount / divider, 2) if divider > 0 else amount


@router.get("/group/{group_id}", response_model=list[ExpenseOut])
def list_expenses(group_id: int, db: Session = Depends(get_db),
                  caller: User = Depends(current_user)):
    member_group(group_id, caller, db)   # 404s for anyone outside the group
    return db.query(Expense).filter(Expense.group_id == group_id).order_by(Expense.date, Expense.id).all()


@router.post("/", response_model=ExpenseOut, status_code=201)
def create_expense(payload: ExpenseCreate, db: Session = Depends(get_db),
                   caller: User = Depends(current_user)):
    group = member_group(payload.group_id, caller, db)

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
    db.flush()

    summary = f"{expense.title or expense.category or 'Expense'}: ₹{expense.amount:,.0f} paid by {expense.paid_by}"
    # Who did it comes from the token; the summary says who paid
    record_activity(db, group, caller.name, "added an expense", summary)

    db.commit()
    db.refresh(expense)

    try:
        notify_group_activity(group, expense.paid_by, "added a new expense", summary)
    except Exception as e:
        print(f"[email] expense notification failed: {e}")

    return expense


@router.put("/{expense_id}", response_model=ExpenseOut)
def update_expense(expense_id: int, payload: ExpenseCreate, db: Session = Depends(get_db),
                   caller: User = Depends(current_user)):
    expense = db.query(Expense).filter(Expense.id == expense_id).first()
    if not expense:
        raise HTTPException(404, "Expense not found")
    group = member_group(expense.group_id, caller, db)

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

    summary = f"{expense.title or expense.category or 'Expense'}: ₹{expense.amount:,.0f} paid by {expense.paid_by}"
    record_activity(db, group, caller.name, "edited an expense", summary)

    db.commit()
    db.refresh(expense)
    return expense


@router.delete("/{expense_id}", status_code=204)
def delete_expense(expense_id: int, db: Session = Depends(get_db),
                   caller: User = Depends(current_user)):
    expense = db.query(Expense).filter(Expense.id == expense_id).first()
    if not expense:
        raise HTTPException(404, "Expense not found")

    group = member_group(expense.group_id, caller, db)
    summary = f"{expense.title or expense.category or 'Expense'}: ₹{expense.amount:,.0f}"
    record_activity(db, group, caller.name, "deleted an expense", summary)

    db.delete(expense)
    db.commit()

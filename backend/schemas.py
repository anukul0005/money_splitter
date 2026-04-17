from pydantic import BaseModel, field_validator
from typing import Optional
from datetime import datetime


# ─── Member ──────────────────────────────────────────────────────────────────

class MemberBase(BaseModel):
    name: str

class MemberCreate(MemberBase):
    pass

class MemberOut(MemberBase):
    id: int
    group_id: int
    model_config = {"from_attributes": True}


# ─── Expense ─────────────────────────────────────────────────────────────────

class ExpenseBase(BaseModel):
    date: Optional[str] = None
    category: Optional[str] = None
    title: Optional[str] = None
    amount: float
    paid_by: str
    participants: Optional[str] = None   # comma-separated; null = all members
    divider: int = 2
    individual_amount: Optional[float] = None
    split_json: Optional[str] = None   # JSON: {memberName: amount} for custom/gentleman splits
    payment_mode: Optional[str] = None  # cash / upi / credit_card / debit_card
    notes: Optional[str] = None

    @field_validator("amount")
    @classmethod
    def amount_must_be_positive(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("amount must be positive")
        return round(v, 2)

class ExpenseCreate(ExpenseBase):
    group_id: int

class ExpenseOut(ExpenseBase):
    id: int
    group_id: int
    created_at: Optional[datetime] = None
    model_config = {"from_attributes": True}


# ─── Group ───────────────────────────────────────────────────────────────────

class GroupBase(BaseModel):
    name: str
    description: Optional[str] = None
    emoji: str = "💰"
    is_historical: bool = False

class GroupCreate(GroupBase):
    members: list[str]           # just names at creation time

class GroupOut(GroupBase):
    id: int
    created_at: Optional[datetime] = None
    members: list[MemberOut] = []
    expenses: list[ExpenseOut] = []
    model_config = {"from_attributes": True}

class GroupUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    emoji: Optional[str] = None
    is_historical: Optional[bool] = None
    members_add: list[str] = []
    members_remove: list[int] = []

class GroupSummary(BaseModel):
    id: int
    name: str
    emoji: str
    is_historical: bool
    member_count: int
    expense_count: int
    total_amount: float
    member_names: list[str] = []
    created_at: Optional[datetime] = None
    model_config = {"from_attributes": True}


# ─── Settlement ───────────────────────────────────────────────────────────────

class BalanceEntry(BaseModel):
    member: str
    paid: float
    share: float
    net: float           # positive → is owed; negative → owes

class Transaction(BaseModel):
    from_member: str
    to_member: str
    amount: float

class SettlementOut(BaseModel):
    group_id: int
    balances: list[BalanceEntry]
    transactions: list[Transaction]


# ─── Stats ───────────────────────────────────────────────────────────────────

class CategoryStat(BaseModel):
    category: str
    total: float

class MemberStat(BaseModel):
    member: str
    total_paid: float

class TimelineStat(BaseModel):
    date: str
    total: float

class GroupStats(BaseModel):
    group_id: int
    total: float
    by_category: list[CategoryStat]
    by_member: list[MemberStat]
    by_date: list[TimelineStat]

from sqlalchemy import Column, Integer, String, Float, Boolean, Text, ForeignKey, DateTime
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from database import Base


class Group(Base):
    __tablename__ = "groups"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), nullable=False)
    description = Column(Text, nullable=True)
    emoji = Column(String(10), default="💰")
    is_historical = Column(Boolean, default=False)
    category = Column(String(50), nullable=True)   # trip / outing / festival / personal / other
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    members = relationship("Member", back_populates="group", cascade="all, delete-orphan", lazy="selectin")
    expenses = relationship("Expense", back_populates="group", cascade="all, delete-orphan", lazy="selectin")


class Member(Base):
    __tablename__ = "members"

    id = Column(Integer, primary_key=True, index=True)
    group_id = Column(Integer, ForeignKey("groups.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(100), nullable=False)

    group = relationship("Group", back_populates="members")


class Expense(Base):
    __tablename__ = "expenses"

    id = Column(Integer, primary_key=True, index=True)
    group_id = Column(Integer, ForeignKey("groups.id", ondelete="CASCADE"), nullable=False)
    date = Column(String(20), nullable=True)
    category = Column(String(100), nullable=True)
    title = Column(String(200), nullable=True)
    amount = Column(Float, nullable=False)
    paid_by = Column(String(100), nullable=False)
    # comma-separated names of who participates; if null → all group members
    participants = Column(Text, nullable=True)
    divider = Column(Integer, nullable=False, default=2)
    individual_amount = Column(Float, nullable=True)
    split_json = Column(Text, nullable=True)   # JSON: {memberName: amount} for custom splits
    payment_mode = Column(String(50), nullable=True)  # cash / upi / credit_card / debit_card
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    group = relationship("Group", back_populates="expenses")

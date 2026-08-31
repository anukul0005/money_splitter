from sqlalchemy import Column, Integer, String, Float, Boolean, Text, ForeignKey, DateTime
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False, unique=True)
    password_hash = Column(String(128), nullable=False)
    salt = Column(String(64), nullable=False)
    is_admin = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


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
    payments = relationship("Payment", back_populates="group", cascade="all, delete-orphan", lazy="selectin")


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
    settled_by = Column(Text, nullable=True)   # JSON array of member names who settled their share
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    group = relationship("Group", back_populates="expenses")


class Payment(Base):
    """A real transfer of money between two members of a group.

    Recording one reduces what `from_member` owes `to_member` by `amount`;
    enough of them and the pair is settled. This replaces the old per-expense
    "mark as settled" flag as the user-facing way to clear a debt.
    """

    __tablename__ = "payments"

    id = Column(Integer, primary_key=True, index=True)
    group_id = Column(Integer, ForeignKey("groups.id", ondelete="CASCADE"), nullable=False)
    from_member = Column(String(100), nullable=False)
    to_member = Column(String(100), nullable=False)
    amount = Column(Float, nullable=False)
    date = Column(String(20), nullable=True)
    note = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    group = relationship("Group", back_populates="payments")


class Activity(Base):
    """One entry in the in-app notification feed.

    Always scoped to a group: only that group's members ever see it, which is
    what keeps a change invisible to users who aren't affected by it.
    """

    __tablename__ = "activities"

    id = Column(Integer, primary_key=True, index=True)
    group_id = Column(Integer, ForeignKey("groups.id", ondelete="CASCADE"), nullable=False, index=True)
    group_name = Column(String(200), nullable=True)   # denormalised so deleted groups still read well
    actor = Column(String(100), nullable=True)
    verb = Column(String(100), nullable=False)        # "added an expense", "recorded a payment", …
    summary = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)


class ActivitySeen(Base):
    """Per-user high-water mark for the notification bell's unread count."""

    __tablename__ = "activity_seen"

    user_name = Column(String(100), primary_key=True)
    last_seen_at = Column(DateTime(timezone=True), server_default=func.now())

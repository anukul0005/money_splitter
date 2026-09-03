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
    # Self-serve password reset: the answer is hashed with its own salt, exactly
    # like the password, so a database leak doesn't hand over the recovery route.
    recovery_question = Column(String(200), nullable=True)
    recovery_answer_hash = Column(String(128), nullable=True)
    recovery_salt = Column(String(64), nullable=True)
    # A 6-digit key is only a million combinations, so reset attempts are
    # counted and locked out rather than left open to a scripted guess.
    reset_fail_count = Column(Integer, default=0)
    reset_locked_until = Column(DateTime(timezone=True), nullable=True)
    # One-time code an admin mints for this user, letting them set a new
    # password and their own security question. Hashed like everything else,
    # and cleared the moment it is redeemed.
    otc_hash = Column(String(128), nullable=True)
    otc_salt = Column(String(64), nullable=True)
    otc_expires_at = Column(DateTime(timezone=True), nullable=True)
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


class PriceOverride(Base):
    """A price somebody corrected by hand, layered over the published tables.

    The state lists are exact but they are also a snapshot: an excise year
    turns over, a shop charges above the minimum, a brand is renamed. Somebody
    standing in the shop knows better than a PDF from April, so they can say
    so, and the correction wins from then on.

    Corrections are shared rather than private. In a group that drinks
    together the useful thing is that everyone sees the real price, and
    `set_by` keeps it attributable so a wrong one can be traced and undone.

    One row per brand, state and size - `_key` in the router normalises the
    brand so "Vat 69" and "VAT 69 " do not become two different corrections.
    """

    __tablename__ = "price_overrides"

    id = Column(Integer, primary_key=True, index=True)
    brand = Column(String(200), nullable=False)
    brand_key = Column(String(200), nullable=False, index=True)  # normalised
    kind = Column(String(20), nullable=False)      # whisky, rum, beer, …
    state = Column(String(100), nullable=False, index=True)
    size_ml = Column(Integer, nullable=False)
    price = Column(Float, nullable=False)
    # Percent alcohol by volume, as printed on the bottle. Optional: plenty of
    # people know the price without knowing the strength, and a made-up number
    # here would be shown as fact next to published ones.
    abv = Column(Float, nullable=True)
    note = Column(Text, nullable=True)
    set_by = Column(String(100), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(),
                        onupdate=func.now())


class PlaceOverride(Base):
    """A restaurant somebody added or corrected by hand.

    The food table is a snapshot of published listings, and restaurants move
    faster than anything else in this app: a place raises its prices, opens a
    second branch, or simply is not in any listing we could source. Somebody
    who ate there last week knows better than a blog post, so they can add it
    and it is recommended from then on.

    The point of this is that the app gets better the more it is used. A
    correction here is worth more than the published row it replaces, because
    it came from someone who actually paid the bill.

    Shared, like the drink corrections, and attributed by `set_by` so a wrong
    one can be traced. `cuisines` is a comma-separated list against the
    controlled vocabulary in food_prices, so a hand-added place is filterable
    exactly like a published one.
    """

    __tablename__ = "place_overrides"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), nullable=False)
    name_key = Column(String(200), nullable=False, index=True)   # normalised
    area = Column(String(200), nullable=True)
    city = Column(String(100), nullable=False, index=True)
    cuisines = Column(String(300), nullable=True)   # comma-separated
    for_two = Column(Float, nullable=False)
    kind = Column(String(30), nullable=False, default="dine-in")
    veg_only = Column(Boolean, default=False)
    note = Column(Text, nullable=True)
    set_by = Column(String(100), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(),
                        onupdate=func.now())

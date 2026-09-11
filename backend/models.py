from sqlalchemy import (
    Column, Integer, String, Float, Boolean, Text, ForeignKey, DateTime, UniqueConstraint,
)
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
    # An alternative way in, alongside the password above - never a
    # replacement for it. Nullable because most accounts won't have one set
    # right away, and a login with no email on file just isn't offered as an
    # option for that account. Uniqueness is enforced case-insensitively by
    # a partial index (see create_tables) rather than a plain UNIQUE
    # constraint, so two NULLs don't collide.
    email = Column(String(200), nullable=True)
    # A one-time login code, same shape and same lockout counter
    # (reset_fail_count / reset_locked_until above) as the admin-issued
    # password-reset code - it is a different secret for a different purpose,
    # so it gets its own hash rather than overloading otc_hash.
    login_code_hash = Column(String(128), nullable=True)
    login_code_salt = Column(String(64), nullable=True)
    login_code_expires_at = Column(DateTime(timezone=True), nullable=True)
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


class KnowledgeItem(Base):
    """One food or drink expense, embedded and searchable.

    The recommender's price tables are static and public; this is the half
    that is yours. Every expense mentioning food or drink lands here as a
    vector, so "what do we actually drink" is answered by retrieval rather
    than by a regex somebody has to keep patching.

    `embedding` is a pgvector column and is deliberately absent from this
    class: SQLAlchemy has no native type for it and the pgvector package is
    one dependency more than this needs. It is added by create_tables() and
    written with a cast in knowledge.py, which is the whole of the raw SQL in
    this codebase.

    `matched_brand` is the catalogue entry the text was linked to, if any, and
    `match_score` is how confident that link is - kept so a bad link can be
    found and the threshold argued about with evidence.
    """

    __tablename__ = "knowledge_items"

    id = Column(Integer, primary_key=True, index=True)
    # One row per expense: re-indexing updates rather than piling up.
    expense_id = Column(Integer, ForeignKey("expenses.id", ondelete="CASCADE"),
                        nullable=False, unique=True, index=True)
    # Denormalised so search can be scoped to the caller's groups without a
    # join, which is what keeps one person's spending out of another's results.
    group_id = Column(Integer, nullable=False, index=True)
    kind = Column(String(10), nullable=False, index=True)   # drink | food
    title = Column(Text, nullable=True)          # the text that was embedded
    label = Column(String(200), nullable=True)   # canonical name, or the phrase
    matched_brand = Column(String(200), nullable=True)
    match_score = Column(Float, nullable=True)
    amount = Column(Float, nullable=True)
    per_head = Column(Float, nullable=True)
    occurred_on = Column(String(20), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Product(Base):
    """One alcohol product's taste and rating profile - a fact about the
    bottle itself, never about where it's sold.

    This is Stage 1 of the alcohol knowledge base: what used to live only in
    a spreadsheet (Alcohol_Prices_Final_Rated.xlsx) as the "Product Master"
    sheet, now queryable. Price is deliberately not here - see
    ProductPrice - because a bottle's taste profile doesn't change crossing
    a state line, while its price, tax-inclusive, absolutely does.

    `rating` is always on a 0-5 scale regardless of `rating_type`: a real
    external score is rescaled onto it, an estimate is computed directly on
    it (see backfill_products.py for the exact formula). `rating_type` is
    what actually matters when this feeds a recommendation - "Verified
    (external)" and "Estimated (heuristic)" are not the same kind of fact,
    and a scoring engine that treats them identically would be more
    confident than the data supports. `rating_basis` is the one-line why:
    which source, or which formula and which inputs.
    """

    __tablename__ = "products"

    id = Column(Integer, primary_key=True, index=True)
    # The exact brand string this row was built from - see backfill_products
    # for why this is the join key rather than a further-normalised name:
    # the enrichment data (taste profile, rating) was researched and written
    # at this same granularity, one row per distinct published brand string,
    # not per semantically-merged product family.
    canonical_name = Column(String(300), nullable=False, unique=True, index=True)
    brand = Column(String(300), nullable=False)
    category = Column(String(30), nullable=True)     # whisky, rum, vodka, beer, wine, ...
    style = Column(String(80), nullable=True)         # "Blended Scotch Whisky", ...
    body = Column(String(20), nullable=True)          # light | medium | full
    abv = Column(Float, nullable=True)
    tasting_notes = Column(Text, nullable=True)

    rating = Column(Float, nullable=True)             # always 0-5
    rating_type = Column(String(40), nullable=True)   # Verified (external) | Estimated (heuristic) | ...
    rating_basis = Column(Text, nullable=True)         # why: source, or formula + inputs
    rating_source = Column(String(80), nullable=True)
    rating_url = Column(Text, nullable=True)

    # A real person's own opinion, separate from the columns above on
    # purpose - see ProductReview. Never blended into `rating`/`rating_type`,
    # which stay exactly what the enrichment pipeline produced: a citation
    # or a formula's estimate, neither of which is the same kind of fact as
    # "three people in this app have actually tried it and scored it 4.2".
    # Recomputed after every review write (see recommend.py's review
    # endpoints) rather than joined live, since it is read far more often
    # than it changes.
    community_rating = Column(Float, nullable=True)
    community_review_count = Column(Integer, nullable=False, default=0)

    # Taste-profile dimensions, each 1-5 (0 where genuinely absent, e.g. a
    # gin's smokiness). Descriptive, not evaluative - see rating above for
    # the one number that says "how good", not "what does it taste like".
    sweetness = Column(Float, nullable=True)
    smokiness = Column(Float, nullable=True)
    smoothness = Column(Float, nullable=True)
    spice = Column(Float, nullable=True)
    fruit_citrus = Column(Float, nullable=True)
    oak = Column(Float, nullable=True)
    intensity = Column(Float, nullable=True)
    beginner_friendly = Column(Float, nullable=True)
    sipping_score = Column(Float, nullable=True)
    mixer_score = Column(Float, nullable=True)

    recommendation_tags = Column(String(300), nullable=True)   # comma-separated
    # The text actually embedded for retrieval - one flattened summary of
    # everything above, written once at backfill time rather than assembled
    # from twelve columns on every search.
    rag_text = Column(Text, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(),
                        onupdate=func.now())

    prices = relationship("ProductPrice", back_populates="product",
                          cascade="all, delete-orphan", lazy="selectin")


class ProductPrice(Base):
    """What one product costs, in one state, at one size - the half of the
    catalogue that genuinely is state-specific, kept apart from Product on
    purpose (see its docstring).

    One row per (product, state, size) - the same shape liquor_prices.py's
    Bottle already has, just persisted rather than rebuilt from a Python
    module and an Excel file on every request.
    """

    __tablename__ = "product_prices"
    # A re-run of the backfill (a refreshed price sheet, say) should update
    # this state-and-size's price, not pile up a second row beside it.
    __table_args__ = (UniqueConstraint("product_id", "state", "size_ml",
                                       name="ux_product_prices_product_state_size"),)

    id = Column(Integer, primary_key=True, index=True)
    product_id = Column(Integer, ForeignKey("products.id", ondelete="CASCADE"),
                        nullable=False, index=True)
    state = Column(String(100), nullable=False, index=True)
    size_ml = Column(Integer, nullable=False)
    price = Column(Float, nullable=False)
    price_max = Column(Float, nullable=True)   # set only where the source gave a range
    source = Column(String(80), nullable=True)
    source_url = Column(Text, nullable=True)
    checked_on = Column(String(20), nullable=True)   # ISO date, as published sources use elsewhere

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    product = relationship("Product", back_populates="prices")


class ProductReview(Base):
    """One real person's own opinion of a bottle - a score, a written note,
    and optionally their own take on its taste profile.

    One row per (product, reviewer): submitting again updates that same
    person's review rather than adding a second one, so the average this
    feeds (see Product.community_rating) reflects distinct people's
    opinions, not however many times one person has resubmitted theirs.

    The taste-profile fields here are deliberately separate from Product's
    own sweetness/smokiness/etc. columns, which mostly came from a
    category-level guess during enrichment (see Product's docstring) - a
    real person's actual perception of a bottle they have had is better
    data than that guess, so once reviews exist their average is written
    onto Product's columns, replacing the guess rather than sitting beside
    it unused. Style, body and tasting_notes are text, not numbers, so
    there is nothing to average there - the most recently updated
    reviewer's version is what gets shown, the same "latest correction
    wins" rule PriceOverride already uses for a single shared fact.
    """

    __tablename__ = "product_reviews"
    __table_args__ = (UniqueConstraint("product_id", "reviewer",
                                       name="ux_product_reviews_product_reviewer"),)

    id = Column(Integer, primary_key=True, index=True)
    product_id = Column(Integer, ForeignKey("products.id", ondelete="CASCADE"),
                        nullable=False, index=True)
    reviewer = Column(String(100), nullable=False)
    score = Column(Float, nullable=False)   # 0-5, required - a review with no score isn't one
    review_text = Column(Text, nullable=True)

    style = Column(String(80), nullable=True)
    body = Column(String(20), nullable=True)
    tasting_notes = Column(Text, nullable=True)
    sweetness = Column(Float, nullable=True)
    smokiness = Column(Float, nullable=True)
    smoothness = Column(Float, nullable=True)
    spice = Column(Float, nullable=True)
    fruit_citrus = Column(Float, nullable=True)
    oak = Column(Float, nullable=True)
    intensity = Column(Float, nullable=True)
    beginner_friendly = Column(Float, nullable=True)
    sipping_score = Column(Float, nullable=True)
    mixer_score = Column(Float, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(),
                        onupdate=func.now())

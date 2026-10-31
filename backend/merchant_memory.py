"""What statement payees are, learnt from people describing payments by hand.

A statement line names its payee the way the bank does - "SRI SAI FILLING
STN PVT", "BHARAT ENT 22" - and those names defeat the keyword rules and
the LLM alike. But when the person writes their own description on one of
those payments ("Petrol"), either by editing the imported row or because
it was merged with an expense they had already entered, the categoriser
works out a category from that text. That category is what the payee is.

learn() stores it as a MerchantLabel, and every statement import after that
- by anyone on the app - files that payee's payments under it
(routers/expenses.py), with no LLM call. Earlier imports of the payee that
nobody has touched are re-filed at the same moment.

Places to eat are learnt by name too. Writing "Lunch at McDonald's" on a
"CONNAUGHT PLAZA REST" payment makes McDonald's the venue of every payment
to that payee - the untouched imports (whose title becomes the name), the
ones people described without naming the place ("lunch"), and every later
import - so the knowledge base counts them as visits to one place.

A payee that is only a person's name ("NEERAJ KUMAR", Khao Piyo's UPI) is
learnt for everyone too, but only for small payments - up to PERSON_CAP, or
more if people have filed bigger payments to it (MerchantLabel.max_amount):
a bigger transfer to a name is likely just a person. A masked number or
phone UPI id, which says nothing about who was paid, is never learnt.
"""
from __future__ import annotations

import re

from sqlalchemy import func, or_

from spend_categories import _ANONYMOUS, _BUSINESS, _rule, tea_stall_overpaid

# Categories that say nothing about a payee - not worth remembering.
_UNINFORMATIVE = {"Other", "Small vendors", "One-off payments"}
# Rows a label may re-file: imported and never described by a person.
_REFILEABLE = ("import", "merchant")
EVERYONE = ""
# The most a payment to a person-named payee can be and still be that shop,
# unless people have filed bigger ones to it (rounded up to the next ₹100)
PERSON_CAP = 300


def fits(lab, amount) -> bool:
    """lab applies to a payment of this amount (see MerchantLabel.max_amount)."""
    return lab is not None and (lab.max_amount is None or (amount or 0) <= lab.max_amount + 0.01)


def _person(merchant: str, venue: str | None = None) -> bool:
    return not (_rule(merchant) or _BUSINESS.search(merchant or ""))


def _cap(db, k: str, category: str) -> float:
    """PERSON_CAP, or the biggest payment to payee k filed under category,
    rounded up to the next ₹100 - whichever is more."""
    import math
    from models import Expense
    squashed = func.lower(func.regexp_replace(Expense.merchant, "[^a-zA-Z0-9]", "", "g"))
    top = (db.query(func.max(Expense.amount))
           .filter(Expense.merchant.isnot(None), squashed == k, Expense.category == category,
                   Expense.category_source.in_(("llm", "user", "rules"))).scalar()) or 0
    return float(max(PERSON_CAP, math.ceil(top / 100) * 100))


def key(merchant: str | None) -> str:
    """Case, spaces and punctuation dropped - the import's own payee key
    (routers/expenses._norm)."""
    return "".join(ch for ch in (merchant or "").lower() if ch.isalnum())


def _scope(merchant: str, teacher: str, venue: str | None = None) -> str | None:
    """Who a label for this payee applies to: EVERYONE for a business, the
    teacher alone for a person's name, None for an anonymous payee.

    A person's name that turned out to be a place to eat ("Mr Akhilesh
    Rajak" is Patiala Seekh Kabab) is that shop's UPI account, not a friend
    - so it's shared like any business: whoever pays it next is eating there."""
    m = (merchant or "").strip()
    if len(key(m)) < 4 or "*" in m or _ANONYMOUS.search(m) or sum(c.isdigit() for c in m) >= 6:
        return None
    return EVERYONE      # a person's name too - capped, see learn()


def _described(e) -> bool:
    """The person put their own words on it - a title that isn't just the
    payee name copied in, or notes ("KHAO PIO (Snacks)" under a title left
    as "NEERAJ KUMAR"). An import's own merge note ("PhonePe: X") isn't."""
    def own(s: str | None) -> bool:
        k = key(s)
        return bool(k) and k != key(e.merchant)
    return own(e.title) or own(_MERGE_NOTE.sub("", e.notes or ""))


def is_food(category: str | None, subcategory: str | None) -> bool:
    """A category whose venue is a place to eat - as knowledge.index_expense
    decides it."""
    return category == "Food & Dining" or (category == "Alcohol" and subcategory == "Bar")


def _touched(db, ids) -> None:
    """Rows changed behind their own request's back - collected on the
    session so the caller can re-index them in the knowledge base."""
    db.info.setdefault("merchant_touched", set()).update(ids)


def touched(db) -> list[int]:
    """Ids of rows learn()/fill_venue() changed on this session, cleared."""
    return sorted(db.info.pop("merchant_touched", set()))


def recognise_place(db, e) -> bool:
    """A statement payment described by a person whose words name a place
    to eat already on file - "Mr Akhilesh Rajak - patiyala seekh kabab" -
    gets that place and its usual category, whatever the AI made of it
    (it said "Small vendors", no venue). Call before learn_from, which then
    teaches the payee. True when it changed e."""
    from places import known_place_in
    if not (e.merchant and not e.venue and _described(e)) or e.parts:
        return False
    hit = known_place_in(db, f"{e.title or ''} {e.notes or ''}")
    if not hit:
        return False
    e.venue = hit[0]
    if not is_food(e.category, e.subcategory):
        e.category, e.subcategory = hit[1], hit[2]
    if e.id:
        _touched(db, [e.id])
    return True


def learn_from(db, e) -> None:
    """Remember what e's payee is, when e is a statement payment a person
    described and that description has been categorised. Call after the
    category is set; the caller commits. A category picked by hand
    teaches even with the payee name left as the title."""
    if not (e.merchant and e.category and not e.parts):
        return
    if tea_stall_overpaid(e.amount, e.title, e.merchant, e.venue):
        return          # not what this payee is - see spend_categories.TEA_STALL_MAX
    if not (_described(e) or e.category_source == "user"):
        return
    if e.category_source not in ("llm", "user", "rules") or e.category in _UNINFORMATIVE:
        return
    venue = e.venue if is_food(e.category, e.subcategory) else None
    learn(db, e.merchant, e.category, e.subcategory, e.paid_by, venue)


def learn(db, merchant: str, category: str, subcategory: str | None, teacher: str,
          venue: str | None = None, shared: bool = False) -> None:
    """shared: the payee is known to be a business (a card statement's
    merchant - a card swipe never pays a person), so the label is everyone's
    even when its name reads like a person's ("SRI RAM AND SON")."""
    from models import Expense, MerchantLabel

    owner = _scope(merchant, teacher, venue if is_food(category, subcategory) else None)
    if owner is None:
        return
    if shared:
        owner = EVERYONE
    k = key(merchant)
    if owner != EVERYONE and db.query(MerchantLabel.id).filter(
            MerchantLabel.merchant_key == k, MerchantLabel.owner == EVERYONE).first():
        owner = EVERYONE     # already known to everyone as a place: "lunch" there updates that
    lab = (db.query(MerchantLabel)
           .filter(MerchantLabel.merchant_key == k, MerchantLabel.owner == owner).first())
    old_venue = lab.venue if lab else None
    # A description that doesn't name the place ("lunch") leaves the name
    # someone gave before; one that moves the payee off food drops it.
    if not venue and is_food(category, subcategory):
        venue = old_venue
    if not is_food(category, subcategory):
        venue = None
    db.flush()
    cap = None if (shared or not _person(merchant)) else max(_cap(db, k, category), (lab.max_amount or 0) if lab else 0)
    if lab is None:
        lab = MerchantLabel(merchant_key=k, owner=owner, merchant=merchant.strip()[:200],
                            category=category, subcategory=subcategory, venue=venue, taught_by=teacher,
                            max_amount=cap)
        db.add(lab)
    elif (lab.category, lab.subcategory, lab.venue, lab.taught_by, lab.max_amount) != (category, subcategory, venue, teacher, cap):
        lab.category, lab.subcategory, lab.venue, lab.taught_by, lab.max_amount = category, subcategory, venue, teacher, cap
    else:
        return
    apply(db, lab, old_venue)


def _refileable(row) -> bool:
    """Imported and never described by a person - including imports from
    before category_source was kept, whose title is still the payee name."""
    return row.category_source in _REFILEABLE or (
        row.category_source is None and key(row.title) == key(row.merchant))


def apply(db, lab, old_venue: str | None = None) -> None:
    """Bring every payment to lab's payee in line with it: the ones nobody
    described take the whole answer; the ones people did keep their own
    category, and take the place's name when theirs is food and names no
    place of its own - none, the payee's bank name, or the name this payee
    had before (old_venue)."""
    from models import Expense

    # The app's sessions don't autoflush: payee names just recorded on rows
    # (an import's merge, the backfill) must reach the database before the
    # match below can see them.
    db.flush()
    squashed = func.lower(func.regexp_replace(Expense.merchant, "[^a-zA-Z0-9]", "", "g"))
    q = db.query(Expense).filter(Expense.merchant.isnot(None), squashed == lab.merchant_key)
    if lab.owner != EVERYONE:
        q = q.filter(func.lower(Expense.paid_by) == lab.owner.lower())
    cat, sub, venue = lab.category, lab.subcategory, lab.venue
    changed = []
    for row in q.all():
        if tea_stall_overpaid(row.amount, row.title, row.merchant):
            continue        # stays unclassified, whatever the payee usually is
        if not fits(lab, row.amount):
            continue        # too big to be this shop - a person's name paid a person
        if _refileable(row):
            title = venue or row.merchant
            if (row.category, row.subcategory, row.venue, row.title, row.category_source) \
                    != (cat, sub, venue, title, "merchant"):
                row.category, row.subcategory, row.category_source = cat, sub, "merchant"
                row.venue, row.title = venue, title
                changed.append(row.id)
        elif venue and row.venue != venue and is_food(row.category, row.subcategory) and (
                row.venue in (None, old_venue) or key(row.venue) == key(row.merchant)):
            row.venue = venue
            changed.append(row.id)
    _touched(db, changed)
    db.flush()


def fill_venue(db, e) -> None:
    """Name e's place from its payee's label when e is food at a payee
    someone named but e itself names no place ("lunch" on a CONNAUGHT
    PLAZA REST payment -> McDonald's). The caller commits."""
    if not (e.merchant and not e.venue and is_food(e.category, e.subcategory)):
        return
    if tea_stall_overpaid(e.amount, e.title, e.merchant):
        return
    lab = labels_for(db, {key(e.merchant)}, e.paid_by).get(key(e.merchant))
    if fits(lab, e.amount) and lab.venue:
        e.venue = lab.venue
        if e.id:
            _touched(db, [e.id])


# What a statement import appends to the notes of an expense it merged with
# ("... · PhonePe: SHREE KRISHNA ENTERPRISES") - routers/expenses.run_import.
_MERGE_NOTE = re.compile(r"(?:^|·\s*)(?:PhonePe|Google Pay|GPay|Paytm|BHIM|Amazon Pay|CRED): (.+?)\s*$")


# Marks the backfill as done. Not a payee key - those are letters and digits
# only - so no import ever matches it. Bump the version to run it again
# after learning something new (v2: places to eat; v3: imports from before
# category_source was kept; v4: descriptions naming a known place the AI
# didn't read as one; v5: person-named payees that are places to eat
# shared with everyone; v6: notes count as a description, and near
# spellings of short place names match).
# v7: person-named payees shared with everyone, for small payments.
_BACKFILL_MARK = "#backfill-v7"


def share_places(db) -> int:
    """Labels kept for their teacher alone because the payee is a person's
    name, but which name a place to eat: shared with everyone (_scope).
    Returns how many."""
    from models import MerchantLabel
    n = 0
    for lab in db.query(MerchantLabel).filter(MerchantLabel.owner.notin_([EVERYONE, "#system"])).all():
        if _person(lab.merchant):
            lab.max_amount = _cap(db, lab.merchant_key, lab.category)
        shared = (db.query(MerchantLabel)
                  .filter(MerchantLabel.merchant_key == lab.merchant_key, MerchantLabel.owner == EVERYONE).first())
        if shared:
            db.delete(lab)            # the shared one already says what this payee is
            target = shared
        else:
            lab.owner = EVERYONE
            target = lab
        db.flush()
        apply(db, target)
        n += 1
    return n


def backfill() -> int:
    """Once per _BACKFILL_MARK: record the payee of every statement payment
    that lacks one - from the merge note on an entry an import merged with,
    else, on an import nobody touched, its title - then learn from every
    one people described (oldest first, so the latest answer wins) and
    bring every payment in line with every label. Returns the label count."""
    from database import get_session_factory
    from models import Expense, MerchantLabel

    db = get_session_factory()()
    try:
        if db.query(MerchantLabel.id).filter(MerchantLabel.merchant_key == _BACKFILL_MARK).first():
            return 0
        rows = (db.query(Expense)
                .filter(or_(Expense.merchant.isnot(None), Expense.txn_ref.isnot(None),
                            Expense.notes.like("%: %")))
                .order_by(Expense.date, Expense.id).all())
        for e in rows:
            if e.merchant:
                continue
            m = _MERGE_NOTE.search(e.notes or "")
            if m:
                e.merchant = m.group(1)[:200]
            elif e.txn_ref and e.category_source in (None, "import") and e.title:
                e.merchant = e.title[:200]
        for e in rows:
            recognise_place(db, e)
            learn_from(db, e)
        share_places(db)
        for lab in db.query(MerchantLabel).filter(MerchantLabel.owner == EVERYONE,
                                                  MerchantLabel.max_amount.is_(None),
                                                  MerchantLabel.venue.isnot(None)).all():
            # shared before as a place to eat (card statements' businesses have no venue)
            if _person(lab.merchant):
                lab.max_amount = _cap(db, lab.merchant_key, lab.category)
        for lab in db.query(MerchantLabel).filter(MerchantLabel.owner != "#system").all():
            apply(db, lab)
        for e in rows:      # "lunch" there before anyone named the place
            fill_venue(db, e)
        db.query(MerchantLabel).filter(MerchantLabel.owner == "#system").delete()
        db.add(MerchantLabel(merchant_key=_BACKFILL_MARK, owner="#system", merchant="-",
                             category="-", taught_by="#system"))
        changed = touched(db)
        db.commit()
        made = db.query(MerchantLabel).filter(MerchantLabel.owner != "#system").count()
        print(f"[merchant-memory] backfill: {made} payee label(s), {len(changed)} expense(s) updated")
    finally:
        db.close()
    if changed:
        from routers.expenses import _index_many_bg
        _index_many_bg(changed)
    return made


def labels_for(db, keys, user_name: str) -> dict:
    """{payee key: MerchantLabel} for the given keys as user_name sees them:
    their own label for a payee first, else the one everyone shares."""
    from models import MerchantLabel

    keys = {k for k in keys if k}
    if not keys:
        return {}
    rows = (db.query(MerchantLabel)
            .filter(MerchantLabel.merchant_key.in_(keys),
                    or_(MerchantLabel.owner == EVERYONE,
                        func.lower(MerchantLabel.owner) == (user_name or "").lower()))
            .all())
    out: dict = {}
    for lab in sorted(rows, key=lambda r: r.owner != EVERYONE):   # shared first, own overwrites
        out[lab.merchant_key] = lab
    return out

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

A payee that is only a person's name is learnt for its teacher alone (see
models.MerchantLabel.owner); a masked number or phone UPI id, which says
nothing about who was paid, is never learnt.
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


def key(merchant: str | None) -> str:
    """Case, spaces and punctuation dropped - the import's own payee key
    (routers/expenses._norm)."""
    return "".join(ch for ch in (merchant or "").lower() if ch.isalnum())


def _scope(merchant: str, teacher: str) -> str | None:
    """Who a label for this payee applies to: EVERYONE for a business, the
    teacher alone for a person's name, None for an anonymous payee."""
    m = (merchant or "").strip()
    if len(key(m)) < 4 or "*" in m or _ANONYMOUS.search(m) or sum(c.isdigit() for c in m) >= 6:
        return None
    return EVERYONE if (_rule(m) or _BUSINESS.search(m)) else teacher


def _described(e) -> bool:
    """The title is the person's own words, not the payee name copied in."""
    return bool(e.title) and key(e.title) != key(e.merchant)


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
          venue: str | None = None) -> None:
    from models import Expense, MerchantLabel

    owner = _scope(merchant, teacher)
    if owner is None:
        return
    k = key(merchant)
    lab = (db.query(MerchantLabel)
           .filter(MerchantLabel.merchant_key == k, MerchantLabel.owner == owner).first())
    old_venue = lab.venue if lab else None
    # A description that doesn't name the place ("lunch") leaves the name
    # someone gave before; one that moves the payee off food drops it.
    if not venue and is_food(category, subcategory):
        venue = old_venue
    if not is_food(category, subcategory):
        venue = None
    if lab is None:
        lab = MerchantLabel(merchant_key=k, owner=owner, merchant=merchant.strip()[:200],
                            category=category, subcategory=subcategory, venue=venue, taught_by=teacher)
        db.add(lab)
    elif (lab.category, lab.subcategory, lab.venue, lab.taught_by) != (category, subcategory, venue, teacher):
        lab.category, lab.subcategory, lab.venue, lab.taught_by = category, subcategory, venue, teacher
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
    if lab is not None and lab.venue:
        e.venue = lab.venue
        if e.id:
            _touched(db, [e.id])


# What a statement import appends to the notes of an expense it merged with
# ("... · PhonePe: SHREE KRISHNA ENTERPRISES") - routers/expenses.run_import.
_MERGE_NOTE = re.compile(r"(?:^|·\s*)(?:PhonePe|Google Pay|GPay|Paytm|BHIM|Amazon Pay|CRED): (.+?)\s*$")


# Marks the backfill as done. Not a payee key - those are letters and digits
# only - so no import ever matches it. Bump the version to run it again
# after learning something new (v2: places to eat; v3: imports from before
# category_source was kept).
_BACKFILL_MARK = "#backfill-v3"


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
            learn_from(db, e)
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

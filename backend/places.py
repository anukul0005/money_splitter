"""One name per place to eat.

A place reaches the app under many spellings: what the AI read from a
description ("Nexe chinese", "Nexe's Chinese (Street Food) Vasundhara"),
the restaurant price list's own name for it ("Nexe’s chinese", with a curly
apostrophe), a bank payee written three ways ("Zafar Omelet Corner",
"Zafar Omlet Corner", "Zafar amlet corner"), with or without a generic word
("Domino's" / "Domino's Pizza"). "Places I've eaten at" groups visits by
name, so every spelling that survives is a duplicate place.

canonical() is the one door every place name goes through before it's
stored - the AI categoriser's venue (expense_classifier), the knowledge
base's (knowledge.index_expense) - and maps a name onto the spelling
already on file: first a merge someone made (PlaceAlias - "Zafar Egg
Corner" is Zafar Omelet Corner, which no spelling rule could know), then
same_place_name() against the names in use. merge() records such a merge
and renames every visit already stored.
"""
from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

# Words that, added to a name, don't make it another place.
_GENERIC = {"pizza", "restaurant", "restaurants", "cafe", "foods", "food", "corner", "hotel", "dhaba",
            "kitchen", "sweets", "shop", "stall", "centre", "center", "point", "house", "bar",
            "bakery", "canteen", "and", "the", "family", "veg", "fast"}


def _words(name: str) -> list[str]:
    s = unicodedata.normalize("NFKD", name or "").lower()
    s = re.sub(r"[’‘`´]", "'", s)
    s = re.sub(r"'s\b", "s", s)
    return [w for w in ("".join(ch for ch in t if ch.isalnum()) for t in s.split()) if w]


def place_key(name: str | None) -> str:
    """Case, spacing, punctuation and apostrophe style dropped: "Nexe’s
    chinese" and "Nexes Chinese" share one key."""
    return "".join(_words(name or ""))


def _qualifier(name: str | None) -> str:
    m = re.search(r"\(([^)]*)\)\s*$", name or "")
    return place_key(m.group(1)) if m else ""


def same_place_name(a: str | None, b: str | None) -> bool:
    ka, kb = place_key(a), place_key(b)
    if not ka or not kb:
        return False
    if ka == kb:
        return True
    qa, qb = _qualifier(a), _qualifier(b)
    if qa and qb and qa != qb:
        return False       # "Khao Pio (Snacks)" and "Khao Pio (FL)": two places under one name
    if min(len(ka), len(kb)) >= 6 and SequenceMatcher(None, ka, kb).ratio() >= 0.9:
        return True                       # "Omelet" / "Omlet", "Nexe" / "Nexe's"
    wa, wb = _words(a), _words(b)
    short, long = sorted((wa, wb), key=len)
    return (len("".join(short)) >= 5 and long[:len(short)] == short
            and set(long[len(short):]) <= _GENERIC)   # "Domino's" / "Domino's Pizza"


def canonical(db, name: str | None) -> str | None:
    """The spelling of this place already on file, else the name itself."""
    if not name:
        return name
    from sqlalchemy import func
    from models import Expense, PlaceAlias

    alias = db.query(PlaceAlias).filter(PlaceAlias.alias_key == place_key(name)).first()
    if alias:
        return alias.name
    best, best_n = None, 0
    for venue, n in (db.query(Expense.venue, func.count()).filter(Expense.venue.isnot(None))
                     .group_by(Expense.venue)):
        if same_place_name(venue, name) and n > best_n:
            best, best_n = venue, n
    return best or name


FOOD_CATEGORIES = ("Food & Dining",)


def known_place_in(db, text: str | None) -> tuple[str, str, str | None] | None:
    """A place already on file named somewhere in this text - (name,
    category, subcategory) as its visits are usually filed - else None.

    The AI reads "Mr Akhilesh Rajak - patiyala seekh kabab" as a street
    vendor with no venue; but Patiala Seekh Kabab has two dozen visits on
    file, and the description names it. Exact for short names (they'd
    otherwise match by accident), near spellings for longer ones
    ("patiyala" / "Patiala"), the longest match wins."""
    from sqlalchemy import func
    from models import Expense, PlaceAlias

    tkey = place_key(text)
    if len(tkey) < 6:
        return None
    # The places on file, read once per session - a history pass asks this
    # for hundreds of descriptions.
    if "place_catalogue" not in db.info:
        names: dict[str, str] = {}                     # key -> canonical name
        usual: dict[str, tuple[str, str | None, int]] = {}
        for venue, cat, sub, n in (db.query(Expense.venue, Expense.category, Expense.subcategory, func.count())
                                   .filter(Expense.venue.isnot(None), Expense.category.in_(FOOD_CATEGORIES))
                                   .group_by(Expense.venue, Expense.category, Expense.subcategory)):
            names[place_key(venue)] = venue
            if n > usual.get(venue, ("", None, 0))[2]:
                usual[venue] = (cat, sub, n)
        for a in db.query(PlaceAlias).all():
            if a.name in usual:
                names.setdefault(a.alias_key, a.name)
        db.info["place_catalogue"] = (names, usual, sorted(names, key=len, reverse=True))
    names, usual, by_length = db.info["place_catalogue"]

    def found(key: str) -> bool:
        if len(key) < 6:
            return False
        if key in tkey:
            return True
        if len(key) < 7:
            return False
        # Near spellings, a letter dropped or added: "khaopio" for Khao Piyo,
        # "patiyala" for Patiala - windows one shorter, as long, one longer.
        for w in (len(key) - 1, len(key), len(key) + 1):
            if any(SequenceMatcher(None, key, tkey[i:i + w]).ratio() >= 0.9
                   for i in range(0, max(len(tkey) - w, 0) + 1)):
                return True
        return False

    for key in by_length:
        if found(key):
            name = names[key]
            cat, sub, _ = usual[name]
            return name, cat, sub
    return None


def merge(db, names: list[str], into: str, by: str = "") -> int:
    """Make every name in `names` the place `into`: remembered for the
    future (PlaceAlias), and renamed on every expense, knowledge-base row
    and learnt merchant label already stored. Returns how many rows changed.
    The caller commits."""
    from models import Expense, KnowledgeItem, MerchantLabel, PlaceAlias

    keys = {place_key(n) for n in names} - {place_key(into)}
    for k in keys:
        row = db.query(PlaceAlias).filter(PlaceAlias.alias_key == k).first()
        if row:
            row.name = into
        else:
            db.add(PlaceAlias(alias_key=k, name=into, created_by=by or None))
    # Earlier merges into one of these names now lead to `into` as well.
    for row in db.query(PlaceAlias).all():
        if place_key(row.name) in keys:
            row.name = into
    keys.add(place_key(into))
    changed = 0
    for e in db.query(Expense).filter(Expense.venue.isnot(None)).all():
        if place_key(e.venue) in keys and e.venue != into:
            if e.category_source == "merchant" and e.title == e.venue:
                e.title = into            # an import titled by its place's name
            e.venue = into
            changed += 1
    for k in db.query(KnowledgeItem).filter(KnowledgeItem.kind == "food").all():
        if place_key(k.venue or k.matched_brand) in keys and k.venue != into:
            k.venue = into
            if k.label and place_key(k.label) in keys:
                k.label = into
            changed += 1
    for lab in db.query(MerchantLabel).filter(MerchantLabel.venue.isnot(None)).all():
        if place_key(lab.venue) in keys and lab.venue != into:
            lab.venue = into
            changed += 1
    db.flush()
    return changed

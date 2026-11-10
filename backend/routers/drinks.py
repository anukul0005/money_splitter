"""Bottles I've had - see bottles.py for how they're read from expenses."""
from __future__ import annotations

from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import bottles
from auth import current_user, is_member
from database import get_db
from models import DrinkBottle, DrinkScan, Group, User

router = APIRouter(prefix="/drinks", tags=["drinks"])

SIZE_ORDER = {"quarter": 1, "half": 2, "pint": 3, "can": 4, "bottle": 5, "full": 6}


def _mine(db: Session, caller: User):
    """The caller's drink expenses they had a share in, with their groups."""
    from routers.stats import _member_share
    groups = {g.id: g for g in db.query(Group).all() if is_member(g, caller)}
    expenses = bottles.drink_expenses(db, list(groups)) if groups else []
    mine = [e for e in expenses
            if len(groups[e.group_id].members) == 1 or _member_share(e, caller.name) is not None
            or (e.paid_by or "").lower() == caller.name.lower()]
    return groups, expenses, mine


def _key(b: DrinkBottle, sized: dict | None = None) -> tuple[str, str]:
    size, ml, _ = (sized or {}).get(b.id, (b.size, b.size_ml, False))
    return bottles.bottle_key(b.name), str(ml or size or "")


def _sized(rows, ref) -> dict:
    """bottle id -> (size, ml, guessed): the size the expense gave, else one
    guessed from what a bottle cost (_Reference.size_for) - ₹830 of Smirnoff
    is a full one."""
    by_ml = {v: k for k, v in bottles.SIZES_ML.items()}
    out = {}
    for b in rows:
        if b.size_ml or not b.price_each:
            continue
        ml = ref.size_for(b.name, b.price_each)
        if ml:
            out[b.id] = (by_ml.get(ml, f"{ml}ml") if ml != 650 else "bottle", ml, True)
    return out


GENERIC = {"beer", "beers", "vodka", "whisky", "whiskey", "rum", "gin", "wine", "brandy", "tequila", "alcohol", "liquor"}


def _generic(name: str) -> bool:
    """A kind of drink, not a bottle: "Beer", "vodka"."""
    return (name or "").strip().lower() in GENERIC


class NameIn(BaseModel):
    id: int
    name: str = Field(min_length=2, max_length=120)
    size_ml: int | None = None
    price_each: float | None = None


@router.post("/my-bottles/name", response_model=dict)
def name_bottle(body: NameIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """Give a "Beer" its brand ("Kingfisher Ultra"), and its size and price
    when known - one of the caller's own drink expenses only."""
    _, _, mine = _mine(db, caller)
    b = db.get(DrinkBottle, body.id)
    if not b or b.expense_id not in {e.id for e in mine}:
        raise HTTPException(404, "Not one of your bottles")
    if _generic(body.name):
        raise HTTPException(400, "Which brand? \"Beer\" alone can't be looked up")
    b.name = body.name.strip()
    if body.size_ml:
        b.size_ml = body.size_ml
        b.size = next((k for k, v in bottles.SIZES_ML.items() if v == body.size_ml), b.size)
    if body.price_each:
        b.price_each = round(body.price_each, 2)
    db.commit()
    return {"id": b.id, "name": b.name, "size_ml": b.size_ml, "price_each": b.price_each}


def _with(e, group: Group, caller: User) -> list[str]:
    """Who else had a share of this expense - the people the bottle was
    drunk with. Empty for one had alone."""
    from routers.stats import _member_share
    return [m.name for m in group.members
            if m.name.lower() != caller.name.lower() and _member_share(e, m.name) is not None]


# What the paid prices teach the price table (PriceOverride), and where:
# the bottles are bought around Noida, so Uttar Pradesh's list.
LEARN_STATE = "Uttar Pradesh"
LEARN_NOTE = "Paid, from drink expenses"     # marks a learned row: these get updated, hand ones never


class _Reference:
    """What a bottle should cost at a size: the brand's price per ml - its
    own state's list first, then any state's, then a hand correction - times
    the size. Checks a paid price, and guesses a size from one."""

    def __init__(self, db: Session):
        from liquor_prices import BOTTLES
        from models import PriceOverride
        from routers.recommend import _brand_key, _resolve_brand
        self.db, self.key, self._resolve = db, _brand_key, _resolve_brand
        self.per_ml: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
        for b in BOTTLES:
            if b.size_ml and b.price:
                self.per_ml[_brand_key(b.brand)]["here" if b.state == LEARN_STATE else "any"].append(b.price / b.size_ml)
        for o in db.query(PriceOverride).all():
            if o.size_ml and o.price and not (o.note or "").startswith(LEARN_NOTE):
                self.per_ml[o.brand_key]["hand"].append(o.price / o.size_ml)
        self._memo: dict[str, tuple] = {}

    def resolve(self, name: str):
        """(catalogue brand, kind, known) - a variety the table lacks
        ("Smirnoff Minty Jamun") falls back to its brand's ("Smirnoff")."""
        if name not in self._memo:
            kind = "beer" if bottles._BEER.search(name) else "whisky"
            hit = self._resolve(self.db, name, kind)
            if not hit[2]:
                parent = next((p for p in sorted(PARENT_BRANDS, key=len, reverse=True)
                               if bottles.bottle_key(name).startswith(bottles.bottle_key(p))), None)
                if parent:
                    hit = self._resolve(self.db, parent, kind)
            self._memo[name] = hit
        return self._memo[name]

    def expected(self, name: str, ml: int) -> float | None:
        brand, _, known = self.resolve(name)
        if not known:
            return None
        for where in ("here", "any", "hand"):
            xs = sorted(self.per_ml[self.key(brand)][where])
            if xs:
                return xs[len(xs) // 2] * ml
        return None

    def size_for(self, name: str, price: float) -> int | None:
        """The standard size a price fits best - ₹830 of Smirnoff is a full
        bottle - or None when no size comes within a third of it."""
        import math
        beer = bool(bottles._BEER.search(name))
        best = None
        for ml in ((330, 500, 650) if beer else (180, 375, 750)):
            ref = self.expected(name, ml)
            if ref:
                off = abs(math.log(price / ref))
                if best is None or off < best[0]:
                    best = (off, ml)
        return best[1] if best and best[0] <= math.log(1.35) else None


def learn_prices(db: Session, sizes: list[dict], by: str, ref: _Reference | None = None) -> list[dict]:
    """Write the average paid for each bottle and size into the shared price
    table, as a correction for LEARN_STATE. Only a bottle the table already
    knows (so a misread name adds nothing), only with a size the expense
    said (not one guessed from the price), and only a price within half to
    double the published one - a bar bill read as one bottle is no price. A
    correction someone typed by hand is left alone. Returns what changed."""
    from models import PriceOverride
    ref_ = ref or _Reference(db)
    changed = []
    for s in sizes:
        ml, price = s.get("size_ml"), s.get("noted_avg")
        if not ml or not price:
            continue
        brand, kind, known = ref_.resolve(s["name"])
        if not known or not ref_._resolve(db, s["name"], kind)[2]:
            continue                                  # unknown, or a variety known only as its brand - it would overwrite the brand's price
        parent, variety = _split_brand(s["name"], sorted(PARENT_BRANDS, key=len))
        if variety and bottles.bottle_key(brand) == bottles.bottle_key(parent):
            continue                                  # "Smirnoff Mango chilli" matched to plain Smirnoff: not its price
        key = ref_.key(brand)
        ref = ref_.expected(s["name"], ml)
        if not ref or not (0.5 * ref <= price <= 2 * ref):
            continue                                  # nothing to check it by, or no bottle costs that
        row = (db.query(PriceOverride).filter(PriceOverride.brand_key == key, PriceOverride.state == LEARN_STATE,
                                              PriceOverride.size_ml == ml).first())
        if row and not (row.note or "").startswith(LEARN_NOTE):
            continue                                  # typed by hand - that one knows better
        note = f"{LEARN_NOTE}: avg of {s['noted_n']}, last bought {s['last'] or '?'}"
        if row and row.price == price and row.note == note:
            continue
        if row is None:
            row = PriceOverride(brand_key=key, state=LEARN_STATE, size_ml=ml, brand=brand, kind=kind)
            db.add(row)
        changed.append({"brand": brand, "size_ml": ml, "was": row.price, "expected": round(ref), "now": price})
        row.price, row.note, row.set_by = price, note, by
    if changed:
        db.commit()
        from knowledge import _extra as _extra_catalogue
        _extra_catalogue.cache_clear()
    return changed


@router.get("/my-bottles", response_model=dict)
def my_bottles(db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """Every bottle the caller has had: times bought, bottles in all, the
    average price of one (over the purchases that say what it cost) and the
    last time. Starts reading any drink expense not read yet."""
    groups, expenses, mine = _mine(db, caller)
    scanned = {s.expense_id: s.text_hash for s in db.query(DrinkScan).filter(
        DrinkScan.expense_id.in_([e.id for e in expenses])).all()} if expenses else {}
    unread = sum(1 for e in expenses if scanned.get(e.id) != bottles._hash(e))
    if unread:
        bottles.scan_in_background(list(groups))

    by_id = {e.id: e for e in mine}
    rows = db.query(DrinkBottle).filter(DrinkBottle.expense_id.in_(list(by_id))).all() if by_id else []
    # "Beer" with no brand isn't a bottle anyone can look up: asked about
    # instead (POST /my-bottles/name), kept out of the list until named
    unnamed = [{"id": b.id, "kind": b.name, "date": (by_id[b.expense_id].date or "")[:10] or None,
                "title": by_id[b.expense_id].title or by_id[b.expense_id].notes, "qty": b.qty,
                "size": b.size, "size_ml": b.size_ml, "price_each": b.price_each,
                "group": groups[by_id[b.expense_id].group_id].name} for b in rows if _generic(b.name)]
    rows = [b for b in rows if not _generic(b.name)]
    ref = _Reference(db)
    sized = _sized(rows, ref)
    agg: dict[tuple, dict] = {}
    spellings: dict[tuple, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    company: dict[tuple, dict[str, int]] = defaultdict(lambda: defaultdict(int))   # who it was drunk with, how often
    for b in rows:
        k = _key(b, sized)
        e = by_id[b.expense_id]
        size, ml, guessed = sized.get(b.id, (b.size, b.size_ml, False))
        a = agg.setdefault(k, {"size": size, "size_ml": ml, "times": 0, "bottles": 0, "guessed": 0,
                               "priced": 0, "spent": 0.0, "noted_n": 0, "noted_spent": 0.0, "last": None})
        if not guessed and b.size_ml:
            a["size"], a["size_ml"] = b.size, b.size_ml    # the expense's own words over a guess
        a["guessed"] += guessed
        for n in _with(e, groups[e.group_id], caller):
            company[k][n] += 1
        a["times"] += 1
        a["bottles"] += b.qty
        if b.price_each:
            a["priced"] += b.qty
            a["spent"] += b.price_each * b.qty
            if not guessed:                               # only a stated size teaches the price table
                a["noted_n"] += b.qty
                a["noted_spent"] += b.price_each * b.qty
        if e.date and (a["last"] is None or e.date > a["last"]):
            a["last"] = e.date[:10]
        spellings[k][b.name] += 1
    out = []
    for k, a in agg.items():
        name = max(spellings[k].items(), key=lambda x: x[1])[0]
        out.append({"name": name, "size": a["size"], "size_ml": a["size_ml"], "times": a["times"],
                    "bottles": a["bottles"], "avg_price": round(a["spent"] / a["priced"]) if a["priced"] else None,
                    "priced": a["priced"], "last": a["last"], "guessed": a["guessed"],
                    "noted_n": a["noted_n"], "noted_avg": round(a["noted_spent"] / a["noted_n"]) if a["noted_n"] else None,
                    "with": [[n, c] for n, c in sorted(company[k].items(), key=lambda x: (-x[1], x[0].lower()))]})
    out.sort(key=lambda x: (-x["times"], x["name"].lower(), SIZE_ORDER.get(x["size"] or "", 9)))
    if not unread:
        try:      # what was paid corrects the shared price table
            learn_prices(db, out, caller.name, ref)
        except Exception as err:
            db.rollback()
            print(f"[drinks] learning prices failed: {err}")
    return {"bottles": out, "brands": _brands(out), "unnamed": sorted(unnamed, key=lambda x: x["date"] or "", reverse=True), "reading": bottles.status()["running"], "unread": unread}


# Brands whose names carry a variety after them ("Smirnoff Minty Jamun",
# "Absolut Passion Fruit"): the variety is listed inside the brand's card.
PARENT_BRANDS = [
    "Smirnoff", "Absolut", "Bacardi", "Magic Moments", "Black Dog", "Old Monk", "Jagermeister", "Budweiser",
    "Kingfisher", "Johnnie Walker", "Royal Stag", "McDowell's", "Blenders Pride", "Signature", "100 Pipers",
    "Vat 69", "Teacher's", "Chivas Regal", "Glenfiddich", "Jameson", "Jack Daniel's", "Ballantine's",
    "Antiquity", "Royal Challenge", "Imperial Blue", "Officer's Choice", "8PM", "Romanov", "Grey Goose",
    "Beefeater", "Bombay Sapphire", "Tanqueray", "Greater Than", "Corona", "Heineken", "Tuborg", "Carlsberg",
    "Bira", "Hoegaarden", "Breezer", "Jacob's Creek", "Sula", "Amrut", "Paul John", "Indri", "Black & White",
]
_SPIRIT_WORDS = {"vodka", "whisky", "whiskey", "rum", "gin", "beer", "wine", "tequila", "brandy", "liqueur"}


def _split_brand(name: str, known: list[str]) -> tuple[str, str | None]:
    """"Smirnoff Minty Jamun" -> ("Smirnoff", "Minty Jamun"); "Magic Moments
    Vodka" -> ("Magic Moments", None). `known` adds the brands seen on their
    own in this list, shortest first, so a name starting with one joins it."""
    from places import _words
    low = bottles.bottle_key(name)
    words = _words(name)
    for parent in known:
        if low == bottles.bottle_key(parent):
            return parent, None
        pw = _words(parent)
        if pw and words[:len(pw)] == pw and len(words) > len(pw):    # whole words: "Smirnoff" + "Minty Jamun"
            rest = name.split()[len(parent.split()):]
            rest = " ".join(w for w in rest if w.lower() not in _SPIRIT_WORDS).strip(" -·")
            return parent, rest or None
    return name, None


def _brands(sizes: list[dict]) -> list[dict]:
    """The same bottles, one entry per brand ("Old Monk", "Smirnoff"), its
    varieties and sizes inside - Minty Jamun, quarter, half, full, or not
    said - so a brand is listed once."""
    seen_alone = {s["name"] for s in sizes}
    # shortest first: the parent is the shortest name the bottle's name starts with
    known = sorted(set(PARENT_BRANDS) | seen_alone, key=lambda n: (len(n), n))
    by: dict[str, dict] = {}
    for s in sizes:
        parent, variety = _split_brand(s["name"], known)
        s = {**s, "variety": variety}
        k = bottles.bottle_key(parent)
        b = by.setdefault(k, {"name": parent, "times": 0, "bottles": 0, "last": None, "sizes": [], "_n": defaultdict(int),
                              "_with": defaultdict(int)})
        for n, c in s.get("with") or []:
            b["_with"][n] += c
        b["times"] += s["times"]
        b["bottles"] += s["bottles"]
        b["_n"][parent] += s["times"]
        if s["last"] and (b["last"] is None or s["last"] > b["last"]):
            b["last"] = s["last"]
        b["sizes"].append(s)
    out = []
    for b in by.values():
        b["name"] = max(b.pop("_n").items(), key=lambda x: x[1])[0]       # the spelling used most
        b["with"] = [[n, c] for n, c in sorted(b.pop("_with").items(), key=lambda x: (-x[1], x[0].lower()))]
        b["sizes"].sort(key=lambda s: ((s["variety"] or "").lower(),
                                       SIZE_ORDER.get(s["size"] or "", 9) if s["size"] else 10, s["size_ml"] or 0))
        b["varieties"] = sorted({s["variety"] for s in b["sizes"] if s["variety"]})
        prices = [s["avg_price"] for s in b["sizes"] if s["avg_price"] is not None]
        b["price_low"], b["price_high"] = (min(prices), max(prices)) if prices else (None, None)
        out.append(b)
    out.sort(key=lambda x: (-x["times"], x["name"].lower()))
    return out


@router.get("/my-bottles/purchases", response_model=list[dict])
def bottle_purchases(name: str, size: str = "", db: Session = Depends(get_db),
                     caller: User = Depends(current_user)):
    """Each time the caller had this bottle (name + size as listed): date,
    description, how many, the price of one, which group. Newest first."""
    groups, _, mine = _mine(db, caller)
    by_id = {e.id: e for e in mine}
    want = (bottles.bottle_key(name), size)
    rows = db.query(DrinkBottle).filter(DrinkBottle.expense_id.in_(list(by_id))).all() if by_id else []
    sized = _sized(rows, _Reference(db))
    out = []
    for b in rows:
        if _key(b, sized) != want:
            continue
        e = by_id[b.expense_id]
        out.append({"expense_id": e.id, "date": (e.date or "")[:10] or None, "title": e.title or e.notes,
                    "notes": e.notes, "qty": b.qty, "price_each": b.price_each, "amount": e.amount,
                    "group": groups[e.group_id].name, "group_id": e.group_id,
                    "with": _with(e, groups[e.group_id], caller), "size_guessed": b.id in sized})
    out.sort(key=lambda x: x["date"] or "", reverse=True)
    return out

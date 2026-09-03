"""What to drink tonight, for this many people, on this budget.

Two inputs, both real: a scraped state price table (liquor_prices) and what
this particular set of people has actually bought and paid before. The second
is the half a generic recommender can't do — "you and Anubhav average ₹1,458 a
session and keep buying Vat 69" is worth more than any generic suggestion.

Nothing here asks a language model. The prices are looked up, the arithmetic
is done in code, and the ranking is explainable: brands you've bought before
come first, then the same category, then whatever fits the budget.
"""

from __future__ import annotations

import re
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from auth import current_user, is_member
from database import get_db
from liquor_prices import (
    ABV_SOURCES, BOTTLES, NCR, SOURCES, STATES, Bottle, abv_for, across_sizes,
    for_state,
)
from models import Group, User

router = APIRouter(prefix="/recommend", tags=["recommend"])

# Words that mark an expense as a drinks run. Deliberately \b-bounded: an
# unbounded "gin" matched "Monginis", a bakery, and put cake in the liquor data.
DRINK_RE = re.compile(
    r"\b(vat\s*69|bacardi|whisky|whiskey|rum|beer|vodka|gin|wine|old\s*monk|"
    r"blenders?|magic\s*moments?|breezer|tuborg|kingfisher|budweiser|corona|"
    r"jack\s*daniel|black\s*label|red\s*label|royal\s*stag|imperial\s*blue|"
    r"8\s*pm|mcdowell|antiquity|glenlivet|jameson|smirnoff|liquor|alcohol|"
    r"booze|daru|thek|absolut|j&b|chivas|100\s*pipers|officer'?s\s*choice|"
    r"bagpiper|captain\s*morgan|grey\s*goose|glenfiddich|black\s*dog)\b",
    re.I,
)

# How much the group is drinking between them, in the sizes spirits are sold
# in. 180ml across two people is 90ml each — it is a total for the room, not
# an allowance per head. Beer is the fourth answer to the same question.
BOTTLE_SIZES = (180, 375, 750)
BOTTLE_CHOICES = ("180", "375", "750", "beer")

# Budget is a range rather than a ceiling, because "around 500" is what people
# actually mean. Too narrow a range matches nothing on a price list that moves
# in fifties, so a span this small is rejected rather than quietly returning
# an empty list.
MIN_BUDGET_SPAN = 60

# Spirits are sold in exactly these three, and everyone names them this way.
# Anything else in the price table (90ml nips, litres, 200ml travel bottles)
# is not something you would walk out of a shop with for an evening, so
# spirits are restricted to these when building a suggestion.
SPIRIT_SIZES = {180: "quarter", 375: "half", 750: "full"}
SIZE_ORDER = (750, 375, 180)






def _text(e) -> str:
    return " ".join(filter(None, [e.title, e.category, e.notes]))


def _history(db: Session, caller: User, names: list[str]) -> dict:
    """What this set of people has actually spent on drinks together.

    Only groups the caller belongs to are considered, so this can't be used to
    read someone else's habits.

    `scoped` says whether this is history *with someone*. With nobody named it
    is just the caller's own drinking across every group, which was being
    shown as though it were shared history — "12 sessions together" with no
    one named. The numbers still rank the suggestions, but the page only
    presents them once there is somebody to have had them with.
    """
    picked = [n.strip() for n in names if n.strip()]
    wanted = {n.lower() for n in picked}
    wanted.add(caller.name.lower())

    total = 0.0
    occasions = 0
    brand_hits: dict[str, int] = defaultdict(int)
    brand_spend: dict[str, float] = defaultdict(float)
    known = {b.brand.lower(): b.brand for b in BOTTLES}

    for g in db.query(Group).all():
        if not is_member(g, caller):
            continue
        members = {m.name.lower() for m in g.members}
        # Every named person must actually be in the group for it to count
        if not wanted.issubset(members):
            continue
        for e in g.expenses:
            t = _text(e)
            if not DRINK_RE.search(t):
                continue
            occasions += 1
            total += e.amount
            low = t.lower()
            for key, display in known.items():
                if key in low:
                    brand_hits[display] += 1
                    brand_spend[display] += e.amount

    favourites = sorted(brand_hits, key=lambda b: (-brand_hits[b], b))
    return {
        "scoped": bool(picked),
        "with_names": picked,
        "occasions": occasions,
        "total_spend": round(total, 2),
        "avg_per_occasion": round(total / occasions, 2) if occasions else 0.0,
        "favourites": favourites[:6],
        "brand_counts": {b: brand_hits[b] for b in favourites[:6]},
    }


def _units(volume_ml: float, abv: float) -> float:
    """Millilitres of pure alcohol — the only fair way to compare a strong
    beer against a mild one, or beer against spirits."""
    return round(volume_ml * abv / 100, 1)


def _pick(bottles: list[Bottle], lo: float, hi: float, people: int,
          bottle_ml: int, favourites: list[str]) -> list[dict]:
    """Every bottle of the chosen size priced inside the budget range.

    Ordered dearest first: within one state and one size, price is the only
    quality signal in the data, and a dearer bottle is the better one often
    enough for that to be useful.
    """
    fav = {f.lower() for f in favourites}
    out: list[dict] = []

    for b in bottles:
        if b.kind not in ("whisky", "rum", "vodka", "gin"):
            continue
        if b.size_ml != bottle_ml:
            continue
        price = b.mid
        if price < lo or price > hi:
            continue

        abv, abv_known = abv_for(b.brand, b.kind)
        compare = across_sizes(b.brand, {bottle_ml: 1})
        priced = [c for c in compare if c["total"] is not None]
        cheapest = min(priced, key=lambda c: c["total"])["region"] if priced else None

        out.append({
            "brand": b.brand,
            "kind": b.kind,
            "size_ml": bottle_ml,
            "size_name": SPIRIT_SIZES[bottle_ml],
            "unit_price": b.price,
            "unit_price_max": b.price_max,
            "total": round(price),
            # What the budget would actually stretch to, said plainly rather
            # than silently picking a quantity on the user's behalf.
            "budget_buys": int(hi // price) if price > 0 else 0,
            "per_head": round(price / max(people, 1)),
            "ml_per_head": round(bottle_ml / max(people, 1)),
            "abv": abv,
            "abv_known": abv_known,
            "alcohol_ml_per_head": _units(bottle_ml / max(people, 1), abv),
            "is_favourite": b.brand.lower() in fav,
            "source": b.source,
            "compare": compare,
            "cheapest_region": cheapest,
        })

    # Best affordable first; a brand they already drink wins a tie.
    out.sort(key=lambda r: (-r["total"], not r["is_favourite"]))
    return out[:8]


def _beers(bottles: list[Bottle], lo: float, hi: float, people: int,
           favourites: list[str] | None = None) -> list[dict]:
    """Beer rounds whose total lands inside the budget range.

    A beer's unit price is small next to any sensible budget, so the round is
    what gets priced, not the bottle: as many as the top of the range buys,
    capped at six each so a large budget doesn't suggest something absurd.
    """
    fav = {f.lower() for f in (favourites or [])}
    out: list[dict] = []
    for b in bottles:
        if b.kind != "beer":
            continue
        qty = min(int(hi // b.mid), people * 6)
        if qty < 1:
            continue
        cost = b.mid * qty
        if cost < lo:
            continue
        abv, abv_known = abv_for(b.brand, b.kind)
        volume = b.size_ml * qty
        out.append({
            "brand": b.brand,
            "size_ml": b.size_ml,
            "qty": qty,
            "unit_price": b.price,
            "unit_price_max": b.price_max,
            "total": round(cost),
            "total_ml": volume,
            "ml_per_head": round(volume / max(people, 1)),
            "bottles_per_head": round(qty / max(people, 1), 1),
            "abv": abv,
            "abv_known": abv_known,
            "alcohol_ml_per_head": _units(volume / max(people, 1), abv),
            "per_head": round(cost / max(people, 1)),
            "is_favourite": b.brand.lower() in fav,
            "source": b.source,
        })

    # Strongest first among what fits, so the cards read as a real choice
    # between a session beer and a strong one rather than an arbitrary list.
    out.sort(key=lambda r: (-r["abv"], r["total"]))
    return out[:6]


def _band(bottles: list[Bottle], bottle_ml: int, is_beer: bool) -> dict | None:
    """Cheapest and dearest of the chosen size in this state."""
    if is_beer:
        rows = [b for b in bottles if b.kind == "beer"]
    else:
        rows = [
            b for b in bottles
            if b.size_ml == bottle_ml and b.kind in ("whisky", "rum", "vodka", "gin")
        ]
    if not rows:
        return None
    return {"min": round(min(r.mid for r in rows)), "max": round(max(r.mid for r in rows))}


@router.get("/meta", response_model=dict)
def meta(_: User = Depends(current_user)):
    """States we have real prices for, and where those prices came from."""
    return {
        "states": STATES,
        "ncr": list(NCR),
        "sources": SOURCES,
        "abv_sources": ABV_SOURCES,
        "row_count": len(BOTTLES),
        "min_budget_span": MIN_BUDGET_SPAN,
        "bottle_choices": [
            {"value": str(ml), "name": SPIRIT_SIZES[ml].title(), "hint": f"{ml}ml"}
            for ml in BOTTLE_SIZES
        ] + [{"value": "beer", "name": "Beer", "hint": "by the bottle"}],
    }


@router.get("/", response_model=dict)
def recommend(
    state: str,
    people: int = 2,
    budget_min: float = 500,
    budget_max: float = 1000,
    bottle: str = "750",
    names: str = "",
    db: Session = Depends(get_db),
    caller: User = Depends(current_user),
):
    if people < 1:
        raise HTTPException(400, "There has to be at least one of you")
    if budget_min < 0 or budget_max <= 0:
        raise HTTPException(400, "Set a budget above zero")
    if budget_max - budget_min < MIN_BUDGET_SPAN:
        raise HTTPException(
            400,
            f"Widen the budget - the range needs to be at least "
            f"Rs {MIN_BUDGET_SPAN} (e.g. 500-560, not 500-530).",
        )
    if bottle not in BOTTLE_CHOICES:
        raise HTTPException(400, f"Pick one of {BOTTLE_CHOICES}")
    is_beer = bottle == "beer"
    bottle_ml = 0 if is_beer else int(bottle)

    bottles = for_state(state)
    if not bottles:
        raise HTTPException(
            404,
            f"No published prices for {state} yet — we only have "
            f"{', '.join(STATES)}. Prices are set per state, so guessing one "
            f"from another would be wrong.",
        )

    people_names = [n for n in (names or "").split(",") if n.strip()]
    hist = _history(db, caller, people_names)
    # The selector decides what you are buying. Beer alongside every spirit
    # answer would make choosing "beer" mean nothing.
    picks = ([] if is_beer else
             _pick(bottles, budget_min, budget_max, people, bottle_ml, hist["favourites"]))
    beers = (_beers(bottles, budget_min, budget_max, people, hist["favourites"])
             if is_beer else [])

    return {
        "state": state,
        "ncr": list(NCR),
        "people": people,
        "budget_min": budget_min,
        "budget_max": budget_max,
        "budget_per_head": round(budget_max / people),
        "bottle": bottle,
        "bottle_ml": bottle_ml,
        "is_beer": is_beer,
        "bottle_name": "beer" if is_beer else SPIRIT_SIZES[bottle_ml],
        "history": hist,
        "picks": picks,
        # Says why a list is empty: no rows at all for this size in this state
        # is a different problem from everything being over budget.
        # What that size actually costs here, so an empty list can say "they
        # run Rs 95-250" instead of leaving you guessing at the range.
        "price_band": _band(bottles, bottle_ml, is_beer),
        "size_available": any(
            b.kind == "beer" if is_beer else
            (b.size_ml == bottle_ml and b.kind in ("whisky", "rum", "vodka", "gin"))
            for b in bottles
        ),
        "beers": beers,
        "sources": SOURCES,
        "abv_sources": ABV_SOURCES,
    }

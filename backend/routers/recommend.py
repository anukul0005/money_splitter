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
from liquor_prices import BOTTLES, NCR, SOURCES, STATES, Bottle, across, for_state
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

# Roughly what one person drinks in an evening, in ml of spirit. Used only to
# size the suggestion; the user can always override by changing the budget.
ML_PER_HEAD = {"light": 120, "normal": 180, "heavy": 260}


def _text(e) -> str:
    return " ".join(filter(None, [e.title, e.category, e.notes]))


def _history(db: Session, caller: User, names: list[str]) -> dict:
    """What this set of people has actually spent on drinks together.

    Only groups the caller belongs to are considered, so this can't be used to
    read someone else's habits.
    """
    wanted = {n.strip().lower() for n in names if n.strip()}
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
        "occasions": occasions,
        "total_spend": round(total, 2),
        "avg_per_occasion": round(total / occasions, 2) if occasions else 0.0,
        "favourites": favourites[:6],
        "brand_counts": {b: brand_hits[b] for b in favourites[:6]},
    }


def _pick(bottles: list[Bottle], budget: float, people: int, strength: str,
          favourites: list[str]) -> list[dict]:
    """Suggest bottle + quantity combinations that fit the budget.

    Ranked by: something they already drink, then closeness to the volume this
    many people would get through, then how much of the budget it uses without
    exceeding it.
    """
    target_ml = ML_PER_HEAD.get(strength, 180) * max(people, 1)
    fav = {f.lower() for f in favourites}
    out: list[dict] = []

    spirits = [b for b in bottles if b.kind in ("whisky", "rum", "vodka", "gin")]
    for b in spirits:
        qty = max(1, round(target_ml / b.size_ml))
        cost = b.mid * qty
        if cost > budget:
            # A single bottle that still fits is a better answer than nothing
            if b.mid > budget:
                continue
            qty, cost = 1, b.mid
        # The NCR trio is close enough to drive between, and the same bottle
        # can differ by hundreds of rupees across it, so show all three.
        compare = [
            {**r, "total": None if r["mid"] is None else round(r["mid"] * qty)}
            for r in across(b.brand, b.size_ml)
        ]
        priced = [c for c in compare if c["total"] is not None]
        cheapest = min(priced, key=lambda c: c["total"])["region"] if priced else None

        out.append({
            "brand": b.brand, "kind": b.kind, "size_ml": b.size_ml,
            "qty": qty, "unit_price": b.price, "unit_price_max": b.price_max,
            "total": round(cost),
            "total_ml": b.size_ml * qty,
            "is_favourite": b.brand.lower() in fav,
            "source": b.source,
            "per_head": round(cost / max(people, 1)),
            "compare": compare,
            "cheapest_region": cheapest,
        })

    out.sort(key=lambda r: (
        not r["is_favourite"],                 # things you drink, first
        abs(r["total_ml"] - target_ml),        # right amount for the room
        -r["total"],                           # then use the budget
    ))
    return out[:6]


@router.get("/meta", response_model=dict)
def meta(_: User = Depends(current_user)):
    """States we have real prices for, and where those prices came from."""
    return {
        "states": STATES,
        "ncr": list(NCR),
        "sources": SOURCES,
        "row_count": len(BOTTLES),
        "strengths": list(ML_PER_HEAD),
    }


@router.get("/", response_model=dict)
def recommend(
    state: str,
    people: int = 2,
    budget: float = 2000,
    strength: str = "normal",
    names: str = "",
    db: Session = Depends(get_db),
    caller: User = Depends(current_user),
):
    if people < 1:
        raise HTTPException(400, "There has to be at least one of you")
    if budget <= 0:
        raise HTTPException(400, "Set a budget above zero")

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
    picks = _pick(bottles, budget, people, strength, hist["favourites"])

    beers = sorted(
        [b for b in bottles if b.kind == "beer"], key=lambda b: b.mid
    )
    beer = beers[0] if beers else None

    return {
        "state": state,
        "ncr": list(NCR),
        "people": people,
        "budget": budget,
        "budget_per_head": round(budget / people),
        "strength": strength,
        "history": hist,
        "picks": picks,
        "beer_option": None if not beer else {
            "brand": beer.brand, "size_ml": beer.size_ml,
            "qty": people * 2, "unit_price": beer.price,
            "total": round(beer.mid * people * 2), "source": beer.source,
        },
        "sources": SOURCES,
    }

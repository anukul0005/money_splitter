"""Where to eat tonight, for this many people, on this budget.

The same shape as the drink recommender, grounded the same way: a cited price
table (food_prices) plus what this exact set of people has actually spent on
eating out together. Nothing asks a language model — the prices are looked up,
the arithmetic is in code, and every ranking decision is explainable.

The one honest difference from drinks is precision. A bottle has a legal MRP; a
restaurant bill does not. So this deals in "cost for two", says plainly that it
is an estimate, and never presents a total to the rupee that it cannot source.
"""

from __future__ import annotations

import re
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from auth import current_user, is_member
from database import get_db
from food_prices import (
    CITIES, CUISINES, DISHES, KINDS, NCR_CITIES, PLACES, SOURCES, Place,
    cuisines_in, dishes_at, for_city, street_food,
)
from models import Group, User

router = APIRouter(prefix="/food", tags=["food"])

# Words that mark an expense as eating out. \b-bounded for the same reason the
# drinks regex is: an unbounded "roll" matches "trolley", and an unbounded
# "tea" matches "steam". Deliberately excludes bare "bar" and "pub", which are
# drinks runs and already counted by the drink recommender.
FOOD_RE = re.compile(
    r"\b(food|lunch|dinner|breakfast|brunch|meal|restaurant|resto|dhaba|"
    r"cafe|café|eat|eating|swiggy|zomato|order(?:ed|ing)?\s*in|takeaway|"
    r"pizza|burger|biryani|biriyani|momo|momos|roll|rolls|thali|buffet|"
    r"chinese|paneer|chicken|kebab|kabab|tikka|butter\s*chicken|chole|"
    r"bhature|paratha|parantha|dosa|idli|sandwich|pasta|noodles|ramen|sushi|"
    r"barbeque|barbecue|bbq|dessert|ice\s*cream|cake|bakery|snacks?|"
    r"domino'?s|mcdonald'?s|kfc|subway|burger\s*king|haldiram'?s|bikaner|"
    r"barbeque\s*nation|social|starbucks|chaayos|keventers)\b",
    re.I,
)

# Bought to cook, not to eat out. Half the "snacks" in the data are a Zepto or
# Blinkit run and raw chicken, which say nothing about which restaurant to
# pick. An expense mentioning any of these is dropped even if it also names a
# restaurant - one line covering both a grocery run and dinner is rare, and
# under-counting is the safer error when the count is presented as a fact.
GROCERY_RE = re.compile(
    r"\b(grocery|groceries|bigbasket|big\s*basket|blinkit|zepto|instamart|"
    r"dmart|d.?mart|kirana|supermarket|sabzi|vegetables?|ration|atta|"
    r"raw|milk|eggs)\b",
    re.I,
)

# Restaurant names that are also ordinary English words. Matching these as
# substrings put "SOCIAL" in the favourites off the word "social" in an
# unrelated expense, so they are never matched by name.
AMBIGUOUS_PLACES = {"social", "red", "r.e.d", "binge restaurant", "italiano"}

# Keywords that place an expense in one of the controlled cuisine buckets, so
# "we always end up eating Mughlai" can actually rank the suggestions.
CUISINE_HINTS = {
    "North Indian": r"\b(dal|paneer|butter\s*chicken|tandoor\w*|naan|roti|"
                    r"chole|rajma|dhaba|punjabi|north\s*indian)\b",
    "Mughlai": r"\b(mughlai|kebab|kabab|biryani|biriyani|korma|nihari|"
               r"karim'?s|changezi|seekh)\b",
    "South Indian": r"\b(dosa|idli|vada|sambar|uttapam|south\s*indian|"
                    r"filter\s*coffee|appam)\b",
    "Chinese": r"\b(chinese|noodles|hakka|manchurian|schezwan|momo|momos)\b",
    "Asian": r"\b(sushi|ramen|thai|asian|pan.?asian|korean|khao\s*suey|dimsum|dim\s*sum)\b",
    "Italian": r"\b(pizza|pasta|italian|lasagne|lasagna|risotto|spaghetti)\b",
    "Continental": r"\b(continental|burger|steak|sizzler|grill|sandwich|fries)\b",
    "Cafe": r"\b(cafe|café|coffee|starbucks|chaayos|latte|croissant)\b",
    "Barbecue": r"\b(barbeque|barbecue|bbq|grill\w*\s*buffet|absolute\s*barbecues)\b",
    "Street food": r"\b(street\s*food|chaat|golgappa|pani\s*puri|tikki|"
                   r"chandni\s*chowk|paranthe)\b",
}
CUISINE_RE = {k: re.compile(v, re.I) for k, v in CUISINE_HINTS.items()}

# A restaurant bill moves in hundreds, not tens, so the drinks rule of a Rs 60
# minimum span would let through a range that matches nothing. Rs 200 is about
# one person's worth of slack, which is the smallest range that is still a range.
MIN_BUDGET_SPAN = 200


def _text(e) -> str:
    return " ".join(filter(None, [e.title, e.category, e.notes]))


def _history(db: Session, caller: User, names: list[str]) -> dict:
    """What this set of people has actually spent eating out together.

    Only groups the caller belongs to are considered, so this can never be
    used to read someone else's habits. `scoped` says whether this is history
    *with someone* — with nobody named it is just the caller's own eating,
    which ranks the picks but is not shown as though it were shared.
    """
    picked = [n.strip() for n in names if n.strip()]
    wanted = {n.lower() for n in picked}
    wanted.add(caller.name.lower())

    total = 0.0
    occasions = 0
    biggest = 0.0
    cuisine_hits: dict[str, int] = defaultdict(int)
    place_hits: dict[str, int] = defaultdict(int)
    known_places = {
        k: p.name for p in PLACES
        if (k := " ".join(p.name.lower().split())) not in AMBIGUOUS_PLACES
    }

    for g in db.query(Group).all():
        if not is_member(g, caller):
            continue
        members = {m.name.lower() for m in g.members}
        # Every named person must actually be in the group for it to count
        if not wanted.issubset(members):
            continue
        for e in g.expenses:
            t = _text(e)
            if not FOOD_RE.search(t) or GROCERY_RE.search(t):
                continue
            occasions += 1
            total += e.amount
            biggest = max(biggest, e.amount)
            for cuisine, rx in CUISINE_RE.items():
                if rx.search(t):
                    cuisine_hits[cuisine] += 1
            low = t.lower()
            for key, display in known_places.items():
                if key in low:
                    place_hits[display] += 1

    favourites = sorted(cuisine_hits, key=lambda c: (-cuisine_hits[c], c))
    places = sorted(place_hits, key=lambda p: (-place_hits[p], p))
    return {
        "scoped": bool(picked),
        "with_names": picked,
        "occasions": occasions,
        "total_spend": round(total, 2),
        "avg_per_occasion": round(total / occasions, 2) if occasions else 0.0,
        "biggest": round(biggest, 2),
        "favourites": favourites[:5],
        "cuisine_counts": {c: cuisine_hits[c] for c in favourites[:5]},
        "places": places[:5],
    }


def _menu(place: Place, limit: int = 4) -> list[dict]:
    """A few real menu prices, dearest first, so a pick is more than a number.

    Only places we found published dish prices for have this. It is a sample,
    never a bill — see the note on Dish in food_prices.
    """
    rows = sorted(dishes_at(place.name, place.city), key=lambda d: -d.mid)[:limit]
    return [
        {
            "name": d.name,
            "price": d.price,
            "price_max": d.price_max if d.is_range else None,
            "veg": d.veg,
            "course": d.course,
        }
        for d in rows
    ]


def _pick(places: list[Place], lo: float, hi: float, people: int,
          cuisine: str, kind: str, veg_only: bool,
          favourites: list[str], been_to: list[str]) -> list[dict]:
    """Every place whose estimated bill for this many people lands in range.

    Ordered dearest-first inside the budget, for the same reason the drinks
    picks are: within one city, price is the only quality signal in the data,
    and the top of someone's stated range is what they were willing to spend.
    A cuisine they actually eat breaks ties.
    """
    fav = {f.lower() for f in favourites}
    seen = {b.lower() for b in been_to}
    out: list[dict] = []

    for p in places:
        if veg_only and not p.veg_only:
            continue
        if cuisine != "any" and cuisine not in p.cuisines:
            continue
        if kind != "any" and p.kind != kind:
            continue
        total = p.total_for(people)
        if total < lo or total > hi:
            continue

        matched = [c for c in p.cuisines if c.lower() in fav]
        out.append({
            "name": p.name,
            "area": p.area,
            "city": p.city,
            "cuisines": list(p.cuisines),
            "kind": p.kind,
            "kind_name": KINDS.get(p.kind, p.kind),
            "veg_only": p.veg_only,
            "for_two": p.for_two,
            "for_two_max": p.for_two_max if p.is_range else None,
            "total": round(total),
            "per_head": round(total / max(people, 1)),
            # Sources disagree on restaurants far more than on bottles. Saying
            # which numbers are a span stops a range being read as a quote.
            "is_estimate_range": p.is_range,
            "matched_cuisines": matched,
            "is_favourite": bool(matched),
            "been_before": p.name.lower() in seen,
            "menu": _menu(p),
            "sources": list(p.sources),
        })

    out.sort(key=lambda r: (-r["total"], not r["is_favourite"]))
    return out[:10]


def _street(city: str, lo: float, hi: float, people: int) -> list[dict]:
    """The small-budget answer: staples priced by the plate.

    Two plates a head is a meal rather than a snack, which is the honest
    reading of "we ate street food". Only offered when the whole round fits.
    """
    out: list[dict] = []
    for d in street_food(city):
        plates = people * 2
        cost = d.mid * plates
        if cost > hi:
            continue
        out.append({
            "name": d.name,
            "price": d.price,
            "price_max": d.price_max if d.is_range else None,
            "veg": d.veg,
            "plates": plates,
            "total": round(cost),
            "per_head": round(cost / max(people, 1)),
            "sources": list(d.sources),
        })
    out.sort(key=lambda r: -r["total"])
    return out


def _band(places: list[Place], people: int) -> dict | None:
    """What a table this size costs here, cheapest to dearest.

    A narrow range finds nothing more often than not, so an empty result can
    say what the city actually costs instead of leaving you guessing.
    """
    if not places:
        return None
    totals = [p.total_for(people) for p in places]
    return {"min": round(min(totals)), "max": round(max(totals))}


@router.get("/meta", response_model=dict)
def meta(_: User = Depends(current_user)):
    """Cities we have real prices for, and where those prices came from."""
    return {
        "cities": CITIES,
        "ncr": list(NCR_CITIES),
        "cuisines": CUISINES,
        "cuisines_by_city": {c: cuisines_in(c) for c in CITIES},
        "kinds": [{"value": k, "name": n} for k, n in KINDS.items()],
        "sources": SOURCES,
        "place_count": len(PLACES),
        "dish_count": len(DISHES),
        "min_budget_span": MIN_BUDGET_SPAN,
    }


@router.get("/", response_model=dict)
def recommend_food(
    city: str,
    people: int = 2,
    budget_min: float = 800,
    budget_max: float = 2000,
    cuisine: str = "any",
    kind: str = "any",
    veg: bool = False,
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
            f"Widen the budget - a restaurant bill moves in hundreds, so the "
            f"range needs to be at least Rs {MIN_BUDGET_SPAN} "
            f"(e.g. 1000-1200, not 1000-1050).",
        )
    if cuisine != "any" and cuisine not in CUISINES:
        raise HTTPException(400, f"We have no places tagged {cuisine!r}")
    if kind != "any" and kind not in KINDS:
        raise HTTPException(400, f"Pick one of {['any', *KINDS]}")

    places = for_city(city)
    if not places:
        raise HTTPException(
            404,
            f"No published prices for {city} yet - we only have "
            f"{', '.join(CITIES)}. Restaurant prices are per city, so "
            f"borrowing one city's numbers for another would be wrong.",
        )

    people_names = [n for n in (names or "").split(",") if n.strip()]
    hist = _history(db, caller, people_names)
    picks = _pick(places, budget_min, budget_max, people, cuisine, kind,
                  veg, hist["favourites"], hist["places"])

    return {
        "city": city,
        "ncr": list(NCR_CITIES),
        "people": people,
        "budget_min": budget_min,
        "budget_max": budget_max,
        "budget_per_head": round(budget_max / max(people, 1)),
        "cuisine": cuisine,
        "kind": kind,
        "veg": veg,
        "history": hist,
        "picks": picks,
        # Says why a list is empty: nothing of this cuisine at all in this city
        # is a different problem from everything being outside the budget.
        "cuisine_available": cuisine == "any" or any(
            cuisine in p.cuisines for p in places),
        "price_band": _band(places, people),
        # Only worth showing when the budget is genuinely tight; at Rs 3000 a
        # head, suggesting momos is not advice.
        "street": _street(city, budget_min, budget_max, people),
        "sources": SOURCES,
    }

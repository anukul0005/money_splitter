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
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from auth import current_user, is_member
from database import get_db
from food_prices import (
    CITIES, CUISINES, DINE_IN, DISHES, KINDS, NCR_CITIES, PLACES, SOURCES,
    Place, cuisines_in, dishes_at, for_city, street_food,
)
from models import Group, PlaceOverride, User

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


def _place_key(name: str) -> str:
    """One spelling per restaurant, so corrections don't fork."""
    return " ".join(name.lower().replace(".", "").replace("'", "").split())


def _as_place(r: PlaceOverride) -> Place:
    cuisines = tuple(c.strip() for c in (r.cuisines or "").split(",") if c.strip())
    return Place(
        name=r.name, area=r.area or "", city=r.city,
        cuisines=cuisines or ("Anything",), for_two=int(round(r.for_two)),
        sources=("added-by-hand",), kind=r.kind or DINE_IN,
        veg_only=bool(r.veg_only),
    )


def _apply_place_overrides(places: list[Place], db: Session, city: str) -> list[Place]:
    """Layer hand-added and hand-corrected restaurants over the published list.

    A correction replaces the published row for that restaurant in that city,
    and a name we have never heard of is simply added. This is the part that
    makes the table get better with use: the published listings are a starting
    point, and the people actually eating out are the better source.
    """
    rows = db.query(PlaceOverride).filter(PlaceOverride.city == city).all()
    if not rows:
        return places

    by_key = {r.name_key: r for r in rows}
    out, replaced = [], set()
    for p in places:
        hit = by_key.get(_place_key(p.name))
        if hit is None:
            out.append(p)
            continue
        replaced.add(hit.name_key)
        out.append(_as_place(hit))
    out.extend(_as_place(r) for k, r in by_key.items() if k not in replaced)
    return out


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
    place_last: dict[str, str] = {}
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
                    # Dates are stored ISO, so a string compare is a date
                    # compare. The latest is the useful one.
                    if e.date and e.date > place_last.get(display, ""):
                        place_last[display] = e.date

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
        # When you last ate there. A place you went to on Friday is not the
        # same suggestion as one you have not seen in a year.
        "place_last": {p: place_last[p] for p in places[:5] if p in place_last},
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
          favourites: list[str], been_to: list[str],
          place_last: dict[str, str] | None = None,
          limit: int = 30) -> list[dict]:
    """Every place whose estimated bill for this many people lands in range.

    Ordered dearest-first inside the budget, for the same reason the drinks
    picks are: within one city, price is the only quality signal in the data,
    and the top of someone's stated range is what they were willing to spend.
    A cuisine they actually eat breaks ties.
    """
    fav = {f.lower() for f in favourites}
    seen = {b.lower() for b in been_to}
    last = {k.lower(): v for k, v in (place_last or {}).items()}
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
            "added_by_hand": "added-by-hand" in p.sources,
            "matched_cuisines": matched,
            "is_favourite": bool(matched),
            "been_before": p.name.lower() in seen,
            "last_visited": last.get(p.name.lower()),
            "menu": _menu(p),
            "sources": list(p.sources),
        })

    # Places you added yourself first and never cut - the same rule the drinks
    # side needed, and for the same reason: adding somewhere and then not
    # finding it makes the whole feature feel broken.
    out.sort(key=lambda r: (not r["added_by_hand"], not r["is_favourite"],
                            -r["total"]))
    mine = sum(1 for r in out if r["added_by_hand"])
    return out[:max(limit, mine + 4)]


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


def _your_places(rows: list[PlaceOverride], people: int, cuisine: str,
                 kind: str, veg: bool, lo: float, hi: float) -> list[dict]:
    """Places you added for this city, and why any of them isn't showing.

    The same reasoning as the drinks side: adding somewhere and then not
    finding it looks like the entry was lost, when usually it is a filter —
    the cuisine is narrowed, pure-veg is ticked, or the bill for this many
    people falls outside the budget. Each one says which.
    """
    out = []
    for r in rows:
        place = _as_place(r)
        total = place.total_for(people)
        reason = None
        if veg and not r.veg_only:
            reason = "hidden by the pure-veg filter"
        elif cuisine != "any" and cuisine not in place.cuisines:
            saved = ", ".join(place.cuisines) or "no cuisine"
            reason = f"saved as {saved} — pick that or Anything"
        elif kind != "any" and (r.kind or DINE_IN) != kind:
            reason = (f"saved as {KINDS.get(r.kind, r.kind)} — "
                      f"pick that or Anywhere")
        elif not (lo <= total <= hi):
            reason = (f"about Rs {round(total)} for {people} is outside "
                      f"this budget")
        stamp = r.updated_at or r.created_at
        out.append({
            "id": r.id,
            "name": r.name,
            "area": r.area,
            "cuisines": list(place.cuisines),
            "kind": r.kind,
            "kind_name": KINDS.get(r.kind, r.kind),
            "veg_only": bool(r.veg_only),
            "for_two": r.for_two,
            "total": round(total),
            "set_by": r.set_by,
            "added_on": stamp.date().isoformat() if stamp else None,
            "shown": reason is None,
            "reason": reason,
        })
    out.sort(key=lambda x: (x["shown"], x["name"].lower()))
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


class PlaceIn(BaseModel):
    """A restaurant somebody is adding or correcting by hand."""

    name: str = Field(min_length=2, max_length=200)
    city: str
    for_two: float
    area: str | None = Field(default=None, max_length=200)
    cuisines: list[str] = Field(default_factory=list)
    kind: str = DINE_IN
    veg_only: bool = False
    note: str | None = Field(default=None, max_length=500)

    @field_validator("name", "city", "area")
    @classmethod
    def _tidy(cls, v):
        return " ".join(v.split()) if isinstance(v, str) else v

    @field_validator("kind")
    @classmethod
    def _known_kind(cls, v: str) -> str:
        v = (v or DINE_IN).strip().lower()
        if v not in KINDS:
            raise ValueError(f"kind must be one of {', '.join(KINDS)}")
        return v

    @field_validator("cuisines")
    @classmethod
    def _known_cuisines(cls, v: list[str]) -> list[str]:
        # Against the controlled list, so a hand-added place filters exactly
        # like a published one. Free text here would be invisible to the
        # cuisine dropdown and the place would never come back.
        out = []
        for c in v:
            c = " ".join(str(c).split())
            match = next((k for k in CUISINES if k.lower() == c.lower()), None)
            if match is None:
                raise ValueError(f"unknown cuisine {c!r}; pick from the list")
            if match not in out:
                out.append(match)
        if len(out) > 6:
            raise ValueError("six cuisines is plenty")
        return out

    @field_validator("for_two")
    @classmethod
    def _sane_cost(cls, v: float) -> float:
        if not 50 <= v <= 100000:
            raise ValueError("cost for two must be between Rs 50 and Rs 1,00,000")
        return round(v, 2)


def _place_out(r: PlaceOverride) -> dict:
    return {
        "id": r.id, "name": r.name, "area": r.area, "city": r.city,
        "cuisines": [c.strip() for c in (r.cuisines or "").split(",") if c.strip()],
        "for_two": r.for_two, "kind": r.kind,
        "kind_name": KINDS.get(r.kind, r.kind),
        "veg_only": bool(r.veg_only), "note": r.note, "set_by": r.set_by,
        "updated_at": (r.updated_at or r.created_at).isoformat()
        if (r.updated_at or r.created_at) else None,
    }


@router.get("/places", response_model=list[dict])
def list_places(city: str = "", db: Session = Depends(get_db),
                _: User = Depends(current_user)):
    """Restaurants people have added or corrected, newest first."""
    q = db.query(PlaceOverride)
    if city:
        q = q.filter(PlaceOverride.city == city)
    return [_place_out(r) for r in q.order_by(PlaceOverride.id.desc()).all()]


@router.post("/places", response_model=dict)
def set_place(body: PlaceIn, db: Session = Depends(get_db),
              caller: User = Depends(current_user)):
    """Add a restaurant, or correct one the published listings got wrong.

    Saving the same name in the same city again updates the existing entry
    rather than stacking a second one, so the list can't end up recommending
    the same place twice at two different prices.
    """
    key = _place_key(body.name)
    row = (db.query(PlaceOverride)
             .filter(PlaceOverride.name_key == key,
                     PlaceOverride.city == body.city)
             .first())
    if row is None:
        row = PlaceOverride(name_key=key, city=body.city)
        db.add(row)
    row.name = body.name
    row.area = (body.area or "").strip() or None
    row.cuisines = ", ".join(body.cuisines) or None
    row.for_two = body.for_two
    row.kind = body.kind
    row.veg_only = body.veg_only
    row.note = (body.note or "").strip() or None
    row.set_by = caller.name
    db.commit()
    db.refresh(row)
    return _place_out(row)


@router.delete("/places/{place_id}", response_model=dict)
def delete_place(place_id: int, db: Session = Depends(get_db),
                 _: User = Depends(current_user)):
    """Drop an entry. A place that only existed here disappears with it."""
    row = db.query(PlaceOverride).filter(PlaceOverride.id == place_id).first()
    if row is None:
        raise HTTPException(404, "That entry is already gone")
    db.delete(row)
    db.commit()
    return {"ok": True, "id": place_id}


@router.get("/meta", response_model=dict)
def meta(db: Session = Depends(get_db), _: User = Depends(current_user)):
    """Cities we have real prices for, and where those prices came from."""
    # A city nobody published but somebody added a place in is a real city.
    # Without this the entry would be saved and then be unreachable, because
    # the dropdown only offers cities the static table knows about.
    added = {c for (c,) in db.query(PlaceOverride.city).distinct()}
    return {
        "cities": sorted(set(CITIES) | added),
        "ncr": list(NCR_CITIES),
        "cuisines": CUISINES,
        "cuisines_by_city": {
            c: sorted(set(cuisines_in(c)) | {
                x.strip()
                for (cs,) in db.query(PlaceOverride.cuisines)
                              .filter(PlaceOverride.city == c).all()
                for x in (cs or "").split(",") if x.strip()
            })
            for c in sorted(set(CITIES) | added)
        },
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

    your_rows = db.query(PlaceOverride).filter(PlaceOverride.city == city).all()
    places = _apply_place_overrides(for_city(city), db, city)
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
                  veg, hist["favourites"], hist["places"], hist["place_last"])

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
        # Your own entries for this city, each saying whether it is in the
        # list above and, if not, why — so a place you added is never just
        # silently absent.
        "your_places": _your_places(your_rows, people, cuisine, kind, veg,
                                    budget_min, budget_max),
        # Only worth showing when the budget is genuinely tight; at Rs 3000 a
        # head, suggesting momos is not advice.
        "street": _street(city, budget_min, budget_max, people),
        "sources": SOURCES,
    }

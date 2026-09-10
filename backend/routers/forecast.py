"""What a session is likely to cost, answered two ways.

The drinks and food recommenders both answer "what should I get for this
budget". Neither answers the question that comes before that one - "how
much of my one total budget should even go to drinks versus food" - or the
one that comes after having already decided - "I know what I'm having,
what's the damage". This router is those two questions, built on the same
history and pricing machinery the two recommenders already have rather than
a third copy of it.

Two endpoints:
  /forecast/budget - split one total budget into a drinks share and a food
  share, using this person's own historical spending ratio between the two,
  and account for the extras a drinking session outside a restaurant always
  seems to carry (a disposable glass per person, some incidental snacks).

  /forecast/items - the reverse direction: told exactly what's being bought,
  price it out using the same cross-state catalogue /recommend uses, add the
  same extras, and total it.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from auth import current_user
from database import get_db
from liquor_prices import STATES, for_state
from models import PriceOverride, User
from routers.food import MIN_BUDGET_SPAN as FOOD_MIN_SPAN
from routers.food import _history as _food_history
from routers.food import recommend_food
from routers.recommend import MIN_BUDGET_SPAN as DRINK_MIN_SPAN
from routers.recommend import (
    _apply_overrides, _by_size, _catalog_for, _find_in, _history as _drink_history,
    _overrides_by_state, recommend,
)

router = APIRouter(prefix="/forecast", tags=["forecast"])

SESSION_CHOICES = ("drinks_food", "drinks_only", "food_only")

# A disposable glass, bought per person, whenever a spirit is being poured
# outside a restaurant - beer is drunk from its own bottle, so a beer-only
# session buys none. Snacks are also per person: a table of four eating
# something alongside their drinks costs roughly four times what a table of
# two does, not a flat amount regardless of headcount.
GLASS_COST = 5
SNACK_COST_PER_PERSON = 50

# Below this, splitting a budget into two pieces is meaningless - the app
# already refuses a drinks or food budget span narrower than this on its own
# (see DRINK_MIN_SPAN / FOOD_MIN_SPAN), so a forecast that hands back a
# narrower one has produced a number neither recommender can even use.
_MIN_BAND = 60


def _spend_ratio(db: Session, caller: User, names: list[str]) -> tuple[float, float, str]:
    """How this person's (or this set of people's) money actually splits
    between drinks and food, as shares that sum to 1.

    Reuses the same two _history functions the recommenders already compute
    this from - drinks' total_spend and food's total_spend are exactly the
    numbers behind "your Vat 69 nights average ₹X" and "your Karim's nights
    average ₹Y" respectively, just summed across every occasion rather than
    kept per brand or per place.

    With no history at all yet - a brand-new account, or two people who have
    never split an expense together - there is nothing to derive a ratio
    from, so a plain 55/45 lean towards drinks is used instead and reported
    as such (`ratio_source`), rather than presenting a made-up number as
    though it were personal.
    """
    d = _drink_history(db, caller, names)
    f = _food_history(db, caller, names)
    drink_total, food_total = d["total_spend"], f["total_spend"]
    if drink_total + food_total <= 0:
        return 0.55, 0.45, "default"
    return drink_total / (drink_total + food_total), food_total / (drink_total + food_total), "history"


def _band(mid: float, min_span: float) -> dict | None:
    """A workable budget_min/budget_max around a point estimate.

    ±20% is arbitrary but reads naturally - "around ₹1,200" becomes a
    ₹960-1,440 band - and is widened to whatever the target recommender's
    own minimum span is, so the numbers handed off to /recommend or
    /food are never rejected by the very budget check those endpoints
    enforce on themselves.
    """
    if mid <= 0:
        return None
    lo = max(1, round(mid * 0.8))
    hi = round(mid * 1.2)
    if hi - lo < min_span:
        hi = lo + min_span
    return {"min": lo, "max": hi}


def _drink_preview(db: Session, caller: User, state: str, band: dict | None,
                   people: int, names: str) -> dict | None:
    """A few real picks in this band, in this state - reuses /recommend
    itself rather than a second pricing pass, so a forecast never disagrees
    with what the Drinks tab would actually show for the same numbers.

    A location a state's own list has never heard of still gets an answer:
    /recommend's own cross-state fallback (see _catalog_for) prices a bottle
    at whatever the cheapest other state charges when the chosen one doesn't
    carry it, labelled `is_price_fallback` on each pick exactly as it is on
    the Drinks tab - "other locations show costs as per the available
    states" is the same mechanism already built for the recommender, not a
    new one.
    """
    if not band or band["max"] <= 0:
        return None
    try:
        result = recommend(state=state, people=people, budget_min=band["min"],
                           budget_max=band["max"], bottle="any", kind="",
                           names=names, db=db, caller=caller)
    except HTTPException:
        return None
    picks = (result.get("picks") or [])[:3] + (result.get("beers") or [])[:3]
    return {"state": state, "sample": picks[:3]}


def _food_preview(db: Session, caller: User, city: str, band: dict | None,
                  people: int, names: str) -> dict | None:
    """A few real picks in this band, in this city - see _drink_preview."""
    if not band or band["max"] <= 0:
        return None
    try:
        result = recommend_food(city=city, people=people, budget_min=band["min"],
                                budget_max=band["max"], names=names, db=db, caller=caller)
    except HTTPException:
        return None
    return {"city": city, "sample": (result.get("picks") or [])[:3]}


@router.get("/budget", response_model=dict)
def forecast_budget(
    people: int = 2,
    budget: float = 2000,
    session: str = "drinks_food",
    beer_only: bool = False,
    state: str = "",
    city: str = "",
    names: str = "",
    db: Session = Depends(get_db),
    caller: User = Depends(current_user),
):
    if people < 1:
        raise HTTPException(400, "There has to be at least one of you")
    if session not in SESSION_CHOICES:
        raise HTTPException(400, f"session must be one of {', '.join(SESSION_CHOICES)}")
    if budget <= 0:
        raise HTTPException(400, "Set a budget above zero")

    drinking = session in ("drinks_food", "drinks_only")
    glasses = 0 if (not drinking or beer_only) else people * GLASS_COST
    snacks = people * SNACK_COST_PER_PERSON if drinking else 0
    extras = glasses + snacks
    remaining = max(budget - extras, 0)

    people_names = [n for n in (names or "").split(",") if n.strip()]

    if session == "food_only":
        drink_share, food_share, ratio_source = 0.0, 1.0, "n/a"
        drink_budget, food_budget = 0.0, remaining
    elif session == "drinks_only":
        drink_share, food_share, ratio_source = 1.0, 0.0, "n/a"
        drink_budget, food_budget = remaining, 0.0
    else:
        drink_share, food_share, ratio_source = _spend_ratio(db, caller, people_names)
        drink_budget = round(remaining * drink_share)
        food_budget = remaining - drink_budget

    return {
        "people": people,
        "budget": budget,
        "session": session,
        "beer_only": beer_only,
        # Said plainly, per person, so "why is this ₹450 higher than I typed"
        # is answered on the page rather than left to work out.
        "extras": {
            "glasses": glasses, "glass_cost": GLASS_COST,
            "snacks": snacks, "snack_cost_per_person": SNACK_COST_PER_PERSON,
            "total": extras,
        },
        # A budget too small to even cover extras is a real answer, not an
        # error - it says "you can't do this for this many people at this
        # price", which is exactly what a forecast is for.
        "shortfall": round(extras - budget) if extras > budget else 0,
        "remaining": round(remaining),
        "ratio_source": ratio_source,   # "history" | "n/a" | "default"
        "drink_share": round(drink_share, 3),
        "food_share": round(food_share, 3),
        "drink_budget": round(drink_budget),
        "food_budget": round(food_budget),
        # Wide enough to hand straight to /recommend and /food's own
        # budget_min/budget_max, so this page can link into a real pick
        # list rather than leaving the forecast as numbers nobody can act on.
        "drink_band": (drink_band := _band(drink_budget, DRINK_MIN_SPAN)),
        "food_band": (food_band := _band(food_budget, FOOD_MIN_SPAN)),
        "state": state or None,
        "city": city or None,
        # A real sample of what that money buys, in the place asked about -
        # or, if that place doesn't carry a bottle natively, at whatever the
        # cheapest other state charges for it (see _drink_preview). Only
        # computed when a location was actually given; forecasting works
        # perfectly well as pure numbers without one.
        "drink_preview": _drink_preview(db, caller, state, drink_band, people, names) if state else None,
        "food_preview": _food_preview(db, caller, city, food_band, people, names) if city else None,
    }


class ForecastDrinkItem(BaseModel):
    """One line of "what I'm having" - a bottle, a size, and how many."""

    brand: str = Field(min_length=2, max_length=200)
    size_ml: int = Field(gt=0)
    qty: int = Field(default=1, ge=1, le=50)


class ForecastFoodItem(BaseModel):
    """One food line. There is no per-dish price data in this app - the food
    tables are restaurants, not menus - so this is exactly what somebody
    expects to pay for it, typed in directly rather than guessed at."""

    name: str = Field(min_length=1, max_length=200)
    amount: float = Field(ge=0)


class ForecastItemsIn(BaseModel):
    people: int = Field(default=2, ge=1)
    # Empty means "no particular state" - price each drink at whatever the
    # cheapest state anyone has published for it charges, the same fallback
    # /recommend uses for a bottle a chosen state doesn't itself carry.
    state: str = ""
    drinks: list[ForecastDrinkItem] = Field(default_factory=list)
    food: list[ForecastFoodItem] = Field(default_factory=list)


@router.post("/items", response_model=dict)
def forecast_items(payload: ForecastItemsIn, db: Session = Depends(get_db),
                   caller: User = Depends(current_user)):
    """Told exactly what's being bought, price it and total it.

    Drinks are priced against the same merged, cross-state catalogue
    /recommend builds (_catalog_for) - a state that doesn't carry a named
    bottle still prices it, at whatever the cheapest other state charges,
    rather than refusing to answer. Passing state="" reuses that same
    fallback path for everything: an empty state has no native rows of its
    own, so _catalog_for treats every bottle as "missing" and returns the
    cheapest price for each one - exactly "no particular state, just tell me
    what it costs somewhere".
    """
    by_state = _overrides_by_state(db)
    known_states = sorted(set(STATES) | set(by_state))
    tables = {
        s: _apply_overrides(for_state(s), by_state.get(s, []), s) for s in known_states
    }
    target_state = payload.state if payload.state in known_states else ""
    buckets = _by_size(_catalog_for(target_state, known_states, tables))

    drink_lines = []
    drink_total = 0
    any_alcohol = False
    any_non_beer = False
    for item in payload.drinks:
        hit = _find_in(buckets.get(item.size_ml), item.brand)
        if hit is None:
            drink_lines.append({
                "brand": item.brand, "size_ml": item.size_ml, "qty": item.qty,
                "matched": False, "unit_price": None, "total": 0,
                "note": f"No known price for a {item.size_ml}ml bottle like "
                        f"this - add one under \"Wrong price? Fix it\" first.",
            })
            continue
        any_alcohol = True
        if hit.kind != "beer":
            any_non_beer = True
        unit = round(hit.mid)
        line_total = unit * item.qty
        drink_total += line_total
        drink_lines.append({
            "brand": hit.brand, "kind": hit.kind, "size_ml": item.size_ml,
            "qty": item.qty, "matched": True, "unit_price": unit, "total": line_total,
            "state": hit.state,
            "is_price_fallback": bool(target_state) and hit.state != target_state,
        })

    food_total = round(sum(f.amount for f in payload.food), 2)

    # Same rule as the budget forecast: a glass per person for anything that
    # isn't beer, snacks per person for any drinking session at all.
    glasses = 0 if (not any_alcohol or not any_non_beer) else payload.people * GLASS_COST
    snacks = payload.people * SNACK_COST_PER_PERSON if any_alcohol else 0
    extras = glasses + snacks
    grand_total = drink_total + food_total + extras

    return {
        "people": payload.people,
        "state": target_state or None,
        "drinks": drink_lines,
        "drink_total": drink_total,
        "food": [{"name": f.name, "amount": f.amount} for f in payload.food],
        "food_total": food_total,
        "extras": {
            "glasses": glasses, "glass_cost": GLASS_COST,
            "snacks": snacks, "snack_cost_per_person": SNACK_COST_PER_PERSON,
            "total": extras,
        },
        "grand_total": round(grand_total),
        "per_head": round(grand_total / max(payload.people, 1)),
    }

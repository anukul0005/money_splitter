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
from food_prices import for_city
from liquor_prices import STATES, for_state
from models import PriceOverride, User
from routers.food import MIN_BUDGET_SPAN as FOOD_MIN_SPAN
from routers.food import _apply_place_overrides, _history as _food_history
from routers.recommend import MIN_BUDGET_SPAN as DRINK_MIN_SPAN
from routers.recommend import (
    _apply_overrides, _by_size, _catalog_for, _find_in, _history as _drink_history,
    _overrides_by_state,
)

router = APIRouter(prefix="/forecast", tags=["forecast"])

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


# The same five cards the Drinks tab effectively offers, just reached
# through one "type" picker here instead of a kind picker plus a separate
# beer toggle - a forecast preview only needs "what kind of thing", not the
# Drinks tab's fuller distinction between a spirit's kind and its size.
FORECAST_KINDS = ("whisky", "rum", "vodka", "gin", "beer")
# Quarter/half/full, the same three sizes the Drinks tab's own picker uses.
# Beer isn't sold in these, so a size pick only ever narrows spirits - same
# rule the Drinks tab itself follows.
FORECAST_SIZES = {"180": 180, "375": 375, "750": 750}


def _parse_forecast_kinds(kind: str) -> tuple[str, ...]:
    parts = [p.strip().lower() for p in (kind or "").split(",") if p.strip()]
    for p in parts:
        if p not in FORECAST_KINDS:
            raise HTTPException(400, f"kind must be any of {', '.join(FORECAST_KINDS)} - got '{p}'")
    return tuple(dict.fromkeys(parts))


def _parse_forecast_sizes(bottle: str) -> tuple[int, ...]:
    parts = [p.strip() for p in (bottle or "").split(",") if p.strip()]
    sizes = []
    for p in parts:
        if p not in FORECAST_SIZES:
            raise HTTPException(
                400, f"bottle must be any of {', '.join(FORECAST_SIZES)} - got '{p}'")
        sizes.append(FORECAST_SIZES[p])
    return tuple(sizes)


def _drink_preview(db: Session, state: str, band: dict | None,
                   kinds: tuple[str, ...] = (), sizes: tuple[int, ...] = ()) -> dict | None:
    """A few real bottles in this band, in this state, optionally narrowed
    to a type (whisky/rum/vodka/gin/beer) and a size (quarter/half/full -
    beer bypasses this the same way it does on the Drinks tab, since it
    isn't sold in those).

    This first called /recommend itself, on the reasoning that a forecast
    should never disagree with what the Drinks tab would show for the same
    numbers. It also called the whole recommender's machinery just to read
    off three prices: rebuilding every state's own catalogue, running the
    full history scan /forecast/budget had already just run for the ratio
    above, computing a comparison strip for every candidate, and looking up
    the knowledge base - none of which a three-item sample needs. Measured:
    over half of one request's total time. This does only the one thing a
    preview needs - price everything in the band and take the priciest few,
    the same "dearest inside budget" convention /recommend itself uses - by
    calling _catalog_for directly rather than the endpoint wrapped around it.

    A location a state's own list has never heard of still gets an answer:
    the same cross-state fallback /recommend uses (see _catalog_for) prices
    a bottle at whatever the cheapest other state charges when the chosen
    one doesn't carry it, labelled `is_price_fallback` here exactly as it is
    on the Drinks tab.
    """
    if not band or band["max"] <= 0:
        return None
    by_state = _overrides_by_state(db)
    known_states = sorted(set(STATES) | set(by_state))
    if state not in known_states:
        return None

    def _matches(b) -> bool:
        if kinds and b.kind not in kinds:
            return False
        if b.kind != "beer" and sizes and b.size_ml not in sizes:
            return False
        return band["min"] <= b.mid <= band["max"]

    # This state's own list first, without building the cross-state merge at
    # all - a state with a real published table (thousands of rows for the
    # bigger ones) almost always has *something* in a given price band, so
    # the common case never needs the expensive part. Only when nothing
    # native qualifies is the fuller cross-state catalogue built to look
    # elsewhere - the rare case is the only one that has to pay for it.
    native = _apply_overrides(for_state(state), by_state.get(state, []), state)
    matches = sorted((b for b in native if _matches(b)), key=lambda b: -b.mid)
    if not matches:
        tables = {
            s: _apply_overrides(for_state(s), by_state.get(s, []), s) for s in known_states
        }
        catalog = _catalog_for(state, known_states, tables)
        matches = sorted((b for b in catalog if _matches(b)), key=lambda b: -b.mid)

    sample = [
        {"brand": b.brand, "kind": b.kind, "size_ml": b.size_ml, "total": round(b.mid),
         "state": b.state, "is_price_fallback": b.state != state}
        for b in matches[:3]
    ]
    return {"state": state, "sample": sample}


def _food_preview(db: Session, city: str, band: dict | None, people: int) -> dict | None:
    """A few real places in this band, in this city - see _drink_preview for
    why this prices directly rather than calling /food itself."""
    if not band or band["max"] <= 0:
        return None
    try:
        places = _apply_place_overrides(for_city(city), db, city)
    except Exception:
        return None
    matches = sorted(
        ((p, p.total_for(people)) for p in places
         if band["min"] <= p.total_for(people) <= band["max"]),
        key=lambda pt: -pt[1],
    )
    sample = [{"name": p.name, "total": round(total)} for p, total in matches[:3]]
    return {"city": city, "sample": sample}


@router.get("/budget", response_model=dict)
def forecast_budget(
    people: int = 2,
    budget: float = 2000,
    beer_only: bool = False,
    include_food: bool = True,
    # A percentage, not a fraction, because that is what a slider actually
    # produces. 65 is a starting point picked by hand, not derived from
    # anything - see the docstring for why this is asked rather than
    # calculated.
    drink_share_pct: float = 65,
    kind: str = "",
    bottle: str = "",
    state: str = "",
    city: str = "",
    names: str = "",
    db: Session = Depends(get_db),
    caller: User = Depends(current_user),
):
    """Split one total budget into a drinks share and a food share.

    The split used to be calculated outright from this person's historical
    drink-spend-vs-food-spend ratio. That number is real and often
    surprising - someone who drinks often but eats out even more often can
    have food dominate total rupees despite costing less per occasion each
    time - and a forecast that quietly used it while a person expected
    something closer to their own sense of the evening felt wrong for
    reasons that had nothing to do with the arithmetic being incorrect.
    Asked directly instead: `drink_share_pct` is now a plain input the
    caller sets (a slider, on the page), defaulting to 65/35 rather than to
    whatever history says. History is still computed and returned
    (`history_drink_share` / `history_food_share`) so the page can show it
    as a reference alongside the slider - useful context, not an
    override.

    `include_food=False` is the one case left of what used to be a
    three-way session choice: no food side at all, the whole (post-extras)
    budget goes to drinks. There is no equivalent "drinks only within a
    mixed session" case worth keeping as its own toggle - a forecast is
    built around a drinking session by construction, food is what is
    optional on top of it.
    """
    if people < 1:
        raise HTTPException(400, "There has to be at least one of you")
    if budget <= 0:
        raise HTTPException(400, "Set a budget above zero")
    if not 0 <= drink_share_pct <= 100:
        raise HTTPException(400, "Drink share has to be between 0 and 100")
    kinds = _parse_forecast_kinds(kind)
    sizes = _parse_forecast_sizes(bottle)

    glasses = 0 if beer_only else people * GLASS_COST
    snacks = people * SNACK_COST_PER_PERSON
    extras = glasses + snacks
    remaining = max(budget - extras, 0)

    people_names = [n for n in (names or "").split(",") if n.strip()]
    # Reference only now, never used to decide the split itself - see the
    # docstring above.
    hist_drink_share, hist_food_share, ratio_source = _spend_ratio(db, caller, people_names)

    if include_food:
        drink_share = drink_share_pct / 100
        food_share = 1 - drink_share
        drink_budget = round(remaining * drink_share)
        food_budget = remaining - drink_budget
    else:
        drink_share, food_share = 1.0, 0.0
        drink_budget, food_budget = remaining, 0.0

    return {
        "people": people,
        "budget": budget,
        "beer_only": beer_only,
        "include_food": include_food,
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
        "drink_share": round(drink_share, 3),
        "food_share": round(food_share, 3),
        "ratio_source": ratio_source,   # "history" | "default" - about the reference numbers below, not the split used
        "history_drink_share": round(hist_drink_share, 3),
        "history_food_share": round(hist_food_share, 3),
        "drink_budget": round(drink_budget),
        "food_budget": round(food_budget),
        # Wide enough to hand straight to /recommend and /food's own
        # budget_min/budget_max, so this page can link into a real pick
        # list rather than leaving the forecast as numbers nobody can act on.
        "drink_band": (drink_band := _band(drink_budget, DRINK_MIN_SPAN)),
        "food_band": (food_band := _band(food_budget, FOOD_MIN_SPAN) if include_food else None),
        "state": state or None,
        "city": city or None,
        # A real sample of what that money buys, in the place asked about -
        # or, if that place doesn't carry a bottle natively, at whatever the
        # cheapest other state charges for it (see _drink_preview). Only
        # computed when a location was actually given; forecasting works
        # perfectly well as pure numbers without one.
        "drink_preview": _drink_preview(db, state, drink_band, kinds, sizes) if state else None,
        "food_preview": (
            _food_preview(db, city, food_band, people)
            if (include_food and city) else None
        ),
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

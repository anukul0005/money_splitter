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

# How heavy a night, expressed as the bottle each person is drinking their way
# through. Asking in millilitres was asking people to do a conversion they
# never do out loud — nobody says "a 260ml night", they say "a quarter each".
PER_HEAD_SIZES = (180, 375, 750)

# Spirits are sold in exactly these three, and everyone names them this way.
# Anything else in the price table (90ml nips, litres, 200ml travel bottles)
# is not something you would walk out of a shop with for an evening, so
# spirits are restricted to these when building a suggestion.
SPIRIT_SIZES = {180: "quarter", 375: "half", 750: "full"}
SIZE_ORDER = (750, 375, 180)


def _combo_label(combo: dict[int, int]) -> str:
    """{750: 1, 180: 1} -> "1 full + 1 quarter"."""
    parts = []
    for size in SIZE_ORDER:
        n = combo.get(size, 0)
        if n:
            name = SPIRIT_SIZES[size]
            parts.append(f"{n} {name}" + ("s" if n > 1 else ""))
    return " + ".join(parts)


def _best_combo(by_size: dict[int, float], target_ml: int) -> tuple[dict[int, int], float] | None:
    """Cheapest set of real bottles covering `target_ml`.

    `by_size` maps an available size to its price. Only 180/375/750 are
    offered, so this is a three-coin problem and brute force over a small grid
    is both exact and instant.

    Overshoot is allowed up to a half-bottle. A tighter cap looked principled
    and was wrong in practice: for three people it rejected a single full,
    which overshoots 540ml by 210ml and is obviously what you would buy. If
    nothing lands inside the cap, the smallest basket that still covers the
    target wins rather than nothing being suggested at all.
    """
    if not any(s in by_size for s in SIZE_ORDER):
        return None

    inside: tuple[dict[int, int], float] | None = None
    outside: tuple[dict[int, int], float, int] | None = None

    for f in range(0, target_ml // 750 + 3):
        for h in range(0, target_ml // 375 + 3):
            for q in range(0, target_ml // 180 + 3):
                combo = {750: f, 375: h, 180: q}
                if any(n and sz not in by_size for sz, n in combo.items()):
                    continue
                vol = f * 750 + h * 375 + q * 180
                if vol < target_ml:
                    continue
                cost = sum(by_size[sz] * n for sz, n in combo.items() if n)
                if cost <= 0:
                    continue
                trimmed = {k: v for k, v in combo.items() if v}
                if vol <= target_ml + 375:
                    if inside is None or cost < inside[1]:
                        inside = (trimmed, cost)
                elif outside is None or vol < outside[2]:
                    outside = (trimmed, cost, vol)

    if inside:
        return inside
    return (outside[0], outside[1]) if outside else None


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


def _pick(bottles: list[Bottle], budget: float, people: int, target_ml: int,
          favourites: list[str]) -> list[dict]:
    """Suggest what to actually buy: whole bottles, in real shop sizes.

    Ranked by: something they already drink, then how close the volume is to
    what this many people would get through, then price.
    """
    fav = {f.lower() for f in favourites}

    # brand -> {size: price} for the three sizes spirits are actually sold in
    by_brand: dict[str, dict[int, float]] = defaultdict(dict)
    meta: dict[str, Bottle] = {}
    for b in bottles:
        if b.kind not in ("whisky", "rum", "vodka", "gin"):
            continue
        if b.size_ml not in SPIRIT_SIZES:
            continue
        by_brand[b.brand][b.size_ml] = b.mid
        meta.setdefault(b.brand, b)

    out: list[dict] = []
    for brand, sizes in by_brand.items():
        picked = _best_combo(sizes, target_ml)
        if not picked:
            continue
        combo, cost = picked
        if cost > budget:
            # Fall back to the largest single bottle that still fits
            affordable = {sz: pr for sz, pr in sizes.items() if pr <= budget}
            if not affordable:
                continue
            sz = max(affordable, key=lambda z: z)
            combo, cost = {sz: 1}, affordable[sz]

        volume = sum(sz * n for sz, n in combo.items())
        ref = meta[brand]
        abv, abv_known = abv_for(brand, ref.kind)

        compare = across_sizes(brand, combo)
        priced = [c for c in compare if c["total"] is not None]
        cheapest = min(priced, key=lambda c: c["total"])["region"] if priced else None

        out.append({
            "brand": brand,
            "kind": ref.kind,
            "combo": [{"size_ml": sz, "label": SPIRIT_SIZES[sz], "qty": n}
                      for sz in SIZE_ORDER if combo.get(sz)
                      for n in [combo[sz]]],
            "combo_label": _combo_label(combo),
            "total": round(cost),
            "total_ml": volume,
            "ml_per_head": round(volume / max(people, 1)),
            "abv": abv,
            "abv_known": abv_known,
            "alcohol_ml_per_head": _units(volume / max(people, 1), abv),
            "is_favourite": brand.lower() in fav,
            "per_head": round(cost / max(people, 1)),
            "source": ref.source,
            "compare": compare,
            "cheapest_region": cheapest,
        })

    out.sort(key=lambda r: (
        not r["is_favourite"],
        abs(r["total_ml"] - target_ml),
        r["total"],
    ))
    return out[:6]


def _beers(bottles: list[Bottle], budget: float, people: int) -> list[dict]:
    """Beer options as their own cards, sized to the budget.

    Two each is the default round. If that overruns the budget the count comes
    down rather than the beer being dropped, so a tight budget still gets an
    answer instead of an empty list.
    """
    out: list[dict] = []
    for b in bottles:
        if b.kind != "beer":
            continue
        qty = max(1, people * 2)
        cost = b.mid * qty
        if cost > budget:
            qty = int(budget // b.mid)
            if qty < 1:
                continue
            cost = b.mid * qty
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
            "source": b.source,
        })

    # Strongest first among what fits, so the cards read as a real choice
    # between a session beer and a strong one rather than an arbitrary list.
    out.sort(key=lambda r: (-r["abv"], r["total"]))
    return out[:6]


@router.get("/meta", response_model=dict)
def meta(_: User = Depends(current_user)):
    """States we have real prices for, and where those prices came from."""
    return {
        "states": STATES,
        "ncr": list(NCR),
        "sources": SOURCES,
        "abv_sources": ABV_SOURCES,
        "row_count": len(BOTTLES),
        "per_head_sizes": list(PER_HEAD_SIZES),
    }


@router.get("/", response_model=dict)
def recommend(
    state: str,
    people: int = 2,
    budget: float = 2000,
    per_head_ml: int = 180,
    names: str = "",
    db: Session = Depends(get_db),
    caller: User = Depends(current_user),
):
    if people < 1:
        raise HTTPException(400, "There has to be at least one of you")
    if budget <= 0:
        raise HTTPException(400, "Set a budget above zero")
    if per_head_ml not in PER_HEAD_SIZES:
        raise HTTPException(400, f"Pick one of {PER_HEAD_SIZES} ml per person")

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
    target_ml = per_head_ml * people
    picks = _pick(bottles, budget, people, target_ml, hist["favourites"])
    beers = _beers(bottles, budget, people)

    return {
        "state": state,
        "ncr": list(NCR),
        "people": people,
        "budget": budget,
        "budget_per_head": round(budget / people),
        "per_head_ml": per_head_ml,
        "target_ml": target_ml,
        "history": hist,
        "picks": picks,
        "beers": beers,
        "sources": SOURCES,
        "abv_sources": ABV_SOURCES,
    }

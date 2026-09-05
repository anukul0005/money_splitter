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
from functools import lru_cache

from fastapi import APIRouter, Depends, HTTPException  # noqa: I001
from sqlalchemy.orm import Session

from pydantic import BaseModel, Field, field_validator

from auth import current_user, is_member
from database import get_db
from knowledge import DRINK, DRINK_RE, learned
from brand_names import core as bn_core, key as bn_key
from liquor_prices import (
    ABV_SOURCES, BOTTLES, NCR, SOURCES, STATES, Bottle, abv_for, for_state,
)
from models import Group, PriceOverride, User

router = APIRouter(prefix="/recommend", tags=["recommend"])

# Words that mark an expense as a drinks run. Deliberately \b-bounded: an
# unbounded "gin" matched "Monginis", a bakery, and put cake in the liquor data.

# How much the group is drinking between them, in the sizes spirits are sold
# in. 180ml across two people is 90ml each — it is a total for the room, not
# an allowance per head. Beer is the fourth answer to the same question.
BOTTLE_SIZES = (180, 375, 750)
# "any" is the default and deliberately first. Picking a size is a decision
# about the evening, not a filter the recommender needs: a budget on its own
# is enough to say what you can buy. Made mandatory, it forced a choice before
# the app had told you anything.
BOTTLE_CHOICES = ("any", "180", "375", "750", "beer")


# Budget is a range rather than a ceiling, because "around 500" is what people
# actually mean. Too narrow a range matches nothing on a price list that moves
# in fifties, so a span this small is rejected rather than quietly returning
# an empty list.
MIN_BUDGET_SPAN = 60

# Spirits are sold in exactly these three, and everyone names them this way.
# Anything else in the price table (90ml nips, litres, 200ml travel bottles)
# is not something you would walk out of a shop with for an evening, so
# spirits are restricted to these when building a suggestion.
SPIRIT_SIZES = {180: "quarter", 375: "half", 700: "full", 750: "full"}
SIZE_ORDER = (750, 700, 375, 180)

# What each card on the picker actually asks for. 700ml is the standard import
# bottle - most of the tequila and a lot of the imported scotch is sold in it -
# and it is a full bottle by any sane reading, so "Full" covers both rather
# than making people learn that their bottle is 50ml short of a card.
SIZE_GROUP = {180: (180,), 375: (375,), 750: (700, 750)}
ALL_SIZES = (180, 375, 700, 750)


def _parse_bottle(bottle: str) -> tuple[tuple[int, ...], bool, bool]:
    """Read the size picker, which takes any combination of its four cards.

    One card was the old rule and it made "a couple of quarters or a few
    beers" - an ordinary way to plan an evening - unaskable. So the parameter
    is a comma-separated list now: "375,beer" means half bottles and beer, and
    nothing at all still means everything.

    Returns (spirit sizes, show beer, show spirits). "any" and the empty
    string both mean no filter, and are kept apart from an explicit choice so
    the page can say which it is.
    """
    parts = [p.strip() for p in (bottle or "").split(",") if p.strip()]
    parts = [p for p in parts if p != "any"]
    for p in parts:
        if p not in BOTTLE_CHOICES:
            raise HTTPException(
                400, f"Pick any of {', '.join(BOTTLE_CHOICES[1:])} - got '{p}'")
    if not parts:
        return ALL_SIZES, True, True
    sizes = tuple(sorted({ml for p in parts if p != "beer"
                          for ml in SIZE_GROUP[int(p)]}))
    want_beer = "beer" in parts
    # A picker showing only beer asks only about beer; one showing only sizes
    # asks only about spirits. Both together asks for both.
    return (sizes or ALL_SIZES), want_beer, bool(sizes)






KINDS = ("whisky", "rum", "vodka", "gin", "tequila", "beer", "wine",
         "brandy", "liqueur")

# The four cards on the "what kind" picker. Deliberately the four base
# spirits rather than all eight kinds the tables carry: wine, brandy, tequila
# and liqueur are real categories but not ones most evenings are planned
# around, and a card for each would crowd four useful ones under four nobody
# taps. Nothing picked still means everything, same rule as the size picker.
KIND_CHOICES = ("whisky", "rum", "vodka", "gin")


def _parse_kinds(kind: str) -> tuple[str, ...]:
    """Any combination of the four kind cards. Empty means no filter."""
    parts = [p.strip().lower() for p in (kind or "").split(",") if p.strip()]
    for p in parts:
        if p not in KIND_CHOICES:
            raise HTTPException(400, f"Pick any of {', '.join(KIND_CHOICES)} - got '{p}'")
    # Order as picked, de-duplicated - order matters for nothing downstream,
    # but echoing back exactly what was sent avoids a silent reshuffle.
    seen: list[str] = []
    for p in parts:
        if p not in seen:
            seen.append(p)
    return tuple(seen)
# Everything sold by the bottle, which is everything except beer. This was
# once the four base spirits, which quietly threw away every wine, brandy and
# tequila row in the tables - 145 of them - so a wine you had bought and
# entered could never be suggested back to you.
BOTTLE_KINDS = ("whisky", "rum", "vodka", "gin", "tequila", "wine",
                "brandy", "liqueur")


# Words that describe a bottle without naming one. A name made only of these
# identifies nothing, so it is never allowed to match another brand.
GENERIC_WORDS = {
    "whisky", "whiskey", "rum", "vodka", "gin", "beer", "wine", "brandy",
    "lager", "ale", "stout", "scotch", "malt", "blended", "grain", "spirit",
    "premium", "super", "extra", "strong", "superior", "deluxe", "special",
    "exclusive", "original", "classic", "reserve", "select", "fine", "rare",
    "aged", "smooth", "pure", "triple", "distilled", "the", "and", "of",
    "new", "no", "xxx",
}


@lru_cache(maxsize=16384)
def _brand_key(brand: str) -> str:
    """One spelling per brand, so corrections don't fork into near-duplicates.

    This is the stored identity of a correction, and it delegates to the same
    normaliser the cross-state name matching uses. It used to have its own,
    looser rule that only dropped full stops and apostrophes, which meant a
    strength typed into the name forked the row: "Bacardi Orange Rum (5%)" and
    "Bacardi Orange Rum" were two corrections at one price for one bottle.

    Size is not part of it, on purpose. The same brand in 180ml and 750ml is
    one brand at two prices, and every lookup here carries the size alongside
    the key rather than baked into it.

    Cached: Delhi alone is 3,257 rows, and the comparison strip calls this on
    every candidate for every pick in every region on every request. Before
    Delhi's real feed replaced the ~35-row aggregator list this was cheap
    enough not to matter; at this size it was 3.6 million regex calls and
    over thirty seconds per request - the "Recommend" button that looked
    broken was really just never coming back before the browser gave up.
    Brand strings are a small, fixed set (the published tables), so caching
    every one of them costs a few hundred KB, not an unbounded amount.
    """
    return bn_key(brand)


def _overrides_by_state(db: Session) -> dict[str, list[PriceOverride]]:
    """Every correction, grouped by state, in one query.

    Fetched once per request rather than per region: the NCR comparison needs
    three states' worth and each card would otherwise go back to the database.
    """
    out: dict[str, list[PriceOverride]] = defaultdict(list)
    for r in db.query(PriceOverride).all():
        out[r.state].append(r)
    return out


def _same_bottle(a: str, b: str) -> bool:
    """Is this the same drink under two states' spellings?

    It has to be asked, because the states do not agree on names. UP prints
    the full registered label - "Seagrams Royal Stag Superior Whisky" - where
    Delhi's list just says "Royal Stag". Matching those exactly meant a bottle
    all three states stock showed a price in one and a dash in the other two.

    So one name matching the other on whole words counts. Whole words matter:
    without the boundary "Bacardi" would match "Bacardi Apple", and they are
    different bottles at different prices.
    """
    ka, kb = _brand_key(a), _brand_key(b)
    if ka == kb:
        return True
    long, short = (ka, kb) if len(ka) >= len(kb) else (kb, ka)
    # The shorter name has to actually name something. Without this, a row
    # published as "Premium Whisky" matched Blenders Pride, Royal Stag and
    # everything else with those two words in it, and quietly reported its
    # price as theirs.
    if not any(w not in GENERIC_WORDS for w in short.split()):
        return False
    return (long.startswith(short + " ") or long.endswith(" " + short)
            or f" {short} " in long)


def _by_size(bottles: list[Bottle]) -> dict[int, list[Bottle]]:
    """One region's table, bucketed by size so a lookup never rescans it.

    _find_in used to filter a region's whole list by size on every single
    call - `[b for b in rows if b.size_ml == size_ml]` - and the comparison
    strip calls it for every pick, in every region, on every request. Against
    Delhi's 3,257 rows that was several million comparisons for one page
    load: the "Recommend" button that looked broken was really just taking
    over twenty seconds to answer. Bucketing once per region per request
    turns "scan everything" into "look up the bucket".
    """
    out: dict[int, list[Bottle]] = defaultdict(list)
    for b in bottles:
        out[b.size_ml].append(b)
    return out


def _find_in(same: list[Bottle], brand: str) -> Bottle | None:
    """The row in one region's size bucket that is this bottle, or nothing.

    An exact name wins outright. Otherwise the closest variant wins - fewest
    extra words - so "Bacardi Apple Platinum Original Apple Rum" pairs with
    Delhi's "Bacardi Apple" rather than its plain "Bacardi".

    Takes the bucket already narrowed to this size - see _by_size - rather
    than a whole region's table, so the size filter is paid for once per
    region instead of once per lookup.
    """
    key = _brand_key(brand)
    exact = [b for b in same if _brand_key(b.brand) == key]
    if exact:
        return exact[0]
    near = [b for b in same if _same_bottle(b.brand, brand)]
    if not near:
        return None
    words = len(key.split())
    return min(near, key=lambda b: (abs(len(_brand_key(b.brand).split()) - words),
                                    len(b.brand)))


# Full state names don't fit a column an inch wide. Shortened here rather than
# in the page, because the server is the half that knows what the states are.
SHORT_STATE = {
    "Uttar Pradesh": "UP",
    "Madhya Pradesh": "MP",
    "Gurugram (Haryana)": "Gurugram",
    "Maharashtra": "M'rashtra",
}


def _regions_for(state: str) -> tuple[str, ...]:
    """Which states a bottle's price is shown against.

    Every state we have a published list for, with the one being asked about
    first. This used to be the three NCR states only, which answered "is it
    cheaper across the border" for somebody in Delhi and nothing at all for
    anybody else - a Madhya Pradesh price sat next to three NCR columns and
    an Uttar Pradesh price never saw Madhya Pradesh, though that is exactly
    the comparison worth making.

    Capped, because the state list grows every time somebody types a price for
    a new one, and a strip of ten columns is unreadable on a phone.
    """
    rest = [s for s in STATES if s != state]
    return (state, *rest)[:MAX_COMPARE_REGIONS]


# Five published states fit across a phone; more would be a scrollbar.
MAX_COMPARE_REGIONS = 5


def _compare(tables_by_size: dict[str, dict[int, list[Bottle]]],
             regions: tuple[str, ...], brand: str, size_ml: int) -> list[dict]:
    """What this bottle costs in each region, corrections included.

    Built from the same tables the picks come from, so a price somebody
    entered by hand shows up here exactly like a published one - and a bottle
    that only exists because somebody added it still gets a row, with the
    regions that have never heard of it showing a dash rather than the whole
    strip disappearing.
    """
    out = []
    for region in regions:
        hit = _find_in(tables_by_size.get(region, {}).get(size_ml, []), brand)
        out.append({
            "region": region,
            "label": SHORT_STATE.get(region, region),
            "total": round(hit.mid) if hit else None,
            "manual": bool(hit and hit.source in MANUAL_SOURCES),
        })
    return out


def _apply_overrides(bottles: list[Bottle], rows: list[PriceOverride],
                     state: str) -> list[Bottle]:
    """Layer hand-entered corrections over the published table.

    A correction replaces the published row for that brand, state and size,
    and adds a row outright when the state list never had one - somebody who
    knows a price we are missing should be able to just say so.

    Corrected rows lose their range: a person quotes one price, not a band,
    and pretending otherwise would put a span on the page nobody gave us.
    """
    if not rows:
        return bottles

    by_key = {(r.brand_key, r.size_ml): r for r in rows}

    # A correction entered off a card carries the published name verbatim and
    # matches exactly. One typed by hand is usually the short name people
    # actually say - "Vat 69" against a listing that reads "VAT 69 BLENDED
    # SCOTCH WHISKY" - and matching only exactly left the published row in
    # place, so the same bottle appeared twice at two prices.
    #
    # So a typed name also claims a published row when it is a prefix of
    # exactly one of them at that size. Exactly one: if it would match two,
    # picking either is a guess, and the correction is added as its own row
    # instead of silently rewriting the wrong bottle.
    claimed: dict[tuple[str, int], tuple[str, int]] = {}
    for (k, size) in by_key:
        if any(bk == k for bk, s in
               ((_brand_key(b.brand), b.size_ml) for b in bottles) if s == size):
            continue
        cands = [b for b in bottles
                 if b.size_ml == size and _brand_key(b.brand).startswith(k)]
        # Failing that, the same product under a different arrangement of the
        # same words. "Smirnoff Mango Chilli" typed by hand against a list
        # printing "Smirnoff Mirchi Mango Triple Distilled Flavoured Vodka" is
        # one bottle, and leaving them apart put it on the page twice. The
        # category is ignored here on purpose - somebody quoting a price
        # should not also have to get the drop-down right.
        if not cands:
            want = bn_core(by_key[(k, size)].brand, "").split("|", 1)[1]
            cands = [b for b in bottles if b.size_ml == size
                     and bn_core(b.brand, "").split("|", 1)[1] == want]
        if len(cands) == 1:
            claimed[(_brand_key(cands[0].brand), size)] = (k, size)

    out, replaced = [], set()
    for b in bottles:
        bk = (_brand_key(b.brand), b.size_ml)
        hit = by_key.get(bk) or by_key.get(claimed.get(bk, ("", 0)))
        if hit is None:
            out.append(b)
            continue
        replaced.add((hit.brand_key, hit.size_ml))
        out.append(Bottle(hit.brand, hit.kind, hit.size_ml, state,
                          int(round(hit.price)), "manual-corrected",
                          None, hit.abv))
    for (k, size), r in by_key.items():
        if (k, size) not in replaced:
            # Nothing published matches this one: it exists only because
            # somebody typed it. Tagged apart from a correction so the ranking
            # can make sure it is actually seen — see _pick.
            out.append(Bottle(r.brand, r.kind, r.size_ml, state,
                              int(round(r.price)), "manual-added",
                              None, r.abv))
    return out


MANUAL_SOURCES = ("manual-added", "manual-corrected")


def _strength(b: Bottle) -> tuple[float, bool]:
    """This row's own strength if it has one, else the brand lookup."""
    if b.abv:
        return b.abv, True
    return abv_for(b.brand, b.kind)


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
    brand_last: dict[str, str] = {}
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
                    # Dates are stored ISO (YYYY-MM-DD), so a string compare
                    # is a date compare. Keeping the latest is what makes
                    # "had on" useful - the last time, not the first.
                    if e.date and e.date > brand_last.get(display, ""):
                        brand_last[display] = e.date

    favourites = sorted(brand_hits, key=lambda b: (-brand_hits[b], b))
    return {
        "scoped": bool(picked),
        "with_names": picked,
        "occasions": occasions,
        "total_spend": round(total, 2),
        "avg_per_occasion": round(total / occasions, 2) if occasions else 0.0,
        "favourites": favourites[:6],
        "brand_counts": {b: brand_hits[b] for b in favourites[:6]},
        # What was actually paid on the nights this brand came up. The list
        # price says what a shop charges; this says what you spend, which is
        # the number worth putting next to a suggestion.
        "brand_avg": {
            b: round(brand_spend[b] / brand_hits[b])
            for b in favourites[:6] if brand_hits[b]
        },
        # When you last actually drank it. Two bottles at the same price are
        # not the same choice if you had one of them last week.
        "brand_last": {b: brand_last[b] for b in favourites[:6] if b in brand_last},
    }


def _units(volume_ml: float, abv: float) -> float:
    """Millilitres of pure alcohol — the only fair way to compare a strong
    beer against a mild one, or beer against spirits."""
    return round(volume_ml * abv / 100, 1)


def _pick(bottles: list[Bottle], lo: float, hi: float, people: int,
          sizes: tuple[int, ...], favourites: list[str],
          brand_avg: dict[str, int] | None = None,
          tables_by_size: dict[str, dict[int, list[Bottle]]] | None = None,
          regions: tuple[str, ...] = NCR,
          brand_last: dict[str, str] | None = None,
          kinds: tuple[str, ...] = (),
          limit: int = 30) -> list[dict]:
    """Every bottle of the chosen size priced inside the budget range.

    Brands you actually drink come first. UP alone now lists over nine hundred
    bottles off the state's own price list, most of them regional labels
    nobody asked about, so ranking on price alone buried Royal Stag under a
    dozen brands you have never heard of. What you have bought before is the
    strongest signal in the data and it goes first.

    After that, dearest inside the budget: within one state and one size price
    is the only quality signal there is, and the top of a stated range is what
    someone was willing to spend.
    """
    # Favourites are short names off the expense text ("Bacardi"); the state
    # lists are verbose ("Bacardi Limon Original Citrus Rum"). Matching those
    # exactly never fired, so the whole ranking silently fell back to price.
    # A favourite counts when the published name contains it.
    fav = [f.lower() for f in favourites]
    avg = {k.lower(): v for k, v in (brand_avg or {}).items()}
    last = {k.lower(): v for k, v in (brand_last or {}).items()}

    def _fav_hit(brand: str) -> str | None:
        low = brand.lower()
        return next((f for f in fav if f in low), None)

    out: list[dict] = []

    for b in bottles:
        if b.kind not in BOTTLE_KINDS:
            continue
        # Narrows to just what was ticked - wine, brandy, tequila and liqueur
        # have no card of their own, so this only ever excludes them, never
        # requires them.
        if kinds and b.kind not in kinds:
            continue
        if b.size_ml not in sizes:
            continue
        price = b.mid
        if price < lo or price > hi:
            continue

        hit = _fav_hit(b.brand)
        abv, abv_known = _strength(b)
        compare = _compare(tables_by_size or {}, regions, b.brand, b.size_ml)
        priced = [c for c in compare if c["total"] is not None]
        cheapest = min(priced, key=lambda c: c["total"])["region"] if priced else None

        out.append({
            "brand": b.brand,
            "kind": b.kind,
            "size_ml": b.size_ml,
            "size_name": SPIRIT_SIZES[b.size_ml],
            "unit_price": b.price,
            "unit_price_max": b.price_max,
            "total": round(price),
            # What the budget would actually stretch to, said plainly rather
            # than silently picking a quantity on the user's behalf.
            "budget_buys": int(hi // price) if price > 0 else 0,
            "per_head": round(price / max(people, 1)),
            "ml_per_head": round(b.size_ml / max(people, 1)),
            "abv": abv,
            "abv_known": abv_known,
            "alcohol_ml_per_head": _units(b.size_ml / max(people, 1), abv),
            "is_favourite": bool(hit),
            "matched_favourite": hit,
            # What this actually cost you the nights you bought it, which is
            # not the same as what the state says it costs.
            "your_avg": avg.get(hit) if hit else None,
            # The last night you actually drank it. Two bottles at one price
            # are not the same choice if you had one of them last week.
            "last_had": last.get(hit) if hit else None,
            "is_override": b.source in MANUAL_SOURCES,
            "is_mine": b.source == "manual-added",
            "source": b.source,
            "compare": compare,
            "cheapest_region": cheapest,
        })

    # Anything you typed in yourself comes first and is never cut.
    #
    # UP alone lists over nine hundred bottles, and with only the eight
    # dearest-in-budget shown, a bottle somebody added was buried the moment
    # the budget widened — there is always something pricier. Adding a bottle
    # and then being unable to find it makes the whole feature feel broken,
    # so the cap stretches rather than dropping one.
    out.sort(key=lambda r: (not r["is_mine"], not r["is_favourite"], -r["total"]))
    mine = sum(1 for r in out if r["is_mine"])
    return out[:max(limit, mine + 4)]


def _parse_search_sizes(bottle: str) -> tuple[tuple[int, ...] | None, bool, bool]:
    """Same four size cards as the recommender, read differently for search.

    The recommender's "nothing ticked" means the three common spirit sizes -
    a sensible default for "what should I buy this evening". Search inherited
    that default and it was a real bug: Kingsmill Pink Raspberry Distilled
    Gin is sold only in 1000ml, so it was suggested by the autocomplete (which
    has no size filter at all) and then reported as not found by search
    (which silently excluded every 1000ml, 500ml, 330ml and other real,
    published size). A bottle search has no business assuming what size
    somebody meant - "nothing ticked" means every size here, full stop, and
    only ticking a card narrows it.

    Returns (sizes or None for unrestricted, show beer, show spirits).
    """
    parts = [p.strip() for p in (bottle or "").split(",")
             if p.strip() and p.strip() != "any"]
    for p in parts:
        if p not in BOTTLE_CHOICES:
            raise HTTPException(400, f"Pick any of {', '.join(BOTTLE_CHOICES[1:])} - got '{p}'")
    size_parts = [p for p in parts if p != "beer"]
    sizes = (tuple(sorted({ml for p in size_parts for ml in SIZE_GROUP[int(p)]}))
             if size_parts else None)
    want_beer = not parts or "beer" in parts
    want_spirits = not parts or bool(size_parts)
    return sizes, want_beer, want_spirits


def _search(bottles: list[Bottle], q: str, sizes: tuple[int, ...] | None,
           want_beer: bool, want_spirits: bool, kinds: tuple[str, ...],
           lo: float | None, hi: float | None) -> list[Bottle]:
    """Every bottle whose name contains the search text.

    Filtered the same way the recommender is - by kind and budget - because a
    search box that sits inside a set of filters and then ignores them would
    be a second, contradictory way of asking the same question. Size is the
    exception: `sizes=None` means every size, which is the default - see
    _parse_search_sizes for why. Budget is optional here, unlike the
    recommender: "what does Vat 69 cost" is a real question with no budget
    attached to it.

    Matched on words, not a single substring: "old rum" finds "Old Monk Xxx
    Rum" and "Old Chief Premium Xxx Rum" alike, which a single contiguous
    substring match would miss on word order.
    """
    qwords = bn_key(q).split()
    if not qwords:
        return []
    out = []
    for b in bottles:
        if b.kind == "beer":
            if not want_beer:
                continue
        else:
            if not want_spirits or b.kind not in BOTTLE_KINDS:
                continue
            if kinds and b.kind not in kinds:
                continue
            if sizes is not None and b.size_ml not in sizes:
                continue
        if lo is not None and b.mid < lo:
            continue
        if hi is not None and b.mid > hi:
            continue
        bk = _brand_key(b.brand)
        if all(w in bk for w in qwords):
            out.append(b)

    # Closest first: a name that starts with the search text, then the
    # shortest match - "Vat 69" before "Vat 69 Blended Scotch Whisky
    # Celebration Edition" when both match "vat 69".
    ql = " ".join(qwords)
    out.sort(key=lambda b: (not _brand_key(b.brand).startswith(ql), len(b.brand)))
    return out


def _legacy_beer_fields(unit: float, size_ml: int, people: int, abv: float,
                        buys: int) -> dict:
    """The old round-priced beer shape, for a web build that hasn't updated.

    Computed exactly as it used to be - as many bottles as the budget buys,
    capped at six a head - so an older page shows the numbers it always did
    instead of "Rs NaN". Nothing current reads any of these.
    """
    qty = max(1, min(buys, people * 6))
    total = unit * qty
    volume = size_ml * qty
    heads = max(people, 1)
    return {
        "qty": qty,
        "total": round(total),
        "total_ml": volume,
        "ml_per_head": round(volume / heads),
        "per_head": round(total / heads),
        "alcohol_ml_per_head": _units(volume / heads, abv),
    }


def _beers(bottles: list[Bottle], lo: float, hi: float, people: int,
           favourites: list[str] | None = None,
           tables_by_size: dict[str, dict[int, list[Bottle]]] | None = None,
           regions: tuple[str, ...] = NCR,
           limit: int = 30) -> list[dict]:
    """Beers you can buy, priced by the bottle.

    This used to price a whole round and lead with that — "Rs 960" for six
    bottles — which is not a number anybody recognises. A beer has a price and
    it is the price of one bottle, so that is what a card shows now. How many
    the budget stretches to is a separate, smaller line, because it is a
    consequence of the budget rather than a property of the beer.

    Only the top of the budget does any work here: a single bottle almost
    never costs as much as the bottom of a sensible range, so filtering on it
    would throw away every beer on the list.
    """
    fav = [f.lower() for f in (favourites or [])]
    out: list[dict] = []
    for b in bottles:
        if b.kind != "beer":
            continue
        # Same containment rule as the spirits: "Budweiser" has to match
        # "Budweiser Magnum Beer" or the ranking never sees a favourite.
        is_fav = any(f in b.brand.lower() for f in fav)
        unit = b.mid
        if unit <= 0 or unit > hi:
            continue                      # the budget won't buy even one
        buys = int(hi // unit)
        abv, abv_known = _strength(b)
        # The same side-by-side the spirits get. Beer was the one card without
        # it, for no better reason than that it was added later - and beer is
        # where the state gap is most obvious, because a crate is worth
        # driving for in a way a single bottle of whisky is not.
        compare = _compare(tables_by_size or {}, regions, b.brand, b.size_ml)
        priced = [c for c in compare if c["total"] is not None]
        cheapest = min(priced, key=lambda c: c["total"])["region"] if priced else None
        out.append({
            "brand": b.brand,
            "kind": b.kind,
            "size_ml": b.size_ml,
            # The headline: one bottle.
            "price": round(unit),
            "unit_price": b.price,
            "unit_price_max": b.price_max,
            # What the budget does with that, kept separate from the price.
            "budget_buys": buys,
            "bottles_per_head": round(buys / max(people, 1), 1),
            # One each for the group, which is the round people actually order.
            "round_for_group": round(unit * max(people, 1)),
            "abv": abv,
            "abv_known": abv_known,
            "alcohol_ml_per_bottle": _units(b.size_ml, abv),
            "is_favourite": is_fav,
            "is_override": b.source in MANUAL_SOURCES,
            "is_mine": b.source == "manual-added",
            "source": b.source,
            "compare": compare,
            "cheapest_region": cheapest,
            # Deprecated: the round-priced shape this card used to have. The
            # web app and the API deploy separately, so there is always a
            # window where one is older than the other, and a browser holding
            # the previous build reads these. Without them it renders "Rs NaN"
            # across every beer card. Safe to delete once a build that reads
            # `price` has been live for a while.
            **_legacy_beer_fields(unit, b.size_ml, people, abv, buys),
        })

    # Beers you actually buy first, then strongest among what fits, so the
    # cards read as a real choice rather than an arbitrary list.
    # Same rule as the spirits: your own entries first and never cut.
    out.sort(key=lambda r: (not r["is_mine"], not r["is_favourite"],
                            -r["abv"], r["price"]))
    mine = sum(1 for r in out if r["is_mine"])
    return out[:max(limit, mine + 4)]


def _your_entries(rows: list[PriceOverride], sizes: tuple[int, ...],
                  want_beer: bool, want_spirits: bool,
                  lo: float, hi: float) -> list[dict]:
    """Your own entries for this state, and why any of them isn't showing.

    Entering a price and then not finding it is the fastest way to stop
    trusting the feature, and there are several honest reasons it can happen:
    a 220ml bottle is not one of the three spirit sizes, a 180ml entry only
    appears when 180ml is selected, a Rs 1,880 bottle is outside a Rs 500
    budget. Silence looks like the data was lost. So each one says where it
    is instead.
    """
    out = []
    for r in rows:
        reason = None
        if r.kind == "beer":
            if not want_beer:
                reason = "saved as beer — tap Beer as well to see it"
            elif r.price > hi:
                reason = f"Rs {round(r.price)} is above this budget"
        elif not want_spirits:
            reason = f"saved as {r.kind} — tap a bottle size to see it"
        elif r.kind not in BOTTLE_KINDS:
            reason = f"saved as {r.kind}, which isn't suggested for an evening"
        elif r.size_ml not in SPIRIT_SIZES:
            reason = (f"saved at {r.size_ml}ml, which isn't one of the three "
                      f"bottle sizes — re-save it as 180, 375 or 750")
        elif r.size_ml not in sizes:
            reason = f"saved at {r.size_ml}ml — tap {r.size_ml}ml to see it"
        elif not (lo <= r.price <= hi):
            reason = f"Rs {round(r.price)} is outside this budget"
        stamp = r.updated_at or r.created_at
        out.append({
            "id": r.id,
            "brand": r.brand,
            "kind": r.kind,
            "size_ml": r.size_ml,
            "price": r.price,
            "abv": r.abv,
            "set_by": r.set_by,
            # When you entered it, so an old correction is recognisable as one.
            "added_on": stamp.date().isoformat() if stamp else None,
            "shown": reason is None,
            "reason": reason,
        })
    out.sort(key=lambda x: (x["shown"], x["brand"].lower()))
    return out


def _band(bottles: list[Bottle], sizes: tuple[int, ...],
          want_beer: bool, want_spirits: bool,
          kinds: tuple[str, ...] = ()) -> dict | None:
    """Cheapest and dearest of what was asked for in this state.

    Spans everything the picker asked for, so a search for halves *and* beer
    reports one range covering both rather than the range of whichever half
    happened to be checked.
    """
    rows = []
    if want_beer:
        rows += [b for b in bottles if b.kind == "beer"]
    if want_spirits:
        rows += [b for b in bottles
                 if b.size_ml in sizes and b.kind in BOTTLE_KINDS
                 and (not kinds or b.kind in kinds)]
    if not rows:
        return None
    return {"min": round(min(r.mid for r in rows)), "max": round(max(r.mid for r in rows))}


class PriceIn(BaseModel):
    """A price somebody is correcting by hand."""

    brand: str = Field(min_length=2, max_length=200)
    kind: str
    state: str
    size_ml: int
    price: float
    # Optional on purpose: plenty of people know what they paid without
    # knowing the strength, and an invented figure would sit on the card
    # looking exactly like a published one.
    abv: float | None = None
    note: str | None = Field(default=None, max_length=500)
    # Keep my spelling of the name, rather than snapping to the one already in
    # the table. Off by default and asked for explicitly, because the two ways
    # of getting this wrong are both bad: silently renaming loses the detailed
    # published label, and silently keeping both spellings creates the
    # duplicate row this whole mechanism exists to prevent. Either way it is
    # one bottle afterwards - the name changes, a second row is never made.
    rename: bool = False

    @field_validator("brand", "state")
    @classmethod
    def _tidy(cls, v: str) -> str:
        return " ".join(v.split())

    @field_validator("state")
    @classmethod
    def _sane_state(cls, v: str) -> str:
        # The state box is free text so a price can be entered for somewhere
        # we have no list for at all. That is the point of it - but a state
        # becomes a permanent entry in everyone's dropdown, so it has to look
        # like a place name rather than a slip of the keyboard.
        if not 2 <= len(v) <= 60:
            raise ValueError("state must be between 2 and 60 characters")
        if not re.fullmatch(r"[A-Za-z][A-Za-z .,()&'\-]*", v):
            raise ValueError("state should be a place name, letters and spaces")
        return v

    @field_validator("kind")
    @classmethod
    def _known_kind(cls, v: str) -> str:
        v = v.strip().lower()
        if v not in KINDS:
            raise ValueError(f"kind must be one of {', '.join(KINDS)}")
        return v

    @field_validator("size_ml")
    @classmethod
    def _sane_size(cls, v: int) -> int:
        # Wide enough for a 90ml nip and a 2-litre, narrow enough that a
        # mistyped price in the size box is caught here rather than shown.
        if not 30 <= v <= 5000:
            raise ValueError("size must be between 30ml and 5000ml")
        return v

    @field_validator("price")
    @classmethod
    def _sane_price(cls, v: float) -> float:
        if not 1 <= v <= 500000:
            raise ValueError("price must be between Rs 1 and Rs 5,00,000")
        return round(v, 2)

    @field_validator("abv")
    @classmethod
    def _sane_abv(cls, v: float | None) -> float | None:
        if v is None:
            return None
        if not 0 < v <= 96:
            # 96% is roughly neat rectified spirit; nothing drinkable is above.
            raise ValueError("strength must be between 0 and 96 % v/v")
        return round(v, 1)


def _known_brands(db: Session, state: str = "") -> list[dict]:
    """Every bottle we already hold, published or entered by hand.

    Scoped to a state when one is given, because "do we have this already" is
    a different question in Delhi than in Punjab.
    """
    out: dict[str, dict] = {}
    for b in BOTTLES:
        if state and b.state != state:
            continue
        e = out.setdefault(b.brand, {"brand": b.brand, "kind": b.kind,
                                     "sizes": set(), "yours": False})
        e["sizes"].add(b.size_ml)
    q = db.query(PriceOverride)
    if state:
        q = q.filter(PriceOverride.state == state)
    for r in q.all():
        e = out.setdefault(r.brand, {"brand": r.brand, "kind": r.kind,
                                     "sizes": set(), "yours": False})
        e["sizes"].add(r.size_ml)
        e["yours"] = True
    return [{**e, "sizes": sorted(e["sizes"])}
            for e in sorted(out.values(), key=lambda x: x["brand"].lower())]


def _resolve_brand(db: Session, brand: str, kind: str) -> tuple[str, str, bool]:
    """Snap a typed brand onto one we already have.

    A bottle already in the table must not be addable a second time under a
    slightly different spelling - "Vat 69 Blended" alongside "Vat 69" is two
    bottles as far as everything downstream is concerned, and only one of them
    has the published price. So the name is resolved before anything is
    written, and what comes back is the existing spelling.

    Matching is by the same core used to unify names across states: strip the
    words that describe rather than identify, and compare what is left. The
    category is tried first and then ignored, because somebody correcting a
    price should not have to also get the drop-down right.

    Returns (name, kind, already_known).
    """
    by_core: dict[str, tuple[str, str]] = {}
    loose: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for e in _known_brands(db):
        c = bn_core(e["brand"], e["kind"])
        by_core.setdefault(c, (e["brand"], e["kind"]))
        loose[c.split("|", 1)[1]].append((e["brand"], e["kind"]))

    hit = by_core.get(bn_core(brand, kind))
    if hit:
        return hit[0], hit[1], True
    # Same words, different category: trust the table's category over the form.
    same = loose.get(bn_core(brand, kind).split("|", 1)[1], [])
    if len(same) == 1:
        return same[0][0], same[0][1], True
    return brand, kind, False


def _override_out(r: PriceOverride) -> dict:
    return {
        "id": r.id, "brand": r.brand, "kind": r.kind, "state": r.state,
        "size_ml": r.size_ml, "price": r.price, "abv": r.abv, "note": r.note,
        "set_by": r.set_by,
        "updated_at": (r.updated_at or r.created_at).isoformat()
        if (r.updated_at or r.created_at) else None,
    }


@router.get("/prices", response_model=list[dict])
def list_prices(state: str = "", db: Session = Depends(get_db),
                _: User = Depends(current_user)):
    """Corrections people have entered, newest first."""
    q = db.query(PriceOverride)
    if state:
        q = q.filter(PriceOverride.state == state)
    rows = q.order_by(PriceOverride.id.desc()).all()
    return [_override_out(r) for r in rows]


@router.get("/brands", response_model=list[dict])
def list_brands(state: str = "", db: Session = Depends(get_db),
                _: User = Depends(current_user)):
    """Bottles we already hold, so the form can suggest rather than duplicate."""
    return _known_brands(db, state)


@router.post("/prices", response_model=dict)
def set_price(body: PriceIn, db: Session = Depends(get_db),
              caller: User = Depends(current_user)):
    """Correct a price, or add one the published lists never carried.

    Writing the same brand, state and size again updates the existing
    correction instead of stacking a second one, so the table can't end up
    with two answers to the same question.
    """
    # Snap to a state we already know, whatever the typing. Without this
    # "uttar pradesh" and "Uttar Pradesh" become two states in the dropdown,
    # each holding half the corrections - the same duplicate-naming problem
    # the brand tables have, arriving through the one free-text box.
    known = set(STATES) | {s for (s,) in db.query(PriceOverride.state).distinct()}
    state = next((k for k in known if k.lower() == body.state.lower()), body.state)

    # A bottle already in the table cannot be added again under a new name -
    # only its price changes. Resolved before the lookup so the upsert lands
    # on the existing row rather than creating a near-duplicate beside it.
    brand, kind, known = _resolve_brand(db, body.brand, body.kind)

    # The key is always the resolved one, so the correction still claims the
    # published row it belongs to. Only the displayed name changes, and only
    # when asked - which is what makes renaming safe: there is no spelling of
    # the name that can turn one bottle into two.
    key = _brand_key(brand)
    if body.rename and body.brand.strip():
        brand = body.brand.strip()
    row = (db.query(PriceOverride)
             .filter(PriceOverride.brand_key == key,
                     PriceOverride.state == state,
                     PriceOverride.size_ml == body.size_ml)
             .first())
    if row is None:
        row = PriceOverride(brand_key=key, state=state, size_ml=body.size_ml)
        db.add(row)
    row.brand = brand
    row.kind = kind
    row.price = body.price
    row.abv = body.abv
    row.note = (body.note or "").strip() or None
    row.set_by = caller.name
    db.commit()
    db.refresh(row)
    # `known` tells the form whether it corrected the name, so the page can
    # say "that was already in the list" rather than silently renaming it.
    return {**_override_out(row), "matched_existing": known,
            "submitted_brand": body.brand}


@router.delete("/prices/{price_id}", response_model=dict)
def delete_price(price_id: int, db: Session = Depends(get_db),
                 _: User = Depends(current_user)):
    """Drop a correction, putting the published price back in charge."""
    row = db.query(PriceOverride).filter(PriceOverride.id == price_id).first()
    if row is None:
        raise HTTPException(404, "That correction is already gone")
    db.delete(row)
    db.commit()
    return {"ok": True, "id": price_id}


@router.get("/meta", response_model=dict)
def meta(db: Session = Depends(get_db), _: User = Depends(current_user)):
    """States we have real prices for, and where those prices came from."""
    # A state nobody published but somebody entered a price for is a real
    # state. Without this the correction would be saved and then unreachable,
    # because the dropdown only offers what the static table knows.
    added = {s for (s,) in db.query(PriceOverride.state).distinct()}
    return {
        "states": sorted(set(STATES) | added),
        "ncr": list(NCR),
        "sources": SOURCES,
        "abv_sources": ABV_SOURCES,
        "row_count": len(BOTTLES),
        "kinds": list(KINDS),
        "min_budget_span": MIN_BUDGET_SPAN,
        # No card for "any": the form says it by having none of these
        # selected, which is one less thing on screen and reads the way a
        # filter should - off until you turn it on.
        "bottle_choices": [
            {"value": str(ml), "name": SPIRIT_SIZES[ml].title(), "hint": f"{ml}ml"}
            for ml in BOTTLE_SIZES
        ] + [{"value": "beer", "name": "Beer", "hint": "by the bottle"}],
        # Same "nothing selected means everything" rule as bottle_choices.
        "kind_choices": [{"value": k, "name": k.title()} for k in KIND_CHOICES],
    }


@router.get("/search", response_model=dict)
def search(
    state: str = "",
    q: str = "",
    bottle: str = "any",
    kind: str = "",
    budget_min: float | None = None,
    budget_max: float | None = None,
    db: Session = Depends(get_db),
    caller: User = Depends(current_user),
):
    """Find one bottle by name, priced here and compared across every state.

    The recommender answers "what should I buy" out of a budget; this
    answers "what does this specific bottle cost" - checking on a brand you
    already have in mind rather than browsing for one. Respects whatever
    kind and budget filters are already set on the page, so searching inside
    a narrowed set of results stays narrowed rather than quietly searching
    everything and ignoring what was picked. Size is deliberately not
    narrowed by default - see _parse_search_sizes. Budget is optional here,
    unlike the recommender - a plain "what does Vat 69 cost" has no budget
    attached to it at all.

    `state` is optional and defaults to every state at once. The recommender
    needs one specific state because alcohol pricing genuinely is
    state-specific - there is no sane single answer to "what should I buy"
    without knowing where. "Does anyone sell this at all" has no such
    natural default, and defaulting search to whichever state the
    recommender happened to have selected meant a bottle Delhi doesn't carry
    read as "not found" even when Madhya Pradesh had it three taps away.
    """
    q = q.strip()
    if len(q) < 2:
        raise HTTPException(400, "Type at least 2 letters to search")
    if budget_min is not None and budget_max is not None and budget_max < budget_min:
        raise HTTPException(400, "budget_max must be at least budget_min")

    sizes, want_beer, want_spirits = _parse_search_sizes(bottle)
    kinds = _parse_kinds(kind)
    # Same rule as the recommender: a kind card (whisky/rum/vodka/gin) rules
    # out beer, which is none of those.
    if kinds:
        want_beer = False

    by_state = _overrides_by_state(db)
    known_states = sorted(set(STATES) | set(by_state))
    is_all = not state.strip() or state.strip().lower() == "all"
    if not is_all and state not in known_states:
        raise HTTPException(
            404,
            f"No published prices for {state} yet — we only have "
            f"{', '.join(known_states)}.",
        )
    search_states = known_states if is_all else [state]

    # Every state's table, built once. The compare strip is the same set of
    # columns regardless of which state a hit happens to come from, so there
    # is no reason to rebuild it per hit or per searched state.
    tables = {
        s: _apply_overrides(for_state(s), by_state.get(s, []), s) for s in known_states
    }
    tables_by_size = {s: _by_size(rows) for s, rows in tables.items()}

    hits: list[tuple[str, Bottle]] = []
    for st in search_states:
        for b in _search(tables[st], q, sizes, want_beer, want_spirits, kinds,
                         budget_min, budget_max):
            hits.append((st, b))

    # Re-ranked as one list rather than state by state, so the closest match
    # to the text overall comes first regardless of which state holds it.
    ql = " ".join(bn_key(q).split())
    hits.sort(key=lambda sb: (not _brand_key(sb[1].brand).startswith(ql),
                              len(sb[1].brand)))

    results = []
    for st, b in hits[:25]:
        abv, abv_known = _strength(b)
        regions = _regions_for(st)
        compare = _compare(tables_by_size, regions, b.brand, b.size_ml)
        priced = [c for c in compare if c["total"] is not None]
        cheapest = min(priced, key=lambda c: c["total"])["region"] if priced else None
        results.append({
            "brand": b.brand,
            "kind": b.kind,
            "size_ml": b.size_ml,
            "size_name": SPIRIT_SIZES.get(b.size_ml) if b.kind != "beer" else None,
            # Which state this exact row came from - always present, since a
            # global search can turn up the same brand from several states.
            "state": st,
            "price": round(b.mid),
            "unit_price": b.price,
            "unit_price_max": b.price_max,
            "abv": abv,
            "abv_known": abv_known,
            "is_override": b.source in MANUAL_SOURCES,
            "is_mine": b.source == "manual-added",
            "source": b.source,
            "compare": compare,
            "cheapest_region": cheapest,
        })

    return {
        "state": "all" if is_all else state,
        "is_all": is_all,
        "states_searched": search_states,
        "q": q,
        "results": results,
        "count": len(results),
        "truncated": len(hits) > len(results),
    }


@router.get("/", response_model=dict)
def recommend(
    state: str,
    people: int = 2,
    budget_min: float = 500,
    budget_max: float = 1000,
    bottle: str = "any",
    kind: str = "",
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
    # Any combination of the four cards, so "a couple of quarters or some
    # beer" is askable. Nothing picked still means everything.
    sizes, want_beer, want_spirits = _parse_bottle(bottle)
    picked = [p.strip() for p in (bottle or "").split(",")
              if p.strip() and p.strip() != "any"]
    is_any = not picked
    # Kept for the page's headline and for older builds: true only when beer
    # is the whole of the question, which is what it always meant.
    is_beer = want_beer and not want_spirits and not is_any
    # The card that was tapped, not the sizes it expands to: tapping "Full"
    # asks for 700ml and 750ml, and reporting 700 back would be a number
    # nobody chose.
    cards = [int(p) for p in picked if p != "beer"]
    bottle_ml = cards[0] if len(cards) == 1 else 0

    # Optional, and separate from the size picker: which of whisky, rum,
    # vodka, gin to show. Nothing ticked still means everything.
    kinds = _parse_kinds(kind)
    # Beer isn't one of those four cards, so ticking one is implicitly asking
    # to not see beer - the size picker's own "beer" card stays independent,
    # but a kind filter always wins over it. Without this, picking "Whisky"
    # left beer showing anyway, since nothing here had ever checked kinds
    # before deciding want_beer.
    if kinds:
        want_beer = False

    by_state = _overrides_by_state(db)
    bottles = _apply_overrides(for_state(state), by_state.get(state, []), state)

    # Every state we have prices for, the one you asked about first. Three NCR
    # columns answered "is it cheaper over the border" for somebody in Delhi
    # and nothing for anybody else - a UP price never saw MP, though that is
    # the comparison worth making.
    regions = _regions_for(state)
    tables = {
        r: _apply_overrides(for_state(r), by_state.get(r, []), r) for r in regions
    }
    # Bucketed by size once per region per request, so the comparison strip's
    # per-pick, per-region lookups never rescan a whole region's table - see
    # _by_size.
    tables_by_size = {r: _by_size(rows) for r, rows in tables.items()}

    if not bottles:
        raise HTTPException(
            404,
            f"No published prices for {state} yet — we only have "
            f"{', '.join(STATES)}. Prices are set per state, so guessing one "
            f"from another would be wrong.",
        )

    people_names = [n for n in (names or "").split(",") if n.strip()]
    hist = _history(db, caller, people_names)
    # The picker decides what you are buying, and it can now ask for both.
    picks = (_pick(bottles, budget_min, budget_max, people, sizes,
                   hist["favourites"], hist["brand_avg"], tables_by_size, regions,
                   hist["brand_last"], kinds)
             if want_spirits else [])
    beers = (_beers(bottles, budget_min, budget_max, people, hist["favourites"],
                    tables_by_size, regions)
             if want_beer else [])

    return {
        "state": state,
        "ncr": list(NCR),
        # The columns of the side-by-side, in order. Not always three: a state
        # outside the NCR is prepended so you can see your own price too.
        "regions": list(regions),
        "people": people,
        "budget_min": budget_min,
        "budget_max": budget_max,
        "budget_per_head": round(budget_max / people),
        "bottle": bottle,
        "bottle_ml": bottle_ml,
        "is_beer": is_beer,
        # What the picker actually asked for, so the page can label the
        # results without having to re-derive it from the raw parameter.
        "picked": picked,
        "want_beer": want_beer,
        "want_spirits": want_spirits,
        "sizes": list(sizes) if want_spirits else [],
        # The cards the page should show as selected, echoed back so it can
        # trust the server's reading of the parameter rather than its own.
        "cards": cards,
        "kinds": list(kinds),
        "bottle_name": (
            "any size" if is_any
            else " · ".join([SPIRIT_SIZES[c] for c in cards]
                            + (["beer"] if want_beer else []))
        ),
        "history": hist,
        "picks": picks,
        # Says why a list is empty: no rows at all for this size in this state
        # is a different problem from everything being over budget.
        # What that size actually costs here, so an empty list can say "they
        # run Rs 95-250" instead of leaving you guessing at the range.
        "price_band": _band(bottles, sizes, want_beer, want_spirits, kinds),
        # Your own entries for this state, each saying whether it is in the
        # list above and, if not, why — so a price you typed is never just
        # silently absent.
        "your_entries": _your_entries(by_state.get(state, []), sizes,
                                      want_beer, want_spirits,
                                      budget_min, budget_max),
        # Straight from the knowledge base: drinks you have actually bought
        # whose typical spend lands in this budget. Priced from what you paid,
        # not from a list, so it is called spend rather than a price.
        "learned": learned(db, DRINK,
                           [g.id for g in db.query(Group).all() if is_member(g, caller)],
                           budget_min, budget_max),
        "size_available": any(
            (want_beer and b.kind == "beer")
            or (want_spirits and b.size_ml in sizes and b.kind in BOTTLE_KINDS
                and (not kinds or b.kind in kinds))
            for b in bottles
        ),
        "is_any": is_any,
        "beers": beers,
        "sources": SOURCES,
        "abv_sources": ABV_SOURCES,
    }

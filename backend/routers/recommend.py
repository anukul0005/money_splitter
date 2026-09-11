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
from knowledge import DRINK, DRINK_RE, is_alcohol, learned
from brand_names import canonicalise as bn_canonicalise, core as bn_core, key as bn_key
from liquor_prices import (
    ABV_SOURCES, BOTTLES, NCR, SOURCES, STATES, Bottle, abv_for, for_state,
)
from models import Group, PriceOverride, Product, ProductReview, User

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
BOTTLE_CHOICES = ("any", "180", "375", "750", "other", "beer")


# Budget is a range rather than a ceiling, because "around 500" is what people
# actually mean. Too narrow a range matches nothing on a price list that moves
# in fifties, so a span this small is rejected rather than quietly returning
# an empty list.
MIN_BUDGET_SPAN = 60

# The three sizes most spirits are sold in, and everyone names them this way.
SPIRIT_SIZES = {180: "quarter", 375: "half", 700: "full", 750: "full"}
SIZE_ORDER = (750, 700, 375, 180)

# What each card on the picker actually asks for. 700ml is the standard import
# bottle - most of the tequila and a lot of the imported scotch is sold in it -
# and it is a full bottle by any sane reading, so "Full" covers both rather
# than making people learn that their bottle is 50ml short of a card.
SIZE_GROUP = {180: (180,), 375: (375,), 750: (700, 750)}
ALL_SIZES = (180, 375, 700, 750)


@lru_cache(maxsize=1)
def _other_spirit_sizes() -> tuple[int, ...]:
    """Every non-beer size the published tables actually carry outside the
    three cards above - 90ml nips, 500ml, 1000ml, even the odd 4.5 litre
    jeroboam. Real rows, not a hypothetical: 1000ml alone is 145 of them.

    These used to be excluded outright, on the reasoning that a nip or a
    litre bottle "is not something you would walk out of a shop with for an
    evening" - true for most evenings, but it also meant a whisky published
    only in 1000ml could never appear in a suggestion or a search result no
    matter how well it fit the budget. The "Other" card exists so those
    sizes are reachable rather than invisible, without disturbing the
    default three-card evening-sized behaviour anyone who never taps it
    still gets.

    Cached: this scans the whole BOTTLES table, which is static for the
    life of the process - see _brand_key's docstring for why that matters
    at this table's size.
    """
    return tuple(sorted({b.size_ml for b in BOTTLES if b.kind != "beer"
                        and b.size_ml not in (180, 375, 700, 750)}))


def _size_group(card: str) -> tuple[int, ...]:
    """Which actual sizes one size-picker card expands to.

    "other" is the one card with no fixed answer - it means every non-beer
    size the tables carry outside the three evening-sized cards, which is a
    property of the data, not a constant anyone chose.
    """
    return _other_spirit_sizes() if card == "other" else SIZE_GROUP[int(card)]


def _parse_bottle(bottle: str) -> tuple[tuple[int, ...], bool, bool]:
    """Read the size picker, which takes any combination of its five cards.

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
                          for ml in _size_group(p)}))
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
    "new", "no", "xxx", "single", "irish",
}

# An age statement's own filler, dropped before comparing two names in
# _same_bottle - "12 Years Old" and "Aged 12 Years" say the same thing about
# the same bottle, and neither "old" nor "aged" showing up (or not) on either
# side should decide whether two spellings match.
_AGE_FILLER = {"old", "aged", "years", "yrs", "yr"}


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

    Every word of the shorter name has to appear somewhere in the longer one,
    not necessarily contiguously. A retail catalogue's "Bushmills 12 Years
    Old" and the official list's "Bushmills Triple Distilled Aged 12 Years
    Single Malt Rare Irish Whisky" are the same bottle, but "Triple Distilled
    Aged" sits between "Bushmills" and "12", which a contiguous-substring
    match missed entirely - two states stocking the identical whisky showed a
    price in one and a dash in the other. Word order carries no information
    in these lists (see brand_names.core for the same reasoning), so
    scattering does not make it a different bottle.

    An age statement is also idiom, not vocabulary: the same fact is "12
    Years Old" on one list and "Aged 12 Years" on the other, and neither
    "old" nor "aged" appearing on both sides is a coincidence worth failing
    the match over - the number is what actually says which bottle this is.
    Dropped from both names before comparing, so the two spellings of that
    one fact stop counting as a mismatch.

    The shorter name needs *two* real, non-generic words, not one - a bare
    "Bacardi" is one word once "rum" is discounted, and a first pass at this
    rule that allowed one word matched it to "Bacardi Anejo Cuatro Aged Gold
    Rum", a real, ₹2050-dearer, differently-flavoured bottle, not the same
    one spelled two ways.

    And every word the longer name adds beyond the shorter one has to be
    filler too, not new content - the same audit that caught the Bacardi
    case also caught "Moooz Sparkle Vodka" matching "Moooz Sparkle Green
    Apple Vodka", "Moooz Sparkle Jamun Vodka" *and* "Moooz Sparkle Limon
    Vodka" all at once, because the base name's words are a subset of every
    flavour's. A flavour, a house name or an edition is real, identifying
    information; requiring the extra words to all be generic filler is what
    tells "Bushmills 12 Years Old" apart (Delhi's longer name for it adds
    nothing but "Triple Distilled ... Single Malt Rare Irish Whisky", every
    word of it descriptive) from an actually different, differently-priced
    bottle that happens to share a base name.
    """
    ka, kb = _brand_key(a), _brand_key(b)
    if ka == kb:
        return True
    wa = [w for w in ka.split() if w not in _AGE_FILLER]
    wb = [w for w in kb.split() if w not in _AGE_FILLER]
    long_words, short_words = (wa, wb) if len(wa) >= len(wb) else (wb, wa)
    # The shorter name has to actually name something specific - see the
    # docstring for why this is two words, not merely non-empty.
    significant = [w for w in short_words if w not in GENERIC_WORDS]
    if len(significant) < 2:
        return False
    long_set = set(long_words)
    if not all(w in long_set for w in short_words):
        return False
    extra = long_set - set(short_words)
    return all(w in GENERIC_WORDS for w in extra)


class _BottleIndex:
    """One region's size bucket, indexed for fuzzy brand lookup that doesn't
    rescan the whole bucket on every call.

    _find_in used to be handed a plain list and scan every row on every
    call - fine when it was called a few times against a small bucket, not
    when it is called for every pick in every comparison region (the compare
    strip re-queries the same bucket once per pick) or for every bottle in
    every other state while building a state's fallback catalogue (see
    _catalog_for) - both call the same bucket thousands of times over. A
    bucket the size of one of Delhi's (hundreds to low thousands of rows)
    times thousands of calls was several million word-set comparisons and
    upwards of twenty seconds for a single request.

    Indexed two ways: an exact-key dict for the common case of an identical
    spelling (O(1)), and an inverted index from each significant word to the
    bottles carrying it, for the fuzzy case - so a candidate is only ever
    compared against bottles that already share at least one real word with
    it, not the whole bucket. "Chivas Regal 25 Years Old" only ever gets
    compared against bottles containing "chivas", "regal" or "25", not
    against every whisky in the bucket.
    """

    def __init__(self, bottles: list[Bottle]):
        self._by_key: dict[str, Bottle] = {}
        self._by_word: dict[str, list[Bottle]] = defaultdict(list)
        for b in bottles:
            k = _brand_key(b.brand)
            self._by_key.setdefault(k, b)
            for w in set(k.split()) - _AGE_FILLER - GENERIC_WORDS:
                self._by_word[w].append(b)

    def find(self, brand: str) -> Bottle | None:
        """The row in this bucket that is this bottle, or nothing.

        An exact name wins outright. Otherwise the closest variant wins -
        fewest extra words - so "Bacardi Apple Platinum Original Apple Rum"
        pairs with Delhi's "Bacardi Apple" rather than its plain "Bacardi".
        """
        key = _brand_key(brand)
        exact = self._by_key.get(key)
        if exact is not None:
            return exact
        words = [w for w in key.split() if w not in _AGE_FILLER and w not in GENERIC_WORDS]
        if not words:
            return None
        seen: set[int] = set()
        candidates: list[Bottle] = []
        for w in words:
            for b in self._by_word.get(w, ()):
                if id(b) not in seen:
                    seen.add(id(b))
                    candidates.append(b)
        near = [b for b in candidates if _same_bottle(b.brand, brand)]
        if not near:
            return None
        nwords = len(key.split())
        return min(near, key=lambda b: (abs(len(_brand_key(b.brand).split()) - nwords),
                                        len(b.brand)))


_EMPTY_INDEX = _BottleIndex([])


def _by_size(bottles: list[Bottle]) -> dict[int, _BottleIndex]:
    """One region's table, bucketed by size and indexed for fuzzy lookup -
    see _BottleIndex for why a plain per-size list stopped being enough.
    """
    grouped: dict[int, list[Bottle]] = defaultdict(list)
    for b in bottles:
        grouped[b.size_ml].append(b)
    return {size_ml: _BottleIndex(rows) for size_ml, rows in grouped.items()}


def _find_in(bucket: _BottleIndex | None, brand: str) -> Bottle | None:
    """The row in one region's size bucket that is this bottle, or nothing.

    Thin wrapper kept so every call site reads the same as before; `bucket`
    is what _by_size now returns per size, or None/missing for a size this
    region has nothing in.
    """
    return (bucket or _EMPTY_INDEX).find(brand)


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


@lru_cache(maxsize=1)
def _catalog_short_names() -> dict[str, str]:
    """The one short, ordinary name for every bottle the state lists carry,
    keyed for matching against a person's own free-text expense notes.

    Fixes a real bug: history matching used to check whether the published
    name - "SEAGRAM'S ROYAL STAG SUPERIOR WHISKY (NEW)" - was a substring of
    what somebody actually typed - "Royal Stag with soda". That is backwards:
    the long official name is never contained inside a short human note, so a
    bottle bought a hundred times over never once registered as a favourite -
    the feature looked like it did not exist because the match could never
    fire.

    canonicalise() already solves the harder half of this: it clusters every
    state's spelling of one product and picks the shortest as the display
    name (brand_names.display), which is exactly the form a person writes
    down - "Royal Stag", not the registered label. Matching now runs the
    other way round: is this short, real name contained in what was typed.

    Cached, because BOTTLES is a large static table that never changes for
    the life of the process - see _brand_key's docstring for why re-deriving
    this per request was what made the recommend endpoint time out before.
    """
    pairs = [(b.brand, b.kind) for b in BOTTLES]
    out: dict[str, str] = {}
    for name in set(bn_canonicalise(pairs).values()):
        words = bn_key(name).split()
        # A name left with nothing but category/marketing filler after
        # canonicalising identifies no actual product - "Premium Whisky" -
        # and would match almost any drinks note going.
        if not words or all(w in GENERIC_WORDS for w in words):
            continue
        # Padded so a short match can never straddle a word boundary in the
        # padded text below - both sides are already single-spaced by
        # bn_key, so padding does the job a \b would do in a regex.
        out[f" {' '.join(words)} "] = name
    return out


def _history(db: Session, caller: User, names: list[str],
            groups: list[Group] | None = None,
            price_overrides: list[PriceOverride] | None = None) -> dict:
    """What this set of people has actually spent on drinks together.

    Only groups the caller belongs to are considered, so this can't be used to
    read someone else's habits.

    `scoped` says whether this is history *with someone*. With nobody named it
    is just the caller's own drinking across every group, which was being
    shown as though it were shared history — "12 sessions together" with no
    one named. The numbers still rank the suggestions, but the page only
    presents them once there is somebody to have had them with.

    `groups`/`price_overrides` let a caller that has already fetched these
    hand them over instead of paying for a second round trip - /recommend
    was fetching both a second time here on top of its own copies, and
    Group's members/expenses/payments being eager (lazy="selectin")
    relationships meant each fresh `db.query(Group).all()` was actually
    several queries, not one. Left as None (and fetched here, as before)
    for callers - the /forecast history reuses - that have no copy handy.
    """
    picked = [n.strip() for n in names if n.strip()]
    wanted = {n.lower() for n in picked}
    wanted.add(caller.name.lower())

    total = 0.0
    occasions = 0
    brand_hits: dict[str, int] = defaultdict(int)
    brand_spend: dict[str, float] = defaultdict(float)
    brand_last: dict[str, str] = {}
    # The published catalogue's short names, plus anything anyone has
    # corrected or added by hand - a brand that only exists because somebody
    # typed it in should count as "known" for history exactly like a
    # published one, or entering "Old Chief" and then buying it every week
    # would still never surface a favourite for it.
    short_names = dict(_catalog_short_names())
    for r in (price_overrides if price_overrides is not None else db.query(PriceOverride).all()):
        words = bn_key(r.brand).split()
        if words and not all(w in GENERIC_WORDS for w in words):
            short_names.setdefault(f" {' '.join(words)} ", r.brand)

    for g in (groups if groups is not None else db.query(Group).all()):
        if not is_member(g, caller):
            continue
        members = {m.name.lower() for m in g.members}
        # Every named person must actually be in the group for it to count
        if not wanted.issubset(members):
            continue
        for e in g.expenses:
            t = _text(e)
            if not is_alcohol(t):
                continue
            occasions += 1
            total += e.amount
            # Padded and normalised the same way _catalog_short_names built
            # its keys, so a short brand name matches whatever punctuation or
            # capitalisation the note actually used.
            padded = f" {bn_key(t)} "
            for key, display in short_names.items():
                if key in padded:
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


# The taste dimensions a purchase profile builds a signal from - the same
# ones _products_by_name now carries. Sipping/mixer/beginner-friendly are
# left out on purpose: those describe how a bottle is *used*, not what it
# *tastes like*, and a profile answering "what does this person's palate
# lean towards" wants the flavour dimensions, not usage ones.
PROFILE_TASTE_DIMENSIONS = (
    "sweetness", "smokiness", "smoothness", "spice", "fruit_citrus",
    "oak", "intensity",
)


def _user_profile(db: Session, caller: User, names: list[str],
                  groups: list[Group] | None = None,
                  price_overrides: list[PriceOverride] | None = None) -> dict:
    """What this person (or this set of people) actually drinks, derived
    entirely from their own recorded purchases - never typed in by hand.

    Stage 2 of the alcohol knowledge base: _history already proved the
    brand-matching works (see its own docstring for the bug that made this
    possible at all - matching a short name against what someone actually
    wrote, not the other way round); this reuses the identical scan and
    the identical short-name catalogue, but keeps every brand it found
    rather than capping to the six a recommendation card has room for, and
    turns the result into three things a scoring engine can use rather
    than one a card can display:

    `category_preferences` - how often each kind of thing shows up in what
    was actually bought, bucketed into high/medium/low by share of
    occasions. Not a stated preference; a measured one.

    `typical_spend` - the middle half (25th-75th percentile) of what a
    single drinks occasion has actually cost, so one big blowout night
    doesn't set the whole range the way an average would.

    `taste_signals` - the purchase-weighted average of every bought
    brand's own taste-profile numbers (from Product - see its docstring
    for why those numbers are a mix of real research and a category-level
    guess, which this inherits along with everything else built on them).
    Someone who has bought Old Monk twelve times has their signal shaped
    far more by Old Monk's numbers than by a brand tried once - weighted
    by purchase count, not averaged flat across distinct brands.
    """
    picked = [n.strip() for n in names if n.strip()]
    wanted = {n.lower() for n in picked}
    wanted.add(caller.name.lower())

    short_names = dict(_catalog_short_names())
    for r in (price_overrides if price_overrides is not None else db.query(PriceOverride).all()):
        words = bn_key(r.brand).split()
        if words and not all(w in GENERIC_WORDS for w in words):
            short_names.setdefault(f" {' '.join(words)} ", r.brand)

    brand_counts: dict[str, int] = defaultdict(int)
    brand_spend: dict[str, float] = defaultdict(float)
    occasion_amounts: list[float] = []
    occasions = 0

    for g in (groups if groups is not None else db.query(Group).all()):
        if not is_member(g, caller):
            continue
        members = {m.name.lower() for m in g.members}
        if not wanted.issubset(members):
            continue
        for e in g.expenses:
            t = _text(e)
            if not is_alcohol(t):
                continue
            occasions += 1
            occasion_amounts.append(e.amount)
            padded = f" {bn_key(t)} "
            for key, display in short_names.items():
                if key in padded:
                    brand_counts[display] += 1
                    brand_spend[display] += e.amount

    if not brand_counts:
        return {
            "scoped": bool(picked), "with_names": picked, "occasions": occasions,
            "purchases": {}, "purchase_avg_spend": {},
            "category_preferences": {}, "typical_spend": None, "taste_signals": {},
        }

    # Category share: the catalogue's own kind for a published brand, falling
    # back to Product.category for a brand that only exists because someone
    # corrected or added it by hand and was never in the static tables.
    kind_by_brand: dict[str, str] = {}
    for b in BOTTLES:
        kind_by_brand.setdefault(b.brand, b.kind)
    products = _products_by_name()

    category_counts: dict[str, int] = defaultdict(int)
    for brand, count in brand_counts.items():
        product = products.get(brand)
        kind = kind_by_brand.get(brand) or (product.category if product else None)
        if kind:
            category_counts[(kind or "").lower()] += count

    total_cat = sum(category_counts.values()) or 1

    def _level(share: float) -> str:
        if share >= 0.4:
            return "high"
        if share >= 0.15:
            return "medium"
        return "low"

    category_preferences = {
        k: _level(v / total_cat)
        for k, v in sorted(category_counts.items(), key=lambda x: -x[1])
    }

    amounts = sorted(occasion_amounts)
    n = len(amounts)
    lo = amounts[int(n * 0.25)]
    hi = amounts[min(n - 1, int(n * 0.75))]
    # A single occasion (n=1) has no meaningful 25th-75th spread - both
    # percentiles land on the same number, which is the honest answer, not
    # a bug to paper over with a fabricated range.

    dim_totals = {d: 0.0 for d in PROFILE_TASTE_DIMENSIONS}
    dim_weights = {d: 0.0 for d in PROFILE_TASTE_DIMENSIONS}
    for brand, count in brand_counts.items():
        product = products.get(brand)
        if product is None:
            continue
        for d in PROFILE_TASTE_DIMENSIONS:
            v = getattr(product, d, None)
            if v is not None:
                dim_totals[d] += v * count
                dim_weights[d] += count
    taste_signals = {
        d: round(dim_totals[d] / dim_weights[d], 1)
        for d in PROFILE_TASTE_DIMENSIONS if dim_weights[d]
    }

    favourites = sorted(brand_counts, key=lambda b: -brand_counts[b])
    return {
        "scoped": bool(picked),
        "with_names": picked,
        "occasions": occasions,
        # Every brand found, not capped to six - a profile is read by code,
        # not squeezed onto a card the way _history's own favourites are.
        "purchases": {b: brand_counts[b] for b in favourites},
        "purchase_avg_spend": {b: round(brand_spend[b] / brand_counts[b]) for b in favourites},
        "category_preferences": category_preferences,
        "typical_spend": {"min": round(lo), "max": round(hi)},
        "taste_signals": taste_signals,
    }


def _units(volume_ml: float, abv: float) -> float:
    """Millilitres of pure alcohol — the only fair way to compare a strong
    beer against a mild one, or beer against spirits."""
    return round(volume_ml * abv / 100, 1)


@lru_cache(maxsize=1)
def _products_by_name() -> dict:
    """Every product's rating, keyed by the exact brand string the price
    tables use (the granularity Product was built at - see
    backfill_products.py), cached for the life of the process.

    Product data changes only when someone re-runs backfill_products.py by
    hand, never from a user action in the app - querying all 3,919 rows
    fresh on every single /recommend request was over a second of pure
    network transfer, every time, for data that is static in every
    practical sense. A restart (which a deploy already does) is what picks
    up a re-run backfill; this is not wired to notice one happening while
    the process is live, which is an acceptable trade for a table nothing
    yet writes to at runtime.

    Ignores whatever request-scoped `db` session happens to be live when
    first called, on purpose - opening its own short-lived one instead, so
    this cache is not accidentally tied to one request's session lifetime.
    """
    from database import get_session_factory

    db = get_session_factory()()
    try:
        return {
            row.canonical_name: row
            for row in db.query(
                Product.id, Product.canonical_name, Product.rating,
                Product.rating_type, Product.rating_basis,
                Product.community_rating, Product.community_review_count,
                # category + taste dimensions: added for the purchase
                # profile (see _user_profile), which needs a bought
                # brand's own taste numbers to build a taste signal that
                # is derived from real purchases rather than typed by hand.
                Product.category, Product.sweetness, Product.smokiness,
                Product.smoothness, Product.spice, Product.fruit_citrus,
                Product.oak, Product.intensity,
            ).all()
        }
    finally:
        db.close()


def _rating_fields(products_by_name: dict | None, brand: str) -> dict:
    """The knowledge-base rating for this exact brand string, or nothing.

    `rating`/`rating_type`/`rating_basis` are the enrichment pipeline's own
    facts, untouched by anything a user submits - "Verified (external)" and
    "Estimated (heuristic)" are not the same kind of fact, and a future
    recommendation score should never weight them identically.
    `community_rating`/`community_review_count` are a different, later fact
    entirely - real people in this app who have actually had the bottle -
    kept in their own fields rather than blended into the columns above, so
    a card (or a sort) can tell "a citation", "a guess" and "what people
    here actually think" apart instead of averaging three different kinds
    of confidence into one number.

    A bottle with no Product row at all (an override that was never in the
    enriched catalogue) gets every field as None/0, same as a real row with
    nothing recorded yet.
    """
    product = (products_by_name or {}).get(brand)
    if product is None:
        return {"product_id": None, "rating": None, "rating_type": None,
                "rating_basis": None, "community_rating": None,
                "community_review_count": 0}
    return {
        "product_id": product.id,
        "rating": product.rating,
        "rating_type": product.rating_type,
        "rating_basis": product.rating_basis,
        "community_rating": product.community_rating,
        "community_review_count": product.community_review_count,
    }


def _effective_rating(fields: dict) -> float:
    """The one number to sort by: what real reviewers here actually think,
    once anyone has said so, otherwise the catalogue's own rating, otherwise
    0 - unrated bottles sort after rated ones rather than being scattered
    arbitrarily among them by whatever order the price table happened to
    list them in.
    """
    if fields.get("community_review_count"):
        return fields.get("community_rating") or 0.0
    return fields.get("rating") or 0.0


def _pick(bottles: list[Bottle], lo: float, hi: float, people: int,
          sizes: tuple[int, ...], favourites: list[str],
          brand_avg: dict[str, int] | None = None,
          tables_by_size: dict[str, dict[int, list[Bottle]]] | None = None,
          regions: tuple[str, ...] = NCR,
          brand_last: dict[str, str] | None = None,
          kinds: tuple[str, ...] = (),
          limit: int = 200, state: str = "",
          products_by_name: dict | None = None) -> list[dict]:
    """Every bottle of the chosen size priced inside the budget range.

    Ranked dearest inside the budget first: within one state and one size,
    price is the only quality signal there is, and the top of a stated range
    is what someone was willing to spend. A brand you actually drink still
    carries `is_favourite` and, if you have a date for it, `last_had` - a
    real signal worth showing - but it no longer moves the bottle up the
    list. That was tried: it meant the list mostly showed back what you
    already know you buy, the opposite of what a recommendation is for.

    Each row also carries `state` (where this exact price is actually from)
    and `is_price_fallback`. Both are always the state being asked about /
    False here - bottles come from that state's own list only, not merged
    across states (see _recommend_for_state) - kept only for field-shape
    consistency with /forecast/budget's own preview, which builds the same
    two fields itself from a real cross-state merge (see _catalog_for).

    The cap used to sit at 30, which was well inside the size of a real
    budget band in a state with a big list - Delhi alone has 67 whisky
    bottles between ₹2,500 and ₹4,500, so a well-known bottle sitting in the
    middle of that range by price (Jack Daniel's, say) lost to thirty
    pricier, less recognisable ones and never reached the response at all -
    "show all" couldn't surface it because it was never sent. 200 clears the
    worst case found across every state, kind and a spread of budget bands
    (142, for cheap Delhi whisky) with room to spare, so nothing that
    actually fits the budget silently disappears before the page's own "top
    7 / show all" toggle gets a chance to show it.
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
            # Named sizes only exist for the three evening-sized cards; an
            # "Other" pick can be any published size, which gets its literal
            # ml instead of a name nothing has ever given it.
            "size_name": SPIRIT_SIZES.get(b.size_ml, f"{b.size_ml}ml"),
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
            # Where this exact price actually comes from. Always the state
            # being asked about here - see _pick's own docstring for why
            # this field exists at all despite that.
            "state": b.state,
            "is_price_fallback": bool(state) and b.state != state,
            **_rating_fields(products_by_name, b.brand),
        })

    # Ranked by rating first, highest to lowest - a real community score or
    # a citation is a stronger signal than price alone, and price was only
    # ever standing in as "the one quality signal there is" before there
    # was a better one. Unrated bottles (rating 0, from _effective_rating)
    # sort after every rated one, then fall back to dearest-inside-budget
    # among themselves - price is still the tiebreaker it always was, just
    # no longer the primary key. A brand you buy often or priced yourself
    # still carries its "you buy this" / "had on <date>" badge
    # (is_favourite, last_had above); purchase history alone still doesn't
    # move a bottle up the list on its own - that was tried, and it meant
    # the list mostly showed back what you already know you drink.
    #
    # Your own entries are still never cut by the cap, though, regardless of
    # where they land in the order - UP alone lists over nine hundred
    # bottles, and a bottle somebody added being buried past the cap the
    # moment the budget widened made the whole feature feel broken.
    sort_key = lambda r: (-_effective_rating(r), -r["total"])
    out.sort(key=sort_key)
    mine = sum(1 for r in out if r["is_mine"])
    if len(out) <= max(limit, mine + 4):
        return out
    kept = [r for r in out if not r["is_mine"]][:limit]
    return sorted(kept + [r for r in out if r["is_mine"]], key=sort_key)


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
    sizes = (tuple(sorted({ml for p in size_parts for ml in _size_group(p)}))
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
           brand_avg: dict[str, int] | None = None,
           brand_last: dict[str, str] | None = None,
           tables_by_size: dict[str, dict[int, list[Bottle]]] | None = None,
           regions: tuple[str, ...] = NCR,
           limit: int = 200, state: str = "",
           products_by_name: dict | None = None) -> list[dict]:
    """Beers you can buy, priced by the bottle.

    Same reasoning as _pick's own limit: a cheap budget band can legitimately
    match most of a state's beer list (Delhi alone lists 438 beer rows), and
    a 30-item cap silently dropped anything past the thirtieth without any
    way for "show all" to recover it.

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
    avg = {k.lower(): v for k, v in (brand_avg or {}).items()}
    last = {k.lower(): v for k, v in (brand_last or {}).items()}
    out: list[dict] = []
    for b in bottles:
        if b.kind != "beer":
            continue
        # Same containment rule as the spirits: "Budweiser" has to match
        # "Budweiser Magnum Beer" or the ranking never sees a favourite.
        hit = next((f for f in fav if f in b.brand.lower()), None)
        is_fav = bool(hit)
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
            "matched_favourite": hit,
            "your_avg": avg.get(hit) if hit else None,
            "last_had": last.get(hit) if hit else None,
            "is_override": b.source in MANUAL_SOURCES,
            "is_mine": b.source == "manual-added",
            "source": b.source,
            "compare": compare,
            "cheapest_region": cheapest,
            "state": b.state,
            "is_price_fallback": bool(state) and b.state != state,
            **_rating_fields(products_by_name, b.brand),
            # Deprecated: the round-priced shape this card used to have. The
            # web app and the API deploy separately, so there is always a
            # window where one is older than the other, and a browser holding
            # the previous build reads these. Without them it renders "Rs NaN"
            # across every beer card. Safe to delete once a build that reads
            # `price` has been live for a while.
            **_legacy_beer_fields(unit, b.size_ml, people, abv, buys),
        })

    # Rated first, same as _pick - see there for why. Strongest, then
    # cheapest, is now the tiebreaker among beers at the same rating (most
    # of them, in practice, since so few carry a real one) rather than the
    # primary key.
    sort_key = lambda r: (-_effective_rating(r), -r["abv"], r["price"])
    out.sort(key=sort_key)
    mine = sum(1 for r in out if r["is_mine"])
    if len(out) > max(limit, mine + 4):
        kept = [r for r in out if not r["is_mine"]][:limit]
        out = sorted(kept + [r for r in out if r["is_mine"]], key=sort_key)
    return out


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
        elif r.size_ml not in SPIRIT_SIZES and r.size_ml not in _other_spirit_sizes():
            reason = (f"saved at {r.size_ml}ml, which isn't a size any "
                      f"published list carries — double check the size")
        elif r.size_ml not in sizes:
            card = f"{r.size_ml}ml" if r.size_ml in SPIRIT_SIZES else "Other"
            reason = f"saved at {r.size_ml}ml — tap {card} to see it"
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


TASTE_DIMENSIONS = (
    "sweetness", "smokiness", "smoothness", "spice", "fruit_citrus", "oak",
    "intensity", "beginner_friendly", "sipping_score", "mixer_score",
)


class ReviewIn(BaseModel):
    """One person's own review of a bottle - a score, a written note, and
    optionally their own take on its taste profile and category info.
    Everything but the score is optional: a review with no written note or
    opinion on smokiness is still a real review, it just answers less.
    """

    score: float = Field(ge=0, le=5)
    review_text: str | None = Field(default=None, max_length=2000)
    style: str | None = Field(default=None, max_length=80)
    body: str | None = Field(default=None, max_length=20)
    tasting_notes: str | None = Field(default=None, max_length=2000)
    sweetness: float | None = Field(default=None, ge=0, le=5)
    smokiness: float | None = Field(default=None, ge=0, le=5)
    smoothness: float | None = Field(default=None, ge=0, le=5)
    spice: float | None = Field(default=None, ge=0, le=5)
    fruit_citrus: float | None = Field(default=None, ge=0, le=5)
    oak: float | None = Field(default=None, ge=0, le=5)
    intensity: float | None = Field(default=None, ge=0, le=5)
    beginner_friendly: float | None = Field(default=None, ge=0, le=5)
    sipping_score: float | None = Field(default=None, ge=0, le=5)
    mixer_score: float | None = Field(default=None, ge=0, le=5)


def _review_out(r: ProductReview) -> dict:
    return {
        "id": r.id, "reviewer": r.reviewer, "score": r.score,
        "review_text": r.review_text, "style": r.style, "body": r.body,
        "tasting_notes": r.tasting_notes,
        **{d: getattr(r, d) for d in TASTE_DIMENSIONS},
        "updated_at": (r.updated_at or r.created_at).isoformat()
        if (r.updated_at or r.created_at) else None,
    }


def _recompute_product_aggregate(db: Session, product_id: int) -> None:
    """After a review is written or removed, bring Product's community
    fields - and, once any review exists, its taste-profile columns - back
    in line with what people have actually said.

    Numeric taste dimensions are averaged across every reviewer who gave an
    opinion on that one dimension - not every review answers every field,
    so each dimension's average is over whoever actually answered it, not
    over every review count-for-count. A real person's perception of a
    bottle they have had is better data than the category-level guess most
    of these started from (see Product's docstring), so once at least one
    review supplies a dimension, its average replaces the guess outright
    rather than sitting alongside it unused.

    Style, body and tasting_notes are text - there is nothing to average -
    so the most recently updated review that actually set that field wins,
    the same "latest correction stands" rule PriceOverride already uses.
    """
    product = db.query(Product).filter(Product.id == product_id).first()
    if product is None:
        return
    reviews = (db.query(ProductReview)
              .filter(ProductReview.product_id == product_id)
              .order_by(ProductReview.updated_at.asc()).all())

    if not reviews:
        product.community_rating = None
        product.community_review_count = 0
    else:
        product.community_rating = round(
            sum(r.score for r in reviews) / len(reviews), 2)
        product.community_review_count = len(reviews)

        for dim in TASTE_DIMENSIONS:
            values = [getattr(r, dim) for r in reviews if getattr(r, dim) is not None]
            if values:
                setattr(product, dim, round(sum(values) / len(values), 1))

        for field in ("style", "body", "tasting_notes"):
            # Reviews are ordered oldest first, so the last non-null value
            # encountered is the most recently updated one.
            latest = next((getattr(r, field) for r in reversed(reviews)
                          if getattr(r, field)), None)
            if latest:
                setattr(product, field, latest)

    db.commit()
    # The cached rating lookup every /recommend call reads from would
    # otherwise keep serving this product's pre-review numbers until the
    # process next restarts.
    _products_by_name.cache_clear()


@router.get("/products/{product_id}/reviews", response_model=dict)
def list_reviews(product_id: int, db: Session = Depends(get_db),
                 caller: User = Depends(current_user)):
    """Every review a product has, plus the caller's own if they have one -
    so the edit form can open already filled in with what they said last
    time instead of a blank form that would create a second review record
    the unique constraint then rejects.
    """
    product = db.query(Product).filter(Product.id == product_id).first()
    if product is None:
        raise HTTPException(404, "No such product")
    reviews = (db.query(ProductReview)
              .filter(ProductReview.product_id == product_id)
              .order_by(ProductReview.updated_at.desc()).all())
    mine = next((r for r in reviews if r.reviewer == caller.name), None)
    return {
        "product_id": product_id,
        "canonical_name": product.canonical_name,
        "community_rating": product.community_rating,
        "community_review_count": product.community_review_count,
        "reviews": [_review_out(r) for r in reviews],
        "my_review": _review_out(mine) if mine else None,
    }


@router.post("/products/{product_id}/review", response_model=dict)
def submit_review(product_id: int, body: ReviewIn, db: Session = Depends(get_db),
                  caller: User = Depends(current_user)):
    """Give a bottle a score, and optionally say why - submitting again
    updates the caller's own review rather than adding a second one, so the
    community average reflects one opinion per person, however many times
    they refine it.
    """
    product = db.query(Product).filter(Product.id == product_id).first()
    if product is None:
        raise HTTPException(404, "No such product")

    row = (db.query(ProductReview)
          .filter(ProductReview.product_id == product_id,
                  ProductReview.reviewer == caller.name)
          .first())
    if row is None:
        row = ProductReview(product_id=product_id, reviewer=caller.name)
        db.add(row)
    row.score = body.score
    row.review_text = (body.review_text or "").strip() or None
    row.style = (body.style or "").strip() or None
    row.body = (body.body or "").strip() or None
    row.tasting_notes = (body.tasting_notes or "").strip() or None
    for dim in TASTE_DIMENSIONS:
        setattr(row, dim, getattr(body, dim))
    db.commit()
    db.refresh(row)

    _recompute_product_aggregate(db, product_id)
    db.refresh(product)

    return {
        "review": _review_out(row),
        "community_rating": product.community_rating,
        "community_review_count": product.community_review_count,
    }


@router.get("/profile", response_model=dict)
def profile(names: str = "", db: Session = Depends(get_db),
           caller: User = Depends(current_user)):
    """Stage 2: a preference profile derived entirely from what this person
    (or, with `names`, this set of people) has actually bought - see
    _user_profile for how every field is computed and why nothing here is
    typed in by hand.
    """
    people_names = [n for n in (names or "").split(",") if n.strip()]
    return _user_profile(db, caller, people_names)


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
        ] + [
            # Every other published size, in one card - 90ml nips up to a
            # 4.5 litre jeroboam, none of them an "evening" size on their
            # own but all of them real, priced rows otherwise unreachable
            # from this picker.
            {"value": "other", "name": "Other", "hint": "any other published size"},
            {"value": "beer", "name": "Beer", "hint": "by the bottle"},
        ],
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

    # Global search turns up the same bottle once per state it's priced in -
    # a retail catalogue's "Bushmills 12 Years Old" and Delhi's official
    # "Bushmills Triple Distilled Aged 12 Years Single Malt Rare Irish
    # Whisky" used to read as two different results, each with its own
    # compare strip showing a dash for the other's state. _same_bottle
    # already recognises them as one bottle for the strip - the same check
    # groups them into one card here too, so a global search shows one row
    # per bottle, not one per state's own spelling of it.
    #
    # Delhi's is the state whose list this app treats as most authoritative
    # (a live government feed, parsed in full - see delhi_prices.py), so a
    # merged group displays under Delhi's name and price when Delhi is one of
    # the states that has it, falling back to the shortest name otherwise -
    # the same "shortest wins" rule brand_names.display uses elsewhere.
    groups: list[list[tuple[str, Bottle]]] = []
    for st, b in hits:
        for g in groups:
            rst, rb = g[0]
            if rb.kind == b.kind and rb.size_ml == b.size_ml and _same_bottle(rb.brand, b.brand):
                g.append((st, b))
                break
        else:
            groups.append([(st, b)])

    def _representative(group: list[tuple[str, Bottle]]) -> tuple[str, Bottle]:
        delhi = [x for x in group if x[0] == "Delhi"]
        pool = delhi if delhi else group
        return min(pool, key=lambda x: len(x[1].brand))

    results = []
    for group in groups[:25]:
        st, b = _representative(group)
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
        "truncated": len(groups) > len(results),
    }


def _catalog_for(state: str, known_states: list[str],
                 tables: dict[str, list[Bottle]]) -> list[Bottle]:
    """Every bottle this app knows of, priced for `state` where it is sold
    there, and at the cheapest price anyone else charges for it otherwise.

    A single state's own price list used to be the whole catalogue: a bottle
    Uttar Pradesh sells but Delhi's list has never heard of simply did not
    exist when Delhi was selected, however good a fit its price was for the
    budget. That is a filter nobody asked for - state pricing is real and
    worth keeping, but "does this bottle even show up" should not depend on
    which state happened to be selected.

    The first version of this clustered every bottle from every state into
    one product up front, before knowing which state was even being asked
    about - a fair-sounding idea that was quadratic in the size of the whole
    catalogue: comparing every bottle against every other bottle it might be
    a spelling of, over four million word-set comparisons and upwards of ten
    seconds for one request, run again from scratch for every state in "all
    states" mode.

    This only has to answer a much smaller question: which of everyone
    else's bottles does `state` not already have an equivalent of. Checked
    with _find_in against `state`'s own list - the same per-size lookup the
    compare strip already relies on - not against every other bottle from
    every other state. What's left after that (typically a few hundred rows,
    not the whole catalogue) is small enough that clustering spellings of the
    same missing product together - two other states can both be missing the
    same bottle, spelled differently - costs nothing worth measuring.

    A returned row's own `.state` field says where its price actually came
    from, which is what lets a card say "not listed in Delhi, priced from
    Uttar Pradesh" rather than presenting a borrowed price as native - see
    _pick and _beers, which surface `b.state != state` as `is_price_fallback`.
    """
    own = tables.get(state, [])
    own_by_size = _by_size(own)

    missing: dict[tuple[str, int], list[Bottle]] = defaultdict(list)
    for s in known_states:
        if s == state:
            continue
        for b in tables.get(s, []):
            if _find_in(own_by_size.get(b.size_ml, []), b.brand) is None:
                missing[(b.kind, b.size_ml)].append(b)

    fallback: list[Bottle] = []
    for rows in missing.values():
        for g in _cluster_bottles(rows):
            fallback.append(min(g, key=lambda b: b.mid))

    return own + fallback


def _cluster_bottles(bottles: list[Bottle]) -> list[list[Bottle]]:
    """Group bottles that are the same product under different states'
    spellings, without comparing every pair against every other pair.

    _catalog_for's docstring already covers why the naive version of this -
    a new bottle compared against every group formed so far - is quadratic
    and was the whole reason that function exists. The "missing" set it
    calls this on is meant to be small, but "small" still meant several
    hundred rows for a wide-open request (any size, any kind), which was
    still enough naive comparisons to be the dominant cost on a CPU as
    constrained as Render's free tier, even though it looked instant on a
    dev machine.

    Indexed the same way _BottleIndex looks up a single bottle: only
    compare a new bottle against groups that already contain a bottle
    sharing at least one of its significant words, not every group formed
    so far. "Chivas Regal 12" only ever gets compared against groups
    containing "chivas", "regal" or "12" - never against an unrelated
    whisky's group, however many of those exist.
    """
    groups: list[list[Bottle]] = []
    by_word: dict[str, list[int]] = defaultdict(list)
    for b in bottles:
        words = [w for w in _brand_key(b.brand).split()
                if w not in _AGE_FILLER and w not in GENERIC_WORDS]
        candidates: set[int] = set()
        for w in words:
            candidates.update(by_word.get(w, ()))
        match = next((gi for gi in candidates
                     if _same_bottle(groups[gi][0].brand, b.brand)), None)
        if match is None:
            groups.append([b])
            match = len(groups) - 1
        else:
            groups[match].append(b)
        for w in words:
            by_word[w].append(match)
    return groups


def _recommend_for_state(
    state: str, known_states: list[str], tables: dict[str, list[Bottle]],
    by_state: dict, sizes: tuple[int, ...], want_beer: bool,
    want_spirits: bool, kinds: tuple[str, ...], budget_min: float,
    budget_max: float, people: int, hist: dict,
    products_by_name: dict | None = None,
) -> dict | None:
    """Everything about a recommendation that actually varies by state.

    Pulled out of the endpoint so "one state" and "every state at once" run
    the identical picking logic rather than a second, easily-diverging copy
    of it. Returns None only when the catalogue is entirely empty, which an
    all-states request simply leaves out rather than failing the whole page
    over one gap - the caller validates the state name itself before this is
    reached (see recommend()), so that is no longer this function's job.
    """
    # This state's own list only. A cross-state fallback used to fill this
    # in - a bottle Uttar Pradesh sells but Delhi's own list never carried
    # would still show up, priced at whatever the cheapest other state
    # charged - but that meant a Delhi recommendation could suggest a
    # bottle nobody in Delhi can actually walk into a shop and buy. This
    # only ever shows what the selected state genuinely stocks; the
    # comparison strip below still shows what other states charge for the
    # same bottle, which is the cross-state information actually worth
    # keeping.
    bottles = tables.get(state, [])
    if not bottles:
        return None

    # Every state we have prices for, the one you asked about first. Three NCR
    # columns answered "is it cheaper over the border" for somebody in Delhi
    # and nothing for anybody else - a UP price never saw MP, though that is
    # the comparison worth making. Capped at MAX_COMPARE_REGIONS for
    # readability - a strip of ten columns is unreadable on a phone.
    regions = _regions_for(state)
    tables_by_size = {r: _by_size(tables.get(r, [])) for r in regions}

    picks = (_pick(bottles, budget_min, budget_max, people, sizes,
                   hist["favourites"], hist["brand_avg"], tables_by_size, regions,
                   hist["brand_last"], kinds, state=state,
                   products_by_name=products_by_name)
             if want_spirits else [])
    beers = (_beers(bottles, budget_min, budget_max, people, hist["favourites"],
                    hist["brand_avg"], hist["brand_last"], tables_by_size, regions,
                    state=state, products_by_name=products_by_name)
             if want_beer else [])

    size_available = any(
        (want_beer and b.kind == "beer")
        or (want_spirits and b.size_ml in sizes and b.kind in BOTTLE_KINDS
            and (not kinds or b.kind in kinds))
        for b in bottles
    )

    return {
        "regions": list(regions),
        "picks": picks,
        "price_band": _band(bottles, sizes, want_beer, want_spirits, kinds),
        "your_entries": _your_entries(by_state.get(state, []), sizes,
                                      want_beer, want_spirits,
                                      budget_min, budget_max),
        "size_available": size_available,
        "beers": beers,
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
    # nobody chose. "other" has no single ml value to report - it is a
    # category of sizes, not one of them - so it is kept out of `cards`
    # (a list of literal millilitre numbers) and handled separately below.
    cards = [int(p) for p in picked if p not in ("beer", "other")]
    bottle_ml = cards[0] if len(cards) == 1 and "other" not in picked else 0

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
    # A state nobody published but somebody entered a price for is a real
    # state - see meta(). Included here for the same reason: a bottle typed
    # in against it should still be part of the catalogue everyone else's
    # recommendation can borrow a fallback price from.
    known_states = sorted(set(STATES) | set(by_state))
    is_all = state.strip().lower() == "all"
    if not is_all and state not in known_states:
        raise HTTPException(
            404,
            f"No published prices for {state} yet — we only have "
            f"{', '.join(known_states)}. Prices are set per state, so "
            f"guessing one from another would be wrong.",
        )
    # Every state's own table, built once regardless of how many states this
    # request ends up looking at - "all states" used to mean rebuilding this
    # from scratch once per state.
    tables = {
        s: _apply_overrides(for_state(s), by_state.get(s, []), s) for s in known_states
    }
    products_by_name = _products_by_name()

    # Fetched once and handed to both _history and learned() below, which
    # each used to run their own separate `db.query(Group).all()` - three
    # copies of the same fetch in one request, each one costing several
    # queries rather than one since Group's members/expenses/payments are
    # eager (lazy="selectin") relationships. by_state already holds every
    # PriceOverride row too (see _overrides_by_state above), so _history's
    # own separate fetch of the same table is skipped the same way.
    all_groups = db.query(Group).all()
    all_overrides = [r for rows in by_state.values() for r in rows]

    people_names = [n for n in (names or "").split(",") if n.strip()]
    hist = _history(db, caller, people_names, groups=all_groups,
                    price_overrides=all_overrides)
    # Shared across every state - what you have actually bought before, and
    # what you paid for it, is a property of you, not of a price list.
    learned_drinks = learned(
        db, DRINK, [g.id for g in all_groups if is_member(g, caller)],
        budget_min, budget_max,
    )

    shared = {
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
                            + (["other sizes"] if "other" in picked else [])
                            + (["beer"] if want_beer else []))
        ),
        "history": hist,
        "learned": learned_drinks,
        "is_any": is_any,
        "sources": SOURCES,
        "abv_sources": ABV_SOURCES,
    }

    # "All states at once": the same picks, run independently per state and
    # handed back grouped rather than merged into one list - price is a
    # per-state fact, so a single ranked list would have to pretend a bottle
    # has one price when it genuinely does not. Every other field the page
    # needs (budget, kinds, sizes, history) is identical across states, so
    # only the parts that actually vary by state get nested.
    if is_all:
        by_state_results = {}
        for st in known_states:
            per_state = _recommend_for_state(
                st, known_states, tables, by_state, sizes, want_beer, want_spirits,
                kinds, budget_min, budget_max, people, hist,
                products_by_name=products_by_name,
            )
            if per_state is not None:
                by_state_results[st] = per_state
        return {
            **shared,
            "state": "all",
            "is_all": True,
            "states_searched": known_states,
            "ncr": list(NCR),
            "by_state": by_state_results,
        }

    per_state = _recommend_for_state(
        state, known_states, tables, by_state, sizes, want_beer, want_spirits,
        kinds, budget_min, budget_max, people, hist,
        products_by_name=products_by_name,
    )
    if per_state is None:
        # Only reachable if the whole catalogue is empty, since `state` was
        # already validated above - see known_states.
        raise HTTPException(404, f"No prices known anywhere yet for {state}.")

    return {
        **shared,
        "state": state,
        "is_all": False,
        "ncr": list(NCR),
        **per_state,
    }

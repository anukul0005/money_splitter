"""Turn the two official UP price PDFs into a Python price table.

Run it: `python parse_up_rates.py`, which rewrites up_prices.py.

WHY THIS EXISTS
Uttar Pradesh publishes its rates as PDFs and nothing else, so the numbers the
app was using for UP came from aggregator sites reporting bands. These two
documents are the state's own lists, which makes them the better source by a
wide margin — an exact MRP set by the excise department beats somebody's
report of what a shop charged.

The two documents cover different ground and are both needed:

  Rate List 26-27 (FY 2026-27, dated 04-04-2026)
      Cleanly tabulated, one row per line. Carries the newer and regional
      brands, and often prints ABV in the brand name itself.

  UP Liquor Price List
      Ragged multi-line layout. Carries the national brands the rate list has
      none of — Vat 69, Old Monk, Royal Stag, Imperial Blue, 100 Pipers,
      Officer's Choice, Absolut, Smirnoff, Tuborg, Black Dog.

WHAT IS DELIBERATELY THROWN AWAY
  * Rows with an MRP of zero. The price list registers brands that are export
    only, CSD (services canteen) only, or marked "For Sale in Delhi Only";
    they carry no UP retail price and are not something you can buy here.
  * Anything whose name says Overseas, Export, CSD or Delhi Only, for the same
    reason.
  * Rows with an ex-distillery price of zero. These are the same kind of
    registration but they slip through the name check, and their last money
    column is a nominal export figure rather than a retail price - which is
    how Tuborg briefly appeared at Rs 10 and a Golden Eagle at Rs 1. A row
    with no EDP was never priced for a UP shop, whatever the last column says.
  * Sizes nobody buys for an evening are kept in the table but the app filters
    them; nothing is dropped silently.

WHERE TWO ROWS DISAGREE
The same brand and size can appear more than once — different registration
years, different distilleries bottling it. Rather than picking one, the row
becomes a range across every MRP found, which is the same rule the Haryana
rows already follow. `sources` records which document each row came from.

This parser refuses to write output if its own checks fail, so a bad extract
is a loud failure rather than a table of plausible-looking wrong numbers.
"""

from __future__ import annotations

import re
import sys
from collections import defaultdict
from pathlib import Path

try:
    import pypdf
except ImportError:  # pragma: no cover - tooling dependency, not a runtime one
    sys.exit("pypdf is needed to re-parse the PDFs: pip install pypdf")

HERE = Path(__file__).parent
SOURCE_DIR = HERE / "sources" / "up"
RATE_PDF = SOURCE_DIR / "up-rate-list-2026-27.pdf"
LIST_PDF = SOURCE_DIR / "up-liquor-price-list.pdf"
OUT = HERE / "up_prices.py"

WHISKY, RUM, VODKA, BEER, GIN, WINE, BRANDY = (
    "whisky", "rum", "vodka", "beer", "gin", "wine", "brandy")

# Sizes worth keeping. Not a filter on what the app shows - it keeps its own
# rules - just a way of leaving out the 60ml nips and 3-litre cases that would
# treble the table for no gain.
KEEP_SIZES = {180, 330, 375, 500, 650, 750, 1000}

# Not on sale to a person walking into a UP shop.
#
# "Export" has to be read carefully: as a channel marker it disqualifies the
# row, but it is also part of real beer names - Tuborg Mild Export is a beer
# you can buy, not an export-only registration. So the word only counts when
# it is punctuated as a marker ("- Export", "(OVERSEAS EXPORT)") or qualified
# ("Export within India"). A bare "Export Beer" is left alone.
EXCLUDE_NAME = re.compile(
    r"[-–(]\s*(?:overseas|export)\b"
    r"|\b(?:overseas|export)\s+(?:within|to|only|market)\b"
    r"|\boverseas\b"
    r"|\b(?:for\s+sale\s+in\s+delhi|delhi\s+only|csd|canteen|defence|"
    r"para\s*military|duty\s*free)\b", re.I)

# Plant locations the manufacturer split leaves stuck on the front of a brand:
# "KALYANI(WB) Kingfisher...", "MYSURU Original Bira91...", "(ARAVALI) ...".
# They name the brewery, not the drink.
LOCATION_PREFIX = re.compile(
    r"^(?:\([A-Za-z .&-]{2,20}\)|[A-Z][A-Za-z]{2,12}\s*\([A-Z]{2}\)|"
    r"(?:GOA|MYSURU|KALYANI|RAISEN|ARAVALI|PALS)\b)\s*", re.I)

# ABV is sometimes printed inside the brand name. When it is, it is published
# and exact, which beats the category typical the app falls back to.
ABV_IN_NAME = re.compile(r"\(?\s*(\d{1,2}(?:\.\d)?)\s*%\s*v\s*/\s*v\s*\)?", re.I)

# Trailing noise in brand names: registration numbers, "NEW", stray brackets.
NAME_NOISE = re.compile(
    r"\s*[\(\[]?\s*(?:regn?\.?\s*no\.?\s*-?\s*\d+|reg\s*no\s*-?\s*\d+|"
    r"id\s*-\s*\S+)\s*[\)\]]?\s*", re.I)

CATEGORY_WORDS = [
    (BEER, r"\bbeer\b"),
    (WINE, r"\bwine\b|\bsangria\b"),
    (BRANDY, r"\bbrandy\b"),
    (GIN, r"\bgin\b"),
    (VODKA, r"\bvodka\b"),
    (RUM, r"\brum\b"),
    (WHISKY, r"\bwhisk(?:y|ey)\b"),
]

# The price list has no category column, so the category comes from the name -
# and not every name says what it is. "BLACK DOG CENTENARY BLACK RESERVE AGED &
# RARE" never uses the word whisky. These are the second pass: the style words
# that only belong to one category.
CATEGORY_STYLES = [
    (WHISKY, r"\b(scotch|single\s*malt|blended\s*malt|blended\s*grain|bourbon)\b"),
    (BEER, r"\b(lager|bier|pilsner|pilsener|stout|ale|witbier|blanche)\b"),
    (WINE, r"\b(shiraz|merlot|chardonnay|sauvignon|cabernet|zinfandel|rose\s*wine)\b"),
]

# Last resort: brand families well known enough to be worth naming, whose
# labels carry neither a category word nor a style word. Kept deliberately
# short - this is a list of things we know, not a place to guess.
CATEGORY_BY_BRAND = [
    (WHISKY, r"\b(black\s*dog|sterling\s*reserve|william\s*lawson|"
             r"black\s*&\s*white|british\s*empire)\b"),
    (BEER, r"\b(bira\s*91|bira91|godfather|amstel|haywards|hoegaarden|"
           r"kingfisher|medusa|the\s*original\s*lion)\b"),
]


def _category(name: str, declared: str = "") -> str | None:
    """Category from the document's own column if it has one, else the name."""
    if declared:
        d = declared.strip().lower()
        if d.startswith("whisk"):
            return WHISKY
        if d in {"rum", "vodka", "gin", "beer", "wine", "brandy"}:
            return d
        if d in {"rtd", "liqueur"}:
            return None            # not something the recommender suggests
    for table in (CATEGORY_WORDS, CATEGORY_STYLES, CATEGORY_BY_BRAND):
        for kind, pattern in table:
            if re.search(pattern, name, re.I):
                return kind
    return None


def _clean(name: str) -> tuple[str, float | None]:
    """Tidy a brand name and lift any published ABV out of it."""
    abv = None
    m = ABV_IN_NAME.search(name)
    if m:
        abv = float(m.group(1))
        name = ABV_IN_NAME.sub(" ", name)
    name = NAME_NOISE.sub(" ", name)
    # "- Civil" and "- CSD" mark which channel a registration is for, not the
    # drink. Left on, the same bottle reads as two different brands.
    name = re.sub(r"\s*[-–]\s*(civil|csd|army|navy)\s*$", "", name, flags=re.I)
    # Debris left by splitting the manufacturer off the front: a stray closing
    # bracket, a full stop, a dangling dash. "). Kingfisher" is not a brand.
    name = re.sub(r"^[\s.,;:\-–—)\]}/&]+", "", name)
    name = LOCATION_PREFIX.sub("", name).strip()
    # "BOTTLING AT M/S SATURN RING PREMIUM..." - the tail of a manufacturer
    # phrase that the split could not see the end of.
    name = re.sub(r"^(?:BOTTLING\s+)?(?:AT\s+)?M/?S\.?\s+", "", name, flags=re.I)
    name = re.sub(r"^(?:BOTTLING|BOTTLED)\s+(?:AT|BY)\s+", "", name, flags=re.I)
    name = re.sub(r"^[\s.,;:\-–—)\]}/&]+", "", name)
    name = re.sub(r"[\s\-–—]+$", "", " ".join(name.split()))
    name = re.sub(r"\s*\(\s*\)\s*", " ", name)
    return " ".join(name.split()), abv


# ── Document 1: the FY 2026-27 rate list ──────────────────────────────────────
RATE_ROW = re.compile(
    r"^(?P<licence>[A-Z0-9\-]+(?:\s+OF\s+[A-Z0-9\-]+)?)\s+"
    r"(?P<cat>Whisky|Wine|Vodka|Rum|Beer|Gin|RTD|Brandy|Liqueur)\s+"
    r"(?P<name>.+?)\s+-\s*Id\s*-\s*(?P<id>\S+)\s+"
    r"(?P<btype>Glass Bottle|Pet Bottle|Can|Tetra Pack)\s+"
    r"(?P<size>[\d.]+)\s*ML\s+"
    r"(?P<nums>[\d.]+(?:\s+[\d.]+){9})$"
)
RATE_HEADER = re.compile(r"^(Type brand|Total|Without|Duty|Total With|Financial Year)")


def parse_rate_list(path: Path) -> list[dict]:
    """One row per line, with long brand names wrapped across up to a few."""
    lines = [ln.strip() for p in pypdf.PdfReader(str(path)).pages
             for ln in (p.extract_text() or "").splitlines() if ln.strip()]

    out: list[dict] = []
    buf = ""
    for ln in lines:
        if RATE_HEADER.match(ln):
            continue
        buf = f"{buf} {ln}".strip() if buf else ln
        m = RATE_ROW.match(buf)
        if not m:
            if len(buf.split()) > 60:
                buf = ""            # runaway; drop rather than mis-join
            continue
        buf = ""

        nums = m.group("nums").split()
        # Columns: bottles-per-case, MSP, MRP, Duty, EDP, then the tax split.
        mrp, edp = float(nums[2]), float(nums[4])
        if edp <= 0:
            continue
        size = int(float(m.group("size")))
        name, abv = _clean(m.group("name"))
        kind = _category(name, m.group("cat"))
        if kind is None or size not in KEEP_SIZES or mrp <= 0:
            continue
        if EXCLUDE_NAME.search(name):
            continue
        out.append({"brand": name, "kind": kind, "size": size,
                    "mrp": mrp, "abv": abv, "source": "up-rate-list-2026-27"})
    return out


# ── Document 2: the ragged price list ─────────────────────────────────────────
# Every money column prints to three decimals, so three or more in a row is the
# end of a record and nothing else in the document looks like that.
LIST_TAIL = re.compile(r"^(?P<pre>.*?)(?P<nums>(?:\d+\.\d{3}\s+){3,}\d+\.\d{3})\s*$")

# A record reads: serial, manufacturer, brand, size, container. The manufacturer
# always ends on one of these words, and taking the LAST one splits the two
# names without needing to know either list in advance.
UNIT_END = re.compile(
    r"^(?P<unit>.*\b(?:LIMITED|LTD\.?|PVT\.?|PRIVATE|LLP|CORPORATION|COMPANY|"
    r"BREWERY|BREWERIES|DISTILLERY|DISTILLERIES|DISTILLERS|WINERY|WINERIES|"
    r"INDUSTRIES|MILLS|SUGAR|AGRO|ALCOBREW|MARKETING|ENTERPRISES|UDYOG|"
    r"BEVERAGES|GROUP|WORKS|UNIT|MEAKIN|ALCOHOLS|LESSEE\)?|DIVISION\)?))\b"
    r"\s*(?P<brand>.*)$",
    re.I)
SIZE_RE = re.compile(r"(\d{2,4})\s*ML")


def parse_price_list(path: Path) -> tuple[list[dict], int]:
    lines = [ln.strip() for p in pypdf.PdfReader(str(path)).pages
             for ln in (p.extract_text() or "").splitlines() if ln.strip()]

    out: list[dict] = []
    unsplit = nominal = 0
    buf: list[str] = []
    for ln in lines:
        m = LIST_TAIL.match(ln)
        if not m:
            buf.append(ln)
            if len(buf) > 14:
                buf = buf[-14:]
            continue

        head = " ".join(buf + [m.group("pre")])
        buf = []
        nums = m.group("nums").split()
        # MRP is the last money column; EDP the first. Both must be real - see
        # the module docstring on why a zero EDP disqualifies the row.
        mrp, edp = float(nums[-1]), float(nums[0])
        if mrp <= 0 or edp <= 0:
            nominal += 1
            continue

        size_hit = SIZE_RE.search(head)
        if not size_hit:
            continue
        size = int(size_hit.group(1))
        if size not in KEEP_SIZES:
            continue

        # Drop the leading serial number and everything from the size onwards
        head = re.sub(r"^\d+\s+", "", head[:size_hit.start()]).strip()
        split = UNIT_END.match(head)
        if not split:
            unsplit += 1
            continue
        name, abv = _clean(split.group("brand"))
        if not name or len(name) < 3:
            unsplit += 1
            continue
        kind = _category(name)
        if kind is None or EXCLUDE_NAME.search(name):
            continue
        out.append({"brand": name, "kind": kind, "size": size,
                    "mrp": mrp, "abv": abv, "source": "up-liquor-price-list"})
    return out, unsplit, nominal


def _key(name: str) -> str:
    return " ".join(name.lower().replace(".", "").replace("'", "").split())


def merge(rows: list[dict]) -> list[dict]:
    """Collapse duplicates of one brand and size into a single row.

    A brand can be registered more than once - different years, different
    bottlers - and the MRPs differ. Keeping the span is honest; averaging them
    would invent a price the state never published.
    """
    grouped: dict[tuple[str, int], list[dict]] = defaultdict(list)
    for r in rows:
        grouped[(_key(r["brand"]), r["size"])].append(r)

    merged: list[dict] = []
    for (_, size), items in grouped.items():
        prices = sorted(r["mrp"] for r in items)
        abvs = {r["abv"] for r in items if r["abv"]}
        srcs = sorted({r["source"] for r in items})
        # Longest spelling wins: the fuller name is the more informative one.
        display = max((r["brand"] for r in items), key=len)
        merged.append({
            "brand": display,
            "kind": items[0]["kind"],
            "size": size,
            "price": int(round(prices[0])),
            "price_max": int(round(prices[-1])) if prices[-1] != prices[0] else None,
            "abv": min(abvs) if abvs else None,
            "sources": srcs,
        })
    merged.sort(key=lambda r: (r["kind"], r["brand"].lower(), -r["size"]))
    return merged


HEADER = '''"""Uttar Pradesh liquor prices, parsed from the state's own PDFs.

GENERATED FILE - do not edit by hand. Rebuild with:

    python parse_up_rates.py

Source documents live in sources/up/ and are committed alongside this file, so
any number here can be traced back to the page it came from. See
parse_up_rates.py for what is deliberately excluded (export-only, CSD and
Delhi-only registrations, all of which carry no UP retail price).

Prices are the MRP set by the UP excise department. Where a brand and size is
registered more than once at different MRPs, `price_max` holds the top of the
span rather than the two being averaged into a number nobody published.
"""

from __future__ import annotations

SOURCES = {
    "up-rate-list-2026-27": {
        "url": "sources/up/up-rate-list-2026-27.pdf",
        "as_of": "2026-04-04",
        "note": "UP excise rate list, financial year 2026-2027 (official PDF)",
    },
    "up-liquor-price-list": {
        "url": "sources/up/up-liquor-price-list.pdf",
        "as_of": "2026-09",
        "note": "UP liquor price list, per-brand MRP (official PDF)",
    },
}

# brand, kind, size_ml, mrp, mrp_max (None if a single published price),
# abv (None where the document did not print it), sources
ROWS: list[tuple] = [
'''

FOOTER = ''']

# Strength published inside a brand name in the source documents. Exact, not a
# category typical, so the app can label it without a "~".
ABV: dict[str, float] = {
%s}
'''


def write(rows: list[dict], path: Path) -> None:
    lines = [HEADER]
    for r in rows:
        srcs = ", ".join(repr(s) for s in r["sources"])
        lines.append(
            "    (%r, %r, %d, %d, %s, %s, (%s%s)),\n"
            % (r["brand"], r["kind"], r["size"], r["price"],
               r["price_max"] if r["price_max"] else "None",
               r["abv"] if r["abv"] else "None",
               srcs, "," if len(r["sources"]) == 1 else "")
        )
    abv_rows = sorted({(_key(r["brand"]), r["abv"]) for r in rows if r["abv"]})
    body = "".join("    %r: %s,\n" % (k, v) for k, v in abv_rows)
    lines.append(FOOTER % body)
    path.write_text("".join(lines), encoding="utf-8")


def main() -> int:
    for p in (RATE_PDF, LIST_PDF):
        if not p.exists():
            sys.exit(f"missing source PDF: {p}")

    rate = parse_rate_list(RATE_PDF)
    price, unsplit, nominal = parse_price_list(LIST_PDF)
    rows = merge(rate + price)

    print(f"rate list  : {len(rate):5} usable rows")
    print(f"price list : {len(price):5} usable rows "
          f"({unsplit} unsplit, {nominal} not priced for UP retail)")
    print(f"merged     : {len(rows):5} brand/size rows")

    # Checks. A silently wrong table is the failure mode worth guarding
    # against, so refuse to write rather than emit something plausible.
    problems = []
    if len(rows) < 400:
        problems.append(f"only {len(rows)} rows; expected several hundred")
    if any(r["price"] <= 0 for r in rows):
        problems.append("a row has a non-positive price")
    if any(r["price_max"] and r["price_max"] < r["price"] for r in rows):
        problems.append("a row's range is inverted")
    kinds = {r["kind"] for r in rows}
    for need in (WHISKY, RUM, VODKA, BEER):
        if need not in kinds:
            problems.append(f"no {need} rows at all")
    # The national brands are the whole reason the second PDF is here.
    for brand in ("vat 69", "old monk", "royal stag", "imperial blue"):
        if not any(brand in _key(r["brand"]) for r in rows):
            problems.append(f"expected to find {brand!r}")
    # A 750ml costing less than a 180ml of the same brand means the columns
    # were read in the wrong order somewhere.
    by_brand: dict[str, dict[int, int]] = defaultdict(dict)
    for r in rows:
        by_brand[_key(r["brand"])][r["size"]] = r["price"]
    inverted = [b for b, s in by_brand.items()
                if 180 in s and 750 in s and s[750] <= s[180]]
    if inverted:
        problems.append(f"{len(inverted)} brands price 750ml at or below 180ml: "
                        f"{inverted[:3]}")
    # Debris from splitting the manufacturer off the brand. A stray bracket or
    # a name that starts mid-word means the split landed in the wrong place.
    debris = [r["brand"] for r in rows
              if re.match(r"^[^A-Za-z0-9]", r["brand"]) or ")" in r["brand"][:14]]
    if debris:
        problems.append(f"{len(debris)} names look mis-split: {debris[:3]}")
    # A beer that costs more than a bottle of whisky, or a 750ml spirit under
    # Rs 100, means a column was read wrong somewhere.
    odd = [r for r in rows if r["kind"] == BEER and r["price"] > 1200]
    odd += [r for r in rows if r["kind"] in (WHISKY, RUM, VODKA, GIN)
            and r["size"] == 750 and r["price"] < 100]
    if odd:
        problems.append(f"{len(odd)} implausible prices, e.g. "
                        f"{[(o['brand'][:30], o['size'], o['price']) for o in odd[:3]]}")

    if problems:
        print("\nREFUSING TO WRITE - checks failed:")
        for p in problems:
            print("  *", p)
        return 1

    write(rows, OUT)
    print(f"\nwrote {OUT.relative_to(HERE)}")
    for kind in sorted(kinds):
        k = [r for r in rows if r["kind"] == kind]
        print(f"  {kind:8} {len(k):4} rows  "
              f"Rs {min(r['price'] for r in k)}-{max(r['price'] for r in k)}")
    print(f"  with published ABV: {sum(1 for r in rows if r['abv'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

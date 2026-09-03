"""Turn the official state price PDFs into one Python price table.

Run it: `python parse_state_rates.py`, which rewrites state_prices.py.

WHAT THE SOURCES ACTUALLY ARE
There are two, and which state each belongs to was got wrong once, so it is
worth stating precisely.

  sources/mp/mp-rate-list-2026-27.pdf   -> Madhya Pradesh
      A cleanly tabulated rate list for FY 2026-27, one row per line, 1337 of
      them. Often prints ABV inside the brand name.

  sources/up/up-liquor-price-list.pdf   -> Uttar Pradesh
      Ragged multi-line layout, per-brand MRP. Carries the national brands the
      MP list has none of - Vat 69, Old Monk, Royal Stag, Imperial Blue,
      100 Pipers, Officer's Choice, Absolut, Smirnoff, Tuborg, Black Dog.

An earlier build filed the rate list under Uttar Pradesh because that is what
the folder said. It is Madhya Pradesh. The evidence is unambiguous: it agrees
with the MP list on 736 of 736 rows keyed by registration id and size, and it
disagrees with the UP price list on every single brand the two share -
Whistler 750ml is Rs 1,575 in one and Rs 910 in the other. Alcohol is a state
subject; two states agreeing to the rupee on hundreds of registrations does
not happen, and identical registration ids across a whole document mean one
document. Neither PDF names its own state anywhere, which is how the mistake
survived. Cross-checking two sources against each other is what caught it.

WHAT IS DELIBERATELY THROWN AWAY
  * Rows with an MRP of zero, or an ex-distillery price of zero. Both mark a
    registration that is export-only, CSD-only or for sale in another state;
    their last money column is a nominal figure rather than a retail price,
    which is how Tuborg briefly appeared at Rs 10 and a beer at Rs 1.
  * Anything whose name marks it as Overseas, Export-to, CSD or Delhi-only.
    "Export" alone is not enough - Tuborg Mild Export Beer is a beer you can
    buy, so the word only counts when punctuated as a channel marker.

WHERE TWO ROWS DISAGREE
The same brand and size can be registered more than once in one state, at
different MRPs. Rather than picking one, the row keeps the span. `sources`
records which document each row came from.

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
MP_PDF = HERE / "sources" / "mp" / "mp-rate-list-2026-27.pdf"
UP_PDF = HERE / "sources" / "up" / "up-liquor-price-list.pdf"
OUT = HERE / "state_prices.py"

MP, UP = "Madhya Pradesh", "Uttar Pradesh"

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
    r"(?:GOA|MYSURU|KALYANI|RAISEN|ARAVALI|PALS|REWARI|HARYANA|RAJASTHAN|"
    r"MAHARASHTRA|PUNJAB|MH|RJ|HR|PB|UP|MP|WB|TN|KA|AP)\b)\s*", re.I)

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


def _fix_glyphs(name: str) -> str:
    """Repair the typography the PDFs encode badly.

    Both documents set possessives with a curly apostrophe that does not
    survive extraction, leaving "SEAGRAM<?>S" and "WILLIAM LAWSON<?>S". A
    replacement character followed by an S is that apostrophe every time it
    appears here, so it is restored; any other stray one is dropped rather
    than guessed at.
    """
    # Mojibake: parts of the MP list are UTF-8 read as Latin-1, so an
    # apostrophe arrives as three characters. Re-encoding undoes it exactly,
    # and is attempted only when the signature is present so a correctly
    # decoded name is never mangled by the repair itself.
    # Any non-ASCII is worth trying: matching on the damaged characters
    # themselves needs those exact bytes in this source file, and a literal
    # that was itself mangled once meant the repair never ran at all.
    if any(ord(c) > 127 for c in name):
        try:
            # cp1252, not latin-1. The euro and trademark signs this damage
            # produces are not in latin-1 at all, so encoding raised and the
            # repair silently gave up on exactly the names that needed it.
            name = name.encode("cp1252").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    # A lone "A-circumflex" is the same damage done to a non-breaking
    # space, but its trailing byte is already gone so re-encoding cannot
    # recover it. Here it only ever appears as that artefact, so it goes.
    name = name.replace('Â', ' ').replace(' ', ' ')
    name = name.replace(" ", " ")
    name = name.replace("’", "'").replace("‘", "'")
    name = name.replace("“", '"').replace("”", '"')
    name = re.sub(r"�(?=[Ss]\b)", "'", name)
    name = name.replace("�", "")
    # Region tags appended to a registration - "{MH}", "- HR". They mark where
    # a label is registered, not what is in the bottle.
    name = re.sub(r"\s*[{\[(]\s*[A-Z]{2}\s*[}\])]\s*", " ", name)
    name = re.sub(r"\s*-\s*(?:HR|MH|UP|MP|DL|PB|RJ|GA)\s*$", "", name, flags=re.I)
    return " ".join(name.split())


def _clean(name: str) -> tuple[str, float | None]:
    """Tidy a brand name and lift any published ABV out of it."""
    name = _fix_glyphs(name)
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
    # Repeated: a plant is written "REWARI HARYANA KINGFISHER ..." and one
    # pass removes only the town.
    for _ in range(3):
        shorter = LOCATION_PREFIX.sub("", name).strip()
        if not shorter or shorter == name:
            break
        name = shorter
    # "BOTTLING AT M/S SATURN RING PREMIUM..." - the tail of a manufacturer
    # phrase that the split could not see the end of.
    name = re.sub(r"^(?:BOTTLING\s+)?(?:AT\s+)?M/?S\.?\s+", "", name, flags=re.I)
    name = re.sub(r"^(?:BOTTLING|BOTTLED)\s+(?:AT|BY)\s+", "", name, flags=re.I)
    name = re.sub(r"^[\s.,;:\-–—)\]}/&]+", "", name)
    name = re.sub(r"[\s\-–—]+$", "", " ".join(name.split()))
    name = re.sub(r"\s*\(\s*\)\s*", " ", name)
    return " ".join(name.split()), abv


# ── Document 1: the FY 2026-27 rate list ──────────────────────────────────────
# The MP list carries a "Bio" column the other document has none of, so the
# numeric tail is eleven wide: bottles-per-case, MSP, MRP, Bio, Duty, EDP,
# 8% TF, Vat, TCS, purchase cost, total.
RATE_ROW = re.compile(
    r"^(?P<licence>[A-Za-z0-9\- ]+?)\s+"
    r"(?P<cat>Whisky|Wine|Vodka|Rum|Beer|Gin|RTD|Brandy|Liqueur)\s+"
    r"(?P<name>.+?)\s+-\s*Id\s*-\s*(?P<id>\S+)\s+"
    r"(?P<btype>Glass Bottle|Pet Bottle|Glass|Can|Pet|Tetra Pack)\s+"
    r"(?P<size>[\d.]+)\s*ML\s+"
    r"(?P<nums>[\d.]+(?:\s+[\d.]+){10})$"
)
RATE_HEADER = re.compile(
    r"^(Unit Type Brand|Type brand|Total|Without|Duty|Total With|Financial Year)")


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
        # bottles-per-case, MSP, MRP, Bio, Duty, EDP, then the tax split.
        mrp, edp = float(nums[2]), float(nums[5])
        if edp <= 0:
            continue
        size = int(float(m.group("size")))
        name, abv = _clean(m.group("name"))
        # "X Glass 90 ML 96 174 ... Spirit Whisky Y" is two rows the line
        # buffer joined because the first did not match on its own. A brand
        # name carrying its own size and price tail is always that, and is
        # dropped rather than stored as a brand nobody could ever match.
        if re.search(r"\d+\s*ML\b", name, re.I):
            continue
        kind = _category(name, m.group("cat"))
        if kind is None or size not in KEEP_SIZES or mrp <= 0:
            continue
        if EXCLUDE_NAME.search(name):
            continue
        out.append({"brand": name, "kind": kind, "size": size,
                    "mrp": mrp, "abv": abv, "source": "mp-rate-list-2026-27", "state": MP})
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
                    "mrp": mrp, "abv": abv, "source": "up-liquor-price-list", "state": UP})
    return out, unsplit, nominal


def _key(name: str) -> str:
    return " ".join(name.lower().replace(".", "").replace("'", "").split())


# Canonical naming lives in brand_names so the parser and the running app
# cannot drift apart on what a bottle is called.
from brand_names import canonicalise  # noqa: E402


def merge(rows: list[dict]) -> tuple[list[dict], dict[str, str]]:
    """One row per canonical brand, size and state.

    Two collapses happen here. Within a state, a brand registered more than
    once at different MRPs keeps the span rather than being averaged into a
    price nobody published. Across states, names referring to the same bottle
    are given one spelling - the prices stay separate, because the price is
    the only thing that legitimately varies by state.
    """
    canonical = canonicalise([(r["brand"], r["kind"]) for r in rows])

    grouped: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        name = canonical[(r["brand"], r["kind"])]
        grouped[(name, r["kind"], r["size"], r["state"])].append(r)

    merged: list[dict] = []
    for (name, kind, size, state), items in grouped.items():
        prices = sorted(r["mrp"] for r in items)
        abvs = {r["abv"] for r in items if r["abv"]}
        merged.append({
            "brand": name,
            "kind": kind,
            "size": size,
            "state": state,
            "price": int(round(prices[0])),
            "price_max": int(round(prices[-1])) if prices[-1] != prices[0] else None,
            "abv": min(abvs) if abvs else None,
            "sources": sorted({r["source"] for r in items}),
        })
    merged.sort(key=lambda r: (r["state"], r["kind"], r["brand"].lower(), -r["size"]))
    return merged, canonical


HEADER = '"""State liquor prices, parsed from the states\' own PDFs.\n\
\n\
GENERATED FILE - do not edit by hand. Rebuild with:\n\
\n\
    python parse_state_rates.py\n\
\n\
Source documents live in sources/ and are committed alongside this file, so\n\
any number here can be traced back to the page it came from. See\n\
parse_state_rates.py for which document belongs to which state, what is\n\
deliberately excluded, and how brand names are made consistent across states.\n\
\n\
Prices are the MRP set by that state. Where a brand and size is registered\n\
more than once in one state at different MRPs, `price_max` holds the top of\n\
the span rather than the two being averaged into a number nobody published.\n\
\n\
Brand names are canonical: the same bottle carries the same spelling in every\n\
state, so only the price varies.\n\
"""\n\
\n\
from __future__ import annotations\n\
\n\
SOURCES = {\n\
    "mp-rate-list-2026-27": {\n\
        "url": "sources/mp/mp-rate-list-2026-27.pdf",\n\
        "as_of": "2026-04-04",\n\
        "note": "Madhya Pradesh rate list, financial year 2026-2027 (official PDF)",\n\
    },\n\
    "up-liquor-price-list": {\n\
        "url": "sources/up/up-liquor-price-list.pdf",\n\
        "as_of": "2026-09",\n\
        "note": "Uttar Pradesh liquor price list, per-brand MRP (official PDF)",\n\
    },\n\
}\n\
\n\
# brand, kind, size_ml, state, mrp, mrp_max (None if a single published\n\
# price), abv (None where the document did not print it), sources\n\
ROWS: list[tuple] = [\n'

FOOTER = ']\n\
\n\
# Strength published inside a brand name in the source documents. Exact, not a\n\
# category typical, so the app can label it without a "~".\n\
ABV: dict[str, float] = {\n\
%s}\n'


def write(rows: list[dict], path: Path) -> None:
    lines = [HEADER]
    for r in rows:
        srcs = ", ".join(repr(s) for s in r["sources"])
        lines.append(
            "    (%r, %r, %d, %r, %d, %s, %s, (%s%s)),\n"
            % (r["brand"], r["kind"], r["size"], r["state"], r["price"],
               r["price_max"] if r["price_max"] else "None",
               r["abv"] if r["abv"] else "None",
               srcs, "," if len(r["sources"]) == 1 else "")
        )
    abv_rows = sorted({(_key(r["brand"]), r["abv"]) for r in rows if r["abv"]})
    body = "".join("    %r: %s,\n" % (k, v) for k, v in abv_rows)
    lines.append(FOOTER % body)
    path.write_text("".join(lines), encoding="utf-8")


def main() -> int:
    for f in (MP_PDF, UP_PDF):
        if not f.exists():
            sys.exit(f"missing source PDF: {f}")

    mp = parse_rate_list(MP_PDF)
    up, unsplit, nominal = parse_price_list(UP_PDF)
    rows, canonical = merge(mp + up)

    print(f"MP rate list   : {len(mp):5} usable rows")
    print(f"UP price list  : {len(up):5} usable rows "
          f"({unsplit} unsplit, {nominal} not priced for retail)")
    print(f"merged         : {len(rows):5} brand/size/state rows")
    print(f"canonical names: {len(set(canonical.values())):5} distinct products")

    problems = []
    if len(rows) < 800:
        problems.append(f"only {len(rows)} rows; expected well over a thousand")
    if any(r["price"] <= 0 for r in rows):
        problems.append("a row has a non-positive price")
    if any(r["price_max"] and r["price_max"] < r["price"] for r in rows):
        problems.append("a row's range is inverted")
    states = {r["state"] for r in rows}
    if states != {MP, UP}:
        problems.append(f"expected both states, got {states}")
    kinds = {r["kind"] for r in rows}
    for need in (WHISKY, RUM, VODKA, BEER):
        if need not in kinds:
            problems.append(f"no {need} rows at all")
    for brand in ("vat 69", "old monk", "royal stag", "imperial blue"):
        if not any(brand in _key(r["brand"]) for r in rows):
            problems.append(f"expected to find {brand!r}")
    by_brand: dict[tuple, dict[int, int]] = defaultdict(dict)
    for r in rows:
        by_brand[(r["state"], _key(r["brand"]))][r["size"]] = r["price"]
    inverted = [b for b, sz in by_brand.items()
                if 180 in sz and 750 in sz and sz[750] <= sz[180]]
    if inverted:
        problems.append(f"{len(inverted)} brands price 750ml at or below 180ml: "
                        f"{inverted[:3]}")
    debris = [r["brand"] for r in rows
              if re.match(r"^[^A-Za-z0-9]", r["brand"]) or ")" in r["brand"][:14]]
    if debris:
        problems.append(f"{len(debris)} names look mis-split: {debris[:3]}")
    odd = [r for r in rows if r["kind"] == BEER and r["price"] > 1200]
    odd += [r for r in rows if r["kind"] in (WHISKY, RUM, VODKA, GIN)
            and r["size"] == 750 and r["price"] < 100]
    if odd:
        problems.append(f"{len(odd)} implausible prices, e.g. "
                        f"{[(o['brand'][:30], o['size'], o['price']) for o in odd[:3]]}")

    if problems:
        print("\nREFUSING TO WRITE - checks failed:")
        for pr in problems:
            print("  *", pr)
        return 1

    write(rows, OUT)
    print(f"\nwrote {OUT.name}")
    for st in sorted(states):
        sub = [r for r in rows if r["state"] == st]
        print(f"  {st:16} {len(sub):5} rows  "
              f"{len({r['brand'] for r in sub}):4} brands")
    both = ({r["brand"] for r in rows if r["state"] == MP}
            & {r["brand"] for r in rows if r["state"] == UP})
    print(f"  brands priced in both states: {len(both)}")
    print(f"  with published ABV: {sum(1 for r in rows if r['abv'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

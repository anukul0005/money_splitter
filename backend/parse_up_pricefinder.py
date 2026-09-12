"""Uttar Pradesh, from the excise department's own citizen Price Finder -
https://cms.upexciseonline.co/add-liquor-price-finder/ - rather than the
old up-liquor-price-list.pdf this replaces.

WHY A SECOND UP PARSER
The old PDF is a single ragged export with no category column, so
parse_state_rates.py had to guess a bottle's kind from its name - which is
also how a genuine typo in that document (Glenfiddich 18YO priced at
Rs 1,480, a corrected-by-hand PriceOverride in this app's own database)
went unnoticed: nothing about the guess-from-name approach could have
caught it. This source is the department's own structured Price Finder
report instead - one row per SKU with the department's own Liquor Type and
Liquor Sub Type already filled in, exported to PDF per liquor type (Beer,
Breeze/RTD, FL, Wine) rather than scraped live (see the ~4,600 small
requests that would take walking the finder's own cascading API instead -
this is that same data, already walked, as four PDFs instead of a script).

THE FOUR SOURCE FILES
    sources/up/Beer-up26.pdf          249 rows, "Beer" liquor type
    sources/up/Breeze_up26.pdf.pdf     42 rows, "LAB" liquor type - a real,
                                       first-class "rtd" kind in this app
                                       (Breezer, canned premix cocktails),
                                       not folded into beer or dropped the
                                       way the MP/Delhi parsers drop it.
    sources/up/Fl_up26.pdf.pdf       3342 rows, "FL" (whisky/rum/vodka/gin/
                                       brandy/tequila/liqueur, plus a mixed
                                       "Imported FL" and "Spirit" bucket the
                                       department didn't sub-categorise)
    sources/up/Wine_up26.pdf.pdf      957 rows, "Wine"

WHAT "0.00" MEANS, AND WHY IT ISN'T JUST DROPPED
A row printing "0.00" for its price is a registered-but-not-currently-sold
SKU (the Price Finder's own JS prints '0.00' for exactly this case). It has
no real price, so it can never be recommended for a budget - but the brand
is real and the department does list it, so `parse()` returns it separately
as `unpriced` rather than discarding it outright: enough for a search to
say "this exists, not currently sold here", not enough to rank against an
actual price.

WHY THIS NEEDS ITS OWN TABLE EXTRACTION
These aren't a plain text export like the MP rate list - they're a real
table with borders, but drawn as unstroked filled rectangles rather than
pdfplumber's default stroked-line detection, and only every other row's
rectangle registers as a "line" under that default. Rebuilding the grid
from every rect's own edges (see _extract_rows) recovers all 4,590 rows
with zero missing and zero duplicates, verified against each PDF's own
last S.NO.

"""
from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import pdfplumber
except ImportError:  # pragma: no cover - tooling dependency, not a runtime one
    sys.exit("pdfplumber is needed to parse these PDFs: pip install pdfplumber")

HERE = Path(__file__).parent
UP_DIR = HERE / "sources" / "up"

# (file, liquor_type) - liquor_type drives how each row's kind is decided,
# see _row_kind.
PRICE_FINDER_PDFS = [
    (UP_DIR / "Beer-up26.pdf", "Beer"),
    (UP_DIR / "Breeze_up26.pdf.pdf", "LAB"),
    (UP_DIR / "Fl_up26.pdf.pdf", "FL"),
    (UP_DIR / "Wine_up26.pdf.pdf", "Wine"),
]

SOURCE_KEY = "up-price-finder-2026"
SOURCE_META = {
    SOURCE_KEY: {
        "url": "https://cms.upexciseonline.co/add-liquor-price-finder/",
        "as_of": "2026-09-13",
        "note": "UP Excise citizen Price Finder, exported per liquor type "
                "(Beer/FL/Wine PDFs) - supersedes the old ragged UP PDF",
    },
}


def _extract_rows(path: Path) -> list[list[str]]:
    """Every data row of the PDF's one table, as a list of 9 cell strings.

    Reconstructs the grid from every cell rect's own edges rather than
    relying on pdfplumber's default line-detection (see the module
    docstring for why the default only finds every other row). Padding the
    line set with the page's own top and bottom edge is what recovers the
    first/last row on each page - their rect's far edge sits exactly on
    the page boundary, which isn't a "line" any rect other than the page
    itself would draw.
    """
    rows: list[list[str]] = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            if not page.rects:
                continue
            hlines = sorted({round(r["top"], 1) for r in page.rects} |
                            {round(r["bottom"], 1) for r in page.rects})
            hlines = [0.0] + hlines + [page.height]
            vlines = sorted({round(r["x0"], 1) for r in page.rects} |
                            {round(r["x1"], 1) for r in page.rects})
            for table in page.extract_tables(table_settings={
                "vertical_strategy": "explicit", "horizontal_strategy": "explicit",
                "explicit_vertical_lines": vlines, "explicit_horizontal_lines": hlines,
            }):
                for row in table:
                    if row and row[0] and row[0].strip().isdigit():
                        rows.append(row)
    return rows


def _text(cell: str | None) -> str:
    return " ".join((cell or "").replace("\n", " ").split())


# "-FTA" marks a tariff category (Free Trade Agreement import duty), not
# part of what's on the label - left on, "Glenfiddich 12YO-FTA" and
# "Glenfiddich 12YO" would price as two different bottles.
_FTA_SUFFIX = re.compile(r"[\s-]*FTA\s*$", re.I)

# A plain number, optionally followed by a stray "%" - "42.8", "46 %". Beer's
# own strength column is usually a category band ("5-8", "Below 8") rather
# than a published figure; those correctly parse to None; only what genuinely
# is a single number is kept.
_STRENGTH = re.compile(r"^(\d+(?:\.\d+)?)\s*%?$")


def _strength(cell: str) -> float | None:
    m = _STRENGTH.match(_text(cell))
    return float(m.group(1)) if m else None


# Declared sub-types this document uses that the shared _category() in
# parse_state_rates.py doesn't already recognise as a direct hit -
# normalised here rather than there, since they're specific to how this
# one document spells things ("Scotch" as its own sub-type rather than a
# style word inside a whisky's name, "White Rum" with a space).
_SUB_TYPE_DECLARED = {
    "scotch": "whisky",
    "white rum": "rum",
    "gin": "gin",
}


def _row_kind(liquor_type: str, sub_type: str, description: str, category_fn) -> str | None:
    """The FL sheet's Liquor Sub Type is usually the real answer (Whisky,
    Rum, Vodka, Gin, Brandy, Tequila, Liqueur); "Imported FL" and "Spirit"
    are the department's own catch-alls for whatever wasn't otherwise
    sub-categorised, so those two fall through to the same name/description
    keyword matching every other source already relies on for a brand that
    doesn't declare its own category.
    """
    if liquor_type == "Beer":
        return category_fn(description, declared="beer")
    if liquor_type == "Wine":
        return category_fn(description, declared="wine")
    if liquor_type == "LAB":
        return category_fn(description, declared="rtd")
    # FL
    declared = _SUB_TYPE_DECLARED.get(sub_type.strip().lower(), sub_type.strip().lower())
    if declared in {"imported fl", "spirit", ""}:
        return category_fn(description)
    return category_fn(description, declared=declared)


def parse(category_fn, clean_fn, plausible_fn, keep_sizes: set[int],
         exclude_name) -> tuple[list[dict], list[dict], dict[str, int]]:
    """Returns (priced, unpriced, stats). `category_fn`/`clean_fn`/
    `plausible_fn`/`exclude_name` are parse_state_rates.py's own
    `_category`/`_clean`/`_plausible`/`EXCLUDE_NAME` - passed in rather than
    imported, so this module has no import-order dependency on that one and
    could just as easily be pointed at a from-scratch category/clean pair
    later.

    A row is real (brand cleaned, categorised, a size this app tracks) all
    the way up to the price check - only then does "0.00" split it into
    `unpriced` instead of `priced`, so a SKU that's merely not currently
    sold still comes out the other end as something, not nothing.
    """
    stats = {"raw": 0, "unpriced": 0, "dropped_size": 0,
             "dropped_no_kind": 0, "dropped_excluded_name": 0,
             "dropped_implausible": 0, "kept": 0}
    priced: list[dict] = []
    unpriced: list[dict] = []

    for path, liquor_type in PRICE_FINDER_PDFS:
        if not path.exists():
            sys.exit(f"missing source PDF: {path}")
        for row in _extract_rows(path):
            stats["raw"] += 1
            # columns: S.NO, BRAND NAME, LIQUOR TYPE, LIQUOR SUB TYPE,
            # DETAILED DESCRIPTION, STRENGTH, PACKAGE SIZE, PACKAGE TYPE, PRICE
            brand_raw, _ltype, sub_type, desc, strength, size_s, _pkg, price_s = (
                _text(c) for c in row[1:])

            try:
                size = int(round(float(size_s)))
            except ValueError:
                stats["dropped_size"] += 1
                continue
            if size not in keep_sizes:
                stats["dropped_size"] += 1
                continue

            name, abv_in_name = clean_fn(_FTA_SUFFIX.sub("", brand_raw))
            if not name or len(name) < 3:
                stats["dropped_no_kind"] += 1
                continue
            if exclude_name.search(name):
                stats["dropped_excluded_name"] += 1
                continue

            kind = _row_kind(liquor_type, sub_type, desc or name, category_fn)
            if kind is None:
                stats["dropped_no_kind"] += 1
                continue

            price_val = re.sub(r"[^\d.]", "", price_s)
            price = float(price_val) if price_val else 0.0
            if price <= 0:
                stats["unpriced"] += 1
                unpriced.append({
                    "brand": name, "kind": kind, "size": size,
                    "source": SOURCE_KEY, "state": "Uttar Pradesh",
                })
                continue

            if not plausible_fn(price, size, kind):
                stats["dropped_implausible"] += 1
                continue

            abv = abv_in_name if abv_in_name is not None else _strength(strength)
            priced.append({
                "brand": name, "kind": kind, "size": size, "mrp": price,
                "abv": abv, "source": SOURCE_KEY, "state": "Uttar Pradesh",
            })
            stats["kept"] += 1

    return priced, unpriced, stats


if __name__ == "__main__":
    # Standalone smoke test - real output only ever comes from
    # parse_state_rates.py, which supplies the shared helpers this needs.
    sys.path.insert(0, str(HERE))
    from parse_state_rates import EXCLUDE_NAME, _category, _clean, _plausible, KEEP_SIZES

    priced, unpriced, stats = parse(_category, _clean, _plausible, KEEP_SIZES, EXCLUDE_NAME)
    print(stats)
    print(f"{len(priced)} priced, {len(unpriced)} unpriced")
    rows = priced
    from collections import Counter
    print(Counter(r["kind"] for r in rows))

"""Parse Discovery Wines' Gurugram catalogue PDF into haryana_prices.py.

Discovery Wines is a real, named Gurugram liquor retailer (discoverywine.in),
not the excise department - Haryana runs a Minimum Selling Price regime, so
there is no single published MRP the way Delhi has one. This is one shop's
printed retail catalogue, cited as exactly that: a retail price, not a legal
one, same tier of source as the wordpress/aggregator rows already carried for
Gurugram (see SOURCES in liquor_prices.py). The catalogue's own footer reads
"February 2022" - so treat it as several years stale, not a current read.

Run with:

    python parse_haryana.py

Source PDF: sources/haryana/discovery-wines-catalogue.pdf (a saved copy of
what the user supplied - not fetched over the network, so this script is
reproducible without needing the retailer's site to still serve it).

WHAT THIS SKIPS, AND WHY
  * The three-brand "spotlight" boxes printed at the top of most pages. In the
    extracted text these come out as four flattened rows - a row of three
    brand names, three ages, three sizes, three prices - stacked in that
    order with nothing tying a given name to its own age/size/price beyond
    position. Some of those brands are never repeated in the page's ordinary
    list beneath the box, so skipping them is a real loss of maybe ~100 rows,
    but mis-pairing a name to the wrong price is worse than not having the
    row: this file's rule is that nothing is invented, and a positionally
    reassembled row is invented, not read.
  * The page 4 "SPECIAL OFFER" bulk table (brand + 1/3/6/12-bottle prices).
    It never prints a size - the ordinary catalogue does, per row, everywhere
    else - and guessing 750ml or 1000ml for it would be exactly the invented
    number this project refuses to add.
  * Beer sold as a 24-bottle case ("Amstel Light Beer (24 Pints) ... 4500").
    The catalogue's own "24 Pints" label for a 24-BOTTLE case is already the
    source's own error, not this parser's; either way, a case price is not a
    per-bottle price, and the schema here is per bottle throughout - listing
    4500 against one "bottle" would overstate every such beer eightfold.
  * "Metal Duri?t" (line ~863) - a ligature glyph the extractor could not
    render, and the only one of the eighteen found where the surrounding
    letters do not pin down a real word (contrast "Glen?ddich", unambiguously
    Glenfiddich). Left out rather than guessed.

Everything else prints as "<brand words> <size>ML <price>" per line, one
brand per line, under an ALL-CAPS section header (SINGLE MALT WHISKIES, GIN,
RED WINE, BEER, ...) that sets the kind for every row under it until the next
header. That header state is the only cross-line memory this parser keeps.
"""

from __future__ import annotations

import re
from pathlib import Path

import pdfplumber

PDF_PATH = Path(__file__).parent / "sources" / "haryana" / "discovery-wines-catalogue.pdf"

SOURCES = {
    "discovery-wines-hr": {
        "url": "https://www.discoverywine.in/",
        "as_of": "2022-02",
        "note": ("Discovery Wines (Gurugram chain) printed retail catalogue - "
                 "one shop's prices, not the state MSP; dated by the "
                 "catalogue's own footer, so treat as stale relative to the "
                 "other Haryana sources"),
    },
}

# Section header (as it appears, all caps) -> our kind vocabulary. Anything
# not listed here that still looks like a header (see _looks_like_header) is
# skipped without setting a kind, which starves rows under it rather than
# risk mis-classing them - see the coverage printout for what fell through.
SECTION_KIND = {
    "SINGLE MALT WHISKIES": "whisky",
    "BLENDED SCOTCH WHISKIES": "whisky",
    "WHISKY": "whisky",
    "VODKA": "vodka",
    "VODKA PLAIN": "vodka",
    "VODKA SWEDISH VODKA": "vodka",
    "GIN": "gin",
    "RUM": "rum",
    "COGNAC": "brandy",
    "VSOP": "brandy",
    "BRANDY": "brandy",
    "LIQUERS/TEQUILA": "liqueur",
    "LIQUERS": "liqueur",
    "LIQUEUR": "liqueur",
    "IRISH CREAM": "liqueur",
    "TEQUILA": "tequila",
    "TEQUILA BLANCO XO CAFÉ": "tequila",
    "WHITE WINE": "wine",
    "RED WINE": "wine",
    "RED/WHITE WINE": "wine",
    "ROSE WINE": "wine",
    "SPARKLING WINE": "wine",
    "CHAMPAGNE": "wine",
    "JAPANESE WINES": "wine",
    "INDIAN WHITE WINE": "wine",
    "INDIAN RED WINE": "wine",
    "INDIAN RED/WHITE WINE": "wine",
    "INDIAN ROSE WINE": "wine",
    "BEER": "beer",
}

# Headers that exist in the PDF but deliberately get no kind: MINIATURE mixes
# whisky, vodka, gin and rum 50ml bottles with nothing in the row itself to
# tell them apart, and guessing from the brand name would be exactly the kind
# of invention this file refuses to do. Without this, rows under it kept
# whatever kind was last set - which was "beer" from the section above, so
# every 50ml Absolut/Chivas/Glenfiddich miniature came out mislabelled as
# beer. Listed here so a header being unmapped is a decision, not an
# omission the parser can't tell from a real gap in SECTION_KIND.
UNKINDED_HEADERS = {"MINIATURE"}

# No single bottle in any state's real published list this app already holds
# exceeds ~600 for beer, even for rare imports (see delhi_prices.py). This
# catalogue's second BEER page prices common mass-market brands - Kingfisher,
# Budweiser, Carlsberg, Bira - at 1200-2700 with no case/carton unit stated,
# 8-10x what the exact same brand and size cost per every other Haryana
# source already in liquor_prices.py. That is a dropped "per case" label, not
# a real per-bottle price, and there is no way to recover the true unit from
# the row alone - so it is excluded rather than trusted at face value.
BEER_PRICE_SANITY_CAP = 800

# Marketing furniture that the PDF's two-column layout glues onto real
# product lines - a right-hand call-to-action sidebar sharing a text line
# with the left-hand price list. Blanked out wherever it appears in a line,
# not just at the start, since it turns up mid-line and at the end too (see
# the docstring in the earlier investigation - "Rates can be change any
# prior notice Bailey's Strawberry 750ML 3000 18").
JUNK_PHRASES = [
    "CALL NOW: +91 99907 00075",
    "SPECIAL OFFER FOREIGN MADE LIQUOR INDIAN MADE FOREIGN LIQUOR",
    "Single Malt Blended Scotch Vodka Gin/Rum/Cognac Liquers/Tequila/Mezcal Wines & Champagnes Beers",
    "Whisky Vodka Rum/Gin Wine Beers",
    "SPECIAL OFFER",
    "FOR BULK ORDER",
    "CALL OR WHATSAPP",
    "+91 99907 00075",
    "CLICK TO EXPLORE",
    "OUR STORE LOCATION",
    "VISIT US ONLINE",
    "WWW.DISCOVERYWINE.IN",
    "Rates can be change any prior notice",
]

# The one ligature the PDF's font never rendered - every occurrence is a
# missing "fi", "fl" or "ff" glyph. Checked individually against what real
# brand each produces (see the parser's own investigation notes); this is a
# fixed, exhaustive list, not a heuristic - anything not in it is left with
# its "�" so a wrong guess never masquerades as a fix.
LIGATURE_FIX = {
    "Aristo�": "Aristoff",
    "Ban�": "Banfi",
    "Bu�alo": "Buffalo",
    "Eristo�": "Eristoff",
    "Geogra�co": "Geografico",
    "Glen�ddich": "Glenfiddich",
    "Kau�man": "Kauffman",
    "Kau�mar": "Kauffmar",
    "King�sher": "Kingfisher",
    "Paci�co": "Pacifico",
    "Re�exion": "Reflexion",
    "Ri�": "Riff",
    "Ru�na": "Rufina",
    "Ru�no": "Ruffino",
    "Smirno�": "Smirnoff",
    "To�ee": "Toffee",
    "Tru�e": "Truffle",
}

_SIZE_PRICE = re.compile(
    r"^(?P<brand>.+?)\s+\(?\s*(?P<size>\d+)\s*[Mm][Ll]\s*\)?\s+"
    r"(?P<price>[\d,]+(?:\.\d+)?)$"
)
_PURE_UPPER_NO_DIGIT = re.compile(r"^[A-Z0-9&’'./\s]+$")
_AGE_ROW = re.compile(r"^(\d+\s+YEARS?\s+OLD\s*)+$")
_SIZE_ROW = re.compile(r"^(\d+\s*[Mm][Ll]\s*)+$")
_PRICE_ROW = re.compile(r"^([\d,]+\s*)+$")
_CASE_OR_PINT = re.compile(r"pint|case", re.IGNORECASE)


def _clean_line(line: str, page_no: int) -> str:
    for phrase in JUNK_PHRASES:
        line = line.replace(phrase, " ")
    line = line.strip()
    # A lone page-number footer, sometimes glued to the end of the line
    # above it once the real footer text is stripped out.
    for token in (str(page_no), f"{page_no:02d}"):
        if line.endswith(" " + token):
            line = line[: -len(token)].rstrip()
    for corrupt, fixed in LIGATURE_FIX.items():
        line = line.replace(corrupt, fixed)
    return " ".join(line.split())


def _looks_like_header(line: str) -> bool:
    """A standalone ALL-CAPS line with no digits - a section header or one of
    the three-brand spotlight box's own name rows. Both are skipped; only the
    ones in SECTION_KIND change what kind gets recorded."""
    if not line or any(c.isdigit() for c in line):
        return False
    if not _PURE_UPPER_NO_DIGIT.match(line):
        return False
    return any(c.isalpha() for c in line)


def parse() -> list[tuple]:
    rows: list[tuple] = []
    skipped_no_kind = 0
    skipped_unparsed: list[str] = []
    kind: str | None = None

    with pdfplumber.open(PDF_PATH) as pdf:
        for page_no, page in enumerate(pdf.pages, start=1):
            text = page.extract_text() or ""
            for raw_line in text.split("\n"):
                line = _clean_line(raw_line, page_no)
                if not line:
                    continue
                if "�" in line:
                    continue  # the one un-fixable ligature (Metal Duri?t)
                if _CASE_OR_PINT.search(line):
                    continue  # case/pint bulk pricing, not per-bottle
                if line in SECTION_KIND:
                    kind = SECTION_KIND[line]
                    continue
                if line in UNKINDED_HEADERS:
                    kind = None
                    continue
                if _looks_like_header(line):
                    continue  # a header we don't map, or a spotlight name row
                if _AGE_ROW.match(line) or _SIZE_ROW.match(line) or _PRICE_ROW.match(line):
                    continue  # the rest of a spotlight box

                m = _SIZE_PRICE.match(line)
                if not m:
                    skipped_unparsed.append(f"p{page_no}: {line}")
                    continue
                if kind is None:
                    skipped_no_kind += 1
                    continue

                brand = m.group("brand").strip(" -")
                if not brand or brand.isupper():
                    # A brand-only spotlight fragment that slipped past the
                    # header check (rare - only when it shares a line with a
                    # real size+price by coincidence of the two-column glue).
                    continue
                size_ml = int(m.group("size"))
                price = int(round(float(m.group("price").replace(",", ""))))
                if price <= 0:
                    continue
                if kind == "beer" and price > BEER_PRICE_SANITY_CAP:
                    skipped_unparsed.append(
                        f"p{page_no}: {line}  (beer priced above the sanity cap - likely an unlabelled case price)"
                    )
                    continue
                rows.append((brand, kind, size_ml, price))

    # Two sizes of the exact same brand at the exact same price is one
    # mis-split line, not two products - the parser has no such case in
    # practice, but a duplicate exact row is still collapsed rather than
    # double-counted.
    seen = set()
    deduped = []
    for r in rows:
        if r in seen:
            continue
        seen.add(r)
        deduped.append(r)

    print(f"{len(deduped)} rows parsed ({len(rows) - len(deduped)} exact duplicates dropped)")
    print(f"{skipped_no_kind} rows skipped for having no section header yet")
    print(f"{len(skipped_unparsed)} lines didn't match the brand/size/price pattern")
    if skipped_unparsed:
        print("First 40 unparsed lines (for a human to check nothing real was missed):")
        for s in skipped_unparsed[:40]:
            print(f"  {s}")

    by_kind: dict[str, int] = {}
    for _, k, _, _ in deduped:
        by_kind[k] = by_kind.get(k, 0) + 1
    print("\nBy kind:", by_kind)

    return deduped


def write_module(rows: list[tuple]) -> None:
    out = Path(__file__).parent / "haryana_prices.py"
    lines = [
        '"""Gurugram (Haryana) liquor prices, parsed from a real retail catalogue.',
        "",
        "GENERATED FILE - do not edit by hand. Rebuild with:",
        "",
        "    python parse_haryana.py",
        "",
        "The source is sources/haryana/discovery-wines-catalogue.pdf - see",
        "parse_haryana.py for what it is, what got skipped, and why.",
        '"""',
        "",
        "from __future__ import annotations",
        "",
        "SOURCES = {",
    ]
    for key, meta in SOURCES.items():
        lines.append(f"    {key!r}: {{")
        for k, v in meta.items():
            lines.append(f"        {k!r}: {v!r},")
        lines.append("    },")
    lines.append("}")
    lines.append("")
    lines.append("# brand, kind, size_ml, price - single published price per row, no ranges")
    lines.append("ROWS: list[tuple] = [")
    for brand, kind, size_ml, price in rows:
        lines.append(f"    ({brand!r}, {kind!r}, {size_ml}, {price}),")
    lines.append("]")
    lines.append("")
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nWrote {out} ({len(rows)} rows)")


if __name__ == "__main__":
    write_module(parse())

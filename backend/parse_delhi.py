"""Delhi liquor prices, parsed from the excise department's own live feed.

Delhi runs eabkari.delhi.gov.in/Reports, a dashboard whose only real content
is one call to its own API:

    GET https://eabkari.delhi.gov.in/WEbservice.asmx/GetBrandPriceList

That call returns every currently registered brand, its MRP, and the window
of dates that MRP is valid for - the department's source of truth, not an
aggregator's report of it. This replaced ~35 hand-curated rows taken from two
blog aggregators (boldsky, madiradeals) that could not be cross-checked
against anything.

Re-fetch and rebuild with:

    python parse_delhi.py --fetch      # pulls the live feed, saves it, parses it
    python parse_delhi.py              # re-parses the file already saved

The feed is large (8,500+ rows) and carries fields this app has no use for
(licensee names, site addresses) — sources/delhi/delhi-brand-price-list.json
keeps only what is parsed, so it stays reproducible without shipping data that
was never used.

WHAT "CURRENT" MEANS
A brand can be registered more than once, each registration valid over its own
`v_range`. This picks, for each (brand, size), the registration whose window
contains today if one does, and otherwise the most recently started one - a
window that opens next month is still the operative price, and one that
closed last month is the last real price on record.

BRAND NAMES ARE GLUED TO JUNK
Roughly two in five distinct names carry an importer's registration code or,
in a few dozen cases, someone's email address, run directly onto the name
with no separator: "ABERFELDY HIGHLAND SINGLE MALT S/W 12 YOMALHOTRA_ANIL
@HOTMAIL.COM". Both are recognisable and stripped - see _clean.
"""

from __future__ import annotations

import datetime
import json
import re
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).parent
FEED_URL = "https://eabkari.delhi.gov.in/WEbservice.asmx/GetBrandPriceList"
SAVED = HERE / "sources" / "delhi" / "delhi-brand-price-list.json"
OUT = HERE / "delhi_prices.py"

WHISKY, RUM, VODKA, BEER, GIN, WINE, BRANDY, TEQUILA, LIQUEUR = (
    "whisky", "rum", "vodka", "beer", "gin", "wine", "brandy", "tequila",
    "liqueur")

# The department's own category, which is a cleaner signal than anything a
# name-matching pass could do - Delhi's feed carries a category column MP and
# UP's PDFs did not. Categories with no home in the recommender (RTDs, country
# liquor, the department's own grab-bag "Mixed Alcoholic Beverages") map to
# None and are dropped, same as an RTD is dropped from the other two states.
CATEGORY = {
    "whisky": WHISKY, "wine": WINE, "vodka": VODKA, "rum": RUM, "gin": GIN,
    "brandy": BRANDY, "tequila": TEQUILA, "liqueur": LIQUEUR,
    "beer (strong)": BEER, "beer (light)": BEER, "draught beer": BEER,
    "champagne": WINE, "cognac": BRANDY,
    "country liquor": None, "alcopop": None,
    "mixed alcoholic beverages": None,
}

KEEP_SIZES = {180, 330, 375, 500, 650, 700, 750, 1000}
MIN_PER_LITRE = {BEER: 60.0}
MIN_PER_LITRE_DEFAULT = 200.0

# The registration code and, in a few dozen rows, an importer's email address,
# both run directly onto the brand name with no space. A code is 4+ digits,
# usually behind "L1F" or "L1P" (foreign liquor licence, this year or last);
# stripped at the end of the string only, so a real word ending in digits -
# there are none in this data - is never touched. An email is recognised
# anywhere: the local part is glued onto whatever word came before it, so the
# match starts wherever an "@" forces it to.
_EMAIL = re.compile(r"\s*[A-Za-z0-9_.+-]*[A-Za-z0-9_.+-]@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\s*",
                    re.IGNORECASE)
_CODE_SUFFIX = re.compile(r"\s*(?:W?L1[FP])\d{4,}\s*$")

# "750        Ml." / "700 ML" - whitespace-padded, full stop, mixed case.
# A handful of rows (6 of 8,531) print in litres instead - "1.5        Lt." -
# and 52 print "quart(US)" against a number that does not match a real US
# quart (946ml); those are left unread rather than guessed at.
_SIZE = re.compile(r"(\d+(?:\.\d+)?)\s*ml", re.IGNORECASE)
_SIZE_LT = re.compile(r"(\d+(?:\.\d+)?)\s*lt", re.IGNORECASE)
# "42.8       %V/V " - same padding.
_ABV = re.compile(r"(\d+(?:\.\d+)?)\s*%")
_RANGE = re.compile(r"\(\s*(\d{2}/\d{2}/\d{4})\s*-\s*(\d{2}/\d{2}/\d{4})\s*\)")


def _clean(name: str) -> str:
    name = _EMAIL.sub(" ", name)
    name = _CODE_SUFFIX.sub("", name)
    name = " ".join(name.split())
    return name.title() if name.isupper() else name


def _size_ml(measure: str) -> int | None:
    m = _SIZE.search(measure or "")
    if m:
        return int(round(float(m.group(1))))
    m = _SIZE_LT.search(measure or "")
    return int(round(float(m.group(1)) * 1000)) if m else None


def _abv(strength: str) -> float | None:
    m = _ABV.search(strength or "")
    if not m:
        return None
    v = float(m.group(1))
    return v if v > 0 else None       # "0 %V/V" on wine means "not printed"


def _window(v_range: str) -> tuple[datetime.date, datetime.date] | None:
    m = _RANGE.search(v_range or "")
    if not m:
        return None
    s, e = m.groups()
    return (datetime.datetime.strptime(s, "%d/%m/%Y").date(),
            datetime.datetime.strptime(e, "%d/%m/%Y").date())


def fetch() -> dict:
    """Pull the live feed and save the fields this module parses."""
    req = urllib.request.Request(
        FEED_URL, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        payload = json.loads(r.read().decode("utf-8"))
    rows = payload.get("details") or payload.get("Details") or []
    keep = ["Financial_Year", "Liquor_Type_Desc", "Brand_Name",
            "Package_Type_desc", "Measure", "Strength", "v_range", "MRP"]
    slim = {
        "fetched_at": datetime.date.today().isoformat(),
        "source_url": FEED_URL,
        "count": len(rows),
        "rows": [{k: r.get(k) for k in keep} for r in rows],
    }
    SAVED.parent.mkdir(parents=True, exist_ok=True)
    SAVED.write_text(json.dumps(slim, ensure_ascii=False), encoding="utf-8")
    print(f"fetched {len(rows)} rows -> {SAVED}")
    return slim


def parse(today: datetime.date | None = None) -> list[dict]:
    payload = json.loads(SAVED.read_text(encoding="utf-8"))
    today = today or datetime.date.today()

    # One registration can repeat across financial years at the same price -
    # the feed carries three years of history, not three years of increases.
    # Grouped by (brand, size) so the newest, or the one valid today, wins.
    groups: dict[tuple[str, int], list[dict]] = defaultdict(list)
    for r in payload["rows"]:
        kind = CATEGORY.get((r["Liquor_Type_Desc"] or "").strip().lower())
        if kind is None:
            continue
        size = _size_ml(r["Measure"])
        if size not in KEEP_SIZES:
            continue
        mrp = r["MRP"]
        if not mrp or mrp <= 0:
            continue
        name = _clean((r["Brand_Name"] or "").strip())
        if len(name) < 3:
            continue
        if mrp / (size / 1000.0) < MIN_PER_LITRE.get(kind, MIN_PER_LITRE_DEFAULT):
            continue
        window = _window(r["v_range"])
        groups[(name, size)].append({
            "kind": kind, "mrp": float(mrp), "abv": _abv(r["Strength"]),
            "window": window,
        })

    out = []
    for (name, size), regs in groups.items():
        valid_today = [g for g in regs if g["window"] and
                       g["window"][0] <= today <= g["window"][1]]
        pool = valid_today or regs
        # Newest start date wins; a registration with no parseable window
        # sorts first (date.min) so a dated one always beats it.
        best = max(pool, key=lambda g: g["window"][0] if g["window"] else datetime.date.min)
        out.append({"brand": name, "kind": best["kind"], "size": size,
                    "mrp": best["mrp"], "abv": best["abv"],
                    "source": "delhi-eabkari", "state": "Delhi"})
    return out


def write(rows: list[dict]) -> None:
    from brand_names import canonicalise

    canonical = canonicalise([(r["brand"], r["kind"]) for r in rows])
    grouped: dict[tuple, dict] = {}
    for r in rows:
        name = canonical[(r["brand"], r["kind"])]
        key = (name, r["kind"], r["size"])
        cur = grouped.get(key)
        if cur is None:
            grouped[key] = {**r, "brand": name, "mrp_lo": r["mrp"], "mrp_hi": r["mrp"]}
        else:
            # Canonicalising can fold two differently-registered rows onto
            # one name at one size - kept as a range rather than picking one
            # arbitrarily, same as the state parser does for a genuine spread.
            cur["mrp_lo"] = min(cur["mrp_lo"], r["mrp"])
            cur["mrp_hi"] = max(cur["mrp_hi"], r["mrp"])
            cur["abv"] = cur["abv"] or r["abv"]

    merged = sorted(grouped.values(), key=lambda r: (r["kind"], r["brand"].lower(), -r["size"]))

    problems = []
    if len(merged) < 1500:
        problems.append(f"only {len(merged)} rows; expected several thousand")
    kinds = {r["kind"] for r in merged}
    for need in (WHISKY, RUM, VODKA, BEER, WINE):
        if need not in kinds:
            problems.append(f"no {need} rows at all")
    junk = [r["brand"] for r in merged if "@" in r["brand"] or re.search(r"L1[FP]\d", r["brand"])]
    if junk:
        problems.append(f"{len(junk)} names still carry the registration junk: {junk[:3]}")
    if any(r["mrp_hi"] < r["mrp_lo"] for r in merged):
        problems.append("a row's range is inverted")

    if problems:
        print("\nREFUSING TO WRITE - checks failed:")
        for p in problems:
            print(f"  - {p}")
        sys.exit(1)

    lines = [
        '"""Delhi liquor prices, parsed from the excise department\'s live feed.',
        "",
        "GENERATED FILE - do not edit by hand. Rebuild with:",
        "",
        "    python parse_delhi.py",
        "",
        "The source is sources/delhi/delhi-brand-price-list.json, itself pulled from",
        "the department's own API - see parse_delhi.py for the endpoint, how",
        '"current" is decided among a brand\'s several registrations, and how the',
        "registration codes and stray email addresses glued onto brand names are",
        "recognised and stripped.",
        '"""',
        "",
        "from __future__ import annotations",
        "",
        "SOURCES = {",
        '    "delhi-eabkari": {',
        f'        "url": "{FEED_URL}",',
        f'        "as_of": "{payload_fetched_at()}",',
        '        "note": "Delhi Excise brand price list, live feed (GetBrandPriceList)",',
        "    },",
        "}",
        "",
        "# brand, kind, size_ml, mrp, mrp_max (None if a single published price),",
        "# abv (None where the feed did not print a strength)",
        "ROWS: list[tuple] = [",
    ]
    for r in merged:
        hi = r["mrp_hi"] if r["mrp_hi"] != r["mrp_lo"] else None
        lines.append(
            f"    ({r['brand']!r}, {r['kind']!r}, {r['size']}, "
            f"{round(r['mrp_lo'])}, {round(hi) if hi else None}, {r['abv']!r}),")
    lines.append("]")
    lines.append("")

    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nwrote {OUT.name}")
    print(f"  {len(merged)} rows, {len({r['brand'] for r in merged})} brands")
    for k in sorted(kinds):
        n = sum(1 for r in merged if r["kind"] == k)
        print(f"  {k:<9} {n}")


def payload_fetched_at() -> str:
    return json.loads(SAVED.read_text(encoding="utf-8"))["fetched_at"]


if __name__ == "__main__":
    if "--fetch" in sys.argv:
        fetch()
    if not SAVED.exists():
        sys.exit(f"{SAVED} not found - run with --fetch first")
    write(parse())

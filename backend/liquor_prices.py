"""Liquor price knowledge base, scraped from public state price lists.

Alcohol is a State subject in India: every state sets its own excise duty and
MRP, so the same bottle costs materially different amounts across a border.
There is no national price, and there is no single machine-readable national
dataset — most states publish a PDF and little else. So this table is built
per state from public listings, and every row carries its source.

RULES FOR THIS FILE
  * Every price here came from a real published listing. Nothing is
    interpolated between states and nothing is invented. If a state is absent
    from a brand, the app says it has no price rather than guessing — a made-up
    number that looks precise is worse than no number.
  * Prices drift with every excise year and vary between shops. Treat these as
    indicative, which is what `as_of` and `source` are for.
  * `price_max` is set only where the source published a range.

To extend: add rows with a real source. `python liquor_prices.py` prints
coverage so you can see what is missing.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Sources, cited per row below.
SOURCES = {
    "madirakprice-mh": {
        "url": "https://madirakprice.com/maharashtra-liquor-price-list-today/",
        "as_of": "2026-09",
        "note": "Aggregator of the Maharashtra State Excise price list",
    },
    "boldsky-dl": {
        "url": "https://www.boldsky.com/liquor-price/delhi.html",
        "as_of": "2026-09",
        "note": "Aggregator of the Delhi Excise Department price list",
    },
    "madiradeals-up": {
        "url": "https://madiradeals.com/royal-stag-whisky-price-in-up/",
        "as_of": "2026-09",
        "note": "UP retail ranges; published as ranges, not fixed MRP",
    },
    "oldmonkprice-up": {
        "url": "https://oldmonkprice.com/up",
        "as_of": "2026-09",
        "note": "Old Monk UP rates",
    },
    "search-up-2026": {
        "url": "https://liquorsprices.com/",
        "as_of": "2026-09",
        "note": "UP city ranges (Lucknow/Noida/Ghaziabad) reported as bands",
    },
}

WHISKY, RUM, VODKA, BEER, GIN, WINE = "whisky", "rum", "vodka", "beer", "gin", "wine"


@dataclass(frozen=True)
class Bottle:
    brand: str
    kind: str
    size_ml: int
    state: str
    price: int
    source: str
    price_max: int | None = None   # set only where the source gave a range

    @property
    def is_range(self) -> bool:
        return self.price_max is not None and self.price_max != self.price

    @property
    def mid(self) -> float:
        return (self.price + self.price_max) / 2 if self.is_range else float(self.price)


# ── Maharashtra ───────────────────────────────────────────────────────────────
_MH = [
    ("Officer's Choice", WHISKY, 750, 610), ("Bagpiper Gold", WHISKY, 750, 585),
    ("Director's Special", WHISKY, 750, 640), ("Haywards Fine", WHISKY, 750, 660),
    ("Royal Stag", WHISKY, 750, 850), ("McDowell's No.1", WHISKY, 750, 715),
    ("Imperial Blue", WHISKY, 750, 750), ("Vat 69", WHISKY, 750, 940),
    ("Blenders Pride", WHISKY, 750, 1440), ("Antiquity Blue", WHISKY, 750, 1275),
    ("100 Pipers", WHISKY, 750, 1740), ("Black Dog", WHISKY, 750, 2000),
    ("Johnnie Walker Red Label", WHISKY, 750, 2725),
    ("Johnnie Walker Black Label", WHISKY, 750, 5400),
    ("Chivas Regal 12", WHISKY, 750, 4000), ("Glenfiddich 12", WHISKY, 750, 4750),
    ("Old Monk", RUM, 750, 1040), ("Bacardi White", RUM, 750, 1275),
    ("Captain Morgan", RUM, 750, 1600), ("McDowell's Celebration", RUM, 750, 715),
    ("Magic Moments", VODKA, 750, 715), ("Smirnoff", VODKA, 750, 1175),
    ("Absolut", VODKA, 750, 2150), ("Grey Goose", VODKA, 750, 5600),
    ("Kingfisher Premium", BEER, 650, 170), ("Kingfisher Strong", BEER, 650, 190),
    ("Budweiser", BEER, 650, 240), ("Tuborg", BEER, 650, 220),
    ("Corona", BEER, 355, 300),
]

# ── Delhi ─────────────────────────────────────────────────────────────────────
_DL = [
    ("100 Pipers", WHISKY, 750, 1400), ("100 Pipers", WHISKY, 375, 700),
    ("100 Pipers", WHISKY, 180, 350), ("100 Pipers 12 YO", WHISKY, 750, 2000),
    ("8 PM Premium Black", WHISKY, 750, 500),
    ("Bacardi Black", RUM, 750, 420), ("Bacardi Black", RUM, 375, 210),
    ("Bacardi Black", RUM, 180, 105),
    ("Bacardi Apple", RUM, 750, 700), ("Bacardi Apple", RUM, 375, 350),
    ("Absolut", VODKA, 750, 1400), ("Absolut", VODKA, 200, 465),
    ("Absolut Lime", VODKA, 750, 1400), ("Absolut Mandrin", VODKA, 750, 1400),
    ("Absolut Raspberi", VODKA, 750, 1400),
    ("Beefeater London Dry", GIN, 750, 1450),
    ("Blue Moon Extra Dry", GIN, 750, 1000), ("Blue Moon Extra Dry", GIN, 375, 500),
    ("Morpheus XO Brandy", WHISKY, 750, 760),
    ("Bad Monkey Super Strong", BEER, 650, 130), ("Bad Monkey Super Strong", BEER, 500, 100),
    ("Bee Young Crafted Strong", BEER, 650, 130), ("Bee Young Crafted Strong", BEER, 500, 100),
    ("Amstel Light", BEER, 355, 260), ("Alhambra Reserva Roja", BEER, 330, 250),
    ("Breezer", BEER, 275, 100),
    ("All Rounder Sauvignon Chenin", WINE, 750, 570),
    ("All Rounder Shiraz Cabernet", WINE, 750, 570),
    ("Alamos Malbec", WINE, 750, 2190), ("Alamos Chardonnay", WINE, 750, 2140),
]

# ── Uttar Pradesh — published as ranges, kept as ranges ───────────────────────
_UP_RANGES = [
    ("Royal Stag", WHISKY, 90, 85, 100, "madiradeals-up"),
    ("Royal Stag", WHISKY, 180, 170, 210, "madiradeals-up"),
    ("Royal Stag", WHISKY, 375, 340, 390, "madiradeals-up"),
    ("Royal Stag", WHISKY, 750, 650, 720, "madiradeals-up"),
    ("Royal Stag", WHISKY, 1000, 850, 950, "madiradeals-up"),
    ("Royal Stag Deluxe", WHISKY, 750, 620, 750, "madiradeals-up"),
    ("Royal Stag Barrel Select", WHISKY, 750, 700, 780, "madiradeals-up"),
    ("Royal Stag Barrel Select", WHISKY, 1000, 900, 1000, "madiradeals-up"),
    ("Old Monk", RUM, 750, 520, 520, "oldmonkprice-up"),
    ("Officer's Choice", WHISKY, 750, 330, 380, "search-up-2026"),
    ("Blenders Pride", WHISKY, 750, 680, 780, "search-up-2026"),
    ("Johnnie Walker Black Label", WHISKY, 750, 2600, 3000, "search-up-2026"),
    ("Kingfisher", BEER, 500, 100, 120, "search-up-2026"),
]

BOTTLES: list[Bottle] = (
    [Bottle(b, k, s, "Maharashtra", p, "madirakprice-mh") for b, k, s, p in _MH]
    + [Bottle(b, k, s, "Delhi", p, "boldsky-dl") for b, k, s, p in _DL]
    + [Bottle(b, k, s, "Uttar Pradesh", lo, src, hi) for b, k, s, lo, hi, src in _UP_RANGES]
)

STATES = sorted({b.state for b in BOTTLES})


def for_state(state: str) -> list[Bottle]:
    return [b for b in BOTTLES if b.state.lower() == (state or "").lower()]


def coverage() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for st in STATES:
        rows = for_state(st)
        out[st] = {
            "rows": len(rows),
            "brands": len({r.brand for r in rows}),
            "kinds": sorted({r.kind for r in rows}),
        }
    return out


if __name__ == "__main__":
    for st, info in coverage().items():
        print(f"{st:16s} {info['rows']:>3} rows  {info['brands']:>3} brands  {', '.join(info['kinds'])}")
    print(f"\n{len(BOTTLES)} rows total across {len(STATES)} states")
    print("Sources:")
    for k, v in SOURCES.items():
        print(f"  {k:18s} {v['as_of']}  {v['url']}")

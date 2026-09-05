"""Delhi NCR eating-out price knowledge base, built from public listings.

The sister file to liquor_prices, and it follows the same rules — but the data
behaves differently enough to be worth saying why.

Alcohol has a legal price: a state sets the MRP and a shop charges it. Food has
no such thing. A restaurant sets its own menu, changes it whenever it likes, and
two honest write-ups of the same place a month apart will disagree. So the unit
here is not "the price of a dish" but **cost for two** — the figure every Indian
listing site publishes and every diner already thinks in. It is a typical bill
for two people ordering a normal meal, drinks aside, and it is the only food
number with enough agreement across sources to be worth putting in a table.

RULES FOR THIS FILE
  * Every row came from a real published listing, cited by `sources`. Nothing is
    interpolated between cities and no place is invented.
  * Where two sources disagree — and for restaurants they routinely do — the row
    spans both as a range rather than picking one and calling it the price.
  * Cost for two is indicative, not a quote. It excludes alcohol, and it moves.
    `as_of` is there so the app can say how stale it is.
  * A city with no row for something says so. It never borrows a number from the
    city next door.

We are deliberately not scraping Zomato or Swiggy. They block automated
fetching, their prices are per-outlet and change weekly, and mirroring their
menu database inside this app would be a licensing problem rather than a
technical one. Curated, cited, and honestly stale beats a scrape we cannot show
the provenance of.

To extend: add rows with a real source. `python food_prices.py` prints coverage.
"""

from __future__ import annotations

from dataclasses import dataclass

# ── Sources, cited per row below ──────────────────────────────────────────────
SOURCES = {
    "fabhotels-cyberhub": {
        "url": "https://www.fabhotels.com/blog/cyber-hub-restaurants-cafes-pubs/",
        "as_of": "2026-09",
        "note": "Cyber Hub round-up with average cost for two",
    },
    "dinediary-cyberhub": {
        "url": "https://www.dinediary.in/2026/07/5-best-restaurants-in-cyber-hub-gurgaon.html",
        "as_of": "2026-07",
        "note": "Cyber Hub under-Rs1500 guide; also publishes individual dish prices",
    },
    "fabhotels-noida": {
        "url": "https://www.fabhotels.com/blog/restaurants-in-noida/",
        "as_of": "2026-09",
        "note": "Noida sector-by-sector list with cost for two",
    },
    "fabhotels-delhi": {
        "url": "https://www.fabhotels.com/blog/restaurants-in-delhi/",
        "as_of": "2026-09",
        "note": "Delhi list with cost for two, fine dining through to dhabas",
    },
    "pulseofnoida": {
        "url": "https://pulseofnoida.com/food-lifestyle/experiences-events/best-restaurants-noida-2026-2574/",
        "as_of": "2026-08",
        "note": "Noida guide, sector by sector",
    },
    "magicpin-buffet-noida": {
        "url": "https://magicpin.in/blog/category/food-and-beverage/best-buffet-restaurants-in-noida",
        "as_of": "2026-08",
        "note": "Noida buffet rates, published per person for lunch and dinner",
    },
    "magicpin-mughlai": {
        "url": "https://magicpin.in/blog/best-mughlai-restaurants-delhi/",
        "as_of": "2026-08",
        "note": "Delhi Mughlai round-up with cost for two",
    },
    "comfortmytrip-street": {
        "url": "https://www.comfortmytrip.com/blog/budget-street-food-delhi",
        "as_of": "2026-09",
        "note": "Delhi street food, published as per-plate bands",
    },
    "traveltriangle-street": {
        "url": "https://traveltriangle.com/blog/best-street-food-in-delhi/",
        "as_of": "2026-09",
        "note": "Delhi street food staples and where to eat them",
    },
    "magicpin-cp": {
        "url": "https://magicpin.in/blog/16-best-restaurants-connaught-place-cp/",
        "as_of": "2026-09",
        "note": "Connaught Place round-up with cost for two",
    },
    "zingbus-cp": {
        "url": "https://www.zingbus.com/blog/best-restaurants-connaught-place-every-budget/",
        "as_of": "2026-09",
        "note": "Connaught Place by budget, published as per-person ranges",
    },
    "magicpin-southdelhi": {
        "url": "https://magicpin.in/blog/restaurants-south-delhi/",
        "as_of": "2026-09",
        "note": "South Delhi round-up (Saket, GK, Safdarjung, Mehrauli) with cost for two",
    },
    "magicpin-delhi-top16": {
        "url": "https://magicpin.in/blog/best-restaurants-new-delhi-top-16/",
        "as_of": "2026-09",
        "note": "Delhi-wide round-up with cost for two",
    },
    "magicpin-hauzkhas": {
        "url": "https://magicpin.in/blog/category/food-and-beverage/best-restaurants-in-hauz-khas",
        "as_of": "2026-09",
        "note": "Hauz Khas Village round-up with cost for two",
    },
    "magicpin-gk1": {
        "url": "https://magicpin.in/blog/category/food-and-beverage/best-restaurants-greater-kailash",
        "as_of": "2026-09",
        "note": "Greater Kailash 1 (M Block) round-up with cost for two",
    },
    "magicpin-datenights": {
        "url": "https://magicpin.in/blog/category/food-and-beverage/best-date-nights-delhi",
        "as_of": "2026-09",
        "note": "Delhi date-night spots across neighbourhoods with cost for two",
    },
    "magicpin-lajpatnagar-street": {
        "url": "https://magicpin.in/blog/famous-street-foods-lajpat-nagar/",
        "as_of": "2026-09",
        "note": "Lajpat Nagar street food with per-plate prices",
    },
}

# The three that are one metro ride apart, which is what makes comparing them
# worth anything. Kept as a tuple so the API can hand the UI a fixed order.
NCR_CITIES = ("Delhi", "Gurugram", "Noida")

# ── Cuisine vocabulary ────────────────────────────────────────────────────────
# A controlled list, because the sources write the same cuisine six ways
# ("North Indian", "Punjabi", "Mughlai") and a free-text filter would miss most
# of what it should match.
NORTH, MUGHLAI, SOUTH, CHINESE, ASIAN = (
    "North Indian", "Mughlai", "South Indian", "Chinese", "Asian")
ITALIAN, CONTINENTAL, CAFE, BBQ, STREET = (
    "Italian", "Continental", "Cafe", "Barbecue", "Street food")
BAKERY, SEAFOOD, MEDITERRANEAN, FUSION, REGIONAL = (
    "Bakery", "Seafood", "Mediterranean", "Fusion", "Regional Indian")

# What kind of outing it is. People choose this before they choose a cuisine —
# "somewhere for a proper dinner" and "something quick" are different questions.
DINE_IN, BUFFET, STREET_KIND, CAFE_KIND = "dine-in", "buffet", "street", "cafe"
KINDS = {
    DINE_IN: "Sit-down meal",
    BUFFET: "Buffet / unlimited",
    CAFE_KIND: "Cafe or casual",
    STREET_KIND: "Street food",
}


@dataclass(frozen=True)
class Place:
    """A restaurant, priced the way listings price them: cost for two.

    `for_two_max` is set only where sources disagreed or published a band. We
    keep both ends rather than averaging them into a number that looks more
    certain than it is.
    """

    name: str
    area: str
    city: str
    cuisines: tuple[str, ...]
    for_two: int
    sources: tuple[str, ...]
    for_two_max: int | None = None
    kind: str = DINE_IN
    veg_only: bool = False

    @property
    def is_range(self) -> bool:
        return self.for_two_max is not None and self.for_two_max != self.for_two

    @property
    def mid(self) -> float:
        return (self.for_two + self.for_two_max) / 2 if self.is_range else float(self.for_two)

    def total_for(self, people: int) -> float:
        """Cost for two, scaled to the actual head count.

        Halving to a per-head figure and multiplying back is the honest
        reading of what "cost for two" means. It is a straight line, which
        slightly overstates a large table (shared starters don't scale) — the
        API says as much rather than quietly applying a discount we can't
        source.
        """
        return self.mid / 2 * max(people, 1)


@dataclass(frozen=True)
class Dish:
    """One item with a published price, at a named place or off a street stall.

    Dish prices are much thinner on the ground than cost-for-two, so these are
    used to show what a place actually serves, not to total up a bill. A spread
    priced from four known dishes and six guessed ones would read as a real
    number and be wrong.
    """

    name: str
    city: str
    price: int
    sources: tuple[str, ...]
    place: str = ""          # blank for street food, which has no one address
    price_max: int | None = None
    veg: bool = True
    course: str = "main"     # starter | main | bread | rice | dessert | drink

    @property
    def is_range(self) -> bool:
        return self.price_max is not None and self.price_max != self.price

    @property
    def mid(self) -> float:
        return (self.price + self.price_max) / 2 if self.is_range else float(self.price)


# ── Gurugram ──────────────────────────────────────────────────────────────────
# Cyber Hub is the densest priced cluster in the NCR, which is why it dominates
# here. Where the two Cyber Hub sources disagree the row spans both.
_GURUGRAM = [
    Place("Yum Yum Cha", "Cyber Hub", "Gurugram", (ASIAN,), 600, ("fabhotels-cyberhub",)),
    Place("Pita Pit", "Cyber Hub", "Gurugram", (MEDITERRANEAN,), 600, ("fabhotels-cyberhub",), kind=CAFE_KIND),
    Place("Panchavati Gaurav", "Cyber Hub", "Gurugram", (REGIONAL,), 1200, ("fabhotels-cyberhub",), veg_only=True),
    Place("Mustard Madras", "Cyber Hub", "Gurugram", (SOUTH,), 1300, ("dinediary-cyberhub",), for_two_max=1500),
    Place("Dhaba Estd. 1986", "Cyber Hub", "Gurugram", (NORTH,), 1400, ("fabhotels-cyberhub",)),
    Place("Gola Sizzlers", "Cyber Hub", "Gurugram", (NORTH, CONTINENTAL), 1400, ("dinediary-cyberhub",), for_two_max=1600),
    Place("YouMee", "Cyber Hub", "Gurugram", (ASIAN,), 1400, ("dinediary-cyberhub",), for_two_max=1600),
    Place("Mr. Mamagoto", "Cyber Hub", "Gurugram", (ASIAN,), 1800, ("fabhotels-cyberhub",)),
    Place("The Beer Cafe", "Cyber Hub", "Gurugram", (CONTINENTAL,), 1800, ("fabhotels-cyberhub",), kind=CAFE_KIND),
    Place("SodaBottleOpenerWala", "Cyber Hub", "Gurugram", (REGIONAL,), 1900, ("fabhotels-cyberhub",)),
    Place("Burma Burma", "Cyber Hub", "Gurugram", (ASIAN,), 1900, ("fabhotels-cyberhub",), veg_only=True),
    # Two sources, two answers, a year apart. Kept as the span between them.
    Place("SOCIAL", "Cyber Hub", "Gurugram", (NORTH, CONTINENTAL, ASIAN), 1500,
          ("dinediary-cyberhub", "fabhotels-cyberhub"), for_two_max=2000),
    Place("Italiano", "Cyber Hub", "Gurugram", (ITALIAN,), 2000, ("fabhotels-cyberhub",)),
    Place("Soi 7 Pub & Brewery", "Cyber Hub", "Gurugram", (CONTINENTAL, NORTH), 2000, ("fabhotels-cyberhub",)),
    Place("Farzi Cafe", "Cyber Hub", "Gurugram", (FUSION,), 2000, ("fabhotels-cyberhub",)),
    Place("Cafe Delhi Heights", "Cyber Hub", "Gurugram", (CONTINENTAL, NORTH, ITALIAN), 1500,
          ("dinediary-cyberhub", "fabhotels-cyberhub"), for_two_max=2500),
    Place("Made in Punjab", "Cyber Hub", "Gurugram", (NORTH,), 2500, ("fabhotels-cyberhub",)),
    Place("Nando's", "Cyber Hub", "Gurugram", (CONTINENTAL,), 2500, ("fabhotels-cyberhub",)),
    Place("The Drunken Botanist", "Cyber Hub", "Gurugram", (NORTH, ASIAN, CONTINENTAL), 2500, ("fabhotels-cyberhub",)),
    Place("United Coffee House Rewind", "Cyber Hub", "Gurugram", (NORTH, SOUTH), 2500, ("fabhotels-cyberhub",)),
    Place("Imperfecto", "Cyber Hub", "Gurugram", (MEDITERRANEAN, CONTINENTAL), 3000, ("fabhotels-cyberhub",)),
    Place("Sutra Gastro Pub", "Cyber Hub", "Gurugram", (NORTH, CONTINENTAL, CHINESE), 3000, ("fabhotels-cyberhub",)),
    Place("Quaff Microbrewery", "Cyber Hub", "Gurugram", (CONTINENTAL, NORTH), 3000, ("fabhotels-cyberhub",)),
    Place("The Wine Company", "Cyber Hub", "Gurugram", (CONTINENTAL, ITALIAN), 3500, ("fabhotels-cyberhub",)),
]

# ── Noida ─────────────────────────────────────────────────────────────────────
_NOIDA = [
    Place("Naivedyam", "Sector 63", "Noida", (SOUTH,), 500, ("fabhotels-noida",), veg_only=True),
    Place("Malabar Junction", "Sector 62", "Noida", (SOUTH, NORTH, CHINESE), 500, ("fabhotels-noida",)),
    Place("Dilli 6", "Sector 15", "Noida", (NORTH, CHINESE), 500, ("fabhotels-noida",), veg_only=True),
    Place("The Courtyard Cafe", "Sector 126", "Noida", (CONTINENTAL, CHINESE, NORTH), 800, ("fabhotels-noida",), kind=CAFE_KIND),
    Place("Bohemia", "Sector 38A", "Noida", (ITALIAN, MEDITERRANEAN), 850, ("fabhotels-noida",), kind=CAFE_KIND),
    Place("Berco's", "Sector 12", "Noida", (CHINESE, ASIAN), 1100, ("fabhotels-noida",)),
    Place("Binge Restaurant", "Sector 62", "Noida", (CHINESE, NORTH, CONTINENTAL), 1100, ("fabhotels-noida",)),
    Place("Asia Kitchen", "Sector 63", "Noida", (CHINESE, ASIAN, NORTH), 1200, ("fabhotels-noida",)),
    Place("The Stonefire Barbeque", "Sector 62", "Noida", (BBQ, NORTH, CHINESE), 1200, ("fabhotels-noida",), kind=BUFFET),
    Place("Jungle Jamboree", "Sector 32", "Noida", (NORTH, CHINESE, ITALIAN, MUGHLAI), 1200, ("fabhotels-noida",)),
    Place("Desi Vibes", "Sector 18", "Noida", (NORTH, MUGHLAI), 1400,
          ("fabhotels-noida", "pulseofnoida"), for_two_max=1800),
    Place("Ching Shihh", "Sector 32", "Noida", (ASIAN,), 1450, ("fabhotels-noida",)),
    Place("Gravity Mantra", "Sector 18", "Noida", (CONTINENTAL, NORTH, CHINESE), 1500, ("fabhotels-noida",)),
    Place("The Ancient Barbeque", "Sector 63", "Noida", (BBQ, NORTH, CHINESE), 1500, ("fabhotels-noida",), kind=BUFFET),
    Place("The Yellow Chilli", "Sector 63", "Noida", (NORTH, MUGHLAI), 1600, ("fabhotels-noida",)),
    Place("Barbeque Nation", "Sector 16", "Noida", (BBQ, NORTH, MEDITERRANEAN), 1600, ("fabhotels-noida",), kind=BUFFET),
    Place("Pirates of Grill", "Sector 18", "Noida", (BBQ, MUGHLAI, CONTINENTAL), 1800, ("fabhotels-noida",), kind=BUFFET),
    Place("Burma Burma", "DLF Mall of India, Sector 18", "Noida", (ASIAN,), 1800, ("pulseofnoida",), veg_only=True),
    Place("AB's Absolute Barbecues", "Sector 62", "Noida", (BBQ, NORTH, MUGHLAI), 1898,
          ("magicpin-buffet-noida",), for_two_max=2598, kind=BUFFET),
    Place("I Sacked Newton", "Sector 32", "Noida", (MEDITERRANEAN, ITALIAN, CONTINENTAL), 2000, ("fabhotels-noida",)),
    Place("The Culinary Court", "Sector 62", "Noida", (NORTH, CONTINENTAL, CHINESE), 2000, ("fabhotels-noida",)),
    Place("SkyHouse", "Sector 32", "Noida", (CONTINENTAL, NORTH, MUGHLAI), 2200, ("fabhotels-noida",)),
    Place("R.E.D", "Sector 18", "Noida", (ASIAN,), 3000, ("fabhotels-noida",)),
    Place("Made in India", "Sector 18", "Noida", (NORTH, MUGHLAI), 3800, ("fabhotels-noida",)),
    Place("S-18", "Sector 18", "Noida", (NORTH, CONTINENTAL), 5000, ("pulseofnoida",)),
]

# ── Delhi ─────────────────────────────────────────────────────────────────────
_DELHI = [
    Place("Indian Coffee House", "Connaught Place", "Delhi", (SOUTH,), 200, ("fabhotels-delhi",), kind=CAFE_KIND),
    Place("Wenger's", "Connaught Place", "Delhi", (BAKERY,), 400, ("fabhotels-delhi",), kind=CAFE_KIND),
    Place("Mughlai Kitchen", "Karol Bagh", "Delhi", (MUGHLAI, NORTH), 550, ("magicpin-mughlai",)),
    Place("Kake Da Hotel", "Connaught Place", "Delhi", (NORTH, MUGHLAI), 600, ("fabhotels-delhi",)),
    Place("Changezi Chicken", "Karol Bagh", "Delhi", (MUGHLAI,), 700, ("magicpin-mughlai",)),
    Place("Karim's", "Jama Masjid", "Delhi", (MUGHLAI,), 800, ("fabhotels-delhi", "magicpin-mughlai")),
    # Two sources, a year and a neighbourhood write-up apart — kept as the span.
    Place("Rajinder Da Dhaba", "Safdarjung Enclave", "Delhi", (NORTH,), 800,
          ("fabhotels-delhi", "magicpin-southdelhi"), for_two_max=900),
    Place("Moti Mahal", "Daryaganj", "Delhi", (MUGHLAI, NORTH), 1000, ("fabhotels-delhi",)),
    Place("Kwality Restaurant", "Connaught Place", "Delhi", (NORTH,), 1250, ("fabhotels-delhi",)),
    Place("Pind Balluchi", "Multiple", "Delhi", (NORTH, MUGHLAI), 1300,
          ("fabhotels-delhi", "magicpin-delhi-top16"), for_two_max=1700),
    Place("Punjabi by Nature", "Multiple", "Delhi", (NORTH,), 1400, ("fabhotels-delhi",)),
    Place("Dakshin", "Saket", "Delhi", (SOUTH,), 4000, ("fabhotels-delhi",)),
    Place("Dum Pukht", "Chanakyapuri", "Delhi", (MUGHLAI, NORTH), 4000, ("fabhotels-delhi",)),
    Place("Varq", "Mansingh Road", "Delhi", (FUSION, NORTH), 4500, ("fabhotels-delhi",)),
    Place("Indian Accent", "Lodhi Road", "Delhi", (FUSION,), 5000,
          ("fabhotels-delhi", "magicpin-delhi-top16"), for_two_max=6000),
    Place("Spice Route", "Janpath", "Delhi", (ASIAN, SEAFOOD), 6000, ("fabhotels-delhi",)),
    Place("Bukhara", "Chanakyapuri", "Delhi", (MUGHLAI, NORTH), 6500,
          ("fabhotels-delhi", "magicpin-southdelhi"), for_two_max=7000),

    # ── Connaught Place, enriched ──
    Place("Zen", "Connaught Place", "Delhi", (ASIAN, CHINESE), 1900, ("magicpin-cp",)),
    Place("Ardor 2.1", "Connaught Place", "Delhi", (NORTH, CONTINENTAL), 2000,
          ("magicpin-cp", "magicpin-delhi-top16")),
    Place("Warehouse Cafe", "Connaught Place", "Delhi", (CONTINENTAL,), 2400, ("magicpin-cp",), kind=CAFE_KIND),
    Place("Saravana Bhavan", "Connaught Place", "Delhi", (SOUTH,), 600, ("magicpin-cp",), veg_only=True),
    Place("Masala Library by Jiggs Kalra", "Connaught Place", "Delhi", (FUSION, NORTH), 5000, ("magicpin-cp",)),
    Place("Lord Of The Drinks", "Connaught Place", "Delhi", (CONTINENTAL, NORTH), 2400,
          ("magicpin-cp", "magicpin-delhi-top16")),
    Place("Farzi Cafe", "Connaught Place", "Delhi", (FUSION,), 2500, ("magicpin-cp",)),
    Place("Cha Bar", "Connaught Place", "Delhi", (CAFE,), 450, ("magicpin-cp",), kind=CAFE_KIND),
    Place("Odeon Social", "Connaught Place", "Delhi", (NORTH, CONTINENTAL, ASIAN), 2000, ("magicpin-cp",)),
    Place("Jungle Jamboree", "Connaught Place", "Delhi", (NORTH, CHINESE, ITALIAN, MUGHLAI), 2600, ("magicpin-cp",)),
    Place("Garam Dharam", "Connaught Place", "Delhi", (NORTH,), 1300, ("magicpin-cp",)),
    Place("The Beer Cafe", "Connaught Place", "Delhi", (CONTINENTAL,), 2500, ("magicpin-cp",), kind=CAFE_KIND),
    Place("Natural Ice Cream", "Connaught Place", "Delhi", (CAFE,), 200, ("magicpin-cp",),
          kind=CAFE_KIND, veg_only=True),
    Place("Rajdhani Thali", "Connaught Place", "Delhi", (REGIONAL,), 800, ("zingbus-cp",),
          for_two_max=1100, veg_only=True),
    Place("Triveni Terrace Cafe", "Connaught Place", "Delhi", (SOUTH, NORTH), 200, ("zingbus-cp",),
          for_two_max=360, kind=CAFE_KIND),
    Place("Nizam's Kathi Kabab", "Connaught Place", "Delhi", (MUGHLAI, STREET), 400, ("zingbus-cp",),
          for_two_max=800),

    # ── South Delhi (Saket / GK / Hauz Khas / Safdarjung / Mehrauli), enriched ──
    Place("Pa Pa Ya", "Saket", "Delhi", (ASIAN,), 2000, ("magicpin-southdelhi",)),
    Place("Diggin", "Anand Lok", "Delhi", (CONTINENTAL, CAFE), 1400,
          ("magicpin-southdelhi", "magicpin-delhi-top16"), for_two_max=1900, kind=CAFE_KIND),
    Place("Rose Cafe", "Saket", "Delhi", (CAFE, CONTINENTAL), 1350, ("magicpin-southdelhi",), kind=CAFE_KIND),
    Place("Olive Bar & Kitchen", "Mehrauli", "Delhi", (MEDITERRANEAN, ITALIAN), 3200,
          ("magicpin-southdelhi", "magicpin-delhi-top16"), for_two_max=5000),
    Place("The Piano Man Jazz Club", "Safdarjung", "Delhi", (CONTINENTAL,), 1800, ("magicpin-southdelhi",)),
    Place("QD's Restaurant", "Satyaniketan", "Delhi", (NORTH, CHINESE), 800, ("magicpin-southdelhi",)),
    Place("Auro Kitchen & Bar", "Hauz Khas", "Delhi", (NORTH, CONTINENTAL), 800,
          ("magicpin-southdelhi", "magicpin-hauzkhas"), for_two_max=1500),
    Place("Music & Mountains - Hillside Cafe", "Greater Kailash 1", "Delhi", (CAFE, ITALIAN, CONTINENTAL), 1350,
          ("magicpin-southdelhi", "magicpin-gk1"), for_two_max=1450, kind=CAFE_KIND),
    Place("Burma Burma", "Saket", "Delhi", (ASIAN,), 1500, ("magicpin-southdelhi",), veg_only=True),
    Place("The Big Chill", "Kailash Colony", "Delhi", (ITALIAN, CONTINENTAL), 1650, ("magicpin-southdelhi",)),
    Place("Carl's Junior", "Saket", "Delhi", (CONTINENTAL,), 550, ("magicpin-southdelhi",), kind=CAFE_KIND),
    Place("Yeti - The Himalayan Kitchen", "Greater Kailash 2", "Delhi", (ASIAN, REGIONAL), 1450,
          ("magicpin-southdelhi",)),
    Place("FIO Country Kitchen And Bar", "Saket", "Delhi", (CONTINENTAL, ITALIAN), 3200, ("magicpin-southdelhi",)),
    Place("Dhaba Estd. 1986", "Saket", "Delhi", (NORTH,), 1500, ("magicpin-southdelhi",)),
    Place("Yum Yum Cha", "Saket", "Delhi", (ASIAN,), 1650, ("magicpin-southdelhi",)),
    Place("Mamagoto", "Saket", "Delhi", (ASIAN,), 1650, ("magicpin-southdelhi",)),
    Place("The Hukman's", "Saket", "Delhi", (NORTH,), 500, ("magicpin-southdelhi",)),
    Place("Beeryani", "Safdarjung", "Delhi", (NORTH,), 900, ("magicpin-delhi-top16",)),
    Place("Berco's", "Connaught Place", "Delhi", (CHINESE, ASIAN), 1500, ("magicpin-delhi-top16",)),
    Place("Jamun", "Lodhi Colony", "Delhi", (NORTH, FUSION), 1800, ("magicpin-delhi-top16",)),
    Place("Moti Mahal Delux", "Greater Kailash 2", "Delhi", (NORTH, MUGHLAI), 1700, ("magicpin-delhi-top16",)),
    Place("Naivedyam", "Hauz Khas Village", "Delhi", (SOUTH,), 550,
          ("magicpin-hauzkhas", "magicpin-delhi-top16"), for_two_max=800, veg_only=True),
    Place("Sagar Ratna", "Defence Colony", "Delhi", (SOUTH,), 600, ("magicpin-delhi-top16",), veg_only=True),
    Place("Hauz Khas Social", "Hauz Khas Village", "Delhi", (NORTH, CONTINENTAL, ASIAN), 1350,
          ("magicpin-hauzkhas", "magicpin-delhi-top16"), for_two_max=2300),
    Place("Summer House Cafe", "Hauz Khas Village", "Delhi", (ITALIAN, CONTINENTAL), 1800,
          ("magicpin-hauzkhas", "magicpin-delhi-top16"), for_two_max=2500, kind=CAFE_KIND),

    # ── Hauz Khas Village, enriched ──
    Place("Masha", "Hauz Khas Village", "Delhi", (CHINESE, NORTH), 1200, ("magicpin-hauzkhas",)),
    Place("Mia Bella - Romantic Kitchen & Bar", "Hauz Khas Village", "Delhi", (CONTINENTAL, ITALIAN), 1800,
          ("magicpin-hauzkhas",)),
    Place("Kaffeine", "Hauz Khas Village", "Delhi", (ITALIAN, CONTINENTAL), 1750, ("magicpin-hauzkhas",),
          kind=CAFE_KIND),
    Place("Maquina", "Hauz Khas Village", "Delhi", (CONTINENTAL, ITALIAN), 1850, ("magicpin-hauzkhas",)),
    Place("Rabbit Hole", "Hauz Khas Village", "Delhi", (NORTH, CONTINENTAL), 1750, ("magicpin-hauzkhas",)),
    Place("Garage Inc.", "Hauz Khas Village", "Delhi", (CONTINENTAL, ITALIAN), 1900, ("magicpin-hauzkhas",)),
    Place("Sandoz Kitchen & Bar", "Hauz Khas Village", "Delhi", (NORTH, CHINESE), 1400, ("magicpin-hauzkhas",)),
    Place("Elma's Bakery, Bar & Kitchen", "Hauz Khas Village", "Delhi", (BAKERY, CONTINENTAL, ITALIAN), 1900,
          ("magicpin-hauzkhas",)),
    Place("Coast Cafe", "Hauz Khas Village", "Delhi", (CONTINENTAL, SEAFOOD), 1500, ("magicpin-hauzkhas",),
          kind=CAFE_KIND),
    Place("Cafe Untold", "Hauz Khas Village", "Delhi", (CONTINENTAL, ITALIAN, NORTH), 500, ("magicpin-hauzkhas",),
          kind=CAFE_KIND),

    # ── Greater Kailash 1 (M Block), enriched ──
    Place("House Of Tigers", "Greater Kailash 1", "Delhi", (NORTH, CONTINENTAL), 950, ("magicpin-gk1",)),
    Place("Elation", "Greater Kailash 1", "Delhi", (ITALIAN, CONTINENTAL), 1550,
          ("magicpin-gk1", "magicpin-datenights"), for_two_max=2000),
    Place("Berco's", "Greater Kailash 1", "Delhi", (CHINESE, ASIAN), 1150, ("magicpin-gk1",)),
    Place("Gastronomica", "Greater Kailash 1", "Delhi", (ITALIAN, CONTINENTAL), 1450, ("magicpin-gk1",)),
    Place("Hunger Strike", "Greater Kailash 1", "Delhi", (STREET,), 300, ("magicpin-gk1",), kind=STREET_KIND),
    Place("Wafflesome", "Greater Kailash 1", "Delhi", (BAKERY,), 270, ("magicpin-gk1",), kind=CAFE_KIND),
    Place("Moti Mahal Delux", "Greater Kailash 1", "Delhi", (NORTH, MUGHLAI), 1250, ("magicpin-gk1",)),
    Place("Londoners", "Greater Kailash 1", "Delhi", (ITALIAN, CHINESE), 1700, ("magicpin-gk1",)),
    Place("Cafe Culture", "Greater Kailash 1", "Delhi", (ITALIAN, CONTINENTAL), 1000, ("magicpin-gk1",),
          kind=CAFE_KIND),
    Place("The Salad Story", "Greater Kailash 1", "Delhi", (CAFE,), 1500, ("magicpin-gk1",), kind=CAFE_KIND),
    Place("Doner Grill", "Greater Kailash 1", "Delhi", (MEDITERRANEAN,), 900, ("magicpin-gk1",)),
    Place("New Minar", "Greater Kailash 1", "Delhi", (NORTH,), 1300, ("magicpin-gk1",)),
    Place("Cafe Roadhouse", "Greater Kailash 1", "Delhi", (ITALIAN, CONTINENTAL), 1650, ("magicpin-gk1",),
          kind=CAFE_KIND),

    # ── Other neighbourhoods, from the Delhi date-night round-up ──
    Place("Miss Nora", "Rajouri Garden", "Delhi", (ITALIAN, CONTINENTAL), 1900, ("magicpin-datenights",)),
    Place("Castle's Barbeque", "Pitampura", "Delhi", (BBQ, NORTH), 2200, ("magicpin-datenights",), kind=BUFFET),
]

PLACES: list[Place] = _GURUGRAM + _NOIDA + _DELHI

# ── Dishes ────────────────────────────────────────────────────────────────────
# Two different things, kept in one table because they answer the same question.
#
# The named-place rows show what a restaurant actually serves and what it
# charges, so a suggestion is more than a number. The blank-place rows are
# Delhi street staples, which genuinely have no single address — the price is
# roughly the price whether you eat it in Chandni Chowk or Lajpat Nagar, and
# every source publishes them as bands for exactly that reason.
_DISHES = [
    # Cafe Delhi Heights, Cyber Hub
    Dish("Juicy Lucy Burger", "Gurugram", 695, ("dinediary-cyberhub",), "Cafe Delhi Heights", veg=False),
    Dish("Chicken Cacciatore", "Gurugram", 625, ("dinediary-cyberhub",), "Cafe Delhi Heights", veg=False),
    Dish("Pesto Spaghetti", "Gurugram", 565, ("dinediary-cyberhub",), "Cafe Delhi Heights"),
    Dish("Panzanella Salad", "Gurugram", 495, ("dinediary-cyberhub",), "Cafe Delhi Heights", course="starter"),
    Dish("Orange Lemonade", "Gurugram", 245, ("dinediary-cyberhub",), "Cafe Delhi Heights", course="drink"),
    # SOCIAL, Cyber Hub
    Dish("Butter Chicken Biryani", "Gurugram", 545, ("dinediary-cyberhub",), "SOCIAL", veg=False, course="rice"),
    Dish("Korean Chicken Bowl", "Gurugram", 485, ("dinediary-cyberhub",), "SOCIAL", veg=False),
    Dish("Loaded Nachos", "Gurugram", 445, ("dinediary-cyberhub",), "SOCIAL", course="starter"),
    Dish("Jalapeno Cheese Nads", "Gurugram", 395, ("dinediary-cyberhub",), "SOCIAL", course="starter"),
    Dish("Crispy Corn", "Gurugram", 325, ("dinediary-cyberhub",), "SOCIAL", course="starter"),
    # YouMee, Cyber Hub
    Dish("Sushi Platter", "Gurugram", 695, ("dinediary-cyberhub",), "YouMee", veg=False, course="starter"),
    Dish("Dynamite Roll", "Gurugram", 575, ("dinediary-cyberhub",), "YouMee", veg=False, course="starter"),
    Dish("Korean Fried Chicken", "Gurugram", 525, ("dinediary-cyberhub",), "YouMee", veg=False, course="starter"),
    Dish("Chicken Ramen", "Gurugram", 495, ("dinediary-cyberhub",), "YouMee", veg=False),
    Dish("Bubble Tea", "Gurugram", 225, ("dinediary-cyberhub",), "YouMee", course="drink"),
    # Gola Sizzlers, Cyber Hub
    Dish("Chicken Steak", "Gurugram", 695, ("dinediary-cyberhub",), "Gola Sizzlers", veg=False),
    Dish("Paneer Sizzler", "Gurugram", 645, ("dinediary-cyberhub",), "Gola Sizzlers"),
    Dish("Veg Sizzler", "Gurugram", 595, ("dinediary-cyberhub",), "Gola Sizzlers"),
    Dish("Brownie Sizzler", "Gurugram", 395, ("dinediary-cyberhub",), "Gola Sizzlers", course="dessert"),
    Dish("Hot Chocolate Fudge", "Gurugram", 345, ("dinediary-cyberhub",), "Gola Sizzlers", course="dessert"),
    # Mustard Madras, Cyber Hub
    Dish("Appam & Stew", "Gurugram", 395, ("dinediary-cyberhub",), "Mustard Madras"),
    Dish("Ghee Podi Dosa", "Gurugram", 345, ("dinediary-cyberhub",), "Mustard Madras"),
    Dish("Curd Rice", "Gurugram", 285, ("dinediary-cyberhub",), "Mustard Madras", course="rice"),
    Dish("Mini Idli", "Gurugram", 265, ("dinediary-cyberhub",), "Mustard Madras", course="starter"),
    Dish("Filter Coffee", "Gurugram", 145, ("dinediary-cyberhub",), "Mustard Madras", course="drink"),
    # Dolma Aunty's Momos, Lajpat Nagar — a named stall with a published price
    Dish("Momos (Dolma Aunty's)", "Delhi", 70, ("magicpin-lajpatnagar-street",), "Dolma Aunty's Momos",
         price_max=150, veg=False, course="starter"),
    # Delhi street food — published as per-plate bands, no single address
    Dish("Chole Bhature", "Delhi", 100, ("comfortmytrip-street", "traveltriangle-street"), price_max=180),
    Dish("Paratha (Paranthe Wali Gali)", "Delhi", 50, ("comfortmytrip-street",), price_max=120, course="bread"),
    Dish("Momos (plate of 6-8)", "Delhi", 30, ("comfortmytrip-street",), price_max=80, veg=False, course="starter"),
    Dish("Kathi Roll", "Delhi", 30, ("comfortmytrip-street",), price_max=50, veg=False),
]

DISHES: list[Dish] = _DISHES

CITIES = sorted({p.city for p in PLACES})
CUISINES = sorted({c for p in PLACES for c in p.cuisines})


def for_city(city: str) -> list[Place]:
    return [p for p in PLACES if p.city.lower() == (city or "").lower()]


def dishes_at(place: str, city: str = "") -> list[Dish]:
    """Menu items we have real prices for at one restaurant."""
    key = " ".join((place or "").lower().split())
    return [
        d for d in DISHES
        if d.place and " ".join(d.place.lower().split()) == key
        and (not city or d.city.lower() == city.lower())
    ]


def street_food(city: str) -> list[Dish]:
    """Staples with no single address, for the small-budget answer."""
    return [d for d in DISHES if not d.place and d.city.lower() == (city or "").lower()]


def cuisines_in(city: str) -> list[str]:
    return sorted({c for p in for_city(city) for c in p.cuisines})


def coverage() -> dict[str, dict]:
    """What we actually hold, so gaps are visible rather than assumed away."""
    out: dict[str, dict] = {}
    for city in CITIES:
        rows = for_city(city)
        out[city] = {
            "places": len(rows),
            "with_menu": len({p.name for p in rows if dishes_at(p.name, city)}),
            "street_items": len(street_food(city)),
            "cheapest_for_two": min(r.mid for r in rows),
            "dearest_for_two": max(r.mid for r in rows),
            "cuisines": len(cuisines_in(city)),
            "kinds": sorted({r.kind for r in rows}),
        }
    return out


if __name__ == "__main__":  # pragma: no cover - a look at the table, not a test
    print(f"{len(PLACES)} places, {len(DISHES)} priced dishes\n")
    for city, c in coverage().items():
        print(f"{city:10} {c['places']:3} places  "
              f"Rs {c['cheapest_for_two']:.0f}-{c['dearest_for_two']:.0f} for two  "
              f"{c['cuisines']} cuisines  {c['with_menu']} with menu prices  "
              f"{c['street_items']} street items")
    print("\nSources:")
    for k, v in SOURCES.items():
        print(f"  {k:24} {v['as_of']}  {v['url']}")

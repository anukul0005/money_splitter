"""Category / subcategory for a payee name, by keyword rules.

Used to build the spending dataset (export_ml_dataset.py). Rules are tried
in order and the first match wins, so specific ones sit above general ones
("Apollo Pharmacy" must be Health before "pharmacy"-less food rules, "BP"
fuel before anything else matching "bp"). Payees that are just a person's
name, a masked number or a phone UPI id match nothing; categorize() then
falls back to the title of the app entry the payment was linked to, and
only after that to "Individual" - with no pretence of knowing what for.
"""
from __future__ import annotations

import re

# (category, subcategory, regex on the lower-cased payee name)
_RULES: list[tuple[str, str, str]] = [
    # Food & dining
    ("Food & Dining", "Office canteen", r"smartq|coriander|tapri kpmg|canteen|indiyeah|anmol catering|grubox|vendiman|culinary brands|bird catering"),
    ("Food & Dining", "Food delivery", r"swiggy(?! ?instamart)|zomato|eternal limited|bundl tech|dominos|jubilant food"),
    ("Groceries", "Quick commerce", r"blinkit|zepto|instamart|bigbasket|commodum|^pincode$"),
    ("Food & Dining", "Restaurants", r"restaurant|dhaba|kitchen|district|haldiram|mcdonald|connaught plaza|kfc|subway|burger king|taco bell|biryani|"
                                      r"zensho|postman|tandoori|spice king|bikaner|sagar ratna|wow momo|theobroma|cafe|caf[eé]|bistro|dining|"
                                      r"food ?court|lounge|diner|hospitality|barbeque|punjab|chaap|kebab|kawab|kababi|desi nookad|paa g|"
                                      r"pari paratha|passion foods|urban punjab|burrito|wakhra swaad|karims|banaaras|jharokha|mr\.?brown|"
                                      r"soho garden|chalde firde|chaska|harry s kitchen|wadeshwar|kannu ki chai|udipi|food durbar|hotel|"
                                      r"twisting tiger|tlw@cyberhub|culinary delight|adige|aarvi foods|chicky flames|green foods"),
    ("Food & Dining", "Street food & snacks", r"momo|paratha|chaat|chat bhandar|omelet|omlet|amlet|egg|sandwich|vada ?pav|kulch|roll|litti|samosa|"
                                               r"shawarma|hot dog|burger|pakod|snack|fast ?food|chinese|noodle|maggi|gol gappe|pani puri|"
                                               r"dosa|nasta|chicken|mutton|seekh|naan|chhole|chakhna|corner|grill|bhakar|chikki|food"),
    ("Food & Dining", "Tea & coffee", r"\btea\b|chai|coffee|roaster|tea stall|tea post|tea point"),
    ("Food & Dining", "Juice & beverages", r"juice|shake|soda|sharbat|coke|cola|pepsi|sprite|water bottle|nariyal|lemon|diet munch|ice ?cream|kwality|amul|dairy|mother dairy|milk"),
    ("Food & Dining", "Sweets & bakery", r"sweet|bakery|bakers|cake|pastry|halwai|mishti|mishthan|laddu|namkeen"),
    # Alcohol
    ("Alcohol", "Liquor store", r"wine|beer|spirits|liquor|vandyk|21 and above|rs beverages|\bfl\b|beverages"),
    ("Alcohol", "Bar", r"\bbar\b|pub\b"),
    # Groceries
    ("Groceries", "Fruits & vegetables", r"fruit|vegetabl|vegitabl|sabzi|green grocers"),
    ("Groceries", "Kirana & supermarket", r"general store|kirana|kiryana|grocery|supermarket|super market|mart\b|avenue supermarts|"
                                         r"provision|store|shopee|modbzr|modern bazaar|atta chakki|masale|traders|daily deals|rama stores|naseem"),
    # Transport
    ("Transport", "Fuel", r"service station|service stn|fuels?\b|filling|fill point|petrol|pateolium|petrolium|hpcl|iocl|\bbp\b|coco bp|"
                          r"diesel|super service|shiva gaurav"),
    ("Transport", "Metro", r"metro|dmrc|mmrda|ncmc|bill paid - metro"),
    ("Transport", "Cab & auto", r"rapido|roppen|\bola\b|olamoney|ola money|uber|cariot|garage on call"),
    ("Transport", "Train", r"irctc|indian railways|rail ahar|\brail\b"),
    ("Transport", "Bus", r"redbus|bus\b"),
    ("Transport", "Parking & tolls", r"parking|parkplus|fastag|\(t-\d\)"),
    ("Transport", "Vehicle purchase & service", r"motors|automobile|auto cent|tyre|torque"),
    # Travel
    ("Travel", "Stays", r"airbnb|oyo|jas holidays|hotel vaishali"),
    ("Travel", "Tours & bookings", r"travels|tours|akbartravels|irctctourism|tourism"),
    # Shopping
    ("Shopping", "Online shopping", r"amazon|flipkart|meesho|nykaa|myntra|ajio"),
    ("Shopping", "Clothing & footwear", r"bata|westside|jockey|fashion|garment|benetton|cantabil|shoppers stop|raymond|apparel|"
                                        r"cobb|max retail|duke|wildcraft|shoes|riyagarments"),
    ("Shopping", "Sports", r"decathlon|sports"),
    ("Shopping", "Electronics & mobile", r"mobile|electronic|electrical|hardware|infotech|communication"),
    ("Shopping", "Books & stationery", r"stationer|book|wheeler"),
    ("Shopping", "Home & garden", r"plywood|timber|nursery|flowers"),
    # Health
    ("Health", "Pharmacy", r"pharma|chemist|medical|medicine|1mg|janaushadhi"),
    ("Health", "Doctor & hospital", r"hospital|clinic|diagnostic|dental|homoeo|homeo|\bdr\b"),
    # Bills
    ("Bills & Utilities", "Mobile & internet", r"airtel|\bjio\b|jio platforms|jio postpaid|recharge|vodafone|\bvi\b"),
    ("Bills & Utilities", "Other bills", r"bill paid|billdesk"),
    # Entertainment
    ("Entertainment", "Movies & events", r"pvr|inox|bookmyshow|bigtree|cinema|coriander event|sun entertainment"),
    ("Entertainment", "Subscriptions", r"apple|jiocinema|fancode|story tv|eversub|google|netflix|spotify|hotstar|youtube"),
    ("Entertainment", "Gaming & fantasy", r"dream11|mpl|winzo"),
    # Personal care & fitness
    ("Personal Care", "Salon & beauty", r"salon|saloon|hair|beauty|naturals|follicular|fixderma|innovist|monarch"),
    ("Personal Care", "Gym & fitness", r"\bgym\b|fitness|in shape|iron champ"),
    # Education & work
    ("Education", "Courses & exams", r"testbook|oliveboard|adda247|recruitment board|preplaced|education|appx"),
    ("Education", "Library & coworking", r"library|co ?working"),
    # Services & other
    ("Services", "Courier", r"dtdc|ekart|courier"),
    ("Services", "Astrology", r"astro"),
    ("Services", "Laundry", r"dhobi|laundry"),
    ("Donations", "Religious & charity", r"mandir|temple|\btrust\b|foundation|charit|samiti"),
]
_COMPILED = [(c, s, re.compile(p)) for c, s, p in _RULES]

# A bare masked number, a phone-number UPI id, or "Bank Account X..." - who
# it went to is unknowable from the statement.
_ANONYMOUS = re.compile(r"^(\*+|x+)\d+$|^\d{8,}|^bank account|^\d{10}\w*$|^paid$|^user$", re.I)
# Business-y words that, absent any rule above, still say "a shop".
_BUSINESS = re.compile(r"enterprise|traders|private|pvt|ltd|limited|llp|services|solutions|company|shop|store|centre|center|"
                       r"technolog|india|rzp|razorpay|payu|paytm@|@|ventures|associates|group", re.I)


def _rule(text: str) -> tuple[str, str] | None:
    t = (text or "").lower()
    for c, s, rx in _COMPILED:
        if rx.search(t):
            return c, s
    return None


def categorize(payee: str, amount: float, linked_title: str | None = None) -> tuple[str, str]:
    """(category, subcategory) for one payment."""
    hit = _rule(payee)
    if hit:
        return hit
    if linked_title:
        hit = _rule(linked_title)
        if hit:
            return hit
    if _BUSINESS.search(payee or ""):
        return "Other", "Unclassified merchant"
    if _ANONYMOUS.search((payee or "").strip()):
        return "Individual", "Unknown payee"
    # A person's name. Small amounts to a named person are overwhelmingly
    # street vendors and kiosks paid by their personal UPI; larger ones are
    # rent, help, repairs, or money to people - kept apart, not guessed.
    return ("Individual", "Small vendor (likely)") if amount <= 200 else ("Individual", "Person-to-person")

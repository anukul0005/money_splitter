"""What an ingredient costs, in ₹ a kg (or litre).

  - mandi: today's modal price at Delhi's mandis (else all India) from
    data.gov.in's daily commodity prices, when a key is set
    (data_gov_in_key). Wholesale - shops charge more - and said so.
  - estimate: the reference price in foods.CATALOGUE, hand-entered typical
    Delhi retail prices - everything mandis don't sell (paneer, oil,
    spices), and everything when there's no key.
Never the LLM's guess.
"""
from __future__ import annotations

import json
import statistics
import threading
import urllib.parse
import urllib.request
from datetime import date

from . import DATA_DIR, key
from .foods import CATALOGUE

RESOURCE = "9ef84268-d588-465a-a308-a864a43d0070"    # Current daily price of various commodities from various markets (Mandi)
SOURCE_URL = "https://www.data.gov.in/resource/current-daily-price-various-commodities-various-markets-mandi"

# Catalogue ingredient -> the commodity's name in the mandi data (Agmarknet's spelling)
MANDI = {
    "onion": "Onion", "tomato": "Tomato", "potato": "Potato", "cauliflower": "Cauliflower", "cabbage": "Cabbage",
    "spinach": "Spinach", "peas": "Peas Wet", "capsicum": "Capsicum", "carrot": "Carrot",
    "cucumber": "Cucumbar(Kheera)", "beans": "Beans", "bhindi": "Bhindi(Ladies Finger)", "brinjal": "Brinjal",
    "lauki": "Bottle gourd", "pumpkin": "Pumpkin", "banana": "Banana", "apple": "Apple", "papaya": "Papaya",
    "orange": "Orange", "lemon": "Lemon", "ginger": "Ginger(Green)", "garlic": "Garlic",
    "green chilli": "Green Chilli", "coriander leaves": "Coriander(Leaves)", "sweet potato": "Sweet Potato",
    "beetroot": "Beetroot", "methi": "Methi(Leaves)", "mint": "Mint(Pudina)", "rice": "Rice", "atta": "Wheat Atta",
    "toor dal": "Arhar Dal(Tur Dal)", "moong dal": "Green Gram Dal (Moong Dal)", "masoor dal": "Masur Dal",
    "urad dal": "Black Gram Dal (Urd Dal)", "chana dal": "Bengal Gram Dal (Chana Dal)", "peanuts": "Groundnut",
}

_lock = threading.Lock()
_CACHE = DATA_DIR / "mandi.json"


def _mandi(ingredient: str) -> float | None:
    """Today's mandi price, ₹ a kg; fetched once a day per commodity."""
    api_key = key("data_gov_in_key")
    commodity = MANDI.get(ingredient)
    if not api_key or not commodity:
        return None
    today = date.today().isoformat()
    try:
        cache = json.loads(_CACHE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cache = {}
    hit = cache.get(commodity)
    if hit and hit.get("day") == today:
        return hit.get("per_kg")
    per_kg = None
    for state in ("NCT of Delhi", None):
        params = {"api-key": api_key, "format": "json", "limit": 200, "filters[commodity]": commodity}
        if state:
            params["filters[state]"] = state
        try:
            with urllib.request.urlopen(f"https://api.data.gov.in/resource/{RESOURCE}?{urllib.parse.urlencode(params)}",
                                        timeout=20) as r:
                recs = json.loads(r.read().decode()).get("records", [])
        except Exception:
            return hit.get("per_kg") if hit else None      # yesterday's beats none
        prices = [float(x["modal_price"]) for x in recs if str(x.get("modal_price") or "").replace(".", "").isdigit()]
        if prices:
            per_kg = round(statistics.median(prices) / 100, 1)     # quoted a quintal
            break
    with _lock:
        cache[commodity] = {"day": today, "per_kg": per_kg}
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        _CACHE.write_text(json.dumps(cache), encoding="utf-8")
    return per_kg


def price(ingredient: str) -> dict | None:
    """{"per_kg": ₹, "source": "mandi" | "estimate"} for a catalogue ingredient."""
    m = _mandi(ingredient)
    if m:
        return {"per_kg": m, "source": "mandi"}
    entry = CATALOGUE.get(ingredient)
    if entry is None:
        return None
    return {"per_kg": entry[2], "source": "estimate"}


def mandi_on() -> bool:
    return bool(key("data_gov_in_key"))

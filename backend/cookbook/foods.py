"""Single ingredients: what a recipe's "paneer 100 g" is, its nutrition
(USDA FoodData Central) and its reference price.

The catalogue below says which USDA entry each Indian ingredient is - the
LLM never picks it. USDA answers are kept in DATA_DIR once fetched: the
free key allows 1,000 lookups an hour (the shared DEMO_KEY 30), and an
ingredient never needs looking up twice.
"""
from __future__ import annotations

import json
import re
import threading
import urllib.error
import urllib.request
from difflib import SequenceMatcher

from . import DATA_DIR, key

SOURCE = "USDA FoodData Central"
SOURCE_URL = "https://fdc.nal.usda.gov/"

# key: (other names it goes by, the USDA entry, reference ₹ a kg/litre, grams in one "piece")
# Prices are hand-entered typical Delhi retail prices (Nov 2026) - shown as
# estimates wherever they're used; mandi prices replace them when set up.
CATALOGUE: dict[str, tuple[list[str], str, float, float | None]] = {
    # grains, flours
    "rice":            (["chawal", "white rice", "sona masoori", "raw rice"], "Rice, white, long-grain, regular, raw, unenriched", 60, None),
    "basmati rice":    (["basmati"], "Rice, white, long-grain, regular, raw, unenriched", 120, None),
    "brown rice":      ([], "Rice, brown, long-grain, raw", 140, None),
    "atta":            (["whole wheat flour", "wheat flour", "chapati flour", "gehun ka atta"], "Wheat flour, whole-grain", 45, None),
    "maida":           (["all purpose flour", "refined flour", "plain flour"], "Wheat flour, white, all-purpose, unenriched", 45, None),
    "besan":           (["gram flour", "chickpea flour"], "Chickpea flour (besan)", 100, None),
    "suji":            (["sooji", "semolina", "rava", "rawa"], "Semolina, unenriched", 50, None),
    "poha":            (["flattened rice", "beaten rice", "chivda"], "Rice, white, long-grain, regular, raw, unenriched", 60, None),
    "oats":            (["rolled oats", "oatmeal"], "Oats", 180, None),
    "ragi":            (["finger millet", "nachni", "ragi flour"], "Millet, raw", 80, None),
    "bajra":           (["pearl millet", "bajra flour"], "Millet, raw", 50, None),
    "jowar":           (["sorghum", "jowar flour"], "Sorghum grain", 60, None),
    "daliya":          (["dalia", "broken wheat", "cracked wheat", "bulgur"], "Bulgur, dry", 60, None),
    "quinoa":          ([], "Quinoa, uncooked", 400, None),
    "bread":           (["white bread", "sandwich bread"], "Bread, white, commercially prepared", 100, 25),
    "brown bread":     (["whole wheat bread", "multigrain bread"], "Bread, whole-wheat, commercially prepared", 120, 28),
    "vermicelli":      (["seviyan", "semiya"], "Spaghetti, dry, unenriched", 120, None),
    # dals, beans
    "toor dal":        (["arhar dal", "tuvar dal", "pigeon peas", "toovar dal"], "Pigeon peas (red gram), mature seeds, raw", 160, None),
    "moong dal":       (["mung dal", "yellow moong", "dhuli moong", "split moong"], "Mung beans, mature seeds, raw", 130, None),
    "whole moong":     (["green moong", "sabut moong", "green gram"], "Mung beans, mature seeds, raw", 130, None),
    "sprouts":         (["moong sprouts", "sprouted moong", "bean sprouts"], "Mung beans, mature seeds, sprouted, raw", 120, None),
    "masoor dal":      (["red lentils", "lentils", "masoor"], "Lentils, raw", 110, None),
    "chana dal":       (["split bengal gram"], "Chickpeas (garbanzo beans, bengal gram), mature seeds, raw", 100, None),
    "urad dal":        (["black gram", "urad", "split urad"], "Beans, black, mature seeds, raw", 140, None),
    "rajma":           (["kidney beans", "red kidney beans"], "Beans, kidney, red, mature seeds, raw", 160, None),
    "chickpeas":       (["kabuli chana", "chole", "chhole", "garbanzo"], "Chickpeas (garbanzo beans, bengal gram), mature seeds, raw", 130, None),
    "kala chana":      (["black chana", "black chickpeas"], "Chickpeas (garbanzo beans, bengal gram), mature seeds, raw", 100, None),
    "soya chunks":     (["soya", "nutrela", "soy chunks", "soya granules"], "Soy flour, defatted", 160, None),
    "peanuts":         (["groundnut", "moongphali", "mungfali"], "Peanuts, all types, raw", 140, None),
    # dairy, protein
    "paneer":          (["cottage cheese", "indian cottage cheese"], "Cheese, paneer", 400, None),
    "tofu":            (["bean curd"], "Tofu, firm, prepared with calcium sulfate", 300, None),
    "curd":            (["dahi", "yogurt", "yoghurt", "plain yogurt"], "Yogurt, plain, whole milk", 70, None),
    "hung curd":       (["greek yogurt", "hung dahi"], "Yogurt, Greek, plain, whole milk", 250, None),
    "milk":            (["doodh", "full cream milk", "toned milk"], "Milk, whole, 3.25% milkfat, with added vitamin D", 66, None),
    "buttermilk":      (["chaas", "chhaas", "lassi"], "Buttermilk, fluid, cultured, lowfat", 50, None),
    "ghee":            (["clarified butter", "desi ghee"], "Butter oil, anhydrous", 650, None),
    "butter":          (["makkhan"], "Butter, salted", 550, None),
    "cheese":          (["cheese slice", "processed cheese"], "Cheese, cheddar", 600, 20),
    "cream":           (["malai", "fresh cream"], "Cream, fluid, heavy whipping", 300, None),
    "egg":             (["eggs", "anda", "egg white", "boiled egg"], "Egg, whole, raw, fresh", 127, 55),
    "chicken":         (["chicken breast", "boneless chicken", "murgh"], "Chicken, broilers or fryers, breast, meat only, raw", 280, None),
    "chicken thigh":   (["chicken leg"], "Chicken, broilers or fryers, thigh, meat only, raw", 240, None),
    "mutton":          (["goat", "lamb", "gosht"], "Game meat, goat, raw", 750, None),
    "fish":            (["rohu", "basa", "surmai", "pomfret", "fish fillet"], "Fish, tilapia, raw", 320, None),
    "prawns":          (["shrimp", "jhinga"], "Crustaceans, shrimp, raw", 550, None),
    # vegetables
    "onion":           (["pyaz", "pyaaz", "kanda"], "Onions, raw", 40, 110),
    "tomato":          (["tamatar"], "Tomatoes, red, ripe, raw, year round average", 40, 100),
    "potato":          (["aloo", "alu"], "Potatoes, flesh and skin, raw", 30, 150),
    "sweet potato":    (["shakarkandi"], "Sweet potato, raw, unprepared", 60, 130),
    "spinach":         (["palak"], "Spinach, raw", 40, None),
    "methi":           (["fenugreek leaves", "kasuri methi"], "Spinach, raw", 60, None),
    "cauliflower":     (["gobi", "phool gobi"], "Cauliflower, raw", 50, None),
    "cabbage":         (["patta gobi", "band gobi"], "Cabbage, raw", 30, None),
    "peas":            (["matar", "green peas", "frozen peas"], "Peas, green, raw", 80, None),
    "capsicum":        (["shimla mirch", "bell pepper", "green capsicum"], "Peppers, sweet, green, raw", 80, 120),
    "carrot":          (["gajar"], "Carrots, raw", 50, 60),
    "cucumber":        (["kheera", "khira"], "Cucumber, with peel, raw", 40, 200),
    "beans":           (["french beans", "green beans"], "Beans, snap, green, raw", 80, None),
    "bhindi":          (["okra", "lady finger", "ladyfinger"], "Okra, raw", 60, None),
    "brinjal":         (["baingan", "eggplant", "aubergine"], "Eggplant, raw", 50, None),
    "lauki":           (["bottle gourd", "doodhi", "ghiya"], "Gourd, white-flowered (calabash), raw", 40, None),
    "pumpkin":         (["kaddu", "sitaphal"], "Pumpkin, raw", 40, None),
    "mushroom":        (["mushrooms", "button mushroom", "khumb"], "Mushrooms, white, raw", 250, None),
    "beetroot":        (["chukandar", "beet"], "Beets, raw", 50, 100),
    "corn":            (["sweet corn", "makka", "bhutta"], "Corn, sweet, yellow, raw", 80, None),
    "lettuce":         (["salad leaves"], "Lettuce, green leaf, raw", 150, None),
    "broccoli":        ([], "Broccoli, raw", 200, None),
    # fruit
    "banana":          (["kela"], "Bananas, raw", 50, 120),
    "apple":           (["seb"], "Apples, raw, with skin", 150, 180),
    "papaya":          (["papita"], "Papaya, raw", 50, None),
    "orange":          (["santra"], "Oranges, raw, all commercial varieties", 80, 150),
    "lemon":           (["nimbu", "lime", "lemon juice"], "Lemons, raw, without peel", 120, 50),
    "coconut":         (["nariyal", "grated coconut", "desiccated coconut"], "Nuts, coconut meat, raw", 120, None),
    "dates":           (["khajoor"], "Dates, medjool", 300, 8),
    # nuts, seeds
    "almonds":         (["badam"], "Nuts, almonds", 900, 1.2),
    "cashews":         (["kaju"], "Nuts, cashew nuts, raw", 1000, 1.5),
    "walnuts":         (["akhrot"], "Nuts, walnuts, english", 1200, 4),
    "chia seeds":      (["chia"], "Seeds, chia seeds, dried", 600, None),
    "flax seeds":      (["alsi", "flaxseed"], "Seeds, flaxseed", 250, None),
    "peanut butter":   ([], "Peanut butter, smooth style, without salt", 400, None),
    # aromatics, fats, sweet
    "ginger":          (["adrak"], "Ginger root, raw", 120, None),
    "garlic":          (["lahsun", "lehsun"], "Garlic, raw", 200, 4),
    "green chilli":    (["hari mirch", "green chili", "chilli"], "Peppers, hot chili, green, raw", 80, 5),
    "coriander leaves": (["dhania", "coriander", "cilantro", "hara dhania"], "Coriander (cilantro) leaves, raw", 100, None),
    "mint":            (["pudina"], "Spearmint, fresh", 100, None),
    "curry leaves":    (["kadi patta", "kari patta"], "Coriander (cilantro) leaves, raw", 100, None),
    "oil":             (["cooking oil", "vegetable oil", "sunflower oil", "refined oil", "groundnut oil"], "Oil, sunflower, linoleic, (approx. 65%)", 160, None),
    "mustard oil":     (["sarson ka tel"], "Oil, mustard", 170, None),
    "olive oil":       ([], "Oil, olive, salad or cooking", 900, None),
    "sugar":           (["cheeni", "shakkar"], "Sugars, granulated", 45, None),
    "jaggery":         (["gur", "gud"], "Sugars, brown", 70, None),
    "honey":           (["shahad"], "Honey", 400, None),
    "tea leaves":      (["chai patti", "tea"], "Tea, black, brewed, prepared with tap water", 500, None),
    # salt and spices: a pinch each - priced, nutrition left out (it's ~0)
    "salt":            (["namak", "rock salt", "black salt", "kala namak"], "", 25, None),
    "spices":          (["turmeric", "haldi", "red chilli powder", "chilli powder", "garam masala", "cumin", "jeera",
                         "mustard seeds", "rai", "hing", "asafoetida", "coriander powder", "dhania powder",
                         "chaat masala", "black pepper", "kali mirch", "cinnamon", "cardamom", "elaichi", "cloves",
                         "bay leaf", "ajwain", "kasoori methi", "pav bhaji masala", "sambar powder", "masala"], "", 400, None),
    "water":           (["paani"], "", 0, None),
}
STAPLES = {"salt", "spices", "water", "oil"}     # in every kitchen - never "you'd need"

_TRIM = re.compile(r"\b(fresh|chopped|finely|roughly|sliced|diced|grated|boiled|cooked|raw|soaked|small|medium|large|"
                   r"big|ripe|whole|crushed|minced|paste|powdered|ground|optional|to taste|for garnish|low fat|"
                   r"full fat|skimmed|homemade|organic|of)\b", re.I)


def _clean(s: str) -> str:
    s = re.sub(r"\(.*?\)", " ", (s or "").lower())
    s = _TRIM.sub(" ", s)
    s = re.sub(r"[^a-z ]", " ", s)
    s = " ".join(s.split())
    return s[:-1] if len(s) > 3 and s.endswith("s") and s[:-1] in _NAMES else s


_NAMES: dict[str, str] = {}
for _k, (_aliases, *_rest) in CATALOGUE.items():
    _NAMES[_k] = _k
    for _a in _aliases:
        _NAMES[_a] = _k


def identify(item: str) -> str | None:
    """Which catalogue ingredient "2 finely chopped onions" is: "onion"."""
    s = _clean(item)
    if not s:
        return None
    if s in _NAMES:
        return _NAMES[s]
    # A known name inside it ("paneer cubes", "toor dal soaked")
    hits = [(len(n), k) for n, k in _NAMES.items() if re.search(rf"\b{re.escape(n)}\b", s)]
    if hits:
        return max(hits)[1]
    best = max(_NAMES, key=lambda n: SequenceMatcher(None, s, n).ratio())
    return _NAMES[best] if SequenceMatcher(None, s, best).ratio() >= 0.84 else None


# ── USDA nutrition, per 100 g ──
_lock = threading.Lock()
_cache: dict | None = None
_CACHE = DATA_DIR / "usda.json"


def _load() -> dict:
    global _cache
    if _cache is None:
        try:
            _cache = json.loads(_CACHE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            _cache = {}
    return _cache


def _save() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _CACHE.write_text(json.dumps(_cache, ensure_ascii=False), encoding="utf-8")


def _nutrients(food: dict) -> dict:
    vals = {}
    for n in food.get("foodNutrients", []):
        name, unit, v = n.get("nutrientName", ""), n.get("unitName", ""), n.get("value")
        if v is None:
            continue
        if name.startswith("Energy") and unit == "KCAL":
            vals.setdefault("kcal", v)
        elif name == "Protein":
            vals["protein"] = v
        elif name.startswith("Carbohydrate, by difference"):
            vals["carbs"] = v
        elif name == "Total lipid (fat)":
            vals["fat"] = v
        elif name.startswith("Fiber, total"):
            vals["fibre"] = v
        elif name.startswith("Sugars, total") or name == "Total Sugars":
            vals.setdefault("sugar", v)
        elif name.startswith("Sodium"):
            vals["sodium_mg"] = v
    if "kcal" not in vals and {"protein", "carbs", "fat"} <= vals.keys():
        vals["kcal"] = round(4 * vals["protein"] + 4 * vals["carbs"] + 9 * vals["fat"], 1)
    return {k: round(float(v), 2) for k, v in vals.items()}


def nutrition(ingredient: str) -> dict | None:
    """Per 100 g of a catalogue ingredient, with where it came from:
    {kcal, protein, ..., "usda": {id, name}}. None when USDA can't be
    reached or has no fitting entry - the recipe then says so."""
    entry = CATALOGUE.get(ingredient)
    if not entry or not entry[1]:
        return None
    query = entry[1]
    cache = _load()
    if query in cache:
        return cache[query]
    payload = json.dumps({"query": query, "pageSize": 5,
                          "dataType": ["Foundation", "SR Legacy", "Survey (FNDDS)"]}).encode()
    req = urllib.request.Request(
        f"https://api.nal.usda.gov/fdc/v1/foods/search?api_key={key('fdc_api_key') or 'DEMO_KEY'}",
        data=payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            foods = json.loads(r.read().decode()).get("foods", [])
    except (urllib.error.URLError, ValueError, TimeoutError):
        return None                       # not cached - tried again next time
    # The entry named most like the one asked for, among those with numbers
    ranked = sorted(foods, key=lambda f: -SequenceMatcher(None, query.lower(), f.get("description", "").lower()).ratio())
    found = None
    for f in ranked:
        vals = _nutrients(f)
        if "kcal" in vals and SequenceMatcher(None, query.lower(), f["description"].lower()).ratio() >= 0.6:
            found = {**vals, "usda": {"id": f["fdcId"], "name": f["description"]}}
            break
    with _lock:
        cache[query] = found              # a miss is remembered too - it won't appear later
        _save()
    return found

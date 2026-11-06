"""Questions in, recipes out - the LLM for ideas, Python for numbers.

ask(): the question is read into what's wanted (meal, diet, calorie /
protein / price limits, ingredients to use, a plan or a comparison); INDB
dishes that meet the numbers are offered to the LLM, which picks and writes
the recipes; each is then worked out here - nutrition from INDB (else from
its ingredients, USDA), cost from its ingredients - and checked against
the limits in code. A recipe that misses a limit says by how much.

plan(): days of meals for a calorie target from body.targets(), dishes
from INDB, portions scaled here to land on the target.
"""
from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor

from . import DATA_DIR, body, chat_json, foods, indb, prices

NUTRIENTS = ("kcal", "protein", "carbs", "fat", "fibre", "sugar", "sodium_mg")

_INTENT = """Read a cooking question from an Indian user. Return ONLY JSON:
{
  "intent": "suggest" | "plan" | "compare",
  "meal": "breakfast" | "lunch" | "dinner" | "snack" | "any",
  "diet": "veg" | "egg" | "nonveg" | "vegan" | "any",
  "max_kcal": number or null (per serving; "low calorie" without a number = 400),
  "min_protein_g": number or null (per serving; "high protein" alone = 15),
  "max_cost_inr": number or null (per serving, only if a price limit is said),
  "use": [ingredients the user wants used, as said],
  "pantry_only": true if they want only what's already in their kitchen,
  "days": number or null (for a meal plan; "a week" = 7),
  "compare": [two dish names] or null,
  "goal": "weight_loss" | "muscle" | "general"
}
"Plan seven days of meals for weight loss" is a plan. "Compare X and Y" is compare. Everything else is suggest."""

_RECIPES = """You suggest Indian home recipes. Return ONLY JSON:
{"recipes": [{
  "name": string,
  "indb": [{"name": copied EXACTLY from the list of known dishes, "servings": number}] - the known dishes this recipe is, usually one (servings 1); a combination like rajma chawal is two (the rajma curry and the rice); [] when none fits,
  "why": one short line on why it fits the request,
  "meal": "breakfast" | "lunch" | "dinner" | "snack",
  "time_min": number,
  "ingredients": [{"item": plain ingredient name, "grams": number}] - for ONE serving, every ingredient with grams (an egg is 55 g; a pinch of spice 1 g; water 0),
  "steps": [up to 6 short steps]
}]}
Rules: never give calories, protein or prices - those are worked out separately. Prefer dishes from the known list when they fit (it's sorted best fit first). Keep to the diet. Use the ingredients the user names. Realistic home portions."""

_PLAN = """You plan everyday Indian home meals for weight loss. Return ONLY JSON:
{"days": [{"day": 1, "breakfast": [names], "lunch": [names], "dinner": [names], "snack": [names]}]}
Every name must be copied EXACTLY from the list of known dishes (each shows kcal and protein per serving).
- Breakfast is a breakfast: poha, upma, idli, dosa, chilla, paratha, daliya, oats, sprouts, eggs - never soup or raita alone.
- Lunch and dinner: a dal or curry or sabzi with roti or rice, plus a salad or raita if room; dinner lighter.
- Snack: fruit, sprouts, chana, buttermilk, a light bite.
- Aim for the day's calorie target and plenty of protein; no dish more than twice a week; keep to the diet. One to three dishes a meal."""

# What everyday Indian meals are made of - a plan's dishes are drawn from
# these as well as from the most protein for the calories (which alone is
# mostly soups and raitas)
_STAPLE_WORDS = ("poha", "upma", "idli", "dosa", "chilla", "cheela", "paratha", "parantha", "daliya", "dalia",
                 "oats", "uttapam", "dhokla", "sprout", "roti", "chapati", "phulka", "rice", "pulao", "khichdi",
                 "dal", "rajma", "chole", "chana", "sabzi", "curry", "bhurji", "paneer", "egg", "chicken", "fish",
                 "raita", "salad", "buttermilk", "chaas", "fruit", "tikka", "kadhi", "sambar", "bhaji")


def _diet_ok(d: dict, diet: str) -> bool:
    return diet in ("any", "nonveg", None) or (diet == "egg" and d["diet"] != "nonveg") or d["diet"] == "veg"


def _sum(parts: list[dict]) -> dict:
    return {k: round(sum(p.get(k, 0) for p in parts), 1) for k in NUTRIENTS}


def work_out(r: dict) -> dict:
    """Nutrition and cost for one serving of a recipe the LLM wrote."""
    lines, missing_nut, unpriced = [], [], []
    items = [x for x in r.get("ingredients") or [] if isinstance(x, dict)]
    keys = [foods.identify(str(x.get("item", ""))) for x in items]
    # USDA lookups side by side - each is a network call the first time
    with ThreadPoolExecutor(max_workers=6) as pool:
        nut = list(pool.map(lambda k: foods.nutrition(k) if k else None, keys))
    for x, k, n in zip(items, keys, nut):
        try:
            g = max(0.0, float(x.get("grams") or 0))
        except (TypeError, ValueError):
            g = 0.0
        p = prices.price(k) if k else None
        cost = round(g / 1000 * p["per_kg"], 1) if p else None
        line = {"item": str(x.get("item", ""))[:60], "grams": round(g), "as": k,
                "cost": cost, "price_source": p["source"] if p else None,
                "per_kg": p["per_kg"] if p else None}
        if n:
            line["nutrition"] = {kk: round(n.get(kk, 0) * g / 100, 1) for kk in NUTRIENTS}
            line["usda"] = n.get("usda")
        elif k not in foods.STAPLES and g > 2:
            missing_nut.append(line["item"])
        if cost is None and g > 0:
            unpriced.append(line["item"])
        lines.append(line)

    # The INDB dishes it's made of, each a known serving
    parts = []
    for p in r.get("indb") or []:
        if not isinstance(p, dict):
            continue
        d = indb.find(str(p.get("name") or ""), min_score=0.9)
        try:
            n_serv = min(4.0, max(0.25, float(p.get("servings") or 1)))
        except (TypeError, ValueError):
            n_serv = 1.0
        if d and d["serving"] and all(d is not q["dish"] for q in parts):
            parts.append({"dish": d, "servings": n_serv})
    if not parts:
        d = indb.find(r.get("name", ""), min_score=0.9)
        if d and d["serving"]:
            parts.append({"dish": d, "servings": 1.0})
    if parts:
        nutrition = _sum([{k: q["dish"]["serving"][k] * q["servings"] for k in NUTRIENTS} for q in parts])
        source = {"kind": "indb", "dishes": [
            {"name": q["dish"]["name"], "servings": q["servings"], "unit": q["dish"]["serving"]["unit"],
             "grams": round(q["dish"]["serving"]["grams"] * q["servings"])} for q in parts]}
    else:
        nutrition = _sum([l["nutrition"] for l in lines if "nutrition" in l])
        # Ingredients USDA had no figures for leave the total short - said so, not hidden
        source = {"kind": "usda", "missing": missing_nut}
    priced = [l["cost"] for l in lines if l["cost"] is not None]
    cost = {
        "total": round(sum(priced)) if priced else None,
        "unpriced": unpriced,
        "basis": "mandi" if any(l["price_source"] == "mandi" for l in lines) else "estimate",
    }
    return {**{k: r.get(k) for k in ("name", "why", "meal", "time_min", "steps")},
            "ingredients": lines, "nutrition": nutrition, "nutrition_source": source, "cost": cost}


def _check(rec: dict, want: dict, pantry: set[str]) -> dict:
    """The limits asked for, checked against the worked-out numbers. With
    ingredients missing from the figures, the calorie and protein checks
    aren't made - a short total would pass for the wrong reason."""
    n, misses = rec["nutrition"], []
    if rec["nutrition_source"].get("missing"):
        want = {**want, "max_kcal": None, "min_protein_g": None}
    if want.get("max_kcal") and n["kcal"] > want["max_kcal"]:
        misses.append(f"{round(n['kcal'])} kcal - {round(n['kcal'] - want['max_kcal'])} over the {want['max_kcal']} asked for")
    if want.get("min_protein_g") and n["protein"] < want["min_protein_g"]:
        misses.append(f"{n['protein']} g protein - under the {want['min_protein_g']} g asked for")
    c = rec["cost"]["total"]
    if want.get("max_cost_inr") and c is not None and c > want["max_cost_inr"]:
        misses.append(f"₹{c} - ₹{c - want['max_cost_inr']} over the ₹{want['max_cost_inr']} asked for")
    need = []
    if pantry:
        need = sorted({l["as"] or l["item"] for l in rec["ingredients"]
                       if l["grams"] > 0 and (l["as"] or l["item"]) not in pantry and l["as"] not in foods.STAPLES})
        if want.get("pantry_only") and need:
            misses.append("needs " + ", ".join(need))
    return {**rec, "fits": not misses, "misses": misses, "you_need": need}


def ask(question: str, pantry: list[str] | None = None, profile: dict | None = None) -> dict:
    want = chat_json(_INTENT, question.strip()[:800], temperature=0, timeout=30,
                     extra={"reasoning_effort": "low"})
    intent = want.get("intent")
    if intent == "plan":
        return plan(profile or {}, days=int(want.get("days") or 7), diet=want.get("diet") or "any", want=want)

    kitchen = {k for k in (foods.identify(p) for p in pantry or []) if k}
    use = [str(u) for u in (want.get("use") or [])][:8]
    diet = want.get("diet") or "any"
    if diet == "any" and profile and profile.get("diet"):
        diet = profile["diet"]
    # Dishes named for (a comparison's two, the ingredients asked for) and
    # dishes that meet the numbers asked for
    words = [w for u in use for w in (foods.identify(u) or u).lower().split()]
    if intent == "compare":
        words += [w for c in (want.get("compare") or [])[:2] for w in str(c).lower().split()]
    named = indb.named(words, diet, limit=30) if words else []
    fit = indb.candidates(diet, want.get("max_kcal"), want.get("min_protein_g"), None, limit=40)
    cands = list({d["code"]: d for d in named + fit}.values())[:60]
    listing = "\n".join(f"- {d['name']} | {round(d['serving']['kcal'])} kcal, {d['serving']['protein']} g protein per {d['serving']['unit']}"
                        for d in cands)
    ask_for = (f"Compare exactly these two: {', '.join(want['compare'][:2])}. Return just those two recipes."
               if intent == "compare" and want.get("compare") else "Suggest 4 recipes.")
    user = "\n".join(filter(None, [
        f"Request: {question.strip()[:800]}",
        f"Diet: {diet}",
        f"Kitchen has: {', '.join(sorted(kitchen))}" if kitchen else "",
        ask_for,
        "Known dishes (INDB):\n" + listing if listing else "",
    ]))
    out = chat_json(_RECIPES, user, temperature=0.4, timeout=60,
                    extra={"reasoning_effort": "low", "max_completion_tokens": 4000})
    raw = [r for r in out.get("recipes") or [] if isinstance(r, dict) and r.get("name")][:6]
    worked = [_check(work_out(r), want, kitchen) for r in raw]
    if intent != "compare":
        # What fits first; among those, most protein for the calories
        worked.sort(key=lambda r: (not r["fits"], -(r["nutrition"]["protein"] / max(r["nutrition"]["kcal"], 1))))
    return {"mode": "compare" if intent == "compare" else "suggest", "want": want, "recipes": worked}


# ── one dish, opened ──
_DETAILS = DATA_DIR / "dish_details.json"


def _details(name: str, serving: dict | None) -> dict:
    """A dish's ingredients (one serving) and method - the LLM's recipe
    knowledge, remembered per dish."""
    try:
        known = json.loads(_DETAILS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        known = {}
    if name in known:
        return known[name]
    size = f" - one serving is 1 {serving['unit']}, about {serving['grams']} g cooked" if serving else ""
    out = chat_json('Return ONLY JSON: {"ingredients": [{"item": plain ingredient name, "grams": number}], '
                    '"steps": [up to 7 short steps], "time_min": number}. Indian home cooking, ingredients for ONE '
                    "serving. No calories or prices.", f"Dish: {name}{size}", temperature=0.2, timeout=45,
                    prefer=1, extra={"reasoning_effort": "low", "max_completion_tokens": 1500})
    got = {"ingredients": [x for x in out.get("ingredients") or [] if isinstance(x, dict)][:20],
           "steps": [str(s) for s in out.get("steps") or []][:7], "time_min": out.get("time_min")}
    if got["ingredients"]:
        with _dish_ing_lock:
            known[name] = got
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            _DETAILS.write_text(json.dumps(known, ensure_ascii=False), encoding="utf-8")
    return got


def dish(name: str, servings: float = 1.0, recipe: dict | None = None) -> dict:
    """Everything about one dish for its own page: a serving's nutrition
    (INDB, else its ingredients), each ingredient priced, the method, a
    photo, and what the portion eaten (`servings`) comes to - its
    nutrition and its effective cost (₹ for the portion, a 100 kcal, 10 g
    protein). `recipe`: a suggestion already written (its ingredients and
    steps are used as they are)."""
    from . import images
    servings = min(6.0, max(0.25, float(servings or 1)))
    d = indb.find(name, min_score=0.9)
    r = dict(recipe or {})
    if not r.get("ingredients"):
        det = _details(d["name"] if d else name, d["serving"] if d else None)
        r.update({"ingredients": det.get("ingredients"), "steps": r.get("steps") or det.get("steps"),
                  "time_min": r.get("time_min") or det.get("time_min")})
    r.setdefault("name", name)
    if d and not r.get("indb"):
        r["indb"] = [{"name": d["name"], "servings": 1}]
    w = work_out(r)
    n, cost = w["nutrition"], w["cost"]["total"]
    portion = {k: round(n[k] * servings, 1) for k in NUTRIENTS}
    kcal_from = {"protein": 4 * n["protein"], "carbs": 4 * n["carbs"], "fat": 9 * n["fat"]}
    made = sum(kcal_from.values()) or 1
    portion_cost = round(cost * servings, 1) if cost is not None else None
    return {
        **w, "servings": servings,
        "indb": {"name": d["name"], "per100": d["per100"], "serving": d["serving"], "diet": d["diet"]} if d else None,
        "portion": portion,
        "split": {k: round(v / made * 100) for k, v in kcal_from.items()},     # % of calories
        "effective": {
            "portion": portion_cost,
            "per_100_kcal": round(cost / n["kcal"] * 100, 1) if cost and n["kcal"] else None,
            "per_10g_protein": round(cost / n["protein"] * 10, 1) if cost and n["protein"] >= 1 else None,
        },
        "photo": images.photo(d["name"] if d else name),
    }


# ── what was actually eaten ──
_READ_MEAL = """The user says what they ate for one meal - in English, Hindi (Devanagari) or Hinglish. Return ONLY JSON:
{"items": [{"said": the user's words for this item, exactly as written,
            "name": the food's usual name in Latin script ("Besan chilla", "Masala chai", "Roti", "Dal", "Banana"),
            "count": number or null, "unit": "piece" | "bowl" | "katori" | "plate" | "cup" | "glass" | "spoon" | "g" | "ml" | null,
            "grams": your best estimate of how many grams (or ml) of it were eaten in all}]}
"ek" = 1, "do" = 2, "teen" = 3, "aadha" = 0.5. Split a meal into its foods ("dal chawal" = dal, rice). Never give calories, protein or prices."""

_MATCH_MEAL = """Match each food to one dish from the list of known dishes.
- A general food takes its most ordinary version: "dal" -> a plain everyday dal (arhar/toor or moong); "rice" / "chawal" -> plain boiled rice; "sabzi" -> a plain mixed vegetable; "roti" -> chapati.
- Never a different dish made from it: a banana is not a banana milkshake, an apple not apple pie, milk not kheer, an egg not an egg curry. A plain fruit, nut, milk, egg or drink that isn't itself in the list -> null.
- null when nothing in the list is that same food.
Return ONLY JSON: {"matches": {"<food name exactly as given>": "<known dish name copied exactly>" or null}}"""

# Bought raw, eaten cooked: their USDA figures are for the dry grain or dal,
# about three times a cooked portion's - so a meal never falls back to them
_RAW_ONLY = {"rice", "basmati rice", "brown rice", "atta", "maida", "besan", "suji", "poha", "ragi", "bajra", "jowar",
             "daliya", "quinoa", "vermicelli", "toor dal", "moong dal", "whole moong", "masoor dal", "chana dal",
             "urad dal", "rajma", "chickpeas", "kala chana", "soya chunks", "oats"}


def _eaten_item(it: dict, dish_name: str | None) -> dict:
    """One thing eaten, worked out: an INDB dish by its servings, else a
    single ingredient by its grams (USDA)."""
    said = str(it.get("said") or it.get("name") or "")[:80]
    name = str(it.get("name") or said)[:80]
    try:
        count = float(it["count"]) if it.get("count") not in (None, "") else None
    except (TypeError, ValueError):
        count = None
    try:
        grams = float(it["grams"]) if it.get("grams") not in (None, "") else None
    except (TypeError, ValueError):
        grams = None
    unit = str(it.get("unit") or "").lower()
    d = indb.find(dish_name, min_score=0.9) if dish_name else None
    if d and d["serving"]:
        s = d["serving"]
        # A count of the dish's own unit ("2 cheela", "1 bowl") is servings;
        # otherwise the grams say how many servings it was
        if count and (not unit or unit in ("piece", "serving", s["unit"].lower()) or unit in s["unit"].lower()):
            servings = count
        elif grams:
            servings = grams / s["grams"]
        else:
            servings = count or 1
        servings = round(min(10.0, max(0.1, servings)), 2)
        n = {k: round(s[k] * servings, 1) for k in NUTRIENTS}
        return {"said": said, "name": d["name"], "source": "indb", "servings": servings, "unit": s["unit"],
                "grams": round(s["grams"] * servings), "nutrition": n}
    k = foods.identify(name)
    entry = foods.CATALOGUE.get(k) if k else None
    if k and entry and entry[1] and k not in _RAW_ONLY:
        g = grams or (count * entry[3] if count and entry[3] else None) or 100
        per = foods.nutrition(k)
        p = prices.price(k)
        out = {"said": said, "name": k, "source": "usda", "grams": round(g),
               "cost": round(g / 1000 * p["per_kg"], 1) if p else None}
        if per:
            out["nutrition"] = {kk: round(per.get(kk, 0) * g / 100, 1) for kk in NUTRIENTS}
            return out
    return {"said": said, "name": name, "source": None, "nutrition": None}


def read_meal(text: str | None = None, planned: list[dict] | None = None) -> dict:
    """What was eaten at one meal, worked out. `text`: in the user's words,
    any language; `planned`: [{name, servings}] eaten as planned (INDB
    dishes, no reading needed). Costs come from each dish's ingredients."""
    items: list[dict] = []
    if planned:
        for p in planned[:8]:
            d = indb.find(str(p.get("name") or ""), min_score=0.9)
            if d:
                items.append(_eaten_item({"said": d["name"], "name": d["name"], "count": p.get("servings") or 1,
                                          "unit": d["serving"]["unit"] if d["serving"] else None}, d["name"]))
    if text and text.strip():
        got = chat_json(_READ_MEAL, text.strip()[:600], temperature=0, timeout=30, extra={"reasoning_effort": "low"})
        raw = [x for x in got.get("items") or [] if isinstance(x, dict) and (x.get("name") or x.get("said"))][:10]
        # Known dishes whose names share a word with what was eaten - the LLM picks among them
        words = [w for x in raw for w in str(x.get("name") or "").lower().split()]
        # The everyday forms a general word means, so they're among the choices
        extra = {"dal": ["arhar", "moong", "toor"], "rice": ["boiled"], "chawal": ["rice", "boiled"],
                 "sabzi": ["vegetable", "mixed"], "roti": ["chapati"], "chai": ["tea"]}
        words += [e for w in list(words) for e in extra.get(w, [])]
        cands = indb.named(words, "any", limit=50) if words else []
        matches = {}
        if cands:
            listing = "\n".join(f"- {d['name']}" for d in cands)
            foods_ = "\n".join(f"- {x.get('name')}" for x in raw)
            try:
                matches = chat_json(_MATCH_MEAL, f"Foods eaten:\n{foods_}\n\nKnown dishes:\n{listing}", temperature=0,
                                    timeout=30, prefer=1, extra={"reasoning_effort": "low"}).get("matches") or {}
            except Exception:
                matches = {}
        low = {str(k).strip().lower(): v for k, v in matches.items()}
        items += [_eaten_item(x, low.get(str(x.get("name") or "").strip().lower())) for x in raw]

    # What each INDB dish cost: its ingredients (remembered per dish), times the servings eaten
    dishes = [indb.find(i["name"], min_score=0.9) for i in items if i["source"] == "indb"]
    ing = _dish_ingredients([d for d in dishes if d and d["serving"]]) if dishes else {}
    for i in items:
        if i["source"] == "indb" and i["name"] in ing:
            i["cost"] = round(_price_serving(ing[i["name"]])["total"] * i["servings"], 1)
    known = [i for i in items if i.get("nutrition")]
    costs = [i["cost"] for i in items if i.get("cost") is not None]
    return {
        "text": (text or "").strip()[:600] or None,
        "items": items,
        "unknown": [i["said"] for i in items if not i.get("nutrition")],
        "totals": _sum([i["nutrition"] for i in known]),
        "cost": round(sum(costs)) if costs else None,
    }


# ── meal plans ──
_dish_ing_lock = threading.Lock()
_DISH_ING = DATA_DIR / "dish_ingredients.json"


def _dish_ingredients(dishes: list[dict]) -> dict[str, list]:
    """One serving's ingredients for INDB dishes (the LLM's recipe knowledge;
    priced here), remembered per dish so a plan's dishes are asked about once."""
    try:
        known = json.loads(_DISH_ING.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        known = {}
    try:      # dishes opened on their own page already have theirs
        for k, v in json.loads(_DETAILS.read_text(encoding="utf-8")).items():
            known.setdefault(k, v.get("ingredients") or [])
    except (OSError, ValueError, AttributeError):
        pass
    todo = [d for d in dishes if d["name"] not in known]

    def ask_some(i_batch):
        i, batch = i_batch
        user = "For ONE serving of each dish (the serving size given), list the ingredients with grams.\n" + "\n".join(
            f"- {d['name']} (1 {d['serving']['unit']}, about {d['serving']['grams']} g cooked)" for d in batch)
        try:
            # Batches side by side, each started on its own key
            out = chat_json('Return ONLY JSON: {"dishes": {"<dish name exactly as given>": [{"item": name, "grams": number}]}}. '
                            "Indian home cooking. No calories or prices.", user, temperature=0.2, timeout=60,
                            prefer=i, extra={"reasoning_effort": "low", "max_completion_tokens": 3000})
            return out.get("dishes") or {}
        except Exception as e:
            print(f"[recipes] dish ingredients failed: {e!r}")
            return {}                 # unpriced this time; asked again next plan
    batches = [todo[i:i + 10] for i in range(0, min(len(todo), 40), 10)]
    if batches:
        with ThreadPoolExecutor(max_workers=len(batches)) as pool:
            answers = list(pool.map(ask_some, enumerate(batches, start=1)))
        got = {}
        for a in answers:
            got.update({str(k).strip().lower(): v for k, v in a.items()})
        with _dish_ing_lock:
            for d in todo:
                v = got.get(d["name"].lower())
                if isinstance(v, list):
                    known[d["name"]] = v
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            _DISH_ING.write_text(json.dumps(known, ensure_ascii=False), encoding="utf-8")
    return known


def _price_serving(ingredients: list) -> dict:
    total, unpriced = 0.0, []
    for x in ingredients:
        if not isinstance(x, dict):
            continue
        k = foods.identify(str(x.get("item", "")))
        p = prices.price(k) if k else None
        try:
            g = float(x.get("grams") or 0)
        except (TypeError, ValueError):
            g = 0
        if p:
            total += g / 1000 * p["per_kg"]
        elif g > 0:
            unpriced.append(str(x.get("item")))
    return {"total": round(total, 1), "unpriced": unpriced}


def plan(profile: dict, days: int = 7, diet: str = "any", want: dict | None = None) -> dict:
    t = body.targets(profile)
    if not t:
        return {"mode": "plan", "need_profile": True,
                "message": "To plan for weight loss I need your age, height, weight, sex and how active you are - fill them in below."}
    days = max(1, min(int(days or 7), 7))
    if diet == "any":
        diet = profile.get("diet") or "any"
    every = [d for d in indb.dishes() if d["serving"] and _diet_ok(d, diet)
             and 40 <= d["serving"]["kcal"] <= t["kcal"] * 0.45]
    every.sort(key=lambda d: -(d["serving"]["protein"] / max(d["serving"]["kcal"], 1)))
    staples = [d for d in every if any(w in d["name"].lower() for w in _STAPLE_WORDS)]
    pool = list({d["code"]: d for d in staples[:130] + every[:50]}.values())
    by_name = {d["name"]: d for d in pool}
    listing = "\n".join(f"- {d['name']} | {round(d['serving']['kcal'])} kcal, {d['serving']['protein']} g protein per {d['serving']['unit']}"
                        for d in pool)
    out = chat_json(_PLAN, f"Days: {days}\nDiet: {diet}\nTarget a day: {t['kcal']} kcal, {t['protein_g']} g protein\n"
                    f"Known dishes:\n{listing}", temperature=0.5, timeout=90,
                    extra={"reasoning_effort": "low", "max_completion_tokens": 3000})

    def dish(name):
        return by_name.get(name) or indb.find(name, min_score=0.9)

    plan_days, used = [], {}
    for i, dday in enumerate((out.get("days") or [])[:days]):
        meals = {}
        for meal in ("breakfast", "lunch", "dinner", "snack"):
            ds = [dish(str(n)) for n in (dday.get(meal) or [])[:3]]
            meals[meal] = [d for d in ds if d and d["serving"]]
        flat = [d for ds in meals.values() for d in ds]
        if not flat:
            continue
        raw_kcal = sum(d["serving"]["kcal"] for d in flat)
        # One portion size for the whole day, in half servings, to land on the target
        f = min(2.0, max(0.5, t["kcal"] / raw_kcal)) if raw_kcal else 1
        day_out = {"day": i + 1, "meals": {}}
        for meal, ds in meals.items():
            day_out["meals"][meal] = []
            for d in ds:
                servings = max(0.5, round(f * 2) / 2)
                used[d["name"]] = d
                day_out["meals"][meal].append({"name": d["name"], "servings": servings, "unit": d["serving"]["unit"],
                                               "grams": round(d["serving"]["grams"] * servings),
                                               **{k: round(d["serving"][k] * servings, 1) for k in NUTRIENTS}})
        items = [x for ms in day_out["meals"].values() for x in ms]
        day_out["totals"] = _sum(items)
        plan_days.append(day_out)

    ing = _dish_ingredients(list(used.values()))
    for dd in plan_days:
        cost, unpriced = 0.0, False
        for ms in dd["meals"].values():
            for x in ms:
                if x["name"] in ing:
                    c = _price_serving(ing[x["name"]])
                    x["cost"] = round(c["total"] * x["servings"])
                    cost += x["cost"]
                else:
                    unpriced = True
        dd["cost"] = round(cost) if cost else None
        dd["cost_partial"] = unpriced
    return {"mode": "plan", "targets": t, "diet": diet, "days": plan_days,
            "price_basis": "mandi" if prices.mandi_on() else "estimate"}

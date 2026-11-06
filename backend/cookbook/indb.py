"""The Indian Nutrient Databank (INDB, Anuvaad Solutions): nutrition for
1,014 common Indian dishes, per 100 g and per serving.

Downloaded from its own site the first time it's needed and kept in
DATA_DIR - not bundled in the repo: INDB is published as open access, but
its redistribution terms aren't stated, so the app fetches it rather than
shipping a copy. Rows whose per-serving figures can't be right (a 4,876 kcal
"plate" of paneer pulao) keep their per-100 g values but lose the serving.
"""
from __future__ import annotations

import json
import re
import threading
import urllib.request
from difflib import SequenceMatcher

from . import DATA_DIR

URL = "https://www.anuvaad.org.in/wp-content/uploads/2020/07/Anuvaad_INDB_2024.11.xlsx"
SOURCE = "Indian Nutrient Databank (INDB), Anuvaad Solutions, 2024"
SOURCE_URL = "https://www.anuvaad.org.in/indian-nutrient-databank/"

# Our field -> INDB's column stem (per 100 g; "unit_serving_" + stem per serving)
FIELDS = {"kcal": "energy_kcal", "protein": "protein_g", "carbs": "carb_g", "fat": "fat_g",
          "fibre": "fibre_g", "sugar": "freesugar_g", "sodium_mg": "sodium_mg"}
NONVEG = re.compile(r"\b(chicken|mutton|lamb|goat|fish|prawns?|shrimps?|crab|keema|kheema|meat|beef|pork|"
                    r"bacon|ham|sausage|salami|liver|kebab of meat|machh|murgh|gosht)\b", re.I)
EGG = re.compile(r"\b(eggs?|omelet+e?|anda|bhurji)\b", re.I)

PARSE_VERSION = 3     # bump when _parse changes: the parsed copy is rebuilt
_lock = threading.Lock()
_dishes: list[dict] | None = None


def _words(s: str) -> list[str]:
    return re.sub(r"[^a-z0-9 ]", " ", (s or "").lower()).split()


def _parse(path) -> list[dict]:
    import openpyxl
    ws = openpyxl.load_workbook(path, read_only=True).worksheets[0]
    rows = ws.iter_rows(values_only=True)
    head = next(rows)
    out = []
    for r in rows:
        d = dict(zip(head, r))
        if not d.get("food_name"):
            continue
        per100 = {k: round(float(d.get(c) or 0), 2) for k, c in FIELDS.items()}
        serving = {k: round(float(d.get("unit_serving_" + c) or 0), 2) for k, c in FIELDS.items()}
        grams = round(serving["kcal"] / per100["kcal"] * 100) if per100["kcal"] > 0 and serving["kcal"] > 0 else None
        # A serving past 1,200 kcal or 900 g is a data slip, not a portion;
        # so is one whose protein, carbs and fat add up to far more or less
        # energy than it says it has (4/4/9 kcal a gram)
        made_of = 4 * serving["protein"] + 4 * serving["carbs"] + 9 * serving["fat"]
        name = str(d["food_name"]).strip()
        # Past 6 kcal a gram is nearly pure fat - only oils, nuts and seeds are that dense
        dense_ok = per100["kcal"] <= 600 or re.search(r"\b(oil|ghee|butter|nuts?|seeds?|almond|cashew|walnut)\b", name, re.I)
        sane = (bool(grams) and serving["kcal"] <= 1200 and grams <= 900 and bool(dense_ok)
                and 0.6 * serving["kcal"] <= made_of <= 1.4 * serving["kcal"])
        out.append({
            "code": d["food_code"], "name": name,
            "per100": per100,
            "serving": ({**serving, "unit": str(d.get("servings_unit") or "serving"), "grams": grams} if sane else None),
            "diet": "nonveg" if NONVEG.search(name) else "egg" if EGG.search(name) else "veg",
        })
    return out


def dishes() -> list[dict]:
    """Every INDB dish, downloading and parsing it on first use."""
    global _dishes
    if _dishes is not None:
        return _dishes
    with _lock:
        if _dishes is not None:
            return _dishes
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        parsed = DATA_DIR / f"indb.v{PARSE_VERSION}.json"
        if parsed.exists():
            _dishes = json.loads(parsed.read_text(encoding="utf-8"))
            return _dishes
        xlsx = DATA_DIR / "indb.xlsx"
        if not xlsx.exists():
            req = urllib.request.Request(URL, headers={"User-Agent": "Settle recipes (personal app)"})
            with urllib.request.urlopen(req, timeout=60) as r:
                xlsx.write_bytes(r.read())
        _dishes = _parse(xlsx)
        parsed.write_text(json.dumps(_dishes, ensure_ascii=False), encoding="utf-8")
        return _dishes


def find(name: str, min_score: float = 0.8) -> dict | None:
    """The INDB dish a recipe name means: "Matar paneer" -> "Pea paneer curry
    (Matar paneer)". Each of a dish's names counts (INDB gives most an
    English and an Indian one, the latter in brackets). Words have to be
    shared - "Moong dal chilla" is not "Moong dal halwa", however alike
    they're spelt; spelling only forgives a slip within a word."""
    want = _words(name)
    if not want:
        return None
    best, score = None, 0.0
    for d in dishes():
        full = d["name"]
        names = [full, re.sub(r"\([^)]*\)", "", full)] + [x for p in re.findall(r"\(([^)]*)\)", full) for x in p.split("/")]
        for n in names:
            words = _words(n)
            if not words:
                continue
            if words == want:
                return d
            # Words in common, a word spelt nearly the same counting as shared
            hit = sum(1 for a in want if a in words or any(SequenceMatcher(None, a, b).ratio() >= 0.85 for b in words))
            sc = hit / max(len(set(want) | set(words)), 1)
            if sc > score:
                best, score = d, sc
    return best if score >= min_score else None


def named(words: list[str], diet: str = "any", limit: int = 40) -> list[dict]:
    """Dishes whose names hold any of these words - what a "compare rajma
    chawal and chole bhature" or "cook with paneer" is offered to pick from."""
    want = {w for w in (x.lower() for x in words) if len(w) >= 3}
    out = []
    for d in dishes():
        if not d["serving"] or (diet == "veg" and d["diet"] != "veg") or (diet == "egg" and d["diet"] == "nonveg"):
            continue
        ws = set(_words(d["name"]))
        hit = sum(1 for w in want if w in ws or any(SequenceMatcher(None, w, b).ratio() >= 0.85 for b in ws))
        if hit:
            out.append((hit, d))
    out.sort(key=lambda x: -x[0])
    return [d for _, d in out[:limit]]


def candidates(diet: str = "any", max_kcal: float | None = None, min_protein: float | None = None,
               words: list[str] | None = None, limit: int = 60) -> list[dict]:
    """Dishes whose serving meets the numbers asked for - what the LLM is
    told it may pick from, so a "under 350 kcal" answer starts from dishes
    that are."""
    out = []
    for d in dishes():
        s = d["serving"]
        if not s:
            continue
        if diet == "veg" and d["diet"] != "veg":
            continue
        if diet == "egg" and d["diet"] == "nonveg":
            continue
        if max_kcal and s["kcal"] > max_kcal:
            continue
        if min_protein and s["protein"] < min_protein:
            continue
        if words and not any(x in d["name"].lower() for x in words):
            continue
        out.append(d)
    # Most protein for the calories first - what "high protein" and "weight
    # loss" both want
    out.sort(key=lambda d: -(d["serving"]["protein"] / max(d["serving"]["kcal"], 1)))
    return out[:limit]

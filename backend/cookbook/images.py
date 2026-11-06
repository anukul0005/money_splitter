"""A photo of a dish, from Wikipedia's article on it (Wikimedia's own image
of the page - free to show, credited on the page). Free, no key. Each
dish is looked up once and remembered, a miss too.

A photo only counts when the article is about the dish: its title has to
share a word with the dish's name - "Besan chilla" can be the article
"Chilla (food)", not one that merely mentions besan.
"""
from __future__ import annotations

import json
import re
import threading
import urllib.parse
import urllib.request
from difflib import SequenceMatcher

from . import DATA_DIR

_lock = threading.Lock()
_CACHE = DATA_DIR / "images.json"
_GENERIC = {"curry", "dish", "food", "indian", "recipe", "mixed", "plain", "with", "and", "the", "of", "in",
            "a", "ka", "ki", "ke", "sauce", "style", "cuisine", "bread", "dessert", "snack"}


def _words(s: str) -> set[str]:
    return {w for w in re.sub(r"[^a-z ]", " ", (s or "").lower()).split() if w not in _GENERIC and len(w) > 2}


def _names(dish: str) -> list[str]:
    """What to search for: the Indian name in brackets first (INDB's "Pea
    paneer curry (Matar paneer)" -> "Matar paneer"), then the name itself."""
    inside = [x.strip() for p in re.findall(r"\(([^)]*)\)", dish) for x in p.split("/") if x.strip()]
    outside = re.sub(r"\([^)]*\)", "", dish).strip()
    return list(dict.fromkeys(inside + [outside]))[:3]


def _search(q: str) -> dict | None:
    params = {"action": "query", "format": "json", "generator": "search", "gsrsearch": q, "gsrlimit": 4,
              "prop": "pageimages|info", "piprop": "thumbnail", "pithumbsize": 640, "inprop": "url"}
    req = urllib.request.Request("https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode(params),
                                 # Wikimedia asks every caller to name itself with a way to reach it
                                 headers={"User-Agent": "SettleRecipes/1.0 (https://www.settle0.in.net)"})
    with urllib.request.urlopen(req, timeout=15) as r:
        pages = (json.loads(r.read().decode()).get("query") or {}).get("pages") or {}
    want = _words(q)
    for p in sorted(pages.values(), key=lambda p: p.get("index", 99)):
        thumb = p.get("thumbnail", {}).get("source")
        # "(food)", "(rice)": Wikipedia's way of telling articles apart, not part of the dish
        title = _words(re.sub(r"\([^)]*\)", "", p.get("title", "")))
        same = lambda a: any(a == b or SequenceMatcher(None, a, b).ratio() >= 0.85 for b in want)
        # The article is the dish itself: every word of its title is in the
        # dish's name (a slip of spelling forgiven - Rajmah, Rajma) - "Chicken
        # curry" is not "Butter chicken", "Fish curry" not "Fish head curry"
        if thumb and title and all(same(w) for w in title):
            return {"url": thumb, "page": p.get("fullurl"), "title": p.get("title"), "credit": "Wikipedia"}
    return None


def photo(dish: str) -> dict | None:
    try:
        cache = json.loads(_CACHE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cache = {}
    if dish in cache:
        return cache[dish]
    found = None
    try:
        for q in _names(dish):
            found = _search(q)
            if found:
                break
    except Exception:
        return None                    # not remembered - tried again next time
    with _lock:
        cache[dish] = found
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        _CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    return found

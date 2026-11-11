"""Bookmaker odds before a tennis match, from The Odds API
(the-odds-api.com, key in ODDS_API_KEY): the winner (h2h) and total games
(totals) - the median price across the bookmakers that have it, and the best.

The free plan is 500 credits a month and each odds read costs one per
market (one region, eu), so only the tournament the match is in is read, at most every
ODDS_HOURS; the list of tournaments (free) every SPORTS_HOURS.
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from statistics import median

import tennis_kb as kb

BASE = "https://api.the-odds-api.com/v4"
ODDS_HOURS = 6
SPORTS_HOURS = 6
_cache: dict = {}
_lock = threading.Lock()
remaining = None                       # credits left this month, as the last answer said


def _get(path: str, **params):
    global remaining
    q = urllib.parse.urlencode({"apiKey": os.environ["ODDS_API_KEY"], **params})
    with urllib.request.urlopen(f"{BASE}{path}?{q}", timeout=15) as r:
        remaining = r.headers.get("x-requests-remaining", remaining)
        return json.loads(r.read())


def _cached(key: str, hours: float, fn):
    with _lock:
        hit = _cache.get(key)
    if hit and time.time() - hit[0] < hours * 3600:
        return hit[1]
    val = fn()
    with _lock:
        _cache[key] = (time.time(), val)
    return val


def _odds(sport: str) -> list:
    try:
        return _get(f"/sports/{sport}/odds", regions="eu", markets="h2h,totals", oddsFormat="decimal")
    except urllib.error.HTTPError as err:
        if err.code != 422:               # totals not offered for this one: the winner alone
            raise
        return _get(f"/sports/{sport}/odds", regions="eu", markets="h2h", oddsFormat="decimal")


def _words(s: str) -> set:
    return {w for w in kb.norm(s).split() if len(w) > 2 and w not in {"atp", "wta", "open", "the", "tennis", "championships"}}


def _surname(n: str) -> str:
    return (kb.norm(n).split() or [""])[-1]


def _price(xs: list) -> dict | None:
    return {"median": round(median(xs), 2), "best": max(xs), "books": len(xs)} if xs else None


def match(tour: str, a: str, b: str, tournament: str = "") -> dict:
    if not os.environ.get("ODDS_API_KEY"):
        return {"missing_key": True}
    sports = [s for s in _cached("sports", SPORTS_HOURS, lambda: _get("/sports"))
              if s.get("active") and s["key"].startswith(f"tennis_{tour.lower()}")]
    # the tournament it's in, by the words of its name; every one of the tour if none fits
    want = _words(tournament)
    best = sorted(sports, key=lambda s: -len(want & _words(s.get("title", ""))))
    picks = [s for s in best if want & _words(s.get("title", ""))][:1] or sports
    pair = {_surname(a), _surname(b)}
    for s in picks:
        for ev in _cached(s["key"], ODDS_HOURS, lambda k=s["key"]: _odds(k)):
            if {_surname(ev["home_team"]), _surname(ev["away_team"])} != pair:
                continue
            win, tot = {ev["home_team"]: [], ev["away_team"]: []}, []
            for bk in ev.get("bookmakers", []):
                for mk in bk.get("markets", []):
                    if mk["key"] == "h2h":
                        for o in mk["outcomes"]:
                            win.setdefault(o["name"], []).append(o["price"])
                    elif mk["key"] == "totals":
                        tot += [(o.get("point"), o["name"], o["price"]) for o in mk["outcomes"]]
            totals = None
            if tot:
                line = Counter(p for p, _, _ in tot).most_common(1)[0][0]
                totals = {"line": line,
                          "over": _price([x for p, n, x in tot if p == line and n == "Over"]),
                          "under": _price([x for p, n, x in tot if p == line and n == "Under"])}
            return {"event": s.get("title"), "start": ev.get("commence_time"),
                    "winner": [{"name": n, **(_price(xs) or {})} for n, xs in win.items() if xs],
                    "totals": totals, "remaining": remaining,
                    "read_at": datetime.fromtimestamp(_cache[s["key"]][0], timezone.utc).isoformat(timespec="seconds")}
    return {"none": True, "remaining": remaining}

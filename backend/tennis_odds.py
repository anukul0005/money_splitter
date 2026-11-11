"""Bookmaker odds before a tennis match: the winner and the total line -
the median price across the bookmakers that have it, and the best.

Two sources, used in tandem (either key may be missing):
- Tennis API (docs.tennis-api.com via RapidAPI, key in TENNIS_API_KEY) first:
  one request lists a whole day's matches of a tour with Pinnacle's and
  Marathonbet's prices, Challengers and ITF included. Free plan 50 requests
  a day; each (tour, day) is read at most every DAY_HOURS.
- The Odds API (the-odds-api.com, key in ODDS_API_KEY) when Tennis API has no
  prices for the match: more bookmakers, the big events only. The free plan is 500 credits a month and each odds read costs one per
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


def _odds_api(tour: str, a: str, b: str, tournament: str) -> dict:
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
                totals = {"line": line, "unit": "games",
                          "over": _price([x for p, n, x in tot if p == line and n == "Over"]),
                          "under": _price([x for p, n, x in tot if p == line and n == "Under"])}
            return {"source": "The Odds API", "event": s.get("title"), "start": ev.get("commence_time"),
                    "winner": [{"name": n, **(_price(xs) or {})} for n, xs in win.items() if xs],
                    "totals": totals, "remaining": remaining,
                    "read_at": datetime.fromtimestamp(_cache[s["key"]][0], timezone.utc).isoformat(timespec="seconds")}
    return {"none": True, "remaining": remaining}


# --- Tennis API (RapidAPI) ---
TA_HOST = "tennis-api-atp-wta-itf.p.rapidapi.com"
DAY_HOURS = 6
TA_PAGES = 4                           # a busy day's list runs to a few pages
ta_used = {}                           # UTC day -> requests made today (the free plan is 50)


def _ta_get(path: str, **params) -> dict:
    day = datetime.now(timezone.utc).date().isoformat()
    ta_used[day] = ta_used.get(day, 0) + 1
    req = urllib.request.Request(f"https://{TA_HOST}{path}?{urllib.parse.urlencode(params)}",
                                 headers={"X-RapidAPI-Key": os.environ["TENNIS_API_KEY"], "X-RapidAPI-Host": TA_HOST})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def _rows(data) -> list:
    if isinstance(data, list):
        return data
    for k in ("data", "results", "result", "matches", "items"):
        if isinstance(data.get(k), list):
            return data[k]
    return []


def _ta_day(tour: str, day: str) -> list:
    rows = []
    for page in range(1, TA_PAGES + 1):
        data = _ta_get(f"/tennis/v2/upcoming/matches/{tour.lower()}", dateOnly=day, page=page, limit=100)
        got = _rows(data)
        if page == 1 and not got:
            print(f"[tennis-odds] Tennis API {tour} {day}: no rows, keys {list(data)[:10] if isinstance(data, dict) else type(data)}")
        rows += got
        more = isinstance(data, dict) and (data.get("hasNextPage") or (data.get("pagination") or {}).get("hasNextPage"))
        if not more:
            break
    return rows


def _pname(p) -> str:
    if isinstance(p, dict):
        return p.get("name") or p.get("fullName") or " ".join(x for x in (p.get("firstName"), p.get("lastName")) if x)
    return str(p or "")


def _num(x):
    try:
        v = float(x)
        return v if v > 1 else None
    except (TypeError, ValueError):
        return None


def _tennis_api(tour: str, a: str, b: str, start: str) -> dict | None:
    pair = {_surname(a), _surname(b)}
    try:
        when = datetime.fromisoformat(start.replace("Z", "+00:00")).date() if start else datetime.now(timezone.utc).date()
    except ValueError:
        when = datetime.now(timezone.utc).date()
    from datetime import timedelta
    for d in (when, when - timedelta(days=1), when + timedelta(days=1)):     # UTC day edges
        day = d.isoformat()
        for r in _cached(f"ta-{tour}-{day}", DAY_HOURS, lambda day=day: _ta_day(tour, day)):
            p1, p2 = r.get("player1") or {}, r.get("player2") or {}
            n1, n2 = _pname(p1) or r.get("player1Name", ""), _pname(p2) or r.get("player2Name", "")
            if {_surname(n1), _surname(n2)} != pair:
                continue
            o = r.get("odds") or {}
            k1, k2 = _num(o.get("k1")), _num(o.get("k2"))
            if o.get("id1_o") is not None and isinstance(p1, dict) and p1.get("id") is not None and str(o.get("id1_o")) != str(p1.get("id")):
                k1, k2 = k2, k1                # Pinnacle's first price is the other player's
            prices = {n1: [x for x in (k1, _num(p1.get("odd") if isinstance(p1, dict) else None)) if x],
                      n2: [x for x in (k2, _num(p2.get("odd") if isinstance(p2, dict) else None)) if x]}
            totals = None
            if o.get("total") not in (None, "") and (_num(o.get("ktb")) or _num(o.get("ktm"))):
                unit = str(o.get("totalUnit") or ("sets" if str(o.get("id_b_o")) == "2" else "games")).lower()
                one = lambda x: {"median": x, "best": x, "books": 1} if x else None
                totals = {"line": float(o["total"]), "unit": "sets" if "set" in unit else "games",
                          "over": one(_num(o.get("ktb"))), "under": one(_num(o.get("ktm")))}
            if not any(prices.values()) and not totals:
                return None
            t = r.get("tournament")
            return {"source": "Tennis API", "match_id": r.get("id"), "type": r.get("type") or tour.lower(),
                    "event": r.get("tournamentName") or (t.get("name") if isinstance(t, dict) else t),
                    "start": r.get("date") or r.get("startTime"),
                    "winner": [{"name": n, **_price(xs)} for n, xs in prices.items() if xs],
                    "totals": totals, "used_today": ta_used.get(datetime.now(timezone.utc).date().isoformat(), 0),
                    "read_at": datetime.fromtimestamp(_cache[f"ta-{tour}-{day}"][0], timezone.utc).isoformat(timespec="seconds")}
    return None


def _ta_games(match_id, kind: str) -> dict | None:
    """The games line for one match (Marathonbet's) - a request of its own,
    so only when the match page is open, and not once the day's 50 run low."""
    if not match_id:
        return None
    day = datetime.now(timezone.utc).date().isoformat()
    key = f"ta-match-{match_id}"
    with _lock:
        hit = key in _cache
    if not hit and ta_used.get(day, 0) >= TA_MATCH_CAP:
        return None
    rows = _cached(key, ODDS_HOURS, lambda: (_ta_get(f"/tennis/v2/matches/{match_id}/odds", type=kind, source="today") or {}).get("odds") or [])
    for o in rows:
        if str(o.get("totalUnit") or "").lower().startswith("game") and o.get("total") is not None:
            one = lambda x: {"median": x, "best": x, "books": 1} if _num(x) else None
            return {"line": float(o["total"]), "unit": "games", "over": one(o.get("ktb")), "under": one(o.get("ktm")),
                    "source": o.get("bookmaker") or "Tennis API"}
    return None


TA_MATCH_CAP = 40                      # past this many of today's 50, no per-match reads


def match(tour: str, a: str, b: str, tournament: str = "", start: str = "") -> dict:
    """Both sources in tandem: the winner from whichever has more bookmakers;
    total games from The Odds API (many bookmakers) where it has the match,
    else Tennis API's per-match read; total sets from Tennis API's Pinnacle."""
    has_ta, has_oa = bool(os.environ.get("TENNIS_API_KEY")), bool(os.environ.get("ODDS_API_KEY"))
    if not has_ta and not has_oa:
        return {"missing_key": True}
    ta = oa = None
    if has_ta:
        try:
            ta = _tennis_api(tour, a, b, start)
        except Exception as err:          # over the day's 50, or down: the other one
            print(f"[tennis-odds] Tennis API: {err}")
    if has_oa:
        try:
            oa = _odds_api(tour, a, b, tournament)
            oa = None if oa.get("none") else oa
        except Exception as err:
            print(f"[tennis-odds] The Odds API: {err}")
    if not ta and not oa:
        return {"none": True, "remaining": remaining}
    books = lambda x: max((w.get("books", 0) for w in (x or {}).get("winner", [])), default=0)
    win = oa if books(oa) > books(ta) else ta
    totals = []
    if oa and oa.get("totals"):
        totals.append({**oa["totals"], "source": "The Odds API"})
    elif ta:
        try:
            g = _ta_games(ta.get("match_id"), ta.get("type") or tour.lower())
            if g:
                totals.append(g)
        except Exception as err:
            print(f"[tennis-odds] Tennis API match odds: {err}")
    if ta and ta.get("totals") and ta["totals"]["unit"] == "sets":
        totals.append({**ta["totals"], "source": "Pinnacle"})
    return {"source": win["source"], "sources": [x["source"] for x in (ta, oa) if x],
            "event": win.get("event"), "start": win.get("start"), "winner": win["winner"], "totals": totals,
            "remaining": remaining, "used_today": ta_used.get(datetime.now(timezone.utc).date().isoformat(), 0) if has_ta else None}

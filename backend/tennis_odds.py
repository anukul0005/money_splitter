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
ta_left = None                         # requests left today, as RapidAPI's last answer said


def _ta_get(path: str, **params) -> dict:
    day = datetime.now(timezone.utc).date().isoformat()
    ta_used[day] = ta_used.get(day, 0) + 1
    req = urllib.request.Request(f"https://{TA_HOST}{path}" + (f"?{urllib.parse.urlencode(params)}" if params else ""),
                                 headers={"X-RapidAPI-Key": os.environ["TENNIS_API_KEY"], "X-RapidAPI-Host": TA_HOST})
    global ta_left
    with urllib.request.urlopen(req, timeout=15) as r:
        left = r.headers.get("x-ratelimit-requests-remaining")
        if left is not None and left.isdigit():
            ta_left = int(left)
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
        data = _ta_get(f"/tennis/v2/upcoming/matches/{tour.lower()}", dateOnly=day, page=page, limit=100, group="singles")
        got = _rows(data)
        if page == 1 and not got:
            print(f"[tennis-odds] Tennis API {tour} {day}: no rows, keys {list(data)[:10] if isinstance(data, dict) else type(data)}", flush=True)
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

# --- in-play prices (Tennis API's live odds: Bet365, BWin, BetFair, FonBet, ...) ---
LIVE_LIST_MIN = 10                     # the list of matches in play, re-read at most this often
LIVE_ODDS_MIN = 4                      # one match's in-play prices, likewise
LIVE_RESERVE = 15                      # left of the day's 50 for the pre-match keeper - no live reads below it
LIVE_FRESH = 600                       # a bookmaker's quote older than this behind the newest is dropped


def _live_get(path: str, **params):
    if ta_left is not None and ta_left < LIVE_RESERVE:
        raise RuntimeError("quota")
    return _ta_get(f"/tennis/v2/extend/api{path}", **params)


def live(tour: str, a: str, b: str) -> dict:
    """The current prices of a match in play - only read while its page is
    open, a few minutes cached, and never into the pre-match keeper's share
    of the day's requests."""
    if not os.environ.get("TENNIS_API_KEY"):
        return {"missing_key": True}
    pair = {_surname(a), _surname(b)}
    with _lock:
        failed = _cache.get("ta-live-failed")
    if failed and time.time() - failed[0] < LIVE_ODDS_MIN * 60:
        return {"error": True}
    try:
        rows = _cached("ta-live", LIVE_LIST_MIN / 60, lambda: _rows(_live_get("/events/live")))
        ev = next((r for r in rows if {_surname(r.get("participant1", "")), _surname(r.get("participant2", ""))} == pair), None)
        if not ev:
            return {"none": True}
        res = _cached(f"ta-live-{ev['id']}", LIVE_ODDS_MIN / 60,
                      lambda: (_live_get(f"/event/recent-odds/get/{ev['id']}", inplay="true") or {}).get("result") or {})
    except RuntimeError:
        return {"quota": True, "left": ta_left}
    except Exception as err:
        print(f"[tennis-odds] live: {err}", flush=True)
        with _lock:                    # not again for a few minutes - each try is one of the day's 50
            _cache["ta-live-failed"] = (time.time(), None)
        return {"error": True}

    def quotes(books: dict) -> list:
        qs = [(int(q.get("addTime") or 0), _num(q.get("od1")), _num(q.get("od2"))) for q in books.values() if isinstance(q, dict)]
        qs = [q for q in qs if q[1] and q[2] and q[1] <= 1000 and q[2] <= 1000]
        newest = max((q[0] for q in qs), default=0)
        return [q for q in qs if newest - q[0] <= LIVE_FRESH]

    win = quotes(res.get("Full Time Result") or {})
    p1, p2 = ev.get("participant1", ""), ev.get("participant2", "")
    winner = [{"name": n, **_price([q[i] for q in win])} for n, i in ((p1, 1), (p2, 2))] if win else []
    totals = []
    lines = []
    for k, books in res.items():
        if k.startswith("Over Under") and "|" in k:
            qs = quotes(books)
            if qs:
                lines.append((max(q[0] for q in qs), float(k.split("|")[1]), qs))
    if lines:
        newest = max(t for t, _, _ in lines)
        recent = [x for x in lines if newest - x[0] <= LIVE_FRESH] or lines
        _, line, qs = min(recent, key=lambda x: abs(median(q[1] for q in x[2]) - median(q[2] for q in x[2])))
        totals.append({"line": line, "unit": "games", "over": _price([q[1] for q in qs]),
                       "under": _price([q[2] for q in qs]), "source": "in play"})
    stamp = max([q[0] for q in win] + [t for t, _, _ in lines], default=0)
    return {"winner": winner, "totals": totals, "score": ev.get("score"), "source": "Tennis API",
            "updated": datetime.fromtimestamp(stamp, timezone.utc).isoformat(timespec="seconds") if stamp else None,
            "read_at": datetime.fromtimestamp(_cache[f"ta-live-{ev['id']}"][0], timezone.utc).isoformat(timespec="seconds"),
            "left": ta_left, **({} if winner or totals else {"none": True})}


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
            print(f"[tennis-odds] Tennis API: {err}", flush=True)
    if has_oa:
        try:
            oa = _odds_api(tour, a, b, tournament)
            oa = None if oa.get("none") else oa
        except Exception as err:
            print(f"[tennis-odds] The Odds API: {err}", flush=True)
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
            print(f"[tennis-odds] Tennis API match odds: {err}", flush=True)
    if ta and ta.get("totals") and ta["totals"]["unit"] == "sets":
        totals.append({**ta["totals"], "source": "Pinnacle"})
    return {"source": win["source"], "sources": [x["source"] for x in (ta, oa) if x],
            "event": win.get("event"), "start": win.get("start"), "winner": win["winner"], "totals": totals,
            "remaining": remaining, "used_today": ta_used.get(datetime.now(timezone.utc).date().isoformat(), 0) if has_ta else None}


# --- kept odds: the last pre-match read stays with the match (models.TennisOdds) ---
def pair_key(a: str, b: str) -> str:
    return "|".join(sorted((_surname(a), _surname(b))))


def store(db, tour: str, a: str, b: str, day, start, prices: dict, totals: list | None, source: str,
          weak: bool = False) -> None:
    """prices {name: {median, best, books}}. Before the start only (a read
    after it may be in-play prices); weak (results archive) only fills a gap."""
    from models import TennisOdds
    now = datetime.now(timezone.utc)
    if start is not None and start <= now:
        return
    key = pair_key(a, b)
    row = db.query(TennisOdds).filter_by(tour=tour, pair=key, day=day).first()
    if row and weak:
        return
    if not row:
        row = TennisOdds(tour=tour, pair=key, day=day)
        db.add(row)
    elif row.prices and max((p.get("books", 0) for p in json.loads(row.prices).values()), default=0) > \
            max((p.get("books", 0) for p in prices.values()), default=0) and (row.start is None or row.start > now):
        # a richer read (The Odds API, many bookmakers) isn't replaced by a thinner one
        prices = {**prices, **{k: v for k, v in json.loads(row.prices).items()}}
    row.start = start or row.start
    row.prices = json.dumps({_surname(n): p for n, p in prices.items()})
    if totals:
        row.totals = json.dumps(totals)
    row.source = source
    row.read_at = now
    db.commit()


def _row_odds(r: dict, tour: str):
    """One Tennis API upcoming row -> (name1, name2, {name: price}, totals) or None."""
    p1, p2 = r.get("player1") or {}, r.get("player2") or {}
    n1, n2 = _pname(p1), _pname(p2)
    if not n1 or not n2 or "/" in n1 + n2:                     # doubles
        return None
    o = r.get("odds") or {}
    k1, k2 = _num(o.get("k1")), _num(o.get("k2"))
    if o.get("id1_o") is not None and p1.get("id") is not None and str(o.get("id1_o")) != str(p1.get("id")):
        k1, k2 = k2, k1
    prices = {n1: [x for x in (k1, _num(p1.get("odd"))) if x], n2: [x for x in (k2, _num(p2.get("odd"))) if x]}
    if not all(prices.values()):
        return None
    totals = []
    if o.get("total") not in (None, "") and (_num(o.get("ktb")) or _num(o.get("ktm"))):
        one = lambda x: {"median": x, "best": x, "books": 1} if x else None
        totals.append({"line": float(o["total"]), "unit": "sets" if str(o.get("id_b_o")) == "2" else "games",
                       "over": one(_num(o.get("ktb"))), "under": one(_num(o.get("ktm"))),
                       "source": o.get("bookmaker") or "Tennis API"})
    return n1, n2, {n: _price(xs) for n, xs in prices.items()}, totals


def _when(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def keep_day(db, tour: str, day) -> int:
    """Reads a day's upcoming list now (refreshing the shared cache) and keeps
    every match's prices that hasn't started."""
    rows = _ta_day(tour, day.isoformat())
    with _lock:
        _cache[f"ta-{tour}-{day.isoformat()}"] = (time.time(), rows)
    n = 0
    for r in rows:
        got = _row_odds(r, tour)
        start = _when(r.get("date"))
        if got and start:
            n1, n2, prices, totals = got
            store(db, tour, n1, n2, start.date(), start, prices, totals, "Tennis API")
            n += 1
    return n


def keep_results(db, tour: str, day) -> int:
    """A played day from Tennis API's results archive: Marathonbet's
    pre-match winner prices, for matches no earlier read kept."""
    n, page = 0, 1
    while page <= TA_PAGES:
        data = _ta_get(f"/tennis/v2/{tour.lower()}/results/{day.isoformat()}", pageSize=500, pageNo=page,
                       filter="PlayerGroup:singles")
        rows = _rows(data)
        for r in rows:
            n1, n2 = _pname(r.get("player1")), _pname(r.get("player2"))
            o1, o2 = _num(r.get("odd1")), _num(r.get("odd2"))
            if n1 and n2 and o1 and o2 and "/" not in n1 + n2:
                one = lambda x: {"median": x, "best": x, "books": 1}
                store(db, tour, n1, n2, day, None, {n1: one(o1), n2: one(o2)}, None, "Marathonbet", weak=True)
                n += 1
        if not rows or not (isinstance(data, dict) and data.get("hasNextPage")):
            break
        page += 1
    return n


BACKFILL_DAYS = 45


def keep_job(db) -> dict:
    """From the 15-minute tennis cron. Within Tennis API's 50 a day: today's
    lists every 3 hours, tomorrow's every 12, yesterday's results once, and
    two more days back each day until BACKFILL_DAYS are filled."""
    if not os.environ.get("TENNIS_API_KEY"):
        return {"skipped": "no key"}
    from datetime import timedelta
    from sqlalchemy import text as sql
    meta = lambda k: db.execute(sql("SELECT value FROM tennis_meta WHERE key = :k"), {"k": k}).scalar()

    def mark(k, v):
        db.execute(sql("INSERT INTO tennis_meta(key, value) VALUES(:k, :v) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
                   {"k": k, "v": str(v)})
        db.commit()

    now = datetime.now(timezone.utc)
    today = now.date()
    age = lambda k: (now - _when(meta(k))).total_seconds() / 3600 if _when(meta(k)) else 1e9
    out = {}
    try:
        if age("odds_today_at") >= 3:
            out["today"] = sum(keep_day(db, t, today) for t in ("ATP", "WTA"))
            mark("odds_today_at", now.isoformat())
        if age("odds_tomorrow_at") >= 12:
            out["tomorrow"] = sum(keep_day(db, t, today + timedelta(days=1)) for t in ("ATP", "WTA"))
            mark("odds_tomorrow_at", now.isoformat())
        if meta("odds_results_day") != today.isoformat():
            back = _when(meta("odds_backfill_to"))
            back = back.date() if back else today - timedelta(days=1)
            days = [today - timedelta(days=1)] + [back - timedelta(days=i) for i in (1, 2)
                                                   if back - timedelta(days=i) >= today - timedelta(days=BACKFILL_DAYS)]
            out["results"] = {d.isoformat(): sum(keep_results(db, t, d) for t in ("ATP", "WTA")) for d in days}
            mark("odds_backfill_to", min(days).isoformat())
            mark("odds_results_day", today.isoformat())
    except Exception as err:
        db.rollback()
        print(f"[tennis-odds] keep: {err}", flush=True)
        out["error"] = str(err)[:200]
    print(f"[tennis-odds] keep {out} · {ta_used.get(today.isoformat(), 0)} Tennis API requests today", flush=True)
    return out


def kept(db, tour: str, a: str, b: str, day) -> dict | None:
    """The kept prices for a played (or started) match, a day either side."""
    from datetime import timedelta
    from models import TennisOdds
    rows = db.query(TennisOdds).filter(TennisOdds.tour == tour.upper(), TennisOdds.pair == pair_key(a, b),
                                       TennisOdds.day.between(day - timedelta(days=1), day + timedelta(days=1))).all()
    if not rows:
        return None
    r = min(rows, key=lambda x: abs((x.day - day).days))
    return as_dict(r)


def as_dict(r) -> dict:
    return {"tour": r.tour, "pair": r.pair, "day": r.day.isoformat(), "start": r.start.isoformat() if r.start else None,
            "prices": json.loads(r.prices), "totals": json.loads(r.totals) if r.totals else [], "source": r.source}

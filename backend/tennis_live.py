"""Live and upcoming ATP / WTA tour-level singles matches, straight from
ESPN's scoreboard (the same feed tennis_kb reads finished matches from) -
for the Live tab of Betting analytics. Nothing is stored: a minute's cache
per tour keeps the page's polling to a few ESPN requests a minute.

Each match carries both players' ids in the knowledge base where ESPN's
athlete id is known there (tennis_players.espn_id), so the match page can
show their form and head-to-head before a ball is hit.
"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import text

import tennis_kb as kb

CACHE_SECONDS = 60
AHEAD_HOURS = 36                      # upcoming: what starts within this
_cache: dict[str, tuple[float, list]] = {}
_tourneys: tuple[float, object] | None = None
_lock = threading.Lock()
_running: set = set()                 # background refreshes under way
_kb_ids: dict = {}                    # (tour, espn id) -> (knowledge-base id or None, when looked up)


def _bg(key: str, fn) -> None:
    """Run fn in the background unless it already is: a request never waits for
    a refresh - it gets the last answer, and the next one gets the new."""
    with _lock:
        if key in _running:
            return
        _running.add(key)

    def run():
        try:
            fn()
        except Exception as err:
            print(f"[tennis-live] {key}: {err}")
        finally:
            with _lock:
                _running.discard(key)
    threading.Thread(target=run, daemon=True, name=f"tennis-live-{key}").start()


def _tourney_info():
    """tennis_kb.Tourneys (surface / WTA tour-level check), rebuilt every 6 hours."""
    global _tourneys
    with _lock:
        if _tourneys and time.time() - _tourneys[0] < 6 * 3600:
            return _tourneys[1]
    from database import get_engine
    conn = kb.connect_pg(get_engine())
    try:
        t = kb.Tourneys(conn)
    finally:
        conn.close()
    with _lock:
        _tourneys = (time.time(), t)
    return t


def _side(x) -> dict:
    a = x.get("athlete") or {}
    rank = (x.get("curatedRank") or {}).get("current")
    code = ((a.get("flag") or {}).get("href") or "").rsplit("/", 1)[-1].split(".")[0].upper() or None
    return {"name": a.get("displayName") or a.get("fullName") or "TBD", "espn_id": str(x.get("id") or a.get("id") or ""),
            "ioc": code, "seed": rank if rank and rank < 5000 else None,
            "games": [int(l.get("value", 0)) for l in x.get("linescores", [])],
            "tiebreaks": [l.get("tiebreak") for l in x.get("linescores", [])],
            "winner": bool(x.get("winner")),
            # ESPN's "possession": the player serving now (true / false; missing when it doesn't say)
            "serving": x.get("possession") is True}


def _fetch(tour: str) -> list:
    now = datetime.now(timezone.utc)
    tourneys = _tourney_info()
    want = "mens-singles" if tour == "ATP" else "womens-singles"
    seen, out = set(), []
    # ESPN files a day under US time: yesterday's page still holds tonight's late matches in Asia
    def get(d):
        try:
            return kb.get_json(kb.ESPN.format(tour=tour.lower(), day=d.strftime("%Y%m%d")))
        except Exception as err:                   # one day ESPN can't give doesn't empty the tab
            print(f"[tennis-live] {tour} {d:%Y-%m-%d}: {err}")
            return {}
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(3) as pool:
        pages = list(pool.map(get, (now - timedelta(days=1), now, now + timedelta(days=1))))
    for data in pages:
        for ev in data.get("events", []):
            name = ev.get("name") or ""
            city = (ev.get("venue") or {}).get("displayName", "")
            if tour == "WTA" and not tourneys.is_wta_tour(name, city, ev.get("major")):
                continue                           # WTA 125s share ESPN's WTA feed
            for g in ev.get("groupings", []):
                if (g.get("grouping") or {}).get("slug") != want:
                    continue
                comps = g.get("competitions", [])
                main = [c for c in comps if "qualif" not in ((c.get("round") or {}).get("displayName") or "").lower()]
                firsts = [c for c in main if ((c.get("round") or {}).get("displayName") or "").lower() == "round 1"]
                draw = 1 if firsts else 0
                while firsts and draw < len(firsts) * 2:
                    draw *= 2
                for c in main:
                    st = (c.get("status") or {}).get("type") or {}
                    state = {"STATUS_IN_PROGRESS": "live", "STATUS_SCHEDULED": "upcoming"}.get(st.get("name"))
                    if not state or c.get("id") in seen:
                        continue
                    start = c.get("date") or c.get("startDate")
                    try:
                        when = datetime.fromisoformat(start.replace("Z", "+00:00")) if start else None
                    except ValueError:
                        when = None
                    if state == "upcoming" and (not when or when > now + timedelta(hours=AHEAD_HOURS) or when < now - timedelta(hours=12)):
                        continue
                    sides = [_side(x) for x in sorted(c.get("competitors", []), key=lambda x: x.get("order", 0))]
                    if len(sides) != 2 or all(s["name"] == "TBD" for s in sides):
                        continue
                    seen.add(c.get("id"))
                    in_set = max((len(s["games"]) for s in sides), default=0)
                    out.append({"espn": str(c.get("id")), "tour": tour, "state": state, "start": start,
                                "detail": (f"Set {in_set}" if in_set else "Starting") if state == "live" else None,
                                "tournament": name, "surface": tourneys.surface(name, city),
                                "level": tourneys.level(name, tour, ev.get("major")),
                                "round": kb._round((c.get("round") or {}).get("displayName"), draw),
                                "players": sides})
    return out


# The points in the game being played: ESPN doesn't give them, the WTA's own
# live scoring does (api.wtatennis.com - free, no key). Nothing like it is open
# for the ATP, so men's matches go without.
WTA_API = "https://api.wtatennis.com/tennis"
POINTS_SECONDS = 2                    # the app asks every few seconds while a WTA match is live (see points())
_points: tuple[float, list] | None = None
_wta_events: tuple[float, list] | None = None


def _wta_live_events() -> list:
    """The WTA tournaments being played now, as (id, year, level) - looked up every 10 minutes."""
    global _wta_events
    with _lock:
        if _wta_events and time.time() - _wta_events[0] < 600:
            return _wta_events[1]
    today = datetime.now(timezone.utc).date()
    data = kb.get_json(f"{WTA_API}/tournaments/?page=0&pageSize=50&excludeLevels=ITF"
                       f"&from={today - timedelta(days=8)}&to={today + timedelta(days=1)}")
    got = [(t["liveScoringId"], t["year"], t.get("level") or "") for t in data.get("content", [])
           if t.get("status") in ("live", "inProgress") and t.get("liveScoringId")]
    with _lock:
        _wta_events = (time.time(), got)
    return got


def _pt(v):
    """The WTA's "Av" (advantage) shows as "A"; an empty point as nothing."""
    v = str(v or "").strip()
    return "A" if v.lower().startswith("a") else (v or None)


def _wta_points() -> list:
    """Live WTA singles matches with the game score: [{a, b, point_a, point_b, serve}] (surnames).
    Older than POINTS_SECONDS: the last answer now, a fresh one fetched behind it."""
    with _lock:
        hit = _points
    if hit:
        if time.time() - hit[0] >= POINTS_SECONDS:
            _bg("wta-points", _load_wta_points)
        return hit[1]
    return _load_wta_points()


def _load_wta_points() -> list:
    global _points
    out = []
    try:
        events = [e for e in _wta_live_events() if "125" not in (e[2] or "")]   # the Live tab is tour level
        from concurrent.futures import ThreadPoolExecutor
        def get(ev):
            try:
                return kb.get_json(f"{WTA_API}/tournaments/{ev[0]}/{ev[1]}/matches?states=L").get("matches", [])
            except Exception as err:
                print(f"[tennis-live] WTA points {ev}: {err}")
                return []
        with ThreadPoolExecutor(4) as pool:
            for ev, ms in zip(events, pool.map(get, events)):
                for m in ms:
                    if m.get("DrawMatchType") != "S" or m.get("MatchState") not in ("P", "S"):   # S: suspended
                        continue
                    out.append({"a": kb.norm(m.get("PlayerNameLastA")), "b": kb.norm(m.get("PlayerNameLastB")),
                                "wta": (ev[0], ev[1], m.get("MatchID")), "level": ev[2],
                                "point_a": _pt(m.get("PointA")), "point_b": _pt(m.get("PointB")),
                                "serve": m.get("Serve"),
                                "games_a": [int(m[f"ScoreSet{i}A"]) for i in range(1, 6) if str(m.get(f"ScoreSet{i}A") or "").isdigit()],
                                "games_b": [int(m[f"ScoreSet{i}B"]) for i in range(1, 6) if str(m.get(f"ScoreSet{i}B") or "").isdigit()]})
    except Exception as err:                       # no points is fine: the games still show
        print(f"[tennis-live] WTA points: {err}")
    with _lock:
        _points = (time.time(), out)
    return out


def _add_points(out: list) -> None:
    """Each live WTA match gets each player's "point" (0 / 15 / 30 / 40 / AD, or the tie-break count)."""
    live = [m for m in out if m["tour"] == "WTA" and m["state"] == "live"]
    if not live:
        return
    pts = _wta_points()
    for m in live:
        names = [kb.norm(p["name"]) for p in m["players"]]
        for w in pts:
            if not (w["a"] and w["b"]):
                continue
            for flip in (False, True):
                a, b = (w["b"], w["a"]) if flip else (w["a"], w["b"])
                if names[0].endswith(a) and names[1].endswith(b):
                    pa, pb = (w["point_b"], w["point_a"]) if flip else (w["point_a"], w["point_b"])
                    m["players"][0]["point"], m["players"][1]["point"] = pa, pb
                    ga, gb = (w["games_b"], w["games_a"]) if flip else (w["games_a"], w["games_b"])
                    # the games from the same feed as the points (ESPN's are up to a minute behind);
                    # sets already finished keep ESPN's tie-break points
                    if ga and len(ga) == len(gb) and len(ga) >= len(m["players"][0]["games"]):
                        m["players"][0]["games"], m["players"][1]["games"] = ga, gb
                        m["detail"] = f"Set {len(ga)}"
                    if w["serve"] in ("A", "B"):
                        first = (w["serve"] == "A") != flip
                        m["players"][0]["serving"], m["players"][1]["serving"] = first, not first
                    break
            else:
                continue
            break


def points() -> dict:
    """Just the live WTA matches' game score, by ESPN id - cheap enough for the
    app to ask every few seconds (the WTA feed only answers when asked, so this
    is as close to "as it happens" as it gets). Uses the ESPN list the last
    matches() call cached; nothing when there isn't one."""
    with _lock:
        hit = _cache.get("WTA")
    if not hit:
        return {"matches": {}}
    out = [{**m, "players": [dict(p) for p in m["players"]]} for m in hit[1] if m["state"] == "live"]
    _add_points(out)
    return {"matches": {m["espn"]: {"detail": m["detail"],
                                    "players": [{k: p.get(k) for k in ("games", "point", "serving")} for p in m["players"]]}
                        for m in out if any(p.get("point") is not None for p in m["players"])}}


def _refresh(t: str) -> None:
    _tourney_info()
    got = _fetch(t)
    with _lock:
        _cache[t] = (time.time(), got)


def warm() -> None:
    """At server start: the tournament list, both tours' matches and the WTA points
    ready before anyone opens the Live tab."""
    for t in ("ATP", "WTA"):
        _refresh(t)
    _load_wta_points()


def matches(db, tour: str = "all") -> dict:
    tours = [tour.upper()] if tour.upper() in ("ATP", "WTA") else ["ATP", "WTA"]
    out = []
    missing = []
    for t in tours:
        with _lock:
            hit = _cache.get(t)
        if hit:
            out += hit[1]
            if time.time() - hit[0] >= CACHE_SECONDS:
                _bg(f"espn-{t}", lambda t=t: _refresh(t))     # this answer now, a fresh one behind it
        else:
            missing.append(t)
    if missing:                                    # only the very first ask waits
        _tourney_info()
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(2) as pool:
            for t, got in zip(missing, pool.map(_fetch, missing)):
                with _lock:
                    _cache[t] = (time.time(), got)
                out += got
    out = [{**m, "players": [dict(p) for p in m["players"]]} for m in out]   # ids go on copies, not the cache
    # ESPN athlete -> knowledge-base player, so the match page can show form and head-to-head
    # (looked up once an hour per player, not on every refresh)
    now = time.time()
    ids = {(m["tour"], p["espn_id"]) for m in out for p in m["players"] if p["espn_id"]}
    ask = sorted({e for k in ids for e in [k[1]] if k not in _kb_ids or now - _kb_ids[k][1] > 3600})
    if ask:
        found = {}
        for r in db.execute(text("SELECT tour, espn_id, player_id FROM tennis_players WHERE espn_id = ANY(:ids)"),
                            {"ids": ask}).fetchall():
            found[(r[0], r[1])] = r[2]
        for k in ids:
            if k[1] in ask:
                _kb_ids[k] = (found.get(k), now)
    for m in out:
        for p in m["players"]:
            p["id"] = (_kb_ids.get((m["tour"], p["espn_id"])) or (None,))[0]
    out.sort(key=lambda m: (m["state"] != "live", m["start"] or "", m["tournament"]))
    return {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "matches": out}

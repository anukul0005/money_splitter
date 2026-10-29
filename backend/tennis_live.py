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
            "winner": bool(x.get("winner"))}


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


def matches(db, tour: str = "all") -> dict:
    tours = [tour.upper()] if tour.upper() in ("ATP", "WTA") else ["ATP", "WTA"]
    out = []
    stale = []
    for t in tours:
        with _lock:
            hit = _cache.get(t)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            out += hit[1]
        else:
            stale.append(t)
    if stale:
        _tourney_info()                            # once, before the tours fetch side by side
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(2) as pool:
            for t, got in zip(stale, pool.map(_fetch, stale)):
                with _lock:
                    _cache[t] = (time.time(), got)
                out += got
    # ESPN athlete -> knowledge-base player, so the match page can show form and head-to-head
    ids = {(m["tour"], p["espn_id"]) for m in out for p in m["players"] if p["espn_id"]}
    known = {}
    if ids:
        espn_ids = sorted({e for _, e in ids})
        for r in db.execute(text("SELECT tour, espn_id, player_id FROM tennis_players WHERE espn_id = ANY(:ids)"),
                            {"ids": espn_ids}).fetchall():
            known[(r[0], r[1])] = r[2]
    for m in out:
        for p in m["players"]:
            p["id"] = known.get((m["tour"], p["espn_id"]))
    out.sort(key=lambda m: (m["state"] != "live", m["start"] or "", m["tournament"]))
    return {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "matches": out}

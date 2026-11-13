"""Field hockey - FIH tournaments, fixtures and results, standings, stats,
head-to-heads and world rankings, read from fih.hockey's own public data
feeds (the ones its match centre, event and rankings pages load in the
browser). No key.

Nothing is stored: hockey has a few dozen international tournaments a
year, each read whole in one request, so every answer is fetched when asked
and held in memory a while - seconds for a tournament with a match on,
hours for one that's over.
"""
from __future__ import annotations

import json
import threading
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

BASE = "https://www.fih.hockey"
FIXTURES = f"{BASE}/default.aspx?methodtype=3&client=8696669363&sport=5&league=0&timezone=0530&language=en"
FEEDS = f"{BASE}/datafeeds/static/json/en"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
IST = timezone(timedelta(hours=5, minutes=30))
LIVE_SECONDS = 30
GENDER = {"M": "Men", "F": "Women"}


def _get(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json",
                                               "Referer": f"{BASE}/"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode("utf-8"))


_held: dict[str, tuple[float, object]] = {}
_lock = threading.Lock()


def _hold(key: str, ttl: float, fn):
    hit = _held.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    value = fn()
    with _lock:
        _held[key] = (time.time(), value)
        if len(_held) > 400:
            _held.pop(next(iter(_held)))
    return value


def _day(s) -> date | None:
    try:
        return date.fromisoformat(str(s)[:10])
    except (TypeError, ValueError):
        return None


# ── Tournaments ─────────────────────────────────────────────────────────────

def _event(s: dict) -> dict:
    return {"id": int(s["series_id"]), "name": (s.get("series") or "").strip(),
            "gender": s.get("series_gender_short") or None, "status": s.get("series_status"),
            "start": s.get("series_start_date"), "end": s.get("series_end_date"),
            "discipline": s.get("discipline"), "age": s.get("age"), "parent": s.get("parent_series"),
            "teams": [{"id": p.get("team_id"), "name": p.get("team_name"), "code": p.get("team_name_short")}
                      for p in s.get("participants") or []],
            "venue": ", ".join(dict.fromkeys(v.get("venue_name") for v in s.get("venues") or [] if v.get("venue_name")))}


def events(status: str, page: int = 1, size: int = 20, parent: int | None = None) -> dict:
    """FIH's tournaments: `status` "l,u" (on now and coming up) or "r" (over), newest first."""
    def read():
        q = {"parentid": parent or "", "seriesid": "", "gender": "", "status": status, "year_from": "", "year_to": "",
             "page_number": page, "pagesize": size, "discipline_id": "", "age_id": ""}
        d = (_get(f"{BASE}/data-api/static/sr/series?{urllib.parse.urlencode(q)}") or {}).get("data") or {}
        return {"events": [_event(s) for s in d.get("value") or [] if s.get("series_id")],
                "pages": d.get("page_count") or 1, "page": page}
    return _hold(f"e{status}:{page}:{size}:{parent}", 600 if "l" in status else 3 * 3600, read)


def event(series_id: int) -> dict | None:
    def read():
        d = (_get(f"{BASE}/data-api/static/sr/series?seriesid={series_id}") or {}).get("data") or {}
        v = d.get("value") or []
        return _event(v[0]) if v else None
    return _hold(f"t{series_id}", 3600, read)


# ── Matches ─────────────────────────────────────────────────────────────────

def _goals(v) -> tuple[int | None, int | None]:
    """FIH's "2(3)": 2 goals, 3 in the shoot-out."""
    v = str(v or "").strip()
    if not v:
        return None, None
    g, _, so = v.partition("(")
    try:
        return int(g), (int(so.rstrip(")")) if so else None)
    except ValueError:
        return None, None


def _match(m: dict) -> dict:
    state = {"R": "finished", "U": "upcoming"}.get(m.get("event_state"), "live")
    sides = []
    for p in (m.get("participants") or [])[:2]:
        g, so = _goals(p.get("value"))
        sides.append({"id": int(p["id"]) if str(p.get("id") or "").isdigit() else None,
                      "name": p.get("name") or "TBD", "code": p.get("short_name"), "goals": g, "so": so})
    while len(sides) < 2:
        sides.append({"id": None, "name": "TBD", "code": None, "goals": None, "so": None})
    a, b = sides
    winner = 0
    if state == "finished" and a["goals"] is not None and b["goals"] is not None:
        ka, kb = (a["goals"], a["so"] or 0), (b["goals"], b["so"] or 0)
        winner = 1 if ka > kb else 2 if kb > ka else 0
    return {"id": int(m["game_id"]), "series_id": int(m.get("series_id") or 0), "series": m.get("series_name"),
            "gender": m.get("gender"), "start": m.get("start_date"), "day": m.get("match_date"),
            "state": state, "status": m.get("event_sub_status") or m.get("event_status"),
            "round": m.get("event_name"), "pool": m.get("pool") or None, "venue": m.get("venue_name"),
            "home": a, "away": b, "winner": winner}


def _when(m: dict) -> datetime | None:
    try:
        return datetime.fromisoformat(m["start"])
    except (TypeError, ValueError, KeyError):
        return None


def matches(series_id: int) -> list[dict]:
    """Every match of a tournament, in order of play."""
    key = f"m{series_id}"
    hit = _held.get(key)
    # read again in seconds while a match is on, else every few minutes - hours once it's all over
    if hit:
        ms = hit[1]
        ttl = LIVE_SECONDS if any(m["state"] == "live" for m in ms) else \
            6 * 3600 if ms and all(m["state"] == "finished" for m in ms) else 300
        if time.time() - hit[0] < ttl:
            return ms

    def read():
        d = _get(f"{FIXTURES}&tournament={series_id}") or {}
        ms = [_match(m) for m in d.get("matches") or [] if m.get("game_id")]
        return sorted(ms, key=lambda m: (m["start"] or "", m["id"]))
    _held.pop(key, None)
    return _hold(key, 0, read)


def live() -> dict:
    """The tournaments on now: today's matches (and yesterday's late ones,
    tomorrow's early ones), live first; and what's coming up."""
    now = datetime.now(IST)
    evs = events("l,u", 1, 30)["events"]
    on, soon = [], []
    for e in evs:
        start, end = _day(e["start"]), _day(e["end"])
        if not start:
            continue
        if start <= now.date() <= (end or start):
            on.append(e)
        else:
            soon.append(e)
    out = []
    for e in on:
        try:
            ms = matches(e["id"])
        except Exception as ex:
            print(f"[hockey] {e['name']}: {ex}")
            continue
        keep = []
        for m in ms:
            w = _when(m)
            hours = (w - now).total_seconds() / 3600 if w else 0
            if m["state"] == "live" or (m["state"] == "upcoming" and hours < 36) or \
                    (m["state"] == "finished" and hours > -24):
                keep.append(m)
        out.append({**e, "matches": keep})
    return {"tournaments": out, "upcoming": sorted(soon, key=lambda e: e["start"] or "")[:12],
            "updated": datetime.now(timezone.utc).isoformat()}


def keep_live() -> None:
    """From server start: the live list's FIH reads redone just before they
    go stale, so the Live tab is answered from memory, never waiting on FIH."""
    time.sleep(20)
    while True:
        try:
            live()
        except Exception as e:
            print(f"[hockey] keep live: {e}")
        time.sleep(10)                 # oftener than LIVE_SECONDS, so it is the one that waits


# ── Standings, stats, head-to-head, rankings ────────────────────────────────

def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def standings(series_id: int) -> list[dict]:
    def read():
        try:
            d = _get(f"{FEEDS}/standings/{series_id}_standings.json")
        except Exception:
            return []
        groups = []
        for g in ((d or {}).get("standings") or {}).get("groups") or []:
            rows = (g.get("teams") or {}).get("team") or []
            groups.append({"name": g.get("name") if g.get("name") not in ("RR", None) else "",
                           "teams": [{"id": t.get("team_id"), "name": t.get("team_name"), "code": t.get("team_short_name"),
                                      "pos": _int(t.get("position")), "p": _int(t.get("played")), "w": _int(t.get("wins")),
                                      "d": _int(t.get("draws")), "l": _int(t.get("lost")),
                                      "so_w": _int(t.get("so_win")), "so_l": _int(t.get("so_loss")),
                                      "gf": _int(t.get("gf")), "ga": _int(t.get("ga")), "gd": _int(t.get("goal_difference")),
                                      "pts": _int(t.get("points")), "form": t.get("result_string") or ""}
                                     for t in sorted(rows, key=lambda t: _int(t.get("position")) or 99)]})
        return [g for g in groups if g["teams"]]
    return _hold(f"s{series_id}", 120, read)


TEAM_STATS = {"Team Goals": "goals", "Team Field Goals": "field_goals", "Team Penalty Corners": "pc_goals",
              "Team Penalty Strokes": "ps_goals", "Team Green Cards": "green", "Team Yellow Cards": "yellow",
              "Team Red Cards": "red"}
PLAYER_STATS = {"Players Goals": "goals", "Players Cards": "cards", "Players shootout": "shootout"}


def stats(series_id: int) -> dict:
    """A tournament's leaders: goals by team (field, penalty corner, stroke)
    and cards, and its top scorers."""
    def read():
        try:
            d = _get(f"{FEEDS}/stats/{series_id}_allstats.json") or {}
        except Exception:
            return {"teams": [], "players": {}}
        teams: dict = {}
        players: dict = {}
        for s in d.get("all_stats") or []:
            name = s.get("stat")
            if name in TEAM_STATS:
                for r in s.get("data") or []:
                    t = teams.setdefault(r.get("team_id"), {"id": r.get("team_id"), "name": r.get("team_name"),
                                                           "code": r.get("team_short"), "played": r.get("match_played")})
                    t[TEAM_STATS[name]] = r.get("value")
            elif name in PLAYER_STATS:
                players[PLAYER_STATS[name]] = [
                    {"id": r.get("player_id"), "name": r.get("player_name"), "team": r.get("team_short"),
                     "value": r.get("value"), "played": r.get("match_played"), "image": r.get("player_image_url")}
                    for r in sorted(s.get("data") or [], key=lambda r: r.get("rank") or 999) if r.get("value")][:15]
        return {"teams": sorted(teams.values(), key=lambda t: -(t.get("goals") or 0)), "players": players}
    return _hold(f"x{series_id}", 300, read)


def h2h(match_id: int) -> dict:
    """The two teams' record against each other and their last meetings."""
    def read():
        try:
            d = _get(f"{FEEDS}/h2h/{match_id}_h2h.json") or {}
        except Exception:
            return {"teams": [], "matches": []}
        teams = [{"id": t.get("team_id"), "name": t.get("team_name"), "code": t.get("team_short_name"),
                  "played": t.get("matches_played"), "won": t.get("won"), "lost": t.get("lost"), "drawn": t.get("tied")}
                 for t in d.get("teams") or []]
        last = [{"id": m.get("match_id"), "day": m.get("match_date"), "series": m.get("comp_name"),
                 "round": m.get("match_number"), "result": m.get("result"),
                 "home": {"id": m.get("team1_id"), "name": m.get("team1_name"), "code": m.get("team1_short_name"),
                          "goals": m.get("team1_score")},
                 "away": {"id": m.get("team2_id"), "name": m.get("team2_name"), "code": m.get("team2_short_name"),
                          "goals": m.get("team2_score")},
                 "winner": 1 if m.get("winner_team_id") == m.get("team1_id") and m.get("winner_team_id")
                 else 2 if m.get("winner_team_id") == m.get("team2_id") and m.get("winner_team_id") else 0}
                for m in d.get("last_n_matches") or [] if m.get("match_id") != match_id]
        return {"teams": teams, "matches": last[:10]}
    return _hold(f"h{match_id}", 6 * 3600, read)


def rankings(gender: str) -> dict:
    """FIH's outdoor world rankings: "m" men, "f" women."""
    def read():
        d = _get(f"{FEEDS}/OutdoorRanking/outdoorranking_{gender}.json") or {}
        try:        # "11/5/2026 8:54:51 PM"
            updated = datetime.strptime(d.get("last_updated") or "", "%m/%d/%Y %I:%M:%S %p").date().isoformat()
        except ValueError:
            updated = None
        return {"updated": updated,
                "rows": [{"rank": r.get("rank"), "id": r.get("team_id"), "code": r.get("team_short_code"),
                          "name": (r.get("team") or "").title(), "cf": r.get("cf_code"),
                          "points": round(r.get("points") or 0, 2), "last": r.get("last_match_played_on")}
                         for r in d.get("ranks") or []]}
    return _hold(f"r{gender}", 6 * 3600, read)

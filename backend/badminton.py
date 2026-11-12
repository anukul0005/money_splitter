"""Badminton - BWF results from 2018, live scores, match stats and rankings,
read from bwfbadminton.com's own public data service (extranet-lv), the one
its calendar, results and rankings pages load in the browser. No key; asked
gently: the backfill waits PACE seconds between requests, and live scores
are read at most every LIVE_SECONDS, only while someone has the Live tab open.

Kept here: tournaments (Olympics / World Championships, World Tour Finals,
Super 1000 down to Super 100), players and every match with its score -
what Results, Players and Stats need. Point-by-point detail and rankings are
fetched when asked for and held in memory a while.

The backfill runs in the background from startup (loop): each year's
calendar, then every tournament not yet read - newest first - a day at a
time. A tournament counts as done (`synced`) once read after it ended, so a
restart picks up where the last one stopped.
"""
from __future__ import annotations

import json
import threading
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

API = "https://extranet-lv.bwfbadminton.com/api"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
FIRST_YEAR = 2018
# bwfbadminton.com's calendar categories -> our level (0 = biggest)
CATEGORIES = {20: 0, 22: 1, 23: 2, 24: 3, 25: 4, 26: 5, 27: 6}
LEVEL_NAME = {0: "Major event", 1: "World Tour Finals", 2: "Super 1000", 3: "Super 750", 4: "Super 500",
              5: "Super 300", 6: "Super 100"}
EVENTS = ("MS", "WS", "MD", "WD", "XD")
EVENT_NAME = {"MS": "Men's singles", "WS": "Women's singles", "MD": "Men's doubles", "WD": "Women's doubles",
              "XD": "Mixed doubles"}
PACE = 2.5                 # seconds between backfill requests
LIVE_SECONDS = 30
RESYNC_EVERY = 3 * 3600    # the backfill looks for new / unfinished tournaments this often

_lock = threading.Lock()
_last_paced = 0.0
_state = {"running": False, "done": 0, "todo": 0, "last": None}


def _get(path: str, params: dict | None = None, pace: bool = False):
    global _last_paced
    if pace:
        with _lock:
            wait = PACE - (time.time() - _last_paced)
            _last_paced = time.time() + max(0.0, wait)
        if wait > 0:
            time.sleep(wait)
    url = f"{API}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json",
                                               "Referer": "https://bwfworldtour.bwfbadminton.com/"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode("utf-8"))


def _day(s) -> date | None:
    try:
        return date.fromisoformat(str(s)[:10])
    except (TypeError, ValueError):
        return None


def _utc(s) -> datetime | None:
    try:
        return datetime.fromisoformat(str(s)[:19])
    except (TypeError, ValueError):
        return None


def _session():
    from database import get_session_factory
    return get_session_factory()()


# ── Reading BWF's answers into rows ──────────────────────────────────────────

def _player_rows(m: dict) -> list[dict]:
    out = []
    for side in ("team1", "team2"):
        for p in (m.get(side) or {}).get("players") or []:
            if p.get("id"):
                out.append({"id": int(p["id"]), "name": (p.get("nameDisplay") or "").strip()[:120] or "?",
                            "country": (p.get("countryCode") or None), "slug": p.get("slug"),
                            "avatar": ((p.get("avatar") or {}).get("thumbnailUrl") or None)})
    return out


def _ids(m: dict, side: str) -> list[int | None]:
    ps = [int(p["id"]) for p in (m.get(side) or {}).get("players") or [] if p.get("id")]
    return (ps + [None, None])[:2]


def _games(m: dict) -> list[list[int]]:
    return [[int(s["home"]), int(s["away"])] for s in m.get("score") or []
            if s.get("home") is not None and s.get("away") is not None]


def _status(m: dict) -> str:
    st = m.get("matchStatus")
    if st:
        return st
    return "F" if m.get("winner") in (1, 2) else "N"


def _result_row(m: dict, tournament_id: int) -> dict | None:
    event = (m.get("eventName") or m.get("drawName") or "")[:4].upper()
    if m.get("isTeamMatch") or event not in EVENTS or not m.get("id"):
        return None
    a, b = _ids(m, "team1"), _ids(m, "team2")
    return {"id": int(m["id"]), "tournament_id": tournament_id, "code": str(m.get("code") or ""),
            "event": event, "round": (m.get("roundName") or None), "day": _day(m.get("matchTime")),
            "time_utc": _utc(m.get("matchTimeUtc")), "status": _status(m)[:2],
            "winner": m.get("winner") if m.get("winner") in (1, 2) else 0,
            "score_status": int(m.get("scoreStatus") or 0),
            "p1a": a[0], "p1b": a[1], "p2a": b[0], "p2b": b[1],
            "c1": ((m.get("team1") or {}).get("countryCode") or None),
            "c2": ((m.get("team2") or {}).get("countryCode") or None),
            "seed1": (str(m["team1seed"])[:6] if m.get("team1seed") else None),
            "seed2": (str(m["team2seed"])[:6] if m.get("team2seed") else None),
            "score": " ".join(f"{x}-{y}" for x, y in _games(m))[:40] or None,
            "minutes": m.get("duration") or None, "court": (m.get("courtName") or None)}


def _store(db, matches: list[dict], tournament_id: int) -> int:
    """Upsert one day's matches and their players; returns how many matches."""
    from models import BadmintonPlayer, BadmintonResult
    players, rows = {}, []
    for m in matches:
        row = _result_row(m, tournament_id)
        if row is None:
            continue
        rows.append(row)
        for p in _player_rows(m):
            players[p["id"]] = p
    for p in players.values():
        db.merge(BadmintonPlayer(**p))
    for r in rows:
        db.merge(BadmintonResult(**r))
    db.commit()
    return len(rows)


def _tournament_row(t: dict, cat: int) -> dict:
    return {"id": int(t["id"]), "code": t["code"], "name": (t.get("name") or "").strip()[:200],
            "category": (t.get("category") or LEVEL_NAME.get(CATEGORIES.get(cat, 9)) or "")[:80] or None,
            "level": CATEGORIES.get(cat, 9), "start_date": _day(t.get("start_date")), "end_date": _day(t.get("end_date")),
            "location": (t.get("location") or t.get("venue_name") or None),
            "country": t.get("country") or None,
            "logo": t.get("logo") or t.get("tmtLogo") or None}


# ── The backfill ────────────────────────────────────────────────────────────

def calendar(db, year: int) -> int:
    """File a year's tournaments (new ones added, dates and names kept current)."""
    from models import BadmintonTournament
    n = 0
    for cat in CATEGORIES:
        data = _get("/vue-grouped-year-tournaments", {"year": year, "category[]": [cat], "state": "all"}, pace=True)
        for month in data.get("results") or []:
            for t in month.get("tournaments") or []:
                row = _tournament_row(t, cat)
                if not row["start_date"] or not row["end_date"]:
                    continue
                have = db.get(BadmintonTournament, row["id"])
                if have is None:
                    db.add(BadmintonTournament(**row))
                else:
                    for k, v in row.items():
                        if v is not None:
                            setattr(have, k, v)
                n += 1
        db.commit()
    return n


def sync_tournament(db, t) -> int:
    """Read every day of a tournament played so far; done once read after it ended."""
    today = datetime.now(timezone.utc).date()
    n, d = 0, t.start_date
    while d <= min(t.end_date, today):
        data = _get("/tournaments/day-matches", {"tournamentCode": t.code, "date": d.isoformat(),
                                                 "order": 2, "court": 0}, pace=True)
        if isinstance(data, list):
            n += _store(db, data, t.id)
        d += timedelta(days=1)
    t.synced_at = datetime.now(timezone.utc)
    if t.end_date < today - timedelta(days=1):
        t.synced = True
    db.commit()
    return n


def sync_all() -> None:
    from models import BadmintonTournament
    db = _session()
    try:
        _state["running"] = True
        today = datetime.now(timezone.utc).date()
        for y in range(FIRST_YEAR, today.year + 2):          # next year too, for what's coming up
            try:
                calendar(db, y)
            except Exception as e:
                db.rollback()
                print(f"[badminton] calendar {y}: {e}")
        todo = (db.query(BadmintonTournament)
                .filter(BadmintonTournament.synced.is_(False), BadmintonTournament.start_date <= today)
                .order_by(BadmintonTournament.start_date.desc()).all())
        _state.update(todo=len(todo), done=0)
        for t in todo:
            try:
                sync_tournament(db, t)
            except Exception as e:
                db.rollback()
                print(f"[badminton] {t.name}: {e}")
            _state["done"] += 1
        _state["last"] = datetime.now(timezone.utc).isoformat()
    finally:
        _state["running"] = False
        db.close()


def loop() -> None:
    time.sleep(90)                 # let the app finish starting
    while True:
        try:
            sync_all()
        except Exception as e:
            print(f"[badminton] sync failed: {e}")
        time.sleep(RESYNC_EVERY)


def progress() -> dict:
    return dict(_state)


# ── Live ────────────────────────────────────────────────────────────────────

_live: tuple[float, dict] | None = None
_live_busy = False


def _serve(m: dict) -> int | None:
    games = m.get("score") or []
    v = games[-1].get("serve") if games else None
    if v in (1, "1", "home", "team1", "h"):
        return 1
    if v in (2, "2", "away", "team2", "a"):
        return 2
    return None


def _side(m: dict, side: str) -> dict:
    t = m.get(side) or {}
    return {"players": [{"id": int(p["id"]) if p.get("id") else None, "name": p.get("nameDisplay") or "TBD",
                         "country": p.get("countryCode")} for p in t.get("players") or []] or [{"id": None, "name": "TBD", "country": None}],
            "country": t.get("countryCode"), "seed": m.get(f"{side}seed") or None}


def live_item(m: dict, tournament_id: int) -> dict:
    st = _status(m)
    return {"id": m.get("id"), "code": str(m.get("code") or ""), "tournament_id": tournament_id,
            "event": (m.get("eventName") or "")[:4].upper(), "round": m.get("roundName"),
            "state": "finished" if st == "F" else "upcoming" if st in ("N", None) else "live",
            "winner": m.get("winner") if m.get("winner") in (1, 2) else 0,
            "score_status": int(m.get("scoreStatus") or 0),
            "side1": _side(m, "team1"), "side2": _side(m, "team2"), "games": _games(m), "serve": _serve(m),
            "time_utc": m.get("matchTimeUtc"), "court": m.get("courtName"), "minutes": m.get("duration")}


def _read_live() -> dict:
    from models import BadmintonTournament
    now = datetime.now(timezone.utc)
    data = _get("/match-center/vue-current-live", {"category[]": list(CATEGORIES)})
    out = []
    for t in data.get("results") or []:
        start, end = _day(t.get("start_date")), _day(t.get("end_date"))
        if not start or not end:
            continue
        cat = int(t.get("tournament_category_id") or 0)
        days = sorted({d for d in (now.date() - timedelta(days=1), now.date(), now.date() + timedelta(days=1))
                       if start <= d <= end})
        raw = {}
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(3) as pool:                  # the days at once, not one after another
            pages = list(pool.map(lambda d: (d, _get("/tournaments/day-matches", {"tournamentCode": t["code"], "date": d.isoformat(),
                                                                                  "order": 2, "court": 0})), days))
        for d, got in pages:
            for m in got if isinstance(got, list) else []:
                if not m.get("isTeamMatch") and m.get("id"):
                    raw[m["id"]] = (m, d)
        items = []
        for m, d in raw.values():
            it = live_item(m, int(t["id"]))
            when = _utc(m.get("matchTimeUtc"))
            hours = (when.replace(tzinfo=timezone.utc) - now).total_seconds() / 3600 if when else 0
            if it["state"] == "live" or (it["state"] == "upcoming" and hours < 30) or \
                    (it["state"] == "finished" and hours > -20):
                items.append(it)
        items.sort(key=lambda i: ({"live": 0, "upcoming": 1, "finished": 2}[i["state"]],
                                  (i["time_utc"] or "") if i["state"] != "finished" else "",
                                  "" if i["state"] != "finished" else _neg(i["time_utc"] or "")))
        out.append({"id": int(t["id"]), "name": t.get("name"), "dates": t.get("date"),
                    "venue": ", ".join(x for x in (t.get("venue_name"), t.get("venue_address1")) if x),
                    "logo": t.get("tmtLogo"), "category": LEVEL_NAME.get(CATEGORIES.get(cat, 9)),
                    "matches": items})
        # what was read goes into the results too
        db = _session()
        try:
            if db.get(BadmintonTournament, int(t["id"])) is None:
                db.add(BadmintonTournament(**_tournament_row(t, cat)))
                db.commit()
            for d in days:
                _store(db, [m for m, dd in raw.values() if dd == d], int(t["id"]))
        except Exception as e:
            db.rollback()
            print(f"[badminton] live store: {e}")
        finally:
            db.close()
    return {"tournaments": out, "updated": now.isoformat()}


def _neg(s: str) -> str:
    """Sort key putting later times first."""
    return "".join(chr(0x10FFFF - ord(c)) for c in s)


KEEP_IDLE = 5 * 60          # kept in the background this often when nobody's looking
_asked = 0.0


def keep_live() -> None:
    """From server start: the live list read now and kept fresh, so the
    Live tab never waits the minute a cold read takes."""
    global _live
    while True:
        try:
            _live = (time.time(), _read_live())
        except Exception as e:
            print(f"[badminton] keep live: {e}")
        time.sleep(LIVE_SECONDS if time.time() - _asked < 20 * 60 else KEEP_IDLE)


def live() -> dict:
    """Today's matches at the tournaments under way; read again when LIVE_SECONDS old
    (the request gets the last answer while that happens in the background)."""
    global _live, _live_busy, _asked
    _asked = time.time()
    if _live and time.time() - _live[0] < LIVE_SECONDS:
        return _live[1]
    if _live is None:
        _live = (time.time(), _read_live())
        return _live[1]
    if not _live_busy:
        _live_busy = True

        def run():
            global _live, _live_busy
            try:
                _live = (time.time(), _read_live())
            except Exception as e:
                print(f"[badminton] live: {e}")
            finally:
                _live_busy = False
        threading.Thread(target=run, daemon=True, name="badminton-live").start()
    return _live[1]


# ── One match's numbers, rankings (fetched when asked, held a while) ────────

_held: dict[str, tuple[float, object]] = {}


def _hold(key: str, ttl: float, fn):
    hit = _held.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    value = fn()
    _held[key] = (time.time(), value)
    if len(_held) > 400:
        _held.pop(next(iter(_held)))
    return value


def match_detail(tournament_id: int, code: str, finished: bool) -> dict:
    def read():
        d = _get("/h2h/match", {"tmt_id": tournament_id, "match_code": code}) or {}
        s = d.get("stats") or {}
        games = []
        for g in sorted(d.get("games") or [], key=lambda g: g.get("ordering") or 0):
            flow = [[p.get("team1") or 0, p.get("team2") or 0]
                    for p in sorted(g.get("match_set_details_model") or [], key=lambda p: p.get("ordering") or 0)]
            games.append({"a": g.get("team1"), "b": g.get("team2"), "flow": flow})
        keys = ("rallies_won", "consecutive_points", "game_points", "smash_winner", "net_winner", "clear_winner",
                "challenge_used", "challenge_won")
        return {"stats": {k: [s.get(f"team1_{k}"), s.get(f"team2_{k}")] for k in keys
                          if s.get(f"team1_{k}") is not None or s.get(f"team2_{k}") is not None},
                "rallies": s.get("team1_rallies_played"), "minutes": (d.get("progress") or {}).get("duration"),
                "games": games}
    return _hold(f"m{tournament_id}:{code}", 24 * 3600 if finished else 20, read)


RANK_CAT = {"MS": 6, "WS": 7, "MD": 8, "WD": 9, "XD": 10}


def _rank_name(pm: dict | None) -> dict | None:
    if not pm:
        return None
    import re
    name = re.sub(r"<[^>]+>", "", pm.get("name_display_bold") or pm.get("name_display") or "").strip()
    # no country here - routers/badminton.py adds it from the players on file
    return {"id": int(pm["id"]) if pm.get("id") else None, "name": " ".join(name.split()), "country": None}


def rankings(event: str) -> dict:
    def read():
        weeks = _get("/vue-rankingweek", {"rankId": 2})
        week = weeks[0] if weeks else {}
        data = _get("/vue-rankingtable", {"rankId": 2, "catId": RANK_CAT[event], "publicationId": week.get("id"),
                                         "doubles": "true" if event in ("MD", "WD", "XD") else "false",
                                         "searchKey": "", "pageKey": 50, "page": 1, "drawCount": 1})
        rows = []
        for r in ((data.get("results") or {}).get("data") or [])[:50]:
            rows.append({"rank": r.get("rank"), "change": r.get("rank_change"),
                         "points": round(float(r.get("points") or 0)), "tournaments": r.get("tournaments"),
                         "players": [x for x in (_rank_name(r.get("player1_model")), _rank_name(r.get("player2_model"))) if x]})
        return {"week": week.get("display"), "rows": rows}
    return _hold(f"r{event}", 6 * 3600, read)

"""Starting line-ups for every top-five league match since 2016/17, from
ESPN's public match summaries (no key) - for the model's rotation feature.

The backfill reads each league's year of events (one scoreboard request a
league a year), then each finished match's summary, about one a second, and
stores both sides' starting XIs (FootballLineup). It resumes where it left
off after a restart, and once caught up it checks the current year every
six hours for newly played matches.

Rotation, as the model sees it: a side's regulars are the players who
started at least three of its last five league matches; `rotation(...)`
counts how many of them aren't in today's XI.
"""
from __future__ import annotations

import difflib
import json
import threading
import time
from datetime import date, timedelta

import football as fb

SLUGS = {"E0": "eng.1", "SP1": "esp.1", "I1": "ita.1", "D1": "ger.1", "F1": "fra.1"}
FIRST_YEAR = 2016             # calendar years: 2016 holds the end of 2015/16 too, skipped by FIRST_SEASON
FIRST_SEASON = "1617"
PAUSE = 0.8                   # seconds between summary requests
status = {"stored": 0, "pending": None, "unmatched": {}, "last": None, "running": False}
_pools: dict[tuple[str, str], dict[str, str]] = {}
_NO_GUESS = {"paris"}         # Paris FC squashes to this, which would otherwise match Paris SG
_lock = threading.Lock()


def _pool(db, code: str, season: str) -> dict[str, str]:
    """{squashed name: name} of the clubs in our results for that league and season (and either side of it)."""
    from sqlalchemy import text
    key = (code, season)
    if key not in _pools:
        y = int(season[:2])
        near = [f"{(y + k) % 100:02d}{(y + k + 1) % 100:02d}" for k in (-1, 0, 1)]
        names = [h for (h,) in db.execute(text(
            "SELECT DISTINCT home FROM football_matches WHERE comp = :c AND season = ANY(:s)"), {"c": code, "s": near})]
        _pools[key] = {fb.squash(n): n for n in names}
    return _pools[key]


def our_name(db, code: str, season: str, team: dict) -> str | None:
    """ESPN's club as football-data.co.uk names it, from that season's clubs."""
    pool = _pool(db, code, season)
    names = set(pool.values())
    for raw in (team.get("shortDisplayName"), team.get("displayName"), team.get("name"), team.get("location")):
        k = fb.squash(raw)
        if not k:
            continue
        if k in fb._ALIAS and fb._ALIAS[k] in names:
            return fb._ALIAS[k]
        if k in pool:
            return pool[k]
        if k in _NO_GUESS:
            continue
        for kk, n in pool.items():
            if len(kk) >= 4 and (kk in k or k in kk):
                return n
    if fb.squash(team.get("displayName")) in _NO_GUESS:
        return None
    best = difflib.get_close_matches(fb.squash(team.get("displayName")), list(pool), n=1, cutoff=0.75)
    return pool[best[0]] if best else None


def _season(d: date) -> str:
    y = d.year if d.month >= 7 else d.year - 1
    return f"{y % 100:02d}{(y + 1) % 100:02d}"


def _year_events(code: str, year: int) -> list[dict]:
    """Finished league matches of `code` in calendar `year`: [{id, day}]."""
    ttl = 6 * 3600 if year >= date.today().year else 30 * 86400
    data = fb._hold(f"lu:{code}{year}", ttl, lambda: fb._get(f"{fb.ESPN_SOCCER}/{SLUGS[code]}/scoreboard?dates={year}&limit=1000"))
    out = []
    for e in data.get("events") or []:
        if ((e.get("status") or {}).get("type") or {}).get("completed"):
            d = date.fromisoformat(e["date"][:10])
            if _season(d) >= FIRST_SEASON:
                out.append({"id": str(e["id"]), "day": d})
    return out


def _store(db, code: str, ev: dict) -> int:
    """Read one match's summary and store both XIs; returns sides stored."""
    from models import FootballLineup
    s = fb._get(f"{fb.ESPN_SOCCER}/{SLUGS[code]}/summary?event={ev['id']}")
    season = _season(ev["day"])
    sides = []
    for r in s.get("rosters") or []:
        t = r.get("team") or {}
        xi = [{"id": str((p.get("athlete") or {}).get("id")), "name": (p.get("athlete") or {}).get("displayName"),
               "pos": (p.get("position") or {}).get("abbreviation")} for p in r.get("roster") or [] if p.get("starter")]
        if len(xi) < 11:
            continue
        sides.append({"t": t, "home": r.get("homeAway") == "home", "xi": xi, "formation": r.get("formation")})
    if len(sides) != 2:
        return 0
    names = [our_name(db, code, season, x["t"]) for x in sides]
    n = 0
    for i, x in enumerate(sides):
        if not names[i]:
            status["unmatched"][x["t"].get("displayName")] = code
        db.add(FootballLineup(event=ev["id"], comp=code, season=season, day=ev["day"], espn_team=str(x["t"].get("id")),
                              espn_name=(x["t"].get("displayName") or "")[:80], team=names[i], opp=names[1 - i],
                              home=x["home"], formation=(x["formation"] or None) and x["formation"][:16],
                              starters=json.dumps(x["xi"], ensure_ascii=False)))
        n += 1
    db.commit()
    return n


def backfill(db, max_matches: int | None = None) -> int:
    """Every finished league match since 2016/17 without line-ups yet; newest years first."""
    from sqlalchemy import text
    have = {e for (e,) in db.execute(text("SELECT DISTINCT event FROM football_lineups"))}
    todo = []
    for year in range(date.today().year, FIRST_YEAR - 1, -1):
        for code in SLUGS:
            try:
                todo += [(code, ev) for ev in _year_events(code, year) if ev["id"] not in have]
            except Exception as e:
                print(f"[lineups] {code} {year}: {e}", flush=True)
            time.sleep(0.3)
    status["pending"] = len(todo)
    n = 0
    for code, ev in todo[:max_matches] if max_matches else todo:
        try:
            if _store(db, code, ev):
                n += 1
        except Exception as e:
            db.rollback()
            print(f"[lineups] {ev['id']}: {type(e).__name__} {e}", flush=True)
        status["pending"] -= 1
        status["stored"] += 1
        status["last"] = ev["day"].isoformat()
        if status["stored"] % 500 == 0:
            print(f"[lineups] {status['stored']} matches read, {status['pending']} to go (at {status['last']})", flush=True)
        time.sleep(PAUSE)
    return n


def loop() -> None:
    """The backfill, then every six hours the newly played matches."""
    from database import get_session_factory
    time.sleep(120)
    while True:
        if _lock.acquire(blocking=False):
            status["running"] = True
            try:
                db = get_session_factory()()
                try:
                    n = backfill(db)
                    if n:
                        print(f"[lineups] stored line-ups for {n} match(es); unmatched names: {status['unmatched'] or 'none'}", flush=True)
                finally:
                    db.close()
            except Exception as e:
                print(f"[lineups] {e}", flush=True)
            finally:
                status["running"] = False
                _lock.release()
        time.sleep(6 * 3600)


# ── Rotation ─────────────────────────────────────────────────────────────────

def regulars(xis: list[list[dict]], k: int = 3) -> dict[str, int]:
    """{player id: starts} for those who started at least `k` of these XIs."""
    count: dict[str, int] = {}
    for xi in xis:
        for p in xi:
            count[p["id"]] = count.get(p["id"], 0) + 1
    return {pid: c for pid, c in count.items() if c >= k}


def rotation_table(db) -> dict[tuple[str, str, date], int]:
    """{(comp, team, day): regulars missing} for every stored side with five
    earlier league XIs - the model's rotation feature, built in one pass."""
    from sqlalchemy import text
    hist: dict[tuple[str, str], list[list[dict]]] = {}
    out = {}
    for comp, team, day, starters in db.execute(text(
            "SELECT comp, team, day, starters FROM football_lineups WHERE team IS NOT NULL ORDER BY day")):
        key = (comp, team)
        xi = json.loads(starters)
        past = hist.setdefault(key, [])
        if len(past) >= 5:
            reg = regulars(past[-5:])
            now = {p["id"] for p in xi}
            out[(comp, team, day)] = sum(1 for pid in reg if pid not in now)
        past.append(xi)
    return out

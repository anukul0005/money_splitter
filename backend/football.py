"""Football - the top five leagues, the Champions League and national teams.

Two feeds, used together:
  * football-data.org (an API key, FOOTBALL_DATA_KEY; free tier, 10 requests
    a minute): fixtures, live scores, results and tables - one request covers
    every competition for a week, so the pages cost a request a minute at
    most. Also the Champions League results the model learns from (the free
    tier reaches back to 2023/24).
  * football-data.co.uk (CSV files, no key): every top-five league result
    with the bookmakers' closing odds, from 2012/13 - what the model learns
    from and is tested against - and the coming week's fixtures with prices.
National teams' results come from the public international results set
(github.com/martj42/international_results, CC0).

Club names differ between the two feeds ("Wolverhampton" / "Wolves"), so a
football-data.org team is matched onto the football-data.co.uk name already
on file (club_name) - the model knows teams by those.
"""
from __future__ import annotations

import csv
import difflib
import io
import json
import os
import re
import threading
import time
import unicodedata
import urllib.request
from datetime import date, datetime, timedelta, timezone

API = "https://api.football-data.org/v4"
CO_UK = "https://football-data.co.uk"
INTL_CSV = "https://raw.githubusercontent.com/martj42/international_results/master/results.csv"
UA = "Mozilla/5.0 (settle football)"

# football-data.org code -> (football-data.co.uk code, name)
LEAGUES = {"PL": ("E0", "Premier League"), "PD": ("SP1", "La Liga"), "SA": ("I1", "Serie A"),
           "BL1": ("D1", "Bundesliga"), "FL1": ("F1", "Ligue 1")}
CUPS = {"CL": "Champions League", "WC": "World Cup", "EC": "European Championship"}
COMPS = {**{k: v[1] for k, v in LEAGUES.items()}, **CUPS}
CO_UK_OF = {v[0]: k for k, v in LEAGUES.items()}
FIRST_SEASON = 2012                 # 2012/13 on: the model warms up, then is tested from 2023/24
INTL_FROM = date(2000, 1, 1)
HISTORY_EVERY = 6 * 3600


def _key() -> str | None:
    return os.environ.get("FOOTBALL_DATA_KEY")


def _get(url: str, headers: dict | None = None, raw: bool = False):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=40) as r:
        body = r.read()
    return body if raw else json.loads(body.decode("utf-8"))


_api_lock = threading.Lock()
_api_last = [0.0]


def _api(path: str):
    """football-data.org, kept under its 10 a minute: one call at a time, 6.5s apart."""
    k = _key()
    if not k:
        raise RuntimeError("FOOTBALL_DATA_KEY isn't set")
    with _api_lock:
        wait = 6.5 - (time.time() - _api_last[0])
        if wait > 0:
            time.sleep(wait)
        try:
            return _get(f"{API}{path}", {"X-Auth-Token": k})
        finally:
            _api_last[0] = time.time()


_held: dict[str, tuple[float, object]] = {}


def _hold(key: str, ttl: float, fn):
    hit = _held.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    try:
        value = fn()
    except Exception:
        if hit:                       # the feed failed: the last answer is better than none
            return hit[1]
        raise
    _held[key] = (time.time(), value)
    return value


# ── Team names ──────────────────────────────────────────────────────────────

_DROP = {"fc", "afc", "cf", "sc", "ssc", "ac", "as", "ud", "cd", "rc", "sv", "vfb", "vfl", "tsg", "bv", "ogc", "losc",
         "rcd", "ca", "sd", "1", "04", "05", "1899", "1907", "1909", "1913", "de", "calcio", "club"}
# football-data.org's short name (squashed) -> football-data.co.uk's
_ALIAS = {"wolverhampton": "Wolves", "nottingham": "Nott'm Forest", "brightonhove": "Brighton", "manunited": "Man United",
          "mancity": "Man City", "atleti": "Ath Madrid", "athletic": "Ath Bilbao", "barca": "Barcelona",
          "espanyol": "Espanol", "rayovallecano": "Vallecano", "realsociedad": "Sociedad", "realbetis": "Betis",
          "realvalladolid": "Valladolid", "realoviedo": "Oviedo", "bayern": "Bayern Munich", "frankfurt": "Ein Frankfurt",
          "bremen": "Werder Bremen", "koln": "FC Koln", "hsv": "Hamburg", "stpauli": "St Pauli", "psg": "Paris SG",
          "olympiquelyon": "Lyon", "staderennais": "Rennes", "lens": "Lens", "stadedereims": "Reims",
          "stadebrestois": "Brest", "angerssco": "Angers", "saintetienne": "St Etienne", "inter": "Inter",
          "milan": "Milan", "hellasverona": "Verona", "mgladbach": "M'gladbach", "leverkusen": "Leverkusen",
          "mainz": "Mainz", "leipzig": "RB Leipzig", "rbleipzig": "RB Leipzig", "deportivoalaves": "Alaves",
          "alaves": "Alaves", "celta": "Celta", "leganes": "Leganes", "sheffieldutd": "Sheffield United",
          "lutontown": "Luton", "ipswichtown": "Ipswich", "leicestercity": "Leicester", "leedsunited": "Leeds",
          "newcastle": "Newcastle", "tottenham": "Tottenham", "westham": "West Ham"}
# football-data.org's national team names -> the international results set's
_NATIONS = {"korea republic": "South Korea", "ir iran": "Iran", "usa": "United States", "côte d'ivoire": "Ivory Coast",
            "cote d'ivoire": "Ivory Coast", "czechia": "Czech Republic", "türkiye": "Turkey", "turkiye": "Turkey",
            "china pr": "China PR", "cabo verde": "Cape Verde", "congo dr": "DR Congo", "north macedonia": "North Macedonia",
            "bosnia-herzegovina": "Bosnia and Herzegovina", "republic of ireland": "Republic of Ireland"}


def squash(name: str | None) -> str:
    s = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"['’.]", "", s)
    return "".join(w for w in re.split(r"[^a-z0-9]+", s) if w and w not in _DROP)


_teams_lock = threading.Lock()
_teams: dict[str, list[str]] = {}       # co.uk league code -> club names in its last 3 seasons


def known_teams(db, league: str) -> list[str]:
    with _teams_lock:
        if league not in _teams:
            from sqlalchemy import text
            since = date.today() - timedelta(days=3 * 366)
            _teams[league] = sorted({n for (n,) in db.execute(text(
                "SELECT home FROM football_matches WHERE comp = :c AND day >= :d UNION SELECT away FROM football_matches "
                "WHERE comp = :c AND day >= :d"), {"c": league, "d": since})})
        return _teams[league]


def club_name(db, team: dict, leagues: list[str]) -> str | None:
    """A football-data.org team as football-data.co.uk names it, from the
    clubs on file in `leagues`; None for a club outside them (Benfica in the
    Champions League)."""
    pool = [n for lg in leagues for n in known_teams(db, lg)]
    if not pool:
        return None
    by_key = {squash(n): n for n in pool}
    for raw in (team.get("shortName"), team.get("name")):
        k = squash(raw)
        if not k:
            continue
        if k in _ALIAS and _ALIAS[k] in pool:
            return _ALIAS[k]
        if k in by_key:
            return by_key[k]
        for kk, n in by_key.items():
            if len(kk) >= 4 and (kk in k or k in kk):
                return n
    best = difflib.get_close_matches(squash(team.get("shortName") or team.get("name")), list(by_key), n=1, cutoff=0.8)
    return by_key[best[0]] if best else None


def nation_name(name: str | None) -> str | None:
    return _NATIONS.get((name or "").strip().lower(), name)


# ── History (stored) ────────────────────────────────────────────────────────

def _fnum(x):
    try:
        v = float(x)
        return v if v > 1.0 else None
    except (TypeError, ValueError):
        return None


def _pdate(s: str):
    for f in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(s, f).date()
        except (TypeError, ValueError):
            pass
    return None


def _season_code(y: int) -> str:
    return f"{y % 100:02d}{(y + 1) % 100:02d}"


def current_season_start(today: date | None = None) -> int:
    t = today or date.today()
    return t.year if t.month >= 7 else t.year - 1


def _upsert(db, rows: list[dict]) -> int:
    from sqlalchemy.dialects.postgresql import insert
    from models import FootballMatch
    if not rows:
        return 0
    n = 0
    for i in range(0, len(rows), 500):
        chunk = rows[i:i + 500]
        st = insert(FootballMatch).values(chunk)
        cols = {c: st.excluded[c] for c in chunk[0] if c not in ("comp", "day", "home", "away")}
        db.execute(st.on_conflict_do_update(constraint="ux_football_matches_game", set_=cols))
        n += len(chunk)
    db.commit()
    return n


def _league_rows(code: str, season: str, body: bytes) -> list[dict]:
    rows = {}
    txt = body.decode("latin-1").lstrip("﻿").lstrip("ï»¿")
    for r in csv.DictReader(io.StringIO(txt)):
        d = _pdate(r.get("Date") or "")
        if not d or not (r.get("HomeTeam") or "").strip() or r.get("FTHG") in (None, ""):
            continue

        def odds(*names):
            for n in names:
                trio = [_fnum(r.get(n + x)) for x in "HDA"]
                if all(trio):
                    return trio
            return [None, None, None]
        pin, avg = odds("PSC", "PS"), odds("AvgC", "Avg", "BbAv")
        row = {"comp": code, "season": season, "tournament": None, "day": d, "home": r["HomeTeam"].strip()[:80],
               "away": r["AwayTeam"].strip()[:80], "home_goals": int(float(r["FTHG"])), "away_goals": int(float(r["FTAG"])),
               "neutral": False, "pin_h": pin[0], "pin_d": pin[1], "pin_a": pin[2], "avg_h": avg[0], "avg_d": avg[1], "avg_a": avg[2]}
        rows[(d, row["home"], row["away"])] = row
    return list(rows.values())


def sync_leagues(db, full: bool = False) -> int:
    """Each league season's CSV: past seasons once, the current one every time."""
    from sqlalchemy import text
    cur = current_season_start()
    have = {(c, s) for c, s in db.execute(text("SELECT DISTINCT comp, season FROM football_matches WHERE season IS NOT NULL"))}
    n = 0
    for y in range(FIRST_SEASON, cur + 1):
        s = _season_code(y)
        for code in CO_UK_OF:
            if not full and y < cur and (code, s) in have:
                continue
            try:
                body = _get(f"{CO_UK}/mmz4281/{s}/{code}.csv", raw=True)
            except Exception as e:
                print(f"[football] {code} {s}: {e}", flush=True)
                continue
            n += _upsert(db, _league_rows(code, s, body))
            time.sleep(1.5)
    with _teams_lock:
        _teams.clear()
    return n


def sync_internationals(db) -> int:
    body = _get(INTL_CSV, raw=True).decode("utf-8")
    rows = {}
    for r in csv.DictReader(io.StringIO(body)):
        if r.get("home_score") in (None, "", "NA"):
            continue
        try:
            d = date.fromisoformat(r["date"])
        except ValueError:
            continue
        if d < INTL_FROM:
            continue
        row = {"comp": "INTL", "season": None, "tournament": (r.get("tournament") or "")[:80], "day": d,
               "home": r["home_team"][:80], "away": r["away_team"][:80], "home_goals": int(r["home_score"]),
               "away_goals": int(r["away_score"]), "neutral": r.get("neutral") == "TRUE",
               "pin_h": None, "pin_d": None, "pin_a": None, "avg_h": None, "avg_d": None, "avg_a": None}
        rows[(d, row["home"], row["away"])] = row
    return _upsert(db, list(rows.values()))


def sync_champions_league(db, seasons: list[int] | None = None) -> int:
    """The Champions League's played matches, club names matched onto the
    co.uk ones (a club from outside the five leagues keeps its own name)."""
    from sqlalchemy import text
    cur = current_season_start()
    have = {s for (s,) in db.execute(text("SELECT DISTINCT season FROM football_matches WHERE comp = 'CL'"))}
    n = 0
    for y in seasons or range(2023, cur + 1):
        s = _season_code(y)
        if y < cur and s in have:
            continue
        try:
            d = _api(f"/competitions/CL/matches?season={y}")
        except Exception as e:
            print(f"[football] CL {y}: {e}", flush=True)
            continue
        rows = {}
        for m in d.get("matches") or []:
            ft = (m.get("score") or {}).get("fullTime") or {}
            reg = (m.get("score") or {}).get("regularTime") or ft
            if m.get("status") != "FINISHED" or reg.get("home") is None:
                continue
            day = date.fromisoformat(m["utcDate"][:10])
            h = club_name(db, m["homeTeam"], list(CO_UK_OF)) or (m["homeTeam"].get("shortName") or m["homeTeam"]["name"])
            a = club_name(db, m["awayTeam"], list(CO_UK_OF)) or (m["awayTeam"].get("shortName") or m["awayTeam"]["name"])
            final = (m.get("stage") or "") == "FINAL"
            rows[(day, h, a)] = {"comp": "CL", "season": s, "tournament": m.get("stage"), "day": day, "home": h[:80], "away": a[:80],
                                 "home_goals": int(reg["home"]), "away_goals": int(reg["away"]), "neutral": final,
                                 "pin_h": None, "pin_d": None, "pin_a": None, "avg_h": None, "avg_d": None, "avg_a": None}
        n += _upsert(db, list(rows.values()))
    return n


_sync = {"running": False, "last": None, "rows": 0}


def sync_history(db) -> dict:
    _sync["running"] = True
    try:
        n = sync_leagues(db) + sync_internationals(db) + sync_champions_league(db)
        _sync.update(last=datetime.now(timezone.utc).isoformat(), rows=n)
        return dict(_sync)
    finally:
        _sync["running"] = False


def history_loop() -> None:
    from database import get_session_factory
    time.sleep(25)
    while True:
        try:
            db = get_session_factory()()
            try:
                t = time.time()
                r = sync_history(db)
                print(f"[football] history synced in {time.time() - t:.0f}s ({r['rows']} rows)", flush=True)
            finally:
                db.close()
        except Exception as e:
            print(f"[football] history: {e}", flush=True)
        time.sleep(HISTORY_EVERY)


# ── The coming week's bookmaker prices (football-data.co.uk) ────────────────

def book_prices() -> dict:
    """{(co.uk league, home, away): {"avg": [h, d, a], "max": [...], "b365": [...], "day": iso}}."""
    def read():
        txt = _get(f"{CO_UK}/fixtures.csv", raw=True).decode("latin-1").lstrip("﻿").lstrip("ï»¿")
        out = {}
        for r in csv.DictReader(io.StringIO(txt)):
            code = (r.get("Div") or "").strip()
            if code not in CO_UK_OF:
                continue
            trio = lambda p: [_fnum(r.get(p + x)) for x in "HDA"]
            d = _pdate(r.get("Date") or "")
            out[(code, r["HomeTeam"].strip(), r["AwayTeam"].strip())] = {
                "avg": trio("Avg"), "max": trio("Max"), "b365": trio("B365"), "day": d.isoformat() if d else None}
        return out
    return _hold("book", 3 * 3600, read)


# ── Live: fixtures, scores, tables (football-data.org) ──────────────────────

def _match(m: dict) -> dict:
    sc = m.get("score") or {}
    ft, ht = sc.get("fullTime") or {}, sc.get("halfTime") or {}
    status = m.get("status")
    state = {"IN_PLAY": "live", "PAUSED": "live", "FINISHED": "finished", "AWARDED": "finished"}.get(status, "upcoming")
    if status in ("POSTPONED", "SUSPENDED", "CANCELLED"):
        state = "off"
    comp = (m.get("competition") or {}).get("code")
    team = lambda t: {"id": t.get("id"), "name": t.get("shortName") or t.get("name"), "full": t.get("name"),
                      "crest": t.get("crest"), "tla": t.get("tla")}
    return {"id": m["id"], "comp": comp, "comp_name": COMPS.get(comp, (m.get("competition") or {}).get("name")),
            "start": m.get("utcDate"), "status": status, "state": state, "matchday": m.get("matchday"),
            "stage": m.get("stage"), "group": m.get("group"),
            "home": {**team(m.get("homeTeam") or {}), "goals": ft.get("home")},
            "away": {**team(m.get("awayTeam") or {}), "goals": ft.get("away")},
            "half": [ht.get("home"), ht.get("away")], "winner": sc.get("winner"), "raw_home": m.get("homeTeam") or {},
            "raw_away": m.get("awayTeam") or {}}


def window(days_back: int = 2, days_ahead: int = 7) -> list[dict]:
    """Every match in our competitions from `days_back` ago to `days_ahead` on -
    one request; a minute when something's live, else five."""
    t = date.today()
    a, b = t - timedelta(days=days_back), t + timedelta(days=days_ahead)

    def read():
        d = _api(f"/matches?dateFrom={a.isoformat()}&dateTo={b.isoformat()}&competitions={','.join(COMPS)}")
        return [_match(m) for m in d.get("matches") or []]
    hit = _held.get(f"w{days_back}:{days_ahead}")
    live_now = hit and any(m["state"] == "live" for m in hit[1])
    return _hold(f"w{days_back}:{days_ahead}", 60 if live_now else 300, read)


def standings(comp: str) -> dict:
    def read():
        d = _api(f"/competitions/{comp}/standings")
        tables = []
        for s in d.get("standings") or []:
            if s.get("type") != "TOTAL":
                continue
            tables.append({"group": s.get("group"), "rows": [
                {"pos": r["position"], "team": (r.get("team") or {}).get("shortName") or (r.get("team") or {}).get("name"),
                 "crest": (r.get("team") or {}).get("crest"), "played": r["playedGames"], "won": r["won"], "draw": r["draw"],
                 "lost": r["lost"], "gf": r["goalsFor"], "ga": r["goalsAgainst"], "gd": r["goalDifference"], "pts": r["points"],
                 "form": r.get("form")} for r in s.get("table") or []]})
        return {"comp": comp, "name": COMPS.get(comp), "season": (d.get("season") or {}).get("startDate"), "tables": tables}
    return _hold(f"s{comp}", 3600, read)

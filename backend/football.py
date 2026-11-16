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
(github.com/martj42/international_results, CC0) - and, as it's kept up by
hand and runs behind, from ESPN's public scoreboard (no key) for every day
since its last result, and API-Football for yesterday to tomorrow
(national_fixtures).

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
          "newcastle": "Newcastle", "tottenham": "Tottenham", "westham": "West Ham",
          # ESPN's spellings
          "cologne": "FC Koln", "atleticomadrid": "Ath Madrid", "deportivo": "La Coruna", "deportivolacoruna": "La Coruna"}
# football-data.org's national team names -> the international results set's
_NATIONS = {"korea republic": "South Korea", "ir iran": "Iran", "usa": "United States", "côte d'ivoire": "Ivory Coast",
            "cote d'ivoire": "Ivory Coast", "czechia": "Czech Republic", "türkiye": "Turkey", "turkiye": "Turkey",
            "china pr": "China", "cabo verde": "Cape Verde", "congo dr": "DR Congo", "north macedonia": "North Macedonia",
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
    # ESPN's same-day rows the weekly file now has (a day either side, as the two date a late kick-off differently)
    from sqlalchemy import text
    db.execute(text("""
        DELETE FROM football_matches a USING football_matches b
        WHERE a.tournament = 'espn' AND a.comp = ANY(:c) AND b.comp = a.comp AND b.tournament IS NULL
          AND abs(a.day - b.day) <= 1 AND a.home = b.home AND a.away = b.away AND a.id <> b.id"""), {"c": list(CO_UK_OF)})
    db.commit()
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
    n = _upsert(db, list(rows.values()))
    from sqlalchemy import text
    db.execute(text("""
        DELETE FROM football_matches a USING football_matches b
        WHERE a.comp = 'INTL' AND a.season IN ('api', 'espn') AND b.comp = 'INTL' AND b.season IS NULL
          AND abs(a.day - b.day) <= 1
          AND ((a.home = b.home AND a.away = b.away) OR (a.home = b.away AND a.away = b.home))"""))
    db.commit()
    _nations_known.clear()
    return n


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


# ── National teams, day by day (API-Football) ───────────────────────────────
# The public results set is kept up by hand and can be weeks behind. API-
# Football (key APIFOOTBALL_KEY, free plan: 100 requests a day, and only
# yesterday / today / tomorrow by date) fills the gap from here on: each
# national-team result is stored the day it's played (season "api"), and
# tomorrow's fixtures are shown. When the public set catches up, its row for
# the same match replaces ours (sync_internationals).

APIF = "https://v3.football.api-sports.io"
_YOUTH = re.compile(r"\b(U-?\d\d|Under|Youth|Women|Olympic|Elite League)\b", re.I)
# API-Football's national team names -> the public results set's
_APIF_NATIONS = {"USA": "United States", "Korea Republic": "South Korea", "South Korea": "South Korea",
                 "Rep. Of Ireland": "Republic of Ireland", "FYR Macedonia": "North Macedonia",
                 "St. Vincent / Grenadines": "Saint Vincent and the Grenadines", "Cape Verde Islands": "Cape Verde", "Congo DR": "DR Congo",
                 "Bosnia & Herzegovina": "Bosnia and Herzegovina", "Chinese Taipei": "Taiwan", "Curacao": "Curaçao",
                 "Kyrgyz Republic": "Kyrgyzstan", "Türkiye": "Turkey", "Czechia": "Czech Republic", "Ivory Coast": "Ivory Coast",
                 "Cote D'Ivoire": "Ivory Coast", "Korea DPR": "North Korea", "Macedonia": "North Macedonia",
                 "Swaziland": "Eswatini", "Gambia": "Gambia", "Congo": "Congo", "Brunei": "Brunei"}
_apif_lock = threading.Lock()
_apif_last = [0.0]
_nations_known: set[str] = set()


def _apif(path: str):
    k = os.environ.get("APIFOOTBALL_KEY")
    if not k:
        raise RuntimeError("APIFOOTBALL_KEY isn't set")
    with _apif_lock:
        wait = 6.5 - (time.time() - _apif_last[0])
        if wait > 0:
            time.sleep(wait)
        try:
            d = _get(f"{APIF}{path}", {"x-apisports-key": k})
        finally:
            _apif_last[0] = time.time()
    if d.get("errors"):
        raise RuntimeError(str(d["errors"])[:200])
    return d.get("response") or []


def _nations(db) -> set[str]:
    if not _nations_known:
        from sqlalchemy import text
        _nations_known.update(n for (n,) in db.execute(text(
            "SELECT home FROM football_matches WHERE comp = 'INTL' UNION SELECT away FROM football_matches WHERE comp = 'INTL'")))
    return _nations_known


def _nation(db, name: str) -> str | None:
    """API-Football's name for a senior national team as the results set
    spells it ("St. Lucia" -> "Saint Lucia"); None for a youth / women's side
    or a name it doesn't know."""
    if re.search(r"(U-?\d\d|W)$", name or ""):
        return None
    known = _nations(db)
    n = _APIF_NATIONS.get(name, name)
    if n in known:
        return n
    n = re.sub(r"^St\.? ", "Saint ", n).replace(" & ", " and ")
    if n in known:
        return n
    close = difflib.get_close_matches(n, list(known), n=1, cutoff=0.88)
    return close[0] if close else None


def apif_day(d: date) -> list[dict]:
    """Every fixture API-Football has on day `d` - today's every half hour,
    tomorrow's every three, yesterday's every six."""
    t = date.today()
    ttl = 1800 if d == t else 3 * 3600 if d > t else 6 * 3600
    return _hold(f"af{d.isoformat()}", ttl, lambda: _apif(f"/fixtures?date={d.isoformat()}"))


def national_fixtures(db) -> list[dict]:
    """Senior men's national-team matches from yesterday to tomorrow, in the
    shape the Matches tab uses (comp "NT"), names as the results set has them."""
    out = []
    t = date.today()
    for d in (t - timedelta(days=1), t, t + timedelta(days=1)):
        try:
            fx = apif_day(d)
        except Exception as e:
            print(f"[football] API-Football {d}: {e}", flush=True)
            continue
        for f in fx:
            lg = f.get("league") or {}
            if _YOUTH.search(lg.get("name") or "") or (lg.get("name") or "").startswith("Friendlies Clubs"):
                continue
            th, ta = (f.get("teams") or {}).get("home") or {}, (f.get("teams") or {}).get("away") or {}
            h, a = _nation(db, th.get("name") or ""), _nation(db, ta.get("name") or "")
            if not (h and a):
                continue
            st = ((f.get("fixture") or {}).get("status") or {}).get("short") or ""
            state = "finished" if st in ("FT", "AET", "PEN", "AWD", "WO") else "live" if st in ("1H", "HT", "2H", "ET", "BT", "P", "LIVE", "INT") \
                else "off" if st in ("PST", "CANC", "ABD", "SUSP") else "upcoming"
            g = f.get("goals") or {}
            ft = ((f.get("score") or {}).get("fulltime") or {})
            hg = ft.get("home") if ft.get("home") is not None else g.get("home")
            ag = ft.get("away") if ft.get("away") is not None else g.get("away")
            winner = None
            if state == "finished" and hg is not None:
                winner = "HOME_TEAM" if hg > ag else "AWAY_TEAM" if ag > hg else "DRAW"
            out.append({"id": f"af{f['fixture']['id']}", "comp": "NT", "comp_name": lg.get("name"), "start": f["fixture"]["date"],
                        "status": st, "state": state, "matchday": None, "stage": (lg.get("round") or None), "group": None,
                        "home": {"id": th.get("id"), "name": h, "full": th.get("name"), "crest": th.get("logo"), "tla": None, "goals": hg},
                        "away": {"id": ta.get("id"), "name": a, "full": ta.get("name"), "crest": ta.get("logo"), "tla": None, "goals": ag},
                        "half": [None, None], "winner": winner, "nation": True,
                        "raw_home": {"name": h}, "raw_away": {"name": a}})
    return out


def sync_national_recent(db) -> int:
    """Store the national-team results API-Football has (yesterday, today)."""
    rows = {}
    for m in national_fixtures(db):
        if m["state"] != "finished" or m["home"]["goals"] is None:
            continue
        day = date.fromisoformat(m["start"][:10])
        rows[(day, m["home"]["name"], m["away"]["name"])] = {
            "comp": "INTL", "season": "api", "tournament": (m["comp_name"] or "")[:80], "day": day,
            "home": m["home"]["name"][:80], "away": m["away"]["name"][:80], "home_goals": int(m["home"]["goals"]),
            "away_goals": int(m["away"]["goals"]), "neutral": False,
            "pin_h": None, "pin_d": None, "pin_a": None, "avg_h": None, "avg_d": None, "avg_a": None}
    return _upsert(db, list(rows.values()))


def recent_loop() -> None:
    """National-team, same-day league and ISL results into the store, every two hours."""
    from database import get_session_factory
    time.sleep(90)
    while True:
        try:
            db = get_session_factory()()
            try:
                n = sync_national_espn(db)
                try:
                    n += sync_national_recent(db)
                except Exception as e:
                    print(f"[football] API-Football: {e}", flush=True)
                if n:
                    print(f"[football] {n} national-team result(s) from ESPN / API-Football", flush=True)
                for what, fn in (("league", sync_leagues_espn), ("ISL", sync_isl)):
                    try:
                        k = fn(db)
                        if k:
                            print(f"[football] {k} {what} result(s) from ESPN", flush=True)
                    except Exception as e:
                        print(f"[football] ESPN {what}: {e}", flush=True)
            finally:
                db.close()
        except Exception as e:
            print(f"[football] national results: {e}", flush=True)
        time.sleep(2 * 3600)


# ── National teams from ESPN (no key) ───────────────────────────────────────
# ESPN's public scoreboard (the one tennis already reads) has every day's
# matches, any date, one request a day for all competitions. It fills the
# days between the end of the public results set and yesterday (season
# "espn"); the public set's own rows replace these when it catches up.

ESPN_SOCCER = "https://site.api.espn.com/apis/site/v2/sports/soccer"
_espn_leagues: dict[str, str] = {}        # ESPN league id -> its name
_espn_done: set[date] = set()             # days read whole (not re-read unless recent)


def _espn_league(event_id: str, league_id: str) -> str:
    if league_id not in _espn_leagues:
        d = _get(f"{ESPN_SOCCER}/all/summary?event={event_id}")
        _espn_leagues[league_id] = (((d.get("header") or {}).get("league") or {}).get("name") or "")
        time.sleep(0.5)
    return _espn_leagues[league_id]


def espn_national_day(db, d: date) -> list[dict]:
    """Senior men's national-team results on day `d` (UTC), as rows to store."""
    data = _espn_all(d)
    rows = []
    for e in data.get("events") or []:
        comp = (e.get("competitions") or [{}])[0]
        cs = comp.get("competitors") or []
        home = next((c for c in cs if c.get("homeAway") == "home"), None)
        away = next((c for c in cs if c.get("homeAway") == "away"), None)
        if not home or not away or not (((e.get("status") or {}).get("type") or {}).get("completed")):
            continue
        h, a = _nation(db, (home.get("team") or {}).get("displayName") or ""), _nation(db, (away.get("team") or {}).get("displayName") or "")
        if not (h and a):
            continue
        lid = (e.get("uid") or "").split("~l:")[-1].split("~")[0]
        league = _espn_league(e["id"], lid)
        if not league or _YOUTH.search(league) or "women" in league.lower():
            continue
        try:
            hg, ag = int(home.get("score")), int(away.get("score"))
        except (TypeError, ValueError):
            continue
        rows.append({"comp": "INTL", "season": "espn", "tournament": league[:80], "day": date.fromisoformat(e["date"][:10]),
                     "home": h[:80], "away": a[:80], "home_goals": hg, "away_goals": ag, "neutral": bool(comp.get("neutralSite")),
                     "pin_h": None, "pin_d": None, "pin_a": None, "avg_h": None, "avg_d": None, "avg_a": None})
    return rows


def sync_national_espn(db, max_days: int = 45) -> int:
    """Every day from the public set's last result to today, from ESPN."""
    from sqlalchemy import text
    last = db.execute(text("SELECT max(day) FROM football_matches WHERE comp = 'INTL' AND season IS NULL")).scalar()
    today = date.today()
    start = max((last or today) + timedelta(days=1), today - timedelta(days=max_days))
    n, d = 0, start
    while d <= today:
        if d not in _espn_done or d >= today - timedelta(days=2):
            try:
                rows = {(r["day"], r["home"], r["away"]): r for r in espn_national_day(db, d)}
                n += _upsert(db, list(rows.values()))
                if d < today - timedelta(days=2):
                    _espn_done.add(d)
            except Exception as e:
                print(f"[football] ESPN {d}: {e}", flush=True)
            time.sleep(1.0)
        d += timedelta(days=1)
    return n


# ── Leagues from ESPN: results within hours, and the ISL ────────────────────
# football-data.co.uk's files (with the closing odds) come once a week, so
# ESPN's scoreboard puts each top-five league result in the store the day
# it's played (tournament "espn", no odds - kept out of the P/L until the
# weekly file brings its prices and replaces the row). The Indian Super
# League comes from ESPN alone - history by year, fixtures and its table.

ESPN_LEAGUE_CODES = {"700": "E0", "740": "SP1", "730": "I1", "720": "D1", "710": "F1", "8316": "ISL"}
ISL_SLUG, ISL_FROM = "ind.1", 2018


def _espn_all(d: date) -> dict:
    """ESPN's whole scoreboard for day `d` (every competition), held a while."""
    ttl = 600 if d >= date.today() - timedelta(days=1) else 12 * 3600
    return _hold(f"espn{d.isoformat()}", ttl,
                 lambda: _get(f"{ESPN_SOCCER}/all/scoreboard?dates={d.strftime('%Y%m%d')}&limit=1000"))


def _sides(e: dict):
    comp = (e.get("competitions") or [{}])[0]
    cs = comp.get("competitors") or []
    return (next((c for c in cs if c.get("homeAway") == "home"), None),
            next((c for c in cs if c.get("homeAway") == "away"), None), comp)


def _club_season(day: date) -> str:
    return _season_code(day.year if day.month >= 7 else day.year - 1)


def _espn_club_row(db, e: dict, code: str) -> dict | None:
    home, away, comp = _sides(e)
    if not home or not away or not (((e.get("status") or {}).get("type") or {}).get("completed")):
        return None
    th, ta = home.get("team") or {}, away.get("team") or {}
    if code == "ISL":
        h, a = th.get("displayName"), ta.get("displayName")
    else:
        h = club_name(db, {"shortName": th.get("shortDisplayName"), "name": th.get("displayName")}, [code])
        a = club_name(db, {"shortName": ta.get("shortDisplayName"), "name": ta.get("displayName")}, [code])
    try:
        hg, ag = int(home.get("score")), int(away.get("score"))
    except (TypeError, ValueError):
        return None
    if not (h and a):
        return None
    day = date.fromisoformat(e["date"][:10])
    return {"comp": code, "season": _club_season(day), "tournament": "espn", "day": day, "home": h[:80], "away": a[:80],
            "home_goals": hg, "away_goals": ag, "neutral": bool(comp.get("neutralSite")),
            "pin_h": None, "pin_d": None, "pin_a": None, "avg_h": None, "avg_d": None, "avg_a": None}


def _insert_new(db, rows: list[dict]) -> int:
    """Rows not on file yet - never over a row that has its odds."""
    from sqlalchemy.dialects.postgresql import insert
    from models import FootballMatch
    if not rows:
        return 0
    db.execute(insert(FootballMatch).values(rows).on_conflict_do_nothing(constraint="ux_football_matches_game"))
    db.commit()
    return len(rows)


def sync_leagues_espn(db, max_days: int = 21) -> int:
    """Each top-five league's results since its weekly file's last, from ESPN."""
    from sqlalchemy import text
    today = date.today()
    last = dict(db.execute(text("SELECT comp, max(day) FROM football_matches WHERE comp = ANY(:c) AND tournament IS NULL GROUP BY comp"),
                           {"c": list(CO_UK_OF)}).all())
    start = max(min(last.values(), default=today) + timedelta(days=1), today - timedelta(days=max_days))
    rows, d = {}, start
    while d <= today:
        try:
            for e in _espn_all(d).get("events") or []:
                lid = (e.get("uid") or "").split("~l:")[-1].split("~")[0]
                code = ESPN_LEAGUE_CODES.get(lid)
                if code and code != "ISL" and (last.get(code) is None or e["date"][:10] > last[code].isoformat()):
                    r = _espn_club_row(db, e, code)
                    if r:
                        rows[(r["comp"], r["day"], r["home"], r["away"])] = r
        except Exception as ex:
            print(f"[football] ESPN leagues {d}: {ex}", flush=True)
        d += timedelta(days=1)
    return _insert_new(db, list(rows.values()))


def sync_isl(db) -> int:
    """The ISL's results: every year since 2018 once, this year and last each time."""
    from sqlalchemy import text
    have = {int(y) for (y,) in db.execute(text("SELECT DISTINCT extract(year FROM day) FROM football_matches WHERE comp = 'ISL'"))}
    n = 0
    for y in range(ISL_FROM, date.today().year + 1):
        if y in have and y < date.today().year - 1:
            continue
        try:
            data = _get(f"{ESPN_SOCCER}/{ISL_SLUG}/scoreboard?dates={y}&limit=1000")
        except Exception as ex:
            print(f"[football] ISL {y}: {ex}", flush=True)
            continue
        rows = {}
        for e in data.get("events") or []:
            r = _espn_club_row(db, e, "ISL")
            if r:
                rows[(r["day"], r["home"], r["away"])] = r
        if rows:
            from sqlalchemy.dialects.postgresql import insert
            from models import FootballMatch
            st = insert(FootballMatch).values(list(rows.values()))
            db.execute(st.on_conflict_do_update(constraint="ux_football_matches_game",
                                                set_={"home_goals": st.excluded.home_goals, "away_goals": st.excluded.away_goals}))
            db.commit()
            n += len(rows)
        time.sleep(1.0)
    return n


def isl_window(days_back: int = 2, days_ahead: int = 7) -> list[dict]:
    """ISL fixtures, scores and results in the Matches tab's shape (comp "ISL")."""
    def read():
        out = []
        t = date.today()
        cal = ((_get(f"{ESPN_SOCCER}/{ISL_SLUG}/scoreboard").get("leagues") or [{}])[0].get("calendar") or [])
        days = sorted({c[:10] for c in cal if isinstance(c, str)})
        for ds in days:
            d = date.fromisoformat(ds)
            if not (t - timedelta(days=days_back) <= d <= t + timedelta(days=days_ahead)):
                continue
            for e in _get(f"{ESPN_SOCCER}/{ISL_SLUG}/scoreboard?dates={d.strftime('%Y%m%d')}").get("events") or []:
                home, away, _ = _sides(e)
                if not home or not away:
                    continue
                st = (e.get("status") or {}).get("type") or {}
                state = "finished" if st.get("completed") else "live" if st.get("state") == "in" else \
                    "off" if "POSTPONED" in (st.get("name") or "") or "CANCELED" in (st.get("name") or "") else "upcoming"
                g = lambda c: int(c["score"]) if state != "upcoming" and str(c.get("score", "")).isdigit() else None
                hg, ag = g(home), g(away)
                team = lambda c: {"id": (c.get("team") or {}).get("id"), "name": (c.get("team") or {}).get("displayName"),
                                  "full": (c.get("team") or {}).get("displayName"), "crest": (c.get("team") or {}).get("logo"), "tla": None}
                winner = None
                if state == "finished" and hg is not None:
                    winner = "HOME_TEAM" if hg > ag else "AWAY_TEAM" if ag > hg else "DRAW"
                out.append({"id": f"isl{e['id']}", "comp": "ISL", "comp_name": "Indian Super League", "start": e["date"],
                            "status": st.get("name"), "state": state, "matchday": None, "stage": None, "group": None,
                            "home": {**team(home), "goals": hg}, "away": {**team(away), "goals": ag}, "half": [None, None],
                            "winner": winner, "isl": True, "raw_home": {"name": (home.get("team") or {}).get("displayName")},
                            "raw_away": {"name": (away.get("team") or {}).get("displayName")}})
            time.sleep(0.3)
        return out
    return _hold(f"isl{days_back}:{days_ahead}", 300, read)


def isl_table() -> dict:
    def read():
        d = _get("https://site.api.espn.com/apis/v2/sports/soccer/ind.1/standings")
        tables = []
        for ch in d.get("children") or []:
            rows = []
            for n, en in enumerate((ch.get("standings") or {}).get("entries") or []):
                stats = {s.get("name"): s.get("value") for s in en.get("stats") or []}
                t = en.get("team") or {}
                rows.append({"pos": int(stats.get("rank") or n + 1), "team": t.get("displayName"),
                             "crest": ((t.get("logos") or [{}])[0]).get("href"), "played": int(stats.get("gamesPlayed") or 0),
                             "won": int(stats.get("wins") or 0), "draw": int(stats.get("ties") or 0), "lost": int(stats.get("losses") or 0),
                             "gf": int(stats.get("pointsFor") or 0), "ga": int(stats.get("pointsAgainst") or 0),
                             "gd": int(stats.get("pointDifferential") or 0), "pts": int(stats.get("points") or 0), "form": None})
            rows.sort(key=lambda r: r["pos"])
            tables.append({"group": None, "rows": rows})
        return {"comp": "ISL", "name": "Indian Super League", "season": None, "tables": tables}
    return _hold("isltable", 3600, read)

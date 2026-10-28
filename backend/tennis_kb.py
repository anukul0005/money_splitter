"""Tennis knowledge base: every ATP and WTA tour-level singles match.

One module, two homes: the local SQLite file (tennis_kb.sqlite - the
Tennis_scraper scripts build_kb.py and update_kb.py, `connect`) and the
app's Postgres (the Betting analytics page, routers/tennis.py; kept current
by the daily cron, tennis_sync.py - `connect_pg`). Same tables in both.

Tables
  tennis_matches  one row per match - tour, tournament, surface, level,
               dates (play_date: the day played, or a Sackmann tournament's
               first day), round, both players (id, name, country, age,
               rank, seed), score, minutes, source. match_id is the key:
                 "ATP:<tourney_id>-<match_num>"  Jeff Sackmann data, 2000-2024
                 "tsdb:<idEvent>"                TheSportsDB (the app's method)
                 "espn:<competition id>"         ESPN scoreboard
  tennis_match_stats  serve/return totals (aces, double faults, break
               points...) where the source has them - Sackmann tour matches.
  tennis_players  ATP and WTA players: id, name, hand, dob, country,
               height, and the ESPN athlete id once seen there. A player
               first met in new matches gets an id from 9,000,000 up.
  tennis_meta  built_at, last_fetched (the last day the updater covered).

New matches come from ESPN's free scoreboard (complete daily results),
with TheSportsDB - the method the original scraper app used - as the
fallback for a day ESPN can't be reached; its free tier only returns a few
matches a day, so it is a fallback only. Each player is matched to their
player id (ESPN id, then full name, then reversed name, then surname +
initial among players active recently). Standard library only.
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta

DB_FILE = "tennis_kb.sqlite"
UA = {"User-Agent": "Mozilla/5.0 (tennis-kb updater)"}
ESPN = "https://site.api.espn.com/apis/site/v2/sports/tennis/{tour}/scoreboard?dates={day}"
TSDB = "https://www.thesportsdb.com/api/v1/json/123/eventsday.php?d={day}&s=Tennis"
NEW_PLAYER_BASE = 9_000_000
# ESPN's WTA feed also carries WTA 125 events (Challenger level) and marks
# them no differently - prize money is 0 for every event, ids overlap. So a
# WTA event is tour-level when its name or host city matches a WTA tour
# event of recent seasons in the knowledge base ("BNB Ningbo Open" in
# Ningbo -> "Ningbo"); 125 cities (Montevideo, Newport, Jinan) aren't
# there, and a name saying "125" is out regardless. A brand-new tour city
# needs adding to WTA_EXTRA_CITIES once.
WTA_HISTORY_FROM = 20230101
WTA_EXTRA_CITIES: set[str] = {"singapore", "london", "chennai"}   # new tour events since 2025 (Queen's = London)
# WTA 125s in a city that also has a tour event, so the city can't tell them apart.
WTA_125_NAMES = ("villa de madrid", "bancomat")

SCHEMA = """
CREATE TABLE IF NOT EXISTS tennis_players (
    tour TEXT NOT NULL, player_id INTEGER NOT NULL, name TEXT, first_name TEXT, last_name TEXT,
    hand TEXT, dob INTEGER, ioc TEXT, height INTEGER, wikidata_id TEXT, espn_id TEXT, source TEXT,
    PRIMARY KEY (tour, player_id));
CREATE INDEX IF NOT EXISTS ix_tennis_players_espn ON tennis_players(espn_id);
CREATE TABLE IF NOT EXISTS tennis_matches (
    match_id TEXT PRIMARY KEY, source TEXT NOT NULL, tour TEXT NOT NULL,
    tourney_id TEXT, tourney_name TEXT, surface TEXT, draw_size INTEGER, tourney_level TEXT,
    tourney_date INTEGER, match_date TEXT, play_date TEXT, match_num INTEGER, round TEXT, best_of INTEGER,
    winner_id INTEGER, winner_name TEXT, winner_ioc TEXT, winner_age REAL, winner_rank INTEGER,
    winner_rank_points INTEGER, winner_seed TEXT, winner_entry TEXT,
    loser_id INTEGER, loser_name TEXT, loser_ioc TEXT, loser_age REAL, loser_rank INTEGER,
    loser_rank_points INTEGER, loser_seed TEXT, loser_entry TEXT,
    score TEXT, minutes INTEGER);
CREATE INDEX IF NOT EXISTS ix_tennis_m_date ON tennis_matches(tourney_date);
CREATE INDEX IF NOT EXISTS ix_tennis_m_winner ON tennis_matches(tour, winner_id);
CREATE INDEX IF NOT EXISTS ix_tennis_m_loser ON tennis_matches(tour, loser_id);
CREATE INDEX IF NOT EXISTS ix_tennis_m_tourney ON tennis_matches(tourney_name);
CREATE INDEX IF NOT EXISTS ix_tennis_m_play ON tennis_matches(play_date, tour);
CREATE TABLE IF NOT EXISTS tennis_match_stats (
    match_id TEXT PRIMARY KEY REFERENCES tennis_matches(match_id) ON DELETE CASCADE,
    w_ace INTEGER, w_df INTEGER, w_svpt INTEGER, w_1stIn INTEGER, w_1stWon INTEGER, w_2ndWon INTEGER,
    w_SvGms INTEGER, w_bpSaved INTEGER, w_bpFaced INTEGER,
    l_ace INTEGER, l_df INTEGER, l_svpt INTEGER, l_1stIn INTEGER, l_1stWon INTEGER, l_2ndWon INTEGER,
    l_SvGms INTEGER, l_bpSaved INTEGER, l_bpFaced INTEGER);
CREATE TABLE IF NOT EXISTS tennis_meta (key TEXT PRIMARY KEY, value TEXT);
"""
MATCH_COLS = ["match_id", "source", "tour", "tourney_id", "tourney_name", "surface", "draw_size",
              "tourney_level", "tourney_date", "match_date", "play_date", "match_num", "round", "best_of",
              "winner_id", "winner_name", "winner_ioc", "winner_age", "winner_rank", "winner_rank_points",
              "winner_seed", "winner_entry", "loser_id", "loser_name", "loser_ioc", "loser_age", "loser_rank",
              "loser_rank_points", "loser_seed", "loser_entry", "score", "minutes"]
STAT_COLS = ["w_ace", "w_df", "w_svpt", "w_1stIn", "w_1stWon", "w_2ndWon", "w_SvGms", "w_bpSaved", "w_bpFaced",
             "l_ace", "l_df", "l_svpt", "l_1stIn", "l_1stWon", "l_2ndWon", "l_SvGms", "l_bpSaved", "l_bpFaced"]

# Surfaces for tournaments by keyword (name or city) - ESPN gives neither
# surface nor level. From the original build_database.py, plus history.
KNOWN_SURFACES = {
    "australian open": "Hard", "roland garros": "Clay", "french open": "Clay", "wimbledon": "Grass",
    "us open": "Hard", "indian wells": "Hard", "bnp paribas open": "Hard", "miami": "Hard",
    "monte carlo": "Clay", "madrid": "Clay", "rome": "Clay", "internazionali": "Clay", "italian open": "Clay",
    "canada": "Hard", "canadian open": "Hard", "national bank open": "Hard", "montreal": "Hard",
    "toronto": "Hard", "cincinnati": "Hard", "shanghai": "Hard", "paris": "Hard", "atp finals": "Hard",
    "wta finals": "Hard", "united cup": "Hard", "auckland": "Hard", "asb classic": "Hard",
    "adelaide": "Hard", "brisbane": "Hard", "hong kong": "Hard", "doha": "Hard", "qatar": "Hard",
    "dubai": "Hard", "abu dhabi": "Hard", "acapulco": "Hard", "mexican open": "Hard", "merida": "Hard",
    "rio": "Clay", "buenos aires": "Clay", "argentina open": "Clay", "santiago": "Clay", "chile": "Clay",
    "barcelona": "Clay", "queen": "Grass", "halle": "Grass", "eastbourne": "Grass", "hertogenbosch": "Grass",
    "libema": "Grass", "nottingham": "Grass", "mallorca": "Grass", "bad homburg": "Grass",
    "berlin": "Grass", "birmingham": "Grass", "stuttgart": "Clay", "hamburg": "Clay", "bastad": "Clay",
    "nordea": "Clay", "umag": "Clay", "gstaad": "Clay", "kitzbuhel": "Clay", "bucharest": "Clay",
    "washington": "Hard", "citi open": "Hard", "beijing": "Hard", "china open": "Hard", "tokyo": "Hard",
    "japan open": "Hard", "vienna": "Hard", "basel": "Hard", "swiss indoors": "Hard", "stockholm": "Hard",
    "antwerp": "Hard", "brussels": "Hard", "european open": "Hard", "marseille": "Hard",
    "montpellier": "Hard", "metz": "Hard", "moselle": "Hard", "delray": "Hard", "dallas": "Hard",
    "winston": "Hard", "rotterdam": "Hard", "abn amro": "Hard", "munich": "Clay", "bmw open": "Clay",
    "geneva": "Clay", "houston": "Clay", "strasbourg": "Clay", "los cabos": "Hard", "chengdu": "Hard",
    "hangzhou": "Hard", "ningbo": "Hard", "guangzhou": "Hard", "wuhan": "Hard", "seoul": "Hard",
    "korea open": "Hard", "singapore": "Hard", "san diego": "Hard", "guadalajara": "Hard",
    "monterrey": "Hard", "austin": "Hard", "linz": "Hard", "prague": "Clay", "marrakech": "Clay",
    "marrakesh": "Clay", "cleveland": "Hard", "bogota": "Clay", "iasi": "Clay", "transylvania": "Hard",
    "cluj": "Hard", "rouen": "Clay", "almaty": "Hard", "hobart": "Hard", "athens": "Hard", "hellenic": "Hard",
    "osaka": "Hard", "pan pacific": "Hard", "tampico": "Hard", "jiujiang": "Hard", "charleston": "Clay",
    "rabat": "Clay", "parma": "Clay", "palermo": "Clay", "warsaw": "Clay", "budapest": "Clay",
    "tallinn": "Hard", "osaka open": "Hard", "kitzb": "Clay", "estoril": "Clay", "lausanne": "Clay",
    "hamburg open": "Clay", "newport": "Grass", "s-hertogenbosch": "Grass", "riyadh": "Hard",
    "jeddah": "Hard", "tennis in the land": "Hard", "monastir": "Hard", "merida open": "Hard",
    "hsbc championships": "Grass", "auvergne": "Hard",     # Queen's Club; Lyon's indoor October event
}
GRAND_SLAMS = ("australian open", "roland garros", "french open", "wimbledon", "us open")
FINALS = ("atp finals", "wta finals", "nitto atp finals", "masters cup", "tour finals")
MASTERS = ("indian wells", "bnp paribas open", "miami", "monte carlo", "rolex monte", "mutua madrid", "madrid",
           "internazionali", "italian open", "rome", "national bank open", "canadian open", "montreal", "toronto",
           "cincinnati", "shanghai", "rolex paris", "paris masters")


# ── names ────────────────────────────────────────────────────────────────────
def norm(s) -> str:
    s = unicodedata.normalize("NFKD", str(s or ""))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[-'’.]", " ", s.lower())
    return " ".join(s.split())


def connect(path: str = DB_FILE) -> sqlite3.Connection:
    """The local SQLite knowledge base."""
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    return conn


class PG:
    """The app's Postgres behind the same calls the SQLite connection takes
    (execute -> cursor, executemany, commit), so one set of functions serves
    both. "?" placeholders become psycopg2's "%s"."""

    def __init__(self, raw):
        self.raw = raw

    def execute(self, sql: str, params=()):
        cur = self.raw.cursor()
        cur.execute(sql.replace("?", "%s"), tuple(params))
        return cur

    def executemany(self, sql: str, rows) -> None:
        from psycopg2.extras import execute_batch
        cur = self.raw.cursor()
        execute_batch(cur, sql.replace("?", "%s"), rows, page_size=1000)

    def executescript(self, script: str) -> None:
        for stmt in (x.strip() for x in script.split(";")):
            if stmt:
                self.execute(stmt)

    def commit(self) -> None:
        self.raw.commit()

    def close(self) -> None:
        self.raw.close()


def connect_pg(engine) -> PG:
    """The app's database (an SQLAlchemy engine), tables made if missing."""
    conn = PG(engine.raw_connection())
    conn.executescript(SCHEMA.replace(" REAL", " DOUBLE PRECISION"))
    conn.commit()
    return conn


def play_date(row) -> str | None:
    """The day a match was played - its own date, or for data that only
    knows the tournament's week (Sackmann), the week's first day."""
    if row.get("match_date"):
        return row["match_date"]
    d = str(row.get("tourney_date") or "")
    return f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else None


def meta_get(conn, key, default=None):
    row = conn.execute("SELECT value FROM tennis_meta WHERE key = ?", (key,)).fetchone()
    return row[0] if row else default


def meta_set(conn, key, value) -> None:
    conn.execute("INSERT INTO tennis_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                 (key, str(value)))


# ── players ──────────────────────────────────────────────────────────────────
class Players:
    """Matches a name from a new match to a player id - ESPN id, then full
    name, then reversed ("Wang Xinyu" / "Xinyu Wang"), then surname + first
    initial among the players active in the last few years - and adds a new
    player when none fits."""

    def __init__(self, conn):
        self.conn = conn
        self.by_name: dict[tuple, int] = {}
        self.by_espn: dict[tuple, int] = {}
        self.by_last: dict[tuple, list] = {}
        self.by_tok: dict[tuple, set] = {}
        self.info: dict[tuple, dict] = {}
        # Who played most recently decides a shared name: "Zhang" means today's Zhang.
        recent: dict[tuple, int] = {}
        for tour, pid, d in conn.execute(
                "SELECT tour, winner_id, MAX(tourney_date) FROM tennis_matches WHERE winner_id IS NOT NULL GROUP BY 1, 2 "
                "UNION ALL SELECT tour, loser_id, MAX(tourney_date) FROM tennis_matches WHERE loser_id IS NOT NULL GROUP BY 1, 2"):
            recent[(tour, pid)] = max(recent.get((tour, pid), 0), d or 0)
        self.recent = recent
        rows = conn.execute("SELECT tour, player_id, first_name, last_name, ioc, dob, espn_id FROM tennis_players").fetchall()
        rows.sort(key=lambda r: recent.get((r[0], r[1]), 0))     # most recent last: wins below
        for tour, pid, first, last, ioc, dob, espn in rows:
            self._index(tour, pid, first, last, ioc, dob, espn)

    def _index(self, tour, pid, first, last, ioc, dob, espn):
        f, l = norm(first), norm(last)
        self.info[(tour, pid)] = {"ioc": ioc, "dob": dob, "name": f"{first or ''} {last or ''}".strip()}
        for key in (f"{f} {l}".strip(), f"{l} {f}".strip()):
            if key:
                self.by_name[(tour, key)] = pid
                # Spacing aside: "Wang Xinyu" / "Xin Yu Wang", "O'Connell" / "Oconnell".
                self.by_name[(tour, "#" + key.replace(" ", ""))] = pid
        if l:
            self.by_last.setdefault((tour, l), []).append(pid)
        toks = frozenset(f"{f} {l}".split())
        self.info[(tour, pid)]["tokens"] = toks
        for t in toks:
            if len(t) > 1:
                self.by_tok.setdefault((tour, t), set()).add(pid)
        if espn:
            self.by_espn[(tour, str(espn))] = pid

    def find(self, tour: str, full_name: str | None = None, espn_id=None, surname: str | None = None):
        if espn_id and (tour, str(espn_id)) in self.by_espn:
            return self.by_espn[(tour, str(espn_id))]
        if full_name:
            pid = self.by_name.get((tour, norm(full_name))) or self.by_name.get((tour, "#" + norm(full_name).replace(" ", "")))
            if pid:
                return pid
            parts = norm(full_name).split()
            pid = self._by_parts(tour, frozenset(parts))
            if pid:
                return pid
            if len(parts) >= 2:                                   # "J. Sinner" / initial + surname
                cands = self.by_last.get((tour, " ".join(parts[1:])), [])
                cands = [c for c in cands if norm(self.info[(tour, c)]["name"]).startswith(parts[0][0])]
                if cands:
                    return max(cands, key=lambda c: self.recent.get((tour, c), 0))
        if surname:                                               # TheSportsDB: "Zhang Z", "Bautista Agut"
            parts = norm(surname).split()
            initials = [p for p in parts if len(p) == 1]
            last = " ".join(p for p in parts if len(p) > 1)
            cands = self.by_last.get((tour, last), [])
            if initials:
                cands = [c for c in cands if norm(self.info[(tour, c)]["name"]).startswith(initials[0])]
            cands = [c for c in cands if self.recent.get((tour, c), 0) >= 20200101] or cands
            if cands:
                return max(cands, key=lambda c: self.recent.get((tour, c), 0))
        return None

    def _by_parts(self, tour, parts: frozenset):
        """A name with a part more or less than the player list's - "Daniel
        Merida" / "Daniel Merida Aguilar", "Joel Josef Schwaerzler" / "Joel
        Schwaerzler": all of one's words in the other, two at least shared.
        The most recently active such player; None when it isn't clear."""
        if len(parts) < 2:
            return None
        cands = set().union(*(self.by_tok.get((tour, t), set()) for t in parts if len(t) > 1))
        fits = []
        for c in cands:
            toks = self.info[(tour, c)].get("tokens") or frozenset()
            shared = len(parts & toks)
            if shared >= 2 and (parts <= toks or toks <= parts):
                fits.append((shared, self.recent.get((tour, c), 0), c))
        if not fits:
            return None
        fits.sort(reverse=True)
        if len(fits) > 1 and fits[0][:2] == fits[1][:2]:
            return None                       # two players fit equally well: don't guess
        return fits[0][2]

    def link_espn(self, tour, pid, espn_id) -> None:
        if espn_id and (tour, str(espn_id)) not in self.by_espn:
            self.conn.execute("UPDATE tennis_players SET espn_id = ? WHERE tour = ? AND player_id = ?", (str(espn_id), tour, pid))
            self.by_espn[(tour, str(espn_id))] = pid

    def add(self, tour: str, full_name: str, ioc: str | None, espn_id=None) -> int:
        top = self.conn.execute("SELECT MAX(player_id) FROM tennis_players WHERE player_id >= ?", (NEW_PLAYER_BASE,)).fetchone()[0]
        pid = (top or NEW_PLAYER_BASE - 1) + 1
        parts = (full_name or "").split()
        first, last = (" ".join(parts[:-1]), parts[-1]) if len(parts) > 1 else ("", full_name or "")
        self.conn.execute("INSERT INTO tennis_players(tour, player_id, name, first_name, last_name, ioc, espn_id, source) "
                          "VALUES(?, ?, ?, ?, ?, ?, ?, 'espn')", (tour, pid, full_name, first, last, ioc, espn_id))
        self._index(tour, pid, first, last, ioc, None, espn_id)
        return pid

    def age(self, tour, pid, on: date) -> float | None:
        dob = (self.info.get((tour, pid)) or {}).get("dob")
        if not dob:
            return None
        try:
            born = datetime.strptime(str(int(dob)), "%Y%m%d").date()
        except ValueError:
            return None
        return round((on - born).days / 365.25, 1)


# ── tournaments ──────────────────────────────────────────────────────────────
class Tourneys:
    """Surface and level for a tournament from new data, which carries
    neither: the same tournament in history, else a keyword in its name or
    city (KNOWN_SURFACES)."""

    def __init__(self, conn):
        self.hist: dict[str, str] = {}
        for name, surf in conn.execute(
                "SELECT tourney_name, surface FROM tennis_matches WHERE surface IS NOT NULL AND surface <> '' "
                "GROUP BY tourney_name, surface ORDER BY COUNT(*)"):
            self.hist[norm(name)] = surf
        self.wta_names = {norm(n) for (n,) in conn.execute(
            # the original sources only: a wrongly kept event mustn't vouch for itself next time
            "SELECT DISTINCT tourney_name FROM tennis_matches WHERE tour = 'WTA' AND tourney_date >= ? AND source <> 'espn'",
            (WTA_HISTORY_FROM,))
            if n and len(norm(n)) >= 4} | {norm(c) for c in WTA_EXTRA_CITIES}

    def surface(self, name, city="") -> str | None:
        n = norm(name)
        if n in self.hist:
            return self.hist[n]
        hay = f"{n} {norm(city)}"
        for kw, surf in KNOWN_SURFACES.items():
            if kw in hay:
                return surf
        return None

    @staticmethod
    def level(name, tour, major=False) -> str:
        n = norm(name)
        if major or any(g in n for g in GRAND_SLAMS):
            return "G"
        if any(f in n for f in FINALS):
            return "F"
        if any(m in n for m in MASTERS):
            return "M"
        return "A"

    def is_wta_tour(self, name, city="", major=False) -> bool:
        n, c = norm(name), norm(str(city).split(",")[0])
        if major:
            return True
        if "125" in n.split() or any(x in n for x in WTA_125_NAMES):
            return False
        words = f" {n} {c} "
        return any(f" {w} " in words or w == n for w in self.wta_names)


# ── fetching ─────────────────────────────────────────────────────────────────
def get_json(url: str, tries: int = 3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1))


ROUNDS = {"final": "F", "semifinal": "SF", "semifinals": "SF", "quarterfinal": "QF", "quarterfinals": "QF",
          "round of 16": "R16", "round of 32": "R32", "round of 64": "R64", "round of 128": "R128",
          "group stage": "RR", "round robin": "RR"}


def _round(display: str, draw: int) -> str:
    d = (display or "").strip().lower()
    if d in ROUNDS:
        return ROUNDS[d]
    m = re.match(r"round (\d+)$", d)                     # "Round 1" in a 32 draw -> R32
    if m and draw:
        size = draw
        for _ in range(int(m.group(1)) - 1):
            size //= 2
        return f"R{max(size, 2)}"
    return display


def _score(note: str, comps: list) -> str:
    """Sackmann style - "6-7(4) 6-4 7-6(5)", "RET" - from ESPN's note
    ("A bt (6) B 6-7 (4-7) 6-4 ret"), else from the set scores."""
    m = re.search(r"\)\s+((?:\d+-\d+.*))$", note or "")
    if m:
        s = m.group(1)
        s = re.sub(r"(\d+)-(\d+)\s*\((\d+)-(\d+)\)", lambda x: f"{x.group(1)}-{x.group(2)}({min(int(x.group(3)), int(x.group(4)))})", s)
        s = re.sub(r"\s+ret\.?$", " RET", s, flags=re.I)
        s = re.sub(r"\s+(def|def\.|w/o|walkover)$", "", s, flags=re.I)
        return " ".join(s.split())
    w = next((c for c in comps if c.get("winner")), None)
    l = next((c for c in comps if not c.get("winner")), None)
    if not w or not l:
        return ""
    sets = []
    for a, b in zip(w.get("linescores", []), l.get("linescores", [])):
        sa, sb = int(a.get("value", 0)), int(b.get("value", 0))
        tb = min(a.get("tiebreak", 99), b.get("tiebreak", 99))
        sets.append(f"{sa}-{sb}" + (f"({tb})" if tb != 99 and {sa, sb} == {6, 7} else ""))
    return " ".join(sets)


def espn_day(tour: str, day: date) -> list:
    """Every finished tour-level singles match ESPN lists for that day's
    tournaments - the whole event so far, which overlap between days makes
    harmless. Qualifying, doubles and WTA 125s are left out."""
    data = get_json(ESPN.format(tour=tour.lower(), day=day.strftime("%Y%m%d")))
    want = "mens-singles" if tour == "ATP" else "womens-singles"
    out = []
    for ev in data.get("events", []):
        try:
            espn_tid = int(str(ev.get("id", "0")).split("-")[0])
        except ValueError:
            espn_tid = 0
        for g in ev.get("groupings", []):
            if (g.get("grouping") or {}).get("slug") != want:
                continue
            comps = g.get("competitions", [])
            main = [c for c in comps if "qualif" not in ((c.get("round") or {}).get("displayName") or "").lower()]
            draw = 0
            firsts = [c for c in main if ((c.get("round") or {}).get("displayName") or "").lower() == "round 1"]
            if firsts:
                draw = 1
                while draw < len(firsts) * 2:
                    draw *= 2
            for c in main:
                st = ((c.get("status") or {}).get("type") or {})
                if not st.get("completed") or st.get("name") == "STATUS_WALKOVER":
                    continue
                cs = c.get("competitors", [])
                if len(cs) != 2 or not all(x.get("athlete") for x in cs):
                    continue
                out.append({"event": ev, "espn_tid": espn_tid, "comp": c, "draw": draw})
    return out


def tsdb_day(day: date) -> list:
    """TheSportsDB - the original scraper app's method, a few matches a day."""
    data = get_json(TSDB.format(day=day.isoformat()))
    return [e for e in (data.get("events") or []) if any(t in (e.get("strLeague") or "") for t in ("ATP", "WTA"))]


# ── writing ──────────────────────────────────────────────────────────────────
def _already(conn, row) -> bool:
    """The same match from another source - same two players within a
    fortnight - is not a new one."""
    if not (row["winner_id"] and row["loser_id"]):
        return False
    d = datetime.strptime(str(row["tourney_date"]), "%Y%m%d").date()
    lo, hi = int((d - timedelta(days=16)).strftime("%Y%m%d")), int((d + timedelta(days=16)).strftime("%Y%m%d"))
    return conn.execute(
        "SELECT 1 FROM tennis_matches WHERE tour = ? AND winner_id = ? AND loser_id = ? AND tourney_date BETWEEN ? AND ? "
        "AND match_id <> ? LIMIT 1", (row["tour"], row["winner_id"], row["loser_id"], lo, hi, row["match_id"])).fetchone() is not None


def upsert(conn, row) -> bool:
    """Add or refresh one match; False when it's another source's copy."""
    row.setdefault("play_date", play_date(row))
    if not conn.execute("SELECT 1 FROM tennis_matches WHERE match_id = ?", (row["match_id"],)).fetchone() and _already(conn, row):
        return False
    cols = MATCH_COLS
    conn.execute(f"INSERT INTO tennis_matches({', '.join(cols)}) VALUES({', '.join('?' * len(cols))}) "
                 f"ON CONFLICT(match_id) DO UPDATE SET " + ", ".join(f"{c} = excluded.{c}" for c in cols[1:]),
                 [row.get(c) for c in cols])
    return True


def _player(players, tour, name, espn_id, flag_code):
    pid = players.find(tour, full_name=name, espn_id=espn_id)
    if pid is None:
        pid = players.add(tour, name, flag_code, espn_id)
    else:
        players.link_espn(tour, pid, espn_id)
    return pid


def espn_rows(item, tour, players, tourneys) -> dict | None:
    ev, c = item["event"], item["comp"]
    name = ev.get("name") or ""
    if tour == "WTA" and not tourneys.is_wta_tour(name, (ev.get("venue") or {}).get("displayName", ""), ev.get("major")):
        return None
    cs = c["competitors"]
    w = next((x for x in cs if x.get("winner")), None)
    l = next((x for x in cs if not x.get("winner")), None)
    if not w or not l:
        return None
    start = (ev.get("date") or c.get("date") or "")[:10]
    mdate = (c.get("date") or "")[:10]
    on = date.fromisoformat(mdate or start)
    note = " ".join(n.get("text", "") for n in c.get("notes", []))
    seeds = dict(re.findall(r"\((\d+)\)\s+([^()]+?)\s+\(", note))   # "(6) Alexandre Muller (FRA)"
    row = {"match_id": f"espn:{c['id']}", "source": "espn", "tour": tour,
           "tourney_id": f"{start[:4]}-espn-{item['espn_tid']}", "tourney_name": name,
           "surface": tourneys.surface(name, (ev.get("venue") or {}).get("displayName", "")),
           "draw_size": item["draw"] or None, "tourney_level": tourneys.level(name, tour, ev.get("major")),
           "tourney_date": int(start.replace("-", "")), "match_date": mdate,
           "round": _round((c.get("round") or {}).get("displayName"), item["draw"]),
           # ESPN's format says 5 periods for every ATP match - only the men's Slams are best of five.
           "best_of": 5 if tour == "ATP" and (ev.get("major") or tourneys.level(name, tour, ev.get("major")) == "G") else 3,
           "score": _score(note, cs), "minutes": None}
    for side, x in (("winner", w), ("loser", l)):
        a = x["athlete"]
        nm = a.get("displayName") or a.get("fullName")
        code = ((a.get("flag") or {}).get("href") or "").rsplit("/", 1)[-1].split(".")[0].upper() or None
        pid = _player(players, tour, nm, x.get("id"), code)
        info = players.info.get((tour, pid), {})
        rank = (x.get("curatedRank") or {}).get("current")
        row.update({f"{side}_id": pid, f"{side}_name": nm, f"{side}_ioc": info.get("ioc") or code,
                    f"{side}_age": players.age(tour, pid, on), f"{side}_rank": rank if rank and rank < 5000 else None,
                    f"{side}_rank_points": None,
                    f"{side}_seed": next((s for s, n in seeds.items() if norm(n) == norm(nm)), None), f"{side}_entry": None})
    return row


def tsdb_rows(e, players, tourneys) -> dict | None:
    league = e.get("strLeague") or ""
    tour = "ATP" if "ATP" in league else "WTA"
    desc = [x.strip() for x in (e.get("strDescriptionEN") or "").replace("\r\n", "\n").split("\n") if x.strip()]
    res = [x.strip() for x in (e.get("strResult") or "").replace("\r\n", "\n").split("\n") if x.strip()]
    if not desc or not res:
        return None
    head = desc[0].split(" - ")
    tname, rnd = head[0].strip(), (head[-1].strip() if len(head) >= 3 else "")
    ranks = re.match(r"(.+?)\s*\((\d+)\)\s+vs\s+(.+?)\s*\((\d+)\)", desc[1]) if len(desc) > 1 else None
    beat = re.match(r"(.+?)\s+beat\s+(.+?)\s+\d", res[0])
    if not beat:
        return None
    wn, ln = beat.group(1).strip(), beat.group(2).strip()
    rank_of = {}
    if ranks:
        rank_of = {norm(ranks.group(1)): int(ranks.group(2)), norm(ranks.group(3)): int(ranks.group(4))}
    ws = [int(v) for v in re.findall(r"\d+", res[1].split(":")[-1])] if len(res) > 1 else []
    ls = [int(v) for v in re.findall(r"\d+", res[2].split(":")[-1])] if len(res) > 2 else []
    d = e.get("dateEvent") or ""
    row = {"match_id": f"tsdb:{e['idEvent']}", "source": "thesportsdb", "tour": tour, "tourney_id": f"{d[:4]}-tsdb",
           "tourney_name": tname, "surface": tourneys.surface(tname, e.get("strCity") or ""), "draw_size": None,
           "tourney_level": tourneys.level(tname, tour), "tourney_date": int(d.replace("-", "")), "match_date": d,
           "round": _round(rnd.replace("The ", ""), 0), "best_of": 5 if tour == "ATP" and tourneys.level(tname, tour) == "G" else 3,
           "score": " ".join(f"{a}-{b}" for a, b in zip(ws, ls)), "minutes": None}
    for side, nm in (("winner", wn), ("loser", ln)):
        pid = players.find(tour, surname=nm)
        info = players.info.get((tour, pid), {}) if pid else {}
        row.update({f"{side}_id": pid, f"{side}_name": info.get("name") or nm, f"{side}_ioc": info.get("ioc"),
                    f"{side}_age": players.age(tour, pid, date.fromisoformat(d)) if pid else None,
                    f"{side}_rank": rank_of.get(norm(nm)), f"{side}_rank_points": None, f"{side}_seed": None,
                    f"{side}_entry": None})
    return row


def fetch_range(conn, start: date, end: date, log=print) -> dict:
    """Every ATP and WTA tour-level singles match from `start` to `end`
    (inclusive) into the knowledge base: ESPN per tour per day, the app's
    TheSportsDB method for a day ESPN can't be reached. Only matches played
    on or after `start` are taken. Commits as it goes."""
    players, tourneys = Players(conn), Tourneys(conn)
    added = refreshed = skipped = 0
    day = start
    while day <= end:
        espn_ok = True
        for tour in ("ATP", "WTA"):
            try:
                items = espn_day(tour, day)
            except Exception as err:
                log(f"  {day} {tour}: ESPN unavailable ({err}) - using TheSportsDB")
                espn_ok = False
                continue
            for it in items:
                if (it["comp"].get("date") or "")[:10] < start.isoformat():
                    continue
                row = espn_rows(it, tour, players, tourneys)
                if not row:
                    continue
                existed = conn.execute("SELECT 1 FROM tennis_matches WHERE match_id = ?", (row["match_id"],)).fetchone()
                if upsert(conn, row):
                    refreshed += bool(existed)
                    added += not existed
                else:
                    skipped += 1
        if not espn_ok:
            try:
                for e in tsdb_day(day):
                    row = tsdb_rows(e, players, tourneys)
                    if row and upsert(conn, row):
                        added += 1
            except Exception as err:
                log(f"  {day}: TheSportsDB unavailable too ({err})")
        meta_set(conn, "last_fetched", day.isoformat())
        conn.commit()
        if day.day == 1 or day == end:
            log(f"  up to {day}: {added} new matches, {refreshed} refreshed, {skipped} already there")
        day += timedelta(days=1)
        time.sleep(0.3)
    return {"added": added, "refreshed": refreshed, "skipped": skipped}


def summary(conn) -> str:
    n = conn.execute("SELECT COUNT(*) FROM tennis_matches").fetchone()[0]
    by = dict(conn.execute("SELECT tour, COUNT(*) FROM tennis_matches GROUP BY tour").fetchall())
    lo, hi = conn.execute("SELECT MIN(play_date), MAX(play_date) FROM tennis_matches").fetchone()
    p = conn.execute("SELECT COUNT(*) FROM tennis_players").fetchone()[0]
    return (f"{n:,} matches (ATP {by.get('ATP', 0):,}, WTA {by.get('WTA', 0):,}), {lo} to {hi}; {p:,} players; "
            f"last fetched {meta_get(conn, 'last_fetched', '-')}")

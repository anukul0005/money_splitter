"""Games-per-set statistics for Betting analytics (routers/tennis.py):
how often a set goes over a games line (over 8.5 = 9+ games), by set
number, tour, surface, best-of, and per tournament year by year.

Every completed set is counted as a histogram of its total games, so any
line (7.5, 8.5, 9.5...) is worked out from the same numbers. A set is
complete when someone reached 6 with a two-game lead, or won it 7-6 /
in a tie-break; the unfinished set of a retirement, walkovers and short
formats (Next Gen 4-game sets) are left out, and so are best-of-five
matches outside the Grand Slams (Davis Cup, Masters finals before 2007...)
and carpet matches (off the tour since 2009).

Besides sets 1-5 two match-level rows are kept: EVERY = the match's
smallest set (every set over the line iff it is), ANY = its largest (at
least one set over). Only matches finished in full count for those.

Tournament names change with sponsors (BNP Paribas Open = Indian Wells),
so canonical() folds them into one name for year-on-year views.

One pass over every match, cached until the match count or last day changes.
"""
from __future__ import annotations

import re
import threading
import unicodedata
from collections import defaultdict

from sqlalchemy import text

EVERY, ANY = "every", "any"
SLAMS = {"Australian Open", "Roland Garros", "Wimbledon", "US Open"}
MAX_GAMES = 14                      # longer final sets (e.g. 70-68) are counted as 14+
_SET = re.compile(r"(\d+)-(\d+)(\(\d+\))?")

# (keywords, canonical name) - first match wins; per tour, then shared.
_COMMON = [
    (("australian open",), "Australian Open"), (("roland garros", "french open"), "Roland Garros"),
    (("wimbledon",), "Wimbledon"), (("us open", "u.s. open"), "US Open"),
    (("davis cup",), "Davis Cup"), (("bjk cup", "fed cup"), "BJK Cup"), (("united cup",), "United Cup"),
    (("olympic",), "Olympics"), (("laver cup",), "Laver Cup"),
    (("auckland", "asb classic"), "Auckland"), (("adelaide",), "Adelaide"), (("brisbane",), "Brisbane"),
    (("doha", "qatar"), "Doha"), (("dubai",), "Dubai"), (("hong kong",), "Hong Kong"),
    (("eastbourne",), "Eastbourne"), (("hertogenbosch", "rosmalen", "libema"), "'s-Hertogenbosch"),
    (("queen's", "queens club", "hsbc championships"), "Queen's Club"),
    (("mallorca",), "Mallorca"), (("hamburg",), "Hamburg"), (("washington", "citi open", "mubadala dc"), "Washington"),
    (("china open", "beijing"), "Beijing"), (("stuttgart", "porsche", "boss open"), "Stuttgart"),
]
_TOUR = {
    "ATP": [
        (("next gen",), "Next Gen Finals"), (("masters cup", "atp finals", "tour finals", "masters cup"), "Tour Finals"),
        (("indian wells", "bnp paribas open"), "Indian Wells Masters"), (("miami",), "Miami Masters"),
        (("monte carlo", "monte-carlo"), "Monte Carlo Masters"), (("madrid",), "Madrid Masters"),
        (("rome", "internazionali"), "Rome Masters"), (("canada", "canadian open", "national bank", "toronto", "montreal"), "Canada Masters"),
        (("cincinnati", "western & southern"), "Cincinnati Masters"), (("shanghai",), "Shanghai Masters"),
        (("paris masters", "bnp paribas masters", "rolex paris"), "Paris Masters"),
        (("rotterdam", "abn amro"), "Rotterdam"), (("acapulco", "abierto mexicano"), "Acapulco"),
        (("los cabos", "mifel"), "Los Cabos"), (("buenos aires", "argentina open"), "Buenos Aires"),
        (("santiago", "chile open"), "Santiago"), (("rio de janeiro", "rio open"), "Rio de Janeiro"),
        (("munich", "bmw open"), "Munich"), (("antwerp", "european open"), "Antwerp"), (("barcelona",), "Barcelona"),
        (("chengdu",), "Chengdu"), (("hangzhou",), "Hangzhou"), (("almaty",), "Almaty"), (("dallas",), "Dallas"),
        (("delray",), "Delray Beach"), (("gstaad",), "Gstaad"), (("vienna", "erste bank"), "Vienna"),
        (("houston", "clay court"), "Houston"), (("geneva",), "Geneva"), (("lyon", "auvergne"), "Lyon"),
        (("marrakech", "hassan"), "Marrakech"), (("halle", "terra wortmann"), "Halle"), (("athens", "hellenic"), "Athens"),
        (("tokyo", "japan open"), "Tokyo"), (("estoril",), "Estoril"), (("bastad", "nordea"), "Bastad"),
        (("stockholm", "nordic open"), "Stockholm"), (("marseille", "open 13"), "Marseille"),
        (("montpellier", "occitanie", "sud de france"), "Montpellier"), (("metz", "moselle"), "Metz"),
        (("umag",), "Umag"), (("basel", "swiss indoors"), "Basel"), (("bucharest", "tiriac"), "Bucharest"),
        (("winston",), "Winston-Salem"), (("kitzbuhel", "generali"), "Kitzbuhel"), (("atlanta",), "Atlanta"),
        (("newport",), "Newport"), (("cordoba",), "Cordoba"), (("belgrade",), "Belgrade"),
    ],
    "WTA": [
        (("wta finals", "riyadh finals", "tour finals", "championships finals"), "WTA Finals"),
        (("indian wells", "bnp paribas open"), "Indian Wells"), (("miami",), "Miami"), (("madrid",), "Madrid"),
        (("rome", "internazionali"), "Rome"), (("canada", "canadian open", "national bank", "toronto", "montreal"), "Canada"),
        (("cincinnati", "western & southern"), "Cincinnati"), (("wuhan",), "Wuhan"),
        (("austin", "atx"), "Austin"), (("monterrey", "abierto gnp"), "Monterrey"), (("ningbo",), "Ningbo"),
        (("bad homburg",), "Bad Homburg"), (("bogota", "colsanitas"), "Bogota"), (("charleston",), "Charleston"),
        (("berlin", "german open"), "Berlin"), (("birmingham",), "Birmingham"), (("nottingham",), "Nottingham"),
        (("rabat", "lalla meryem", "morocco open"), "Rabat"), (("guadalajara",), "Guadalajara"),
        (("guangzhou",), "Guangzhou"), (("hobart",), "Hobart"), (("iasi",), "Iasi"), (("strasbourg",), "Strasbourg"),
        (("seoul", "korea open"), "Seoul"), (("linz",), "Linz"), (("prague",), "Prague"), (("merida",), "Merida"),
        (("abu dhabi",), "Abu Dhabi"), (("palermo",), "Palermo"), (("rouen",), "Rouen"), (("sp open", "sao paulo"), "Sao Paulo"),
        (("singapore",), "Singapore"), (("cleveland", "tennis in the land"), "Cleveland"),
        (("cluj", "transylvania"), "Cluj-Napoca"), (("jiujiang", "jiangxi"), "Jiujiang"), (("warsaw",), "Warsaw"),
        (("pan pacific", "tokyo"), "Tokyo"), (("osaka", "japan open"), "Osaka"), (("san diego",), "San Diego"),
        (("hua hin",), "Hua Hin"), (("budapest",), "Budapest"), (("monastir",), "Monastir"),
    ],
}


def _plain(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"\s+", " ", s.replace("�", "")).strip()


_canon_cache: dict[tuple, str] = {}


def canonical(tour: str, name: str) -> str:
    key = (tour, name)
    if key not in _canon_cache:
        p = _plain(name)
        out = name or "Unknown"
        for kws, canon in _TOUR.get(tour, []) + _COMMON:
            if any(k in p for k in kws):
                out = canon
                break
        _canon_cache[key] = out
    return _canon_cache[key]


def sets_of(score: str, took: list | None = None) -> tuple[list[int], bool]:
    """Total games of each completed set, and whether the match was played
    out in full (no retirement / walkover / unfinished set). Pass a list as
    took to get, per set, whether the match winner won it (scores are
    written from the winner's side)."""
    s = score or ""
    full = not re.search(r"RET|W/O|DEF|ABD|unfinished", s, re.I)
    out = []
    for m in _SET.finditer(s):
        a, b, tb = int(m.group(1)), int(m.group(2)), m.group(3)
        hi, lo = max(a, b), min(a, b)
        if hi >= 6 and (hi - lo >= 2 or tb or (hi == 7 and lo == 6) or (hi > 7 and hi - lo == 1)):
            out.append(min(a + b, MAX_GAMES))
            if took is not None:
                took.append(a > b)
        else:
            full = False
    return out, full and bool(out)


def match_sets(tour, tname, surface, best_of, score, took: list | None = None):
    """What a match adds to the statistics: (canonical tournament, best-of,
    [(set, games)...]) - or None when it doesn't count (no completed set,
    carpet, best-of-five outside the Grand Slams). took: as in sets_of."""
    mine: list = []
    games, full = sets_of(score, mine)
    if took is not None:
        took.extend(mine)
    if not games or surface == "Carpet":       # carpet: gone from the tour since 2009 - nothing to bet on
        return None
    # The score settles it when the match was played out: three sets won = best of five.
    # Otherwise (a retirement) the stored format.
    bo = 5 if (len(games) > 3 or sum(mine) >= 3) else 3 if full else (5 if best_of == 5 else 3)
    canon = canonical(tour, tname)
    if bo == 5 and canon not in SLAMS:         # Davis Cup, old Masters finals... - not like today's tour
        return None
    keys = [(str(i + 1), g) for i, g in enumerate(games)]
    if full:
        keys += [(EVERY, min(games)), (ANY, max(games))]
    return canon, bo, keys


def player_sets(rows, recent_cut: str, player_id: int) -> list:
    """A player's matches as [period, surface, set, outcome, {games: count}]
    rows: period 'all' or '12m' (played after recent_cut); outcome 'W' / 'L'
    = the player won / lost that set, 'M' for the every / any match rows."""
    h: dict = defaultdict(lambda: defaultdict(int))
    for r in rows:
        took: list = []
        got = match_sets(r["tour"], r["tourney_name"], r["surface"], r["best_of"], r["score"], took)
        if not got:
            continue
        won_match = r["winner_id"] == player_id
        periods = ["all", "12m"] if (r["play_date"] or "") > recent_cut else ["all"]
        for i, (sn, g) in enumerate(got[2]):
            outcome = "M" if i >= len(took) else ("W" if took[i] == won_match else "L")
            for p in periods:
                h[(p, r["surface"] or "Unknown", sn, outcome)][g] += 1
    return [[p, s, sn, o, dict(c)] for (p, s, sn, o), c in h.items()]


def _strength(rank, seed):
    """Ranking at the time; the tournament seed where no ranking was
    recorded (ESPN, 2026: its rank field is the seed too)."""
    for v in (rank, seed):
        try:
            if v not in (None, ""):
                return int(v)
        except (TypeError, ValueError):
            pass
    return None


def player_sets_vs(rows, recent_cut: str, player_id: int) -> list:
    """The player's sets 1-5 by opponent strength: [period, surface, tag,
    outcome W/L, {games: count}], tag 'above' (opponent ranked higher than
    the player), 'top5', 'top10', 'top20' - overlapping groups. Outcome
    MW / ML rows count the matches won / lost against them (as {0: n})."""
    h: dict = defaultdict(lambda: defaultdict(int))
    for r in rows:
        took: list = []
        got = match_sets(r["tour"], r["tourney_name"], r["surface"], r["best_of"], r["score"], took)
        if not got:
            continue
        me, opp = ("winner", "loser") if r["winner_id"] == player_id else ("loser", "winner")
        mine, theirs = _strength(r[f"{me}_rank"], r[f"{me}_seed"]), _strength(r[f"{opp}_rank"], r[f"{opp}_seed"])
        if theirs is None:
            continue
        tags = [t for t, n in (("top5", 5), ("top10", 10), ("top20", 20)) if theirs <= n]
        if mine is None or theirs < mine:
            tags.append("above")
        if not tags:
            continue
        won_match = me == "winner"
        periods = ["all", "12m"] if (r["play_date"] or "") > recent_cut else ["all"]
        for p in periods:                      # the matches themselves: outcome MW / ML, counted under 0 games
            for t in tags:
                h[(p, r["surface"] or "Unknown", t, "MW" if won_match else "ML")][0] += 1
        for i, (sn, g) in enumerate(got[2]):
            if i >= len(took):                 # the every / any rows
                break
            outcome = "W" if took[i] == won_match else "L"
            for p in periods:
                for t in tags:
                    h[(p, r["surface"] or "Unknown", t, outcome)][g] += 1
    return [[p, s, t, o, dict(c)] for (p, s, t, o), c in h.items()]


_lock = threading.Lock()
_cache: dict = {"key": None, "data": None}


def _build(db) -> dict:
    # main[(tour, surface, best_of, set)][games] = count; per[(tour, tourney)][(year, set)][games] = count
    main: dict = defaultdict(lambda: defaultdict(int))
    per: dict = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
    info: dict = defaultdict(lambda: {"matches": 0, "first": "9999", "last": "0000", "surfaces": defaultdict(int)})
    rows = db.execute(text("SELECT tour, tourney_name, surface, best_of, play_date, score FROM tennis_matches")).fetchall()
    # pairs[(tour, surface, best_of, first set n, games in set n, games in set n+1, same player won both, year)] = matches
    pairs: dict = defaultdict(int)
    for tour, tname, surface, best_of, play, score in rows:
        took: list = []
        got = match_sets(tour, tname, surface, best_of, score, took)
        if not got:
            continue
        canon, bo, keys = got
        surface = surface or "Unknown"
        year = (play or "")[:4]
        t = per[(tour, canon)]
        for sn, g in keys:
            main[(tour, surface, bo, sn)][g] += 1
            t[(year, sn)][g] += 1
        games = [g for sn, g in keys if sn.isdigit()]
        for i in range(min(2, len(games) - 1)):          # set 1 -> set 2, set 2 -> set 3
            pairs[(tour, surface, bo, i + 1, games[i], games[i + 1], int(took[i] == took[i + 1]), year)] += 1
        inf = info[(tour, canon)]
        inf["matches"] += 1
        inf["first"], inf["last"] = min(inf["first"], year), max(inf["last"], year)
        inf["surfaces"][surface] += 1
    return {"main": [[k[0], k[1], k[2], k[3], dict(h)] for k, h in main.items()],
            "pairs": pairs,
            "per": per,
            "tournaments": sorted(({"tour": k[0], "name": k[1], "matches": v["matches"], "first": v["first"],
                                    "last": v["last"], "surface": max(v["surfaces"], key=v["surfaces"].get)}
                                   for k, v in info.items()), key=lambda x: -x["matches"])}


def data(db) -> dict:
    key = tuple(db.execute(text("SELECT COUNT(*), MAX(play_date) FROM tennis_matches")).first())
    with _lock:
        if _cache["key"] != key:
            _cache["data"] = _build(db)
            _cache["key"] = key
        return _cache["data"]


def pairs(db, since: int = 0) -> tuple[list, list]:
    """Consecutive-set rows for matches played from `since` (a year; 0 =
    all): [tour, surface, best_of, first set, games, next set's games,
    same winner, matches] - years added together - and the years there are."""
    out: dict = defaultdict(int)
    years = set()
    for (*k, year), n in data(db)["pairs"].items():
        years.add(year)
        if year and int(year) >= since:
            out[tuple(k)] += n
    return [[*k, n] for k, n in out.items()], sorted(y for y in years if y)


def tournament(db, tour: str, name: str) -> list:
    """[year, set, {games: count}] for one tournament, every year."""
    per = data(db)["per"].get((tour, name), {})
    return [[y, sn, dict(h)] for (y, sn), h in sorted(per.items())]

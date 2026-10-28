"""Games-per-set statistics for Betting analytics (routers/tennis.py):
how often a set goes over a games line (over 8.5 = 9+ games), by set
number, tour, surface, best-of, and per tournament year by year.

Every completed set is counted as a histogram of its total games, so any
line (7.5, 8.5, 9.5...) is worked out from the same numbers. A set is
complete when someone reached 6 with a two-game lead, or won it 7-6 /
in a tie-break; the unfinished set of a retirement, walkovers and short
formats (Next Gen 4-game sets) are left out.

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


def sets_of(score: str) -> tuple[list[int], bool]:
    """Total games of each completed set, and whether the match was played
    out in full (no retirement / walkover / unfinished set)."""
    s = score or ""
    full = not re.search(r"RET|W/O|DEF|ABD|unfinished", s, re.I)
    out = []
    for m in _SET.finditer(s):
        a, b, tb = int(m.group(1)), int(m.group(2)), m.group(3)
        hi, lo = max(a, b), min(a, b)
        if hi >= 6 and (hi - lo >= 2 or tb or (hi == 7 and lo == 6) or (hi > 7 and hi - lo == 1)):
            out.append(min(a + b, MAX_GAMES))
        else:
            full = False
    return out, full and bool(out)


_lock = threading.Lock()
_cache: dict = {"key": None, "data": None}


def _build(db) -> dict:
    # main[(tour, surface, best_of, set)][games] = count; per[(tour, tourney)][(year, set)][games] = count
    main: dict = defaultdict(lambda: defaultdict(int))
    per: dict = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
    info: dict = defaultdict(lambda: {"matches": 0, "first": "9999", "last": "0000", "surfaces": defaultdict(int)})
    rows = db.execute(text("SELECT tour, tourney_name, surface, best_of, play_date, score FROM tennis_matches")).fetchall()
    for tour, tname, surface, best_of, play, score in rows:
        games, full = sets_of(score)
        if not games:
            continue
        surface = surface or "Unknown"
        bo = 5 if (best_of == 5 or len(games) > 3) else 3
        year = (play or "")[:4]
        canon = canonical(tour, tname)
        keys = [(str(i + 1), g) for i, g in enumerate(games)]
        if full:
            keys += [(EVERY, min(games)), (ANY, max(games))]
        t = per[(tour, canon)]
        for sn, g in keys:
            main[(tour, surface, bo, sn)][g] += 1
            t[(year, sn)][g] += 1
        inf = info[(tour, canon)]
        inf["matches"] += 1
        inf["first"], inf["last"] = min(inf["first"], year), max(inf["last"], year)
        inf["surfaces"][surface] += 1
    return {"main": [[k[0], k[1], k[2], k[3], dict(h)] for k, h in main.items()],
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


def tournament(db, tour: str, name: str) -> list:
    """[year, set, {games: count}] for one tournament, every year."""
    per = data(db)["per"].get((tour, name), {})
    return [[y, sn, dict(h)] for (y, sn), h in sorted(per.items())]

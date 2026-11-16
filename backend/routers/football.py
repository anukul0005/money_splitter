"""Football in the sports section: fixtures, live scores and results for the
top five leagues, the Champions League, the World Cup and the Euros, each
with our odds (football_model) and the bookmakers' where football-data.co.uk
has them; how backing the bookmakers' favourite has gone; league tables.
Data: football.py. (No consider / skip for football: on the closing prices
the model's suggestions lost at every threshold - see picks._football.)

For the same people as the other sports (routers.tennis.owner).
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import football as fb
import football_model as fm
from database import get_db
from models import User
from routers.tennis import owner

router = APIRouter(prefix="/football", tags=["football"])


def _names(db, m: dict) -> tuple[str, str | None, str | None, bool]:
    """(the model's competition, home, away, neutral ground) for a football-data.org match."""
    comp = m["comp"]
    if comp in fb.LEAGUES:
        code = fb.LEAGUES[comp][0]
        return code, fb.club_name(db, m["raw_home"], [code]), fb.club_name(db, m["raw_away"], [code]), False
    if comp == "CL":
        name = lambda t: fb.club_name(db, t, list(fb.CO_UK_OF)) or t.get("shortName") or t.get("name")
        return "CL", name(m["raw_home"]), name(m["raw_away"]), (m.get("stage") or "") == "FINAL"
    return "INTL", fb.nation_name(m["raw_home"].get("name")), fb.nation_name(m["raw_away"].get("name")), True


def _annotate(db, m: dict, books: dict, mine: dict, watch: set) -> dict:
    comp, h, a, neutral = _names(db, m)
    club_comp = comp if comp in fb.CO_UK_OF else None
    follows = lambda t: bool(t) and (((club_comp, t) in watch) or (comp == "CL" and any((c, t) in watch for c in fb.CO_UK_OF))
                                     or (comp == "INTL" and ("INTL", t) in watch))
    mod = None
    if h and a:
        if m["state"] == "finished":
            try:
                mod = fm.before(comp, date.fromisoformat(m["start"][:10]), h, a)
            except ValueError:
                mod = None
        mod = mod or (fm.predict(comp, h, a, neutral) if m["state"] != "finished" else None)
    out = {k: v for k, v in m.items() if not k.startswith("raw_")}
    out["model"] = mod
    out["mine"] = follows(h) or follows(a)
    book = books.get((comp, h, a)) if comp in fb.CO_UK_OF else None
    prices, src = None, None
    if book and all(book["avg"]):
        prices, src = [book["avg"][0], book["avg"][2], book["avg"][1]], "market average"   # home, away, draw
        out["book"] = {"avg": prices, "max": [book["max"][0], book["max"][2], book["max"][1]] if all(book["max"]) else None,
                       "source": "football-data.co.uk"}
    typed = mine.get(str(m["id"]))
    if typed and typed.odds_draw:
        prices, src = [typed.odds1, typed.odds2, typed.odds_draw], typed.book or "bookmaker"
    if typed:
        out["typed"] = {"prices": prices, "book": src}
    return out


@router.get("/live", response_model=dict)
def live(db: Session = Depends(get_db), caller: User = Depends(owner)):
    """Two days back to a week ahead across our competitions, by competition."""
    from models import BookOdds
    try:
        ms = fb.window(2, 7)
    except Exception as e:
        raise HTTPException(502, f"football-data.org didn't answer: {type(e).__name__}")
    try:
        books = fb.book_prices()
    except Exception:
        books = {}
    mine = {b.match_key: b for b in db.query(BookOdds).filter(BookOdds.sport == "football", BookOdds.voter_id == caller.id)}
    watch = {(c, t) for c, ts in _watch(db, caller.id).items() for t in ts}
    out = [_annotate(db, m, books, mine, watch) for m in ms if m["state"] != "off"]
    order = list(fb.COMPS)
    out.sort(key=lambda m: (m["start"] or "", order.index(m["comp"]) if m["comp"] in order else 99))
    return {"matches": out, "comps": fb.COMPS}


@router.get("/favourites", response_model=dict)
def favourites(stake: float = 100, db: Session = Depends(get_db), _: User = Depends(owner)):
    """Rs stake on the bookmakers' favourite in every top-five league match,
    at the market's closing average (football-data.co.uk): the last 30, 60
    and 90 days, overall and by league."""
    from datetime import timedelta
    from sqlalchemy import text
    stake = max(1.0, min(stake, 100000.0))
    names = {v[0]: v[1] for v in fb.LEAGUES.values()}
    rows = db.execute(text(
        "SELECT comp, day, home, away, home_goals, away_goals, avg_h, avg_d, avg_a FROM football_matches "
        "WHERE comp = ANY(:c) AND day >= :d AND avg_h IS NOT NULL AND avg_d IS NOT NULL AND avg_a IS NOT NULL"),
        {"c": list(names), "d": date.today() - timedelta(days=90)}).all()

    def rec(xs):
        n = len(xs)
        won = [x for x in xs if x["won"]]
        pl = sum(stake * (x["odds"] - 1) for x in won) - stake * (n - len(won))
        return {"bets": n, "won": len(won), "draws": sum(x["draw"] for x in xs), "pl": round(pl, 2),
                "roi": round(pl / (stake * n), 4) if n else None,
                "avg_odds": round(sum(x["odds"] for x in xs) / n, 2) if n else None}
    bets = []
    for comp, day, h, a, hg, ag, ah, ad, aa in rows:
        prices = {"H": ah, "D": ad, "A": aa}
        fav = min(prices, key=prices.get)
        res = "H" if hg > ag else "A" if ag > hg else "D"
        bets.append({"comp": comp, "day": day, "odds": prices[fav], "won": fav == res, "draw": res == "D",
                     "label": f"{h} v {a} {hg}-{ag}", "pick": {"H": h, "A": a, "D": "Draw"}[fav]})
    periods = []
    for n in (30, 60, 90):
        since = date.today() - timedelta(days=n)
        xs = [b for b in bets if b["day"] >= since]
        periods.append({"days": n, "since": since.isoformat(), **rec(xs),
                        "leagues": [{"comp": c, "name": names[c], **rec([b for b in xs if b["comp"] == c])} for c in names]})
    recent = sorted((b for b in bets if b["day"] >= date.today() - timedelta(days=30)), key=lambda b: b["day"], reverse=True)
    last = max((b["day"] for b in bets), default=None)
    return {"stake": stake, "periods": periods, "results_to": last.isoformat() if last else None,
            "recent": [{"day": b["day"].isoformat(), "league": names[b["comp"]], "match": b["label"], "pick": b["pick"],
                        "odds": b["odds"], "won": b["won"],
                        "pl": round(stake * (b["odds"] - 1), 2) if b["won"] else -stake} for b in recent[:120]]}


# -- My teams: the football "My teams" page ----------------------------------
# Each team I follow is either tracked (its results, nothing more) or one I bet
# on (counted in the P/L).

MODES = ("track", "bet")


class WatchIn(BaseModel):
    teams: dict[str, dict[str, str]]     # {"E0": {"Arsenal": "bet", "Chelsea": "track"}, "INTL": {"India": "track"}}


def _modes(db, user_id: int) -> dict[str, dict[str, str]]:
    from models import FootballWatch
    out: dict[str, dict[str, str]] = {}
    for w in db.query(FootballWatch).filter(FootballWatch.user_id == user_id).order_by(FootballWatch.team):
        out.setdefault(w.comp, {})[w.team] = w.mode or "track"
    return out


def _watch(db, user_id: int, mode: str | None = None) -> dict[str, list[str]]:
    """{comp: [team]} - every team I follow, or only those in `mode`."""
    return {c: [t for t, m in ts.items() if mode in (None, m)] for c, ts in _modes(db, user_id).items()}


def _options(db) -> dict:
    """What the questionnaire offers: each league's clubs this season, best
    placed first; national teams that have played since 2022, strongest
    first by our model (India always in)."""
    from collections import defaultdict
    from datetime import timedelta
    from sqlalchemy import text
    season = fb._season_code(fb.current_season_start())
    pts = defaultdict(lambda: [0, 0])
    for comp, h, a, hg, ag in db.execute(text(
            "SELECT comp, home, away, home_goals, away_goals FROM football_matches WHERE season = :s AND comp <> 'CL'"), {"s": season}):
        for side, gf, ga in ((h, hg, ag), (a, ag, hg)):
            r = pts[(comp, side)]
            r[0] += 3 if gf > ga else 1 if gf == ga else 0
            r[1] += gf - ga
    clubs = {}
    for code, name in ((v[0], v[1]) for v in fb.LEAGUES.values()):
        teams = [t for (c, t) in pts if c == code]
        clubs[code] = {"name": name, "teams": sorted(teams, key=lambda t: (-pts[(code, t)][0], -pts[(code, t)][1], t))}
    since = date.today() - timedelta(days=4 * 366)
    nations = {t for (t,) in db.execute(text(
        "SELECT home FROM football_matches WHERE comp = 'INTL' AND day >= :d UNION SELECT away FROM football_matches "
        "WHERE comp = 'INTL' AND day >= :d"), {"d": since})}
    pool = fm._state.get("nations")
    strength = (lambda t: pool.A.get(t, 0) + pool.D.get(t, 0)) if pool else (lambda t: 0)
    ranked = sorted(nations, key=lambda t: -strength(t))
    return {"clubs": clubs, "nations": ranked[:60] + (["India"] if "India" not in ranked[:60] else []),
            "all_nations": sorted(nations)}


@router.get("/watch", response_model=dict)
def get_watch(db: Session = Depends(get_db), caller: User = Depends(owner)):
    return {"teams": _modes(db, caller.id), "options": _options(db)}


@router.put("/watch", response_model=dict)
def put_watch(body: WatchIn, db: Session = Depends(get_db), caller: User = Depends(owner)):
    """Replace the teams I follow with these, each tracked or bet on."""
    from models import FootballWatch
    allowed = set(fb.CO_UK_OF) | {"INTL"}
    rows = {(c, t.strip()[:80]): (m if m in MODES else "track") for c, ts in body.teams.items() if c in allowed
            for t, m in list(ts.items())[:60] if t and t.strip()}
    db.query(FootballWatch).filter(FootballWatch.user_id == caller.id).delete()
    for (c, t), m in rows.items():
        db.add(FootballWatch(user_id=caller.id, comp=c, team=t, mode=m))
    db.commit()
    return {"teams": _modes(db, caller.id)}


@router.get("/watch/results", response_model=dict)
def watch_results(back: str = "mine", stake: float = 100, skip1: bool = False, close: float = 0.5,
                  skip2: bool = False, cap: float = 1.85, db: Session = Depends(get_db), caller: User = Depends(owner)):
    """The matches of the teams I bet on. Clubs: Rs stake a match at the
    market's closing average (the last price before kick-off), on my team
    (`back` mine; the better priced of two if both are mine) or the
    bookmakers' favourite (`back` fav) - the last 30 / 60 / 90 days and since
    2023/24. Bets can be skipped by pattern 1 - a close match, the two
    sides' win prices within `close` of each other - and, as a check, also
    when my team is priced `cap` (1.85) or more (`skip2`); what the skipped
    ones would have made is given beside.
    National teams: there are no free prices, so each team's won / drawn / lost."""
    from datetime import timedelta
    from sqlalchemy import text
    stake = max(1.0, min(stake, 100000.0))
    mine = _watch(db, caller.id, "bet")
    names = {v[0]: v[1] for v in fb.LEAGUES.values()}
    today = date.today()
    long_from = fm.CLUB_TEST
    bets = []
    for comp, day, h, a, hg, ag, ph, pd, pa in db.execute(text(
            "SELECT comp, day, home, away, home_goals, away_goals, avg_h, avg_d, avg_a FROM football_matches "
            "WHERE comp = ANY(:c) AND day >= :d AND avg_h IS NOT NULL AND avg_d IS NOT NULL AND avg_a IS NOT NULL ORDER BY day"),
            {"c": [c for c in names if mine.get(c)], "d": long_from}):
        sel = set(mine.get(comp, []))
        ours = [s for s, t in (("H", h), ("A", a)) if t in sel]
        if not ours:
            continue
        prices = {"H": ph, "D": pd, "A": pa}
        pick = min(ours, key=lambda s: prices[s]) if back == "mine" else min(prices, key=prices.get)
        res = "H" if hg > ag else "A" if ag > hg else "D"
        won = pick == res
        p1 = abs(ph - pa) <= close + 1e-9                      # pattern 1: too close to call
        p2 = pick != "D" and prices[pick] >= cap - 1e-9        # and my team priced cap (1.85) or more
        bets.append({"day": day, "comp": comp, "team": h if "H" in ours else a, "odds": prices[pick], "won": won,
                     "pl": round(stake * (prices[pick] - 1), 2) if won else -stake,
                     "pick": {"H": h, "A": a, "D": "Draw"}[pick], "match": f"{h} v {a} {hg}-{ag}",
                     "rival": prices["A" if pick == "H" else "H"], "p1": p1, "p2": p2,
                     "skip": (skip1 and p1) or (skip2 and p2)})

    def rec(xs):
        k = len(xs)
        pl = sum(x["pl"] for x in xs)
        return {"bets": k, "won": sum(x["won"] for x in xs), "pl": round(pl, 2), "roi": round(pl / (stake * k), 4) if k else None,
                "avg_odds": round(sum(x["odds"] for x in xs) / k, 2) if k else None}
    windows = [(f"{d} days", today - timedelta(days=d), d) for d in (30, 60, 90)] + [("Since 2023/24", long_from, None)]
    kept = [b for b in bets if not b["skip"]]
    clubs = [{"label": lbl, "days": d, **rec([b for b in kept if b["day"] >= s]),
              "all": rec([b for b in bets if b["day"] >= s]),
              "skipped": rec([b for b in bets if b["day"] >= s and b["skip"]]),
              "teams": sorted(({"team": t, **rec([b for b in kept if b["day"] >= s and b["team"] == t])}
                               for t in {b["team"] for b in kept if b["day"] >= s}), key=lambda x: -x["pl"])}
             for lbl, s, d in windows]

    nat = set(mine.get("INTL", []))
    games = []
    if nat:
        for day, h, a, hg, ag, tour in db.execute(text(
                "SELECT day, home, away, home_goals, away_goals, tournament FROM football_matches WHERE comp = 'INTL' "
                "AND day >= :d AND (home = ANY(:t) OR away = ANY(:t)) ORDER BY day"), {"d": today - timedelta(days=366), "t": list(nat)}):
            for t, gf, ga, opp in ((h, hg, ag, a), (a, ag, hg, h)):
                if t in nat:
                    games.append({"day": day, "team": t, "opp": opp, "gf": gf, "ga": ga, "tournament": tour,
                                  "res": "W" if gf > ga else "D" if gf == ga else "L"})

    def wdl(xs):
        return {"played": len(xs), "won": sum(x["res"] == "W" for x in xs), "drawn": sum(x["res"] == "D" for x in xs),
                "lost": sum(x["res"] == "L" for x in xs)}
    nations = [{"label": f"{d} days", "days": d, **wdl([g for g in games if g["day"] >= today - timedelta(days=d)])}
               for d in (30, 60, 90)] + [{"label": "Last 12 months", "days": 365, **wdl(games)}]
    recent = sorted((b for b in bets if b["day"] >= today - timedelta(days=90)), key=lambda b: b["day"], reverse=True)
    return {"back": back, "stake": stake, "skip1": skip1, "close": close, "skip2": skip2, "cap": cap,
            "teams": mine, "clubs": clubs, "nations": nations,
            "club_bets": [{**b, "day": b["day"].isoformat(), "league": names[b["comp"]]} for b in recent[:150]],
            "nation_games": [{**g, "day": g["day"].isoformat()} for g in sorted(games, key=lambda g: g["day"], reverse=True)[:60]]}


@router.get("/watch/feed", response_model=dict)
def watch_feed(db: Session = Depends(get_db), caller: User = Depends(owner)):
    """Each team I follow: its form (last five, any competition on file), its
    last results and its next match this week (with our odds and the
    bookmakers' where there are some)."""
    from datetime import timedelta
    from sqlalchemy import text
    modes = _modes(db, caller.id)
    if not modes:
        return {"teams": []}
    names = {v[0]: v[1] for v in fb.LEAGUES.values()}
    want = {t for ts in modes.values() for t in ts}
    since = date.today() - timedelta(days=240)
    games: dict[tuple, list] = {}
    for comp, day, h, a, hg, ag, tour in db.execute(text(
            "SELECT comp, day, home, away, home_goals, away_goals, tournament FROM football_matches "
            "WHERE day >= :d AND (home = ANY(:t) OR away = ANY(:t)) ORDER BY day DESC"), {"d": since, "t": list(want)}):
        for t, gf, ga, opp, at_home in ((h, hg, ag, a, True), (a, ag, hg, h, False)):
            for c, ts in modes.items():
                if t not in ts or (c == "INTL") != (comp == "INTL"):
                    continue
                if c != "INTL" and comp not in (c, "CL"):
                    continue
                games.setdefault((c, t), []).append({
                    "day": day.isoformat(), "opp": opp, "home": at_home, "gf": gf, "ga": ga,
                    "comp": names.get(comp) or ("Champions League" if comp == "CL" else tour),
                    "res": "W" if gf > ga else "D" if gf == ga else "L"})
    nxt: dict[tuple, dict] = {}
    try:
        ms = fb.window(2, 7)
        books = fb.book_prices()
    except Exception:
        ms, books = [], {}
    for m in ms:
        if m["state"] not in ("upcoming", "live"):
            continue
        comp, h, a, neutral = _names(db, m)
        for t, opp, at_home in ((h, a, True), (a, h, False)):
            for c, ts in modes.items():
                if t in ts and (c, t) not in nxt and ((c == "INTL") == (comp == "INTL")):
                    mod = fm.predict(comp, h, a, neutral) if h and a else None
                    bk = books.get((comp, h, a)) if comp in fb.CO_UK_OF else None
                    nxt[(c, t)] = {"start": m["start"], "state": m["state"], "opp": opp, "home": at_home,
                                   "comp": m.get("comp_name"), "probs": mod["probs"] if mod else None,
                                   "book": [bk["avg"][0], bk["avg"][2], bk["avg"][1]] if bk and all(bk["avg"]) else None}
    out = []
    for c, ts in modes.items():
        for t, mode in ts.items():
            g = games.get((c, t), [])
            out.append({"comp": c, "league": names.get(c, "National team"), "team": t, "mode": mode,
                        "form": [x["res"] for x in g[:5]], "last": g[:5], "next": nxt.get((c, t))})
    out.sort(key=lambda x: (x["mode"] != "bet", (x["next"] or {}).get("start") or "9", x["team"]))
    return {"teams": out}


@router.get("/table/{comp}", response_model=dict)
def table(comp: str, _: User = Depends(owner)):
    if comp not in fb.COMPS:
        raise HTTPException(404, "Not one of our competitions")
    try:
        return fb.standings(comp)
    except Exception as e:
        raise HTTPException(502, f"football-data.org didn't answer: {type(e).__name__}")


@router.get("/model", response_model=dict)
def model(db: Session = Depends(get_db), _: User = Depends(owner)):
    from sqlalchemy import text
    counts = {c: n for c, n in db.execute(text("SELECT comp, count(*) FROM football_matches GROUP BY comp"))}
    return {"record": fm.record(), "matches": counts, "sync": fb._sync}

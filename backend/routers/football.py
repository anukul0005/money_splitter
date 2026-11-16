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


def _annotate(db, m: dict, books: dict, mine: dict) -> dict:
    comp, h, a, neutral = _names(db, m)
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
    out = [_annotate(db, m, books, mine) for m in ms if m["state"] != "off"]
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


# -- Top teams only: where a side stood in its league on the day --------------

EARLY = 5            # until a side has played this many, last season's final place counts


def _ranked(db, since: date) -> list[dict]:
    """Top-five league matches from `since`, each with both sides' league
    places going into that day - from the season's results before it, or
    last season's final table while the season is young (a promoted side:
    the bottom). Never today's table: that would know who went on to win."""
    from collections import defaultdict
    from datetime import timedelta
    from sqlalchemy import text
    codes = [v[0] for v in fb.LEAGUES.values()]
    rows = db.execute(text(
        "SELECT comp, season, day, home, away, home_goals, away_goals, avg_h, avg_d, avg_a FROM football_matches "
        "WHERE comp = ANY(:c) AND day >= :d ORDER BY comp, season, day"), {"c": codes, "d": since - timedelta(days=430)}).all()
    out, final = [], {}
    by = defaultdict(list)
    for r in rows:
        by[(r.comp, r.season)].append(r)
    for (comp, season) in sorted(by, key=lambda k: (k[0], k[1])):
        ms = by[(comp, season)]
        prev = final.get((comp, f"{int(season[:2]) - 1:02d}{int(season[2:]) - 1:02d}"), {})
        t = defaultdict(lambda: [0, 0, 0, 0])               # points, goal difference, goals for, played
        order = lambda: sorted(t, key=lambda k: (-t[k][0], -t[k][1], -t[k][2], k))
        i = 0
        while i < len(ms):
            day = ms[i].day
            todays = [m for m in ms[i:] if m.day == day]
            i += len(todays)
            places = {k: n + 1 for n, k in enumerate(order())}
            size = max(len({m.home for m in ms} | {m.away for m in ms}), 18)

            def place(team):
                if t[team][3] >= EARLY:
                    return places[team]
                return prev.get(team, size)                  # promoted / new: the bottom
            for m in todays:
                if m.day >= since and m.avg_h and m.avg_d and m.avg_a:
                    out.append({"comp": comp, "day": m.day, "home": m.home, "away": m.away, "hg": m.home_goals,
                                "ag": m.away_goals, "prices": {"H": m.avg_h, "D": m.avg_d, "A": m.avg_a},
                                "rank": {"H": place(m.home), "A": place(m.away)}})
            for m in todays:
                for side, gf, ga in ((m.home, m.home_goals, m.away_goals), (m.away, m.away_goals, m.home_goals)):
                    r = t[side]
                    r[0] += 3 if gf > ga else 1 if gf == ga else 0
                    r[1] += gf - ga
                    r[2] += gf
                    r[3] += 1
        final[(comp, season)] = {k: n + 1 for n, k in enumerate(order())}
    return out


@router.get("/top-teams", response_model=dict)
def top_teams(n: int = 5, leagues: str = "", matches: str = "any", back: str = "top", venue: str = "all",
              stake: float = 100, db: Session = Depends(get_db), _: User = Depends(owner)):
    """Only the matches of each league's top `n` (by place on the day):
    `matches` any (a top side v anyone) / both (top v top) / rest (top v the
    rest); `back` the top side (the higher placed, if both are) or the
    bookmakers' favourite; `venue` all / home / away (where the top side
    plays). Rs stake a match at the market's closing average; the last 30,
    60 and 90 days and since 2023/24, overall and by league."""
    from datetime import timedelta
    n = max(1, min(n, 10))
    stake = max(1.0, min(stake, 100000.0))
    names = {v[0]: v[1] for v in fb.LEAGUES.values()}
    want = [c for c in leagues.split(",") if c in names] or list(names)
    long_from = fm.CLUB_TEST
    bets = []
    for m in _ranked(db, long_from):
        if m["comp"] not in want:
            continue
        top = {s for s in ("H", "A") if m["rank"][s] <= n}
        if not top or (matches == "both" and len(top) < 2) or (matches == "rest" and len(top) > 1):
            continue
        side = min(top, key=lambda s: m["rank"][s])         # the higher placed top side
        if venue in ("home", "away") and side != venue[0].upper():
            continue
        pick = side if back == "top" else min(m["prices"], key=m["prices"].get)
        res = "H" if m["hg"] > m["ag"] else "A" if m["ag"] > m["hg"] else "D"
        odds = m["prices"][pick]
        won = pick == res
        team = {"H": m["home"], "A": m["away"], "D": "Draw"}[pick]
        bets.append({"day": m["day"], "comp": m["comp"], "odds": odds, "won": won,
                     "pl": round(stake * (odds - 1), 2) if won else -stake,
                     "pick": team, "place": m["rank"].get(pick), "match": f"{m['home']} v {m['away']} {m['hg']}-{m['ag']}",
                     "places": [m["rank"]["H"], m["rank"]["A"]]})

    def rec(xs):
        k = len(xs)
        pl = sum(x["pl"] for x in xs)
        return {"bets": k, "won": sum(x["won"] for x in xs), "pl": round(pl, 2), "roi": round(pl / (stake * k), 4) if k else None,
                "avg_odds": round(sum(x["odds"] for x in xs) / k, 2) if k else None}

    def window(xs, since, label, days=None):
        ys = [x for x in xs if x["day"] >= since]
        return {"label": label, "days": days, "since": since.isoformat(), **rec(ys),
                "leagues": [{"comp": c, "name": names[c], **rec([y for y in ys if y["comp"] == c])} for c in want]}
    today = date.today()
    periods = [window(bets, today - timedelta(days=d), f"{d} days", d) for d in (30, 60, 90)]
    periods.append(window(bets, long_from, "Since 2023/24"))
    recent = sorted((b for b in bets if b["day"] >= today - timedelta(days=90)), key=lambda b: b["day"], reverse=True)[:150]
    return {"n": n, "leagues": want, "matches": matches, "back": back, "venue": venue, "stake": stake, "periods": periods,
            "recent": [{**b, "day": b["day"].isoformat(), "league": names[b["comp"]]} for b in recent]}


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

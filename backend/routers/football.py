"""Football in the sports section: fixtures, live scores and results for the
top five leagues, the Champions League, the World Cup and the Euros, each
with our odds (football_model), the bookmakers' where football-data.co.uk
has them, and consider / skip (suggest.py); league tables. Data: football.py.

For the same people as the other sports (routers.tennis.owner).
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

import football as fb
import football_model as fm
import suggest
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


def _annotate(db, m: dict, books: dict, mine: dict, edge: float) -> dict:
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
    if mod and m["state"] == "upcoming":
        v = suggest.verdict(mod["probs"], prices, edge)
        out["suggest"] = {**v, "names": [m["home"]["name"], m["away"]["name"]], "prices": prices,
                          "price_from": src, "three_way": True}
    return out


@router.get("/live", response_model=dict)
def live(edge: float = suggest.DEFAULT, db: Session = Depends(get_db), caller: User = Depends(owner)):
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
    edge = suggest.clamp_edge(edge)
    out = [_annotate(db, m, books, mine, edge) for m in ms if m["state"] != "off"]
    order = list(fb.COMPS)
    out.sort(key=lambda m: (m["start"] or "", order.index(m["comp"]) if m["comp"] in order else 99))
    return {"matches": out, "comps": fb.COMPS, "edge": edge}


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

"""The betting model's picks, recorded live - the real test after the backtest.

Every 20 minutes: each top-five league match in the next three days is
priced by football_ml. A side is a pick when it's the favourite and our
chance x price beats 1 (underdog value lost in testing, so it isn't
backed). Prices: football-data.co.uk's market average for the week (or
ESPN's sportsbook line until that file is out), and from three hours before
kick-off ESPN's line - with the starting XIs once they're out, so the model
with rotation decides. A pick that stops
being value before kick-off is dropped; at kick-off it's frozen.

Settled from our results at Rs 100: at the closing average once the weekly
file brings it (as the backtest was), else at the price it was picked at.
"""
from __future__ import annotations

import time
from datetime import date, datetime, timedelta, timezone

import football as fb

AHEAD_DAYS = 3
ESPN_WINDOW = timedelta(hours=3)
status = {"last": None, "priced": 0, "picks": 0, "settled": 0}


def _upcoming(db) -> list[dict]:
    """League matches to come in the next AHEAD_DAYS, with our names."""
    out = []
    now = datetime.now(timezone.utc)
    for m in fb.window(0, AHEAD_DAYS):
        if m["state"] != "upcoming" or m["comp"] not in fb.LEAGUES or not m.get("start"):
            continue
        ko = datetime.fromisoformat(m["start"].replace("Z", "+00:00"))
        if ko <= now:
            continue
        code = fb.LEAGUES[m["comp"]][0]
        h, a = fb.club_name(db, m["raw_home"], [code]), fb.club_name(db, m["raw_away"], [code])
        if h and a:
            out.append({"comp": m["comp"], "code": code, "kickoff": ko, "home": h, "away": a,
                        "names": ([m["home"].get("full") or "", m["home"].get("name") or ""],
                                  [m["away"].get("full") or "", m["away"].get("name") or ""])})
    return out


def _espn(m: dict, full: bool) -> tuple[tuple | None, list | None, list | None]:
    """ESPN's sportsbook prices - and, close to kick-off (`full`), both XIs (ids)."""
    import football_match as fmc
    ev = fmc.find_event(m["comp"], m["kickoff"].date(), *m["names"])
    if not ev:
        return None, None, None
    if not full:                      # far from kick-off: the price alone, one request
        o = fmc._prices(fmc._summary(ev, 1800))
        return ((o["home"], o["draw"], o["away"]) if o else None), None, None
    c = fmc.centre(ev, m["comp"])
    o = c.get("espn_odds")
    trio = (o["home"], o["draw"], o["away"]) if o else None
    xi = lambda s: [p["id"] for p in ((c["lineups"].get(s) or {}).get("starters") or [])] or None
    return trio, xi("home"), xi("away")


def record(db) -> int:
    """Price the coming matches and keep the value picks up to date."""
    from sqlalchemy import text
    from sqlalchemy.dialects.postgresql import insert
    import football_ml
    from models import FootballModelPick
    if not football_ml.state.get("built"):
        return 0
    now = datetime.now(timezone.utc)
    db.execute(text("UPDATE football_model_picks SET decided = TRUE WHERE NOT decided AND kickoff <= :n"), {"n": now})
    db.commit()
    try:
        books = fb.book_prices()
    except Exception:
        books = {}
    n = 0
    for m in _upcoming(db):
        trio, src, xh, xa = None, None, None, None
        near = m["kickoff"] - now <= ESPN_WINDOW
        if near:
            try:
                trio, xh, xa = _espn(m, True)
                src = "ESPN sportsbook" if trio else None
            except Exception:
                trio = None
        if not trio:
            bk = books.get((m["code"], m["home"], m["away"]))
            if bk and all(bk["avg"]):
                trio, src = tuple(bk["avg"]), "market average"
        if not trio and not near:             # the week's file isn't out yet: ESPN's line
            try:
                trio = _espn(m, False)[0]
                src = "ESPN sportsbook" if trio else None
            except Exception:
                trio = None
        if not trio:
            continue
        r = football_ml.predict(m["code"], m["home"], m["away"], trio, m["kickoff"].date(), xh, xa)
        status["priced"] += 1
        if not r:
            continue
        for side in ("home", "away"):
            x = r["sides"][side]
            other = r["sides"]["away" if side == "home" else "home"]
            key = {"comp": m["code"], "day": m["kickoff"].date(), "home": m["home"], "away": m["away"], "side": side}
            if x["bet"] and x["odds"] <= other["odds"]:
                row = {**key, "kickoff": m["kickoff"], "team": x["team"], "odds": x["odds"], "price_src": src,
                       "p_model": x["p"], "p_market": x["market"], "ev": x["ev"], "model": r["model"], "flagged_at": now}
                st = insert(FootballModelPick).values(row)
                upd = {k: st.excluded[k] for k in ("kickoff", "odds", "price_src", "p_model", "p_market", "ev", "model", "flagged_at")}
                db.execute(st.on_conflict_do_update(constraint="ux_football_model_picks", set_=upd,
                                                    where=(FootballModelPick.decided.is_(False))))
                n += 1
            else:                                  # no longer value: drop it while it can still change
                db.execute(text("DELETE FROM football_model_picks WHERE NOT decided AND comp = :comp AND day = :day "
                                "AND home = :home AND away = :away AND side = :side"), key)
        db.commit()
    status["picks"] = n
    return n


def settle(db) -> int:
    """Results (and closing prices, when they come) for the frozen picks."""
    from sqlalchemy import text
    k = 0
    for pid, comp, day, home, away, side, odds, close in db.execute(text(
            "SELECT id, comp, day, home, away, side, odds, close_odds FROM football_model_picks "
            "WHERE decided AND (result IS NULL OR close_odds IS NULL) AND kickoff < now() - interval '2 hours'")).fetchall():
        row = db.execute(text(
            "SELECT home_goals, away_goals, avg_h, avg_a FROM football_matches WHERE comp = :c AND home = :h AND away = :a "
            "AND day BETWEEN :d0 AND :d1 ORDER BY (avg_h IS NULL) LIMIT 1"),
            {"c": comp, "h": home, "a": away, "d0": day - timedelta(days=1), "d1": day + timedelta(days=1)}).first()
        if not row:
            continue
        gf, ga = (row[0], row[1]) if side == "home" else (row[1], row[0])
        res = "W" if gf > ga else "D" if gf == ga else "L"
        closing = (row[2] if side == "home" else row[3]) or None
        price = closing or odds
        pl = round(100 * (price - 1), 2) if res == "W" else -100.0
        db.execute(text("UPDATE football_model_picks SET result = :r, close_odds = :c, pl = :pl, score = :s WHERE id = :i"),
                   {"r": res, "c": closing, "pl": pl, "s": f"{row[0]}-{row[1]}", "i": pid})
        k += 1
    db.commit()
    status["settled"] += k
    return k


def loop() -> None:
    from database import get_session_factory
    time.sleep(420)
    while True:
        try:
            db = get_session_factory()()
            try:
                record(db)
                settle(db)
                status["last"] = time.strftime("%Y-%m-%d %H:%M")
            finally:
                db.close()
        except Exception as e:
            print(f"[football-picks] {type(e).__name__}: {e}", flush=True)
        time.sleep(20 * 60)


def report(db, stake: float = 100) -> dict:
    """The live record: settled picks, those still to come, and the totals."""
    from sqlalchemy import text
    rows = [dict(r._mapping) for r in db.execute(text(
        "SELECT comp, day, kickoff, home, away, side, team, odds, price_src, p_model, p_market, ev, model, decided, "
        "result, close_odds, pl, score FROM football_model_picks ORDER BY kickoff DESC"))]
    k = stake / 100
    for r in rows:
        r["opp"] = r["away"] if r["side"] == "home" else r["home"]
        r["pl"] = round(r["pl"] * k, 2) if r["pl"] is not None else None
        r["kickoff"] = r["kickoff"].isoformat()
        r["day"] = r["day"].isoformat()
    done = [r for r in rows if r["result"]]

    def tot(xs):
        pl = sum(x["pl"] for x in xs)
        return {"bets": len(xs), "won": sum(x["result"] == "W" for x in xs), "pl": round(pl, 2),
                "roi": round(pl / (stake * len(xs)), 4) if xs else None,
                "avg_odds": round(sum((x["close_odds"] or x["odds"]) for x in xs) / len(xs), 2) if xs else None}
    cut = (date.today() - timedelta(days=30)).isoformat()
    return {"since": min((r["day"] for r in rows), default=None), "all": tot(done), "d30": tot([r for r in done if r["day"] >= cut]),
            "settled": done, "pending": [r for r in rows if not r["result"]], "status": status}

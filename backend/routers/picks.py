"""My picks for badminton and hockey (models.SportPick): who wins a match,
picked on the Live tab before it starts, with the price I got if I typed
one in - My picks settles them as mock bets. Tennis picks are routers/tennis
(they have bookmaker prices of their own).

For the same people as tennis (routers.tennis.owner).
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import BadmintonResult, BookOdds, SportPick, User
from routers.tennis import owner

router = APIRouter(prefix="/picks", tags=["picks"])
SPORTS = ("badminton", "hockey")
BOOK_SPORTS = SPORTS + ("football",)   # football: prices typed in (picks there come later)
IST = timezone(timedelta(hours=5, minutes=30))


def _aware(s, tz=timezone.utc) -> datetime | None:
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=tz)


def _badminton_names(side: dict) -> str:
    return " / ".join(p.get("name") or "TBD" for p in side.get("players") or [])


def _find(sport: str, key: str) -> dict | None:
    """The match on the Live tab now: {start, names [1, 2], label, ref, state}."""
    if sport == "badminton":
        import badminton as bwf
        for t in bwf.live().get("tournaments", []):
            for m in t.get("matches", []):
                if str(m.get("id")) == key:
                    return {"start": _aware(m.get("time_utc")), "state": m.get("state"),
                            "names": [_badminton_names(m["side1"]), _badminton_names(m["side2"])],
                            "label": f"{t.get('name')} · {m.get('event') or ''}".strip(" ·"),
                            "ref": {"id": m.get("id"), "tournament_id": m.get("tournament_id"), "code": m.get("code")}}
    elif sport == "football":
        import football as fb
        for m in fb.window(2, 7):
            if str(m["id"]) == key:
                state = {"live": "live", "finished": "finished"}.get(m["state"], "upcoming")
                return {"start": _aware(m.get("start")), "state": state, "names": [m["home"]["name"], m["away"]["name"]],
                        "label": " · ".join(str(x) for x in (m.get("comp_name"), m.get("matchday") and f"matchday {m['matchday']}") if x),
                        "ref": {"id": m["id"], "comp": m.get("comp")}}
    else:
        import hockey as fih
        for t in fih.live().get("tournaments", []):
            for m in t.get("matches", []):
                if str(m.get("id")) == key:
                    return {"start": _aware(m.get("start"), IST), "state": m.get("state"),
                            "names": [m["home"]["name"], m["away"]["name"]],
                            "label": " · ".join(x for x in (t.get("name"), m.get("round")) if x),
                            "ref": {"id": m["id"], "series_id": m.get("series_id")}}
    return None


class PickIn(BaseModel):
    sport: str
    key: str
    side: int | None = None          # 1 or 2; leave out to change only the odds
    odds: float | None = None


def _row(p: SportPick) -> dict:
    return {"sport": p.sport, "key": p.match_key, "side": p.side, "pick": p.pick_name, "other": p.other_name,
            "odds": p.odds, "start": p.start.isoformat(), "label": p.label}


@router.get("/mine", response_model=dict)
def mine(sport: str, db: Session = Depends(get_db), caller: User = Depends(owner)):
    """My picks from the last two days on, by match - the Live tab marks them."""
    since = datetime.now(timezone.utc) - timedelta(days=2)
    rows = db.query(SportPick).filter(SportPick.sport == sport, SportPick.voter_id == caller.id,
                                      SportPick.start >= since).all()
    return {"picks": {p.match_key: _row(p) for p in rows}}


@router.post("", response_model=dict)
def pick(body: PickIn, db: Session = Depends(get_db), caller: User = Depends(owner)):
    """Picks (or changes) the winner and/or the price, until the match starts."""
    if body.sport not in SPORTS:
        raise HTTPException(400, "Unknown sport")
    if body.odds is not None and not (1.01 <= body.odds <= 1000):
        raise HTTPException(400, "Odds are decimal, like 1.85")
    m = _find(body.sport, body.key)
    if not m or m["state"] != "upcoming" or not m["start"] or m["start"] <= datetime.now(timezone.utc):
        raise HTTPException(409, "Picking closed - the match has started")
    p = db.query(SportPick).filter_by(sport=body.sport, match_key=body.key, voter_id=caller.id).first()
    if not p:
        if body.side not in (1, 2):
            raise HTTPException(400, "Pick a side first")
        p = SportPick(sport=body.sport, match_key=body.key, voter_id=caller.id)
        db.add(p)
    if body.side in (1, 2):
        p.side = body.side
    p.pick_name, p.other_name = m["names"][p.side - 1], m["names"][2 - p.side]
    p.start, p.label, p.ref = m["start"], m["label"], json.dumps(m["ref"])
    if body.odds is not None:
        p.odds = round(body.odds, 2)
    db.commit()
    return _row(p)


def _result(p: SportPick, db: Session) -> tuple[str, str | None]:
    """(won / lost / void / pending, score)."""
    ref = json.loads(p.ref or "{}")
    if p.sport == "badminton":
        r = db.get(BadmintonResult, int(ref.get("id") or 0))
        if not r or r.status != "F":
            return "pending", None
        if not r.winner or r.score_status == 1:                # no result, or a walkover
            return "void", r.score
        return ("won" if r.winner == p.side else "lost"), r.score
    import hockey as fih
    try:
        ms = fih.matches(int(ref.get("series_id") or 0))
    except Exception:
        return "pending", None
    m = next((x for x in ms if x["id"] == ref.get("id")), None)
    if not m or m["state"] != "finished":
        return "pending", None
    score = f"{m['home']['goals']}-{m['away']['goals']}" + (f" ({m['home']['so']}-{m['away']['so']} SO)" if m["home"]["so"] is not None else "")
    if not m["winner"]:
        return "void", score                                  # a draw: no winner to have picked
    return ("won" if m["winner"] == p.side else "lost"), score


@router.get("/history", response_model=dict)
def history(sport: str, db: Session = Depends(get_db), caller: User = Depends(owner)):
    """Every pick I've made in a sport, newest first, with how it went."""
    rows = db.query(SportPick).filter(SportPick.sport == sport, SportPick.voter_id == caller.id) \
        .order_by(SportPick.start.desc()).all()
    books = {b.match_key: b for b in db.query(BookOdds).filter(BookOdds.sport == sport, BookOdds.voter_id == caller.id).all()}
    out = []
    for p in rows:
        status, score = _result(p, db) if p.start <= datetime.now(timezone.utc) else ("pending", None)
        row = {**_row(p), "status": status, "score": score, "tournament": p.label, "other_odds": None, "odds_source": "mine" if p.odds else None}
        b = books.get(p.match_key)
        if b:                                 # the bookmaker's prices I typed in for the match
            row["book"] = b.book
            row["book_odds"] = b.odds1 if p.side == 1 else b.odds2
            row["other_odds"] = b.odds2 if p.side == 1 else b.odds1
            if not p.odds:
                row["odds"], row["odds_source"] = row["book_odds"], "book"
        if p.sport == "hockey" and not row["odds"]:
            try:
                import hockey_model as hm
                m = hm.before(json.loads(p.ref or "{}").get("id"))
            except ImportError:
                m = None
            if m:
                row["model_odds"] = m["odds"][p.side - 1]
                row["odds"], row["odds_source"] = row["model_odds"], "model"
        if p.sport == "badminton":            # our model's price from before the start, where I typed none
            import badminton_model as bm
            m = bm.before(int(json.loads(p.ref or "{}").get("id") or 0))
            if m:
                row["model_odds"] = m["odds"][p.side - 1]
                if not b:
                    row["other_odds"] = m["odds"][2 - p.side]
                if not row["odds"]:
                    row["odds"], row["odds_source"] = row["model_odds"], "model"
        out.append(row)
    return {"picks": out}


# -- A bookmaker's prices, typed in by hand ----------------------------------

class BookIn(BaseModel):
    sport: str
    key: str
    odds1: float
    odds2: float
    odds_draw: float | None = None
    book: str | None = None


def _book_row(b: BookOdds) -> dict:
    late = bool(b.start and b.entered_at > b.start)
    return {"key": b.match_key, "book": b.book, "odds": [b.odds1, b.odds2], "draw": b.odds_draw, "names": json.loads(b.names or "[]"),
            "margin": round(1 / b.odds1 + 1 / b.odds2 + (1 / b.odds_draw if b.odds_draw else 0) - 1, 4), "start": b.start.isoformat() if b.start else None,
            "entered_at": b.entered_at.isoformat(), "late": late, "label": b.label}


@router.get("/book", response_model=dict)
def books(sport: str, db: Session = Depends(get_db), caller: User = Depends(owner)):
    """The prices I've typed in from the last few days on, by match."""
    since = datetime.now(timezone.utc) - timedelta(days=4)
    rows = db.query(BookOdds).filter(BookOdds.sport == sport, BookOdds.voter_id == caller.id,
                                     (BookOdds.start >= since) | (BookOdds.entered_at >= since)).all()
    return {"books": {b.match_key: _book_row(b) for b in rows}}


@router.post("/book", response_model=dict)
def book(body: BookIn, db: Session = Depends(get_db), caller: User = Depends(owner)):
    """Both sides' prices from a bookmaker, for a match on the Live tab that isn't over."""
    if body.sport not in BOOK_SPORTS:
        raise HTTPException(400, "Unknown sport")
    if not (1.01 <= body.odds1 <= 1000 and 1.01 <= body.odds2 <= 1000):
        raise HTTPException(400, "Odds are decimal, like 1.85")
    if body.odds_draw is not None and not (1.01 <= body.odds_draw <= 1000):
        raise HTTPException(400, "Odds are decimal, like 1.85")
    total = 1 / body.odds1 + 1 / body.odds2 + (1 / body.odds_draw if body.odds_draw else 0)
    if total < 0.98:
        raise HTTPException(400, "Those prices can't all be right - check them")
    m = _find(body.sport, body.key)
    if not m or m["state"] == "finished":
        raise HTTPException(409, "Only for a match on the Live tab that isn't over")
    b = db.query(BookOdds).filter_by(sport=body.sport, match_key=body.key, voter_id=caller.id).first()
    if not b:
        b = BookOdds(sport=body.sport, match_key=body.key, voter_id=caller.id)
        db.add(b)
    b.odds1, b.odds2 = round(body.odds1, 3), round(body.odds2, 3)
    b.odds_draw = round(body.odds_draw, 3) if body.odds_draw and body.sport in ("hockey", "football") else None
    b.book = (body.book or "").strip()[:30] or None
    b.names, b.label, b.start, b.ref = json.dumps(m["names"]), m["label"], m["start"], json.dumps(m["ref"])
    b.entered_at = datetime.now(timezone.utc)
    db.commit()
    return _book_row(b)


@router.get("/book/compare", response_model=dict)
def compare(sport: str, db: Session = Depends(get_db), caller: User = Depends(owner)):
    """Played matches I typed a bookmaker's prices in for (before the start):
    how close the bookmaker (margin taken out), our model and the two averaged
    came - Brier score, lower is better - and the margin the bookmaker took."""
    import math
    import badminton_model as bm
    rows = db.query(BookOdds).filter(BookOdds.sport == sport, BookOdds.voter_id == caller.id) \
        .order_by(BookOdds.start.desc()).all()
    items, late = [], 0
    for b in rows:
        if sport != "badminton":
            continue
        if b.start and b.entered_at > b.start:
            late += 1
            continue
        ref = json.loads(b.ref or "{}")
        r = db.get(BadmintonResult, int(ref.get("id") or 0))
        if not r or r.status != "F" or not r.winner or r.score_status == 1:
            continue
        ours = bm.before(r.id)
        if not ours:
            continue
        i1, i2 = 1 / b.odds1, 1 / b.odds2
        pb, pm = i1 / (i1 + i2), ours["p1"]
        items.append({"key": b.match_key, "names": json.loads(b.names or "[]"), "label": b.label, "book": b.book,
                      "start": b.start.isoformat() if b.start else None, "winner": r.winner, "score": r.score,
                      "book_p1": round(pb, 3), "our_p1": pm, "blend_p1": round((pb + pm) / 2, 3),
                      "margin": round(i1 + i2 - 1, 4), "odds": [b.odds1, b.odds2], "our_odds": ours["odds"]})

    def score(k):
        if not items:
            return None
        ys = [(1 if x["winner"] == 1 else 0, x[k]) for x in items]
        return {"brier": round(sum((p - y) ** 2 for y, p in ys) / len(ys), 4),
                "log_loss": round(-sum(math.log(max(p if y else 1 - p, 1e-4)) for y, p in ys) / len(ys), 4),
                "right": round(sum((p > 0.5) == (y == 1) for y, p in ys) / len(ys), 3)}
    return {"matches": len(items), "late": late, "book": score("book_p1"), "ours": score("our_p1"),
            "blend": score("blend_p1"),
            "margin": round(sum(x["margin"] for x in items) / len(items), 4) if items else None,
            "items": items[:100]}


# -- P/L dashboard: my picks, plus a flat stake on every other played match ---

def _settle(odds, status, stake):
    if status == "won" and odds:
        return round(stake * (odds - 1), 2)
    if status == "lost" and odds:
        return -stake
    return None


@router.get("/backtest", response_model=dict)
def backtest(days: int = 30, stake: float = 100, edge: float = 0.20, db: Session = Depends(get_db), caller: User = Depends(owner)):
    """The last `days` across the sports, at `stake` a bet. My own picks count
    as recorded (their prices as My picks settles them). Every other played
    match gets `stake` on the favourite: tennis at the bookmakers' kept
    pre-match price (median), badminton at our model's pre-match price - and,
    to be fair to a real bookmaker, that price with an 8% margin too. Hockey
    has no price but the ones I typed, so only my picks."""
    from sqlalchemy import text
    import badminton_model as bm
    import tennis_odds
    from routers.tennis import my_pick_history
    days = max(1, min(days, 120))
    stake = max(1.0, min(stake, 100000.0))
    now = datetime.now(timezone.utc)
    since = (now - timedelta(days=days)).date()
    out = {}

    # tennis
    mine = [p for p in my_pick_history(db=db, caller=caller)["picks"] if p["start"][:10] >= since.isoformat()]
    taken = {p["match_id"] for p in mine if p.get("match_id")}
    bets = [{"date": p["start"][:10], "label": p.get("tournament") or p["tour"], "pick": p["pick"], "other": p["other"],
             "odds": p["odds"], "status": p["status"], "kind": "mine"} for p in mine]
    no_price = 0
    for r in db.execute(text("SELECT match_id, tour, winner_name, loser_name, score, play_date, tourney_name, round "
                             "FROM tennis_matches WHERE play_date >= :s ORDER BY play_date"), {"s": since.isoformat()}).mappings():
        if r["match_id"] in taken:
            continue
        sc = (r["score"] or "").upper()
        if "W/O" in sc or sc.strip() in ("WO", "W.O."):
            continue
        k = tennis_odds.kept(db, r["tour"], r["winner_name"], r["loser_name"], date_of(r["play_date"]))
        prices = (k or {}).get("prices") or {}
        w, l = tennis_odds._surname(r["winner_name"]), tennis_odds._surname(r["loser_name"])
        pw, pl_ = (prices.get(w) or {}).get("median"), (prices.get(l) or {}).get("median")
        if not pw or not pl_:
            no_price += 1
            continue
        fav_won = pw <= pl_
        bets.append({"date": r["play_date"][:10], "label": f"{r['tourney_name']} · {r['round']}",
                     "pick": r["winner_name"] if fav_won else r["loser_name"],
                     "other": r["loser_name"] if fav_won else r["winner_name"],
                     "odds": pw if fav_won else pl_, "status": "won" if fav_won else "lost", "kind": "auto"})
    sugg = _tennis_suggested(db, since, edge)
    out["tennis"] = _summary(bets, stake, {"no_price": no_price,
                                           "auto_rule": "the bookmakers' favourite at their median pre-match price",
                                           "priced_from": _first_kept(db)})
    out["tennis"]["suggested"] = _summary(sugg, stake, {})

    # badminton
    hist = [p for p in history(sport="badminton", db=db, caller=caller)["picks"] if p["start"][:10] >= since.isoformat()]
    taken = {int(json.loads(sp.ref or "{}").get("id") or 0) for sp in db.query(SportPick).filter(
        SportPick.sport == "badminton", SportPick.voter_id == caller.id).all()}
    bets = [{"date": p["start"][:10], "label": p.get("tournament"), "pick": p["pick"], "other": p["other"],
             "odds": p["odds"], "status": p["status"], "kind": "mine", "source": p.get("odds_source")} for p in hist]
    from models import BadmintonPlayer, BadmintonTournament
    rows = db.query(BadmintonResult).filter(BadmintonResult.day >= since, BadmintonResult.winner > 0,
                                            BadmintonResult.status == "F").order_by(BadmintonResult.day).all()
    ids = {i for r in rows for i in (r.p1a, r.p1b, r.p2a, r.p2b) if i}
    names = {p.id: p.name for p in db.query(BadmintonPlayer).filter(BadmintonPlayer.id.in_(ids)).all()} if ids else {}
    tn = {t.id: t.name for t in db.query(BadmintonTournament).filter(
        BadmintonTournament.id.in_({r.tournament_id for r in rows})).all()} if rows else {}
    side = lambda a, b: " / ".join(names.get(i, "?") for i in (a, b) if i)
    no_price = 0
    every = []                                           # every played match, for the chance analysis
    for r in rows:
        if r.score_status == 1:                          # a walkover (void)
            continue
        m = bm.before(r.id)
        if m:
            fp = max(m["p1"], 1 - m["p1"])
            every.append({"p": fp, "won": r.winner == (1 if m["p1"] >= 0.5 else 2), "event": r.event})
        if r.id in taken:                                # mine: counted as recorded
            continue
        if not m:
            no_price += 1
            continue
        fav = 1 if m["p1"] >= 0.5 else 2
        p = m["p1"] if fav == 1 else 1 - m["p1"]
        bets.append({"date": r.day.isoformat(), "label": f"{tn.get(r.tournament_id, '?')} · {r.event} {r.round or ''}".strip(),
                     "pick": side(r.p1a, r.p1b) if fav == 1 else side(r.p2a, r.p2b),
                     "other": side(r.p2a, r.p2b) if fav == 1 else side(r.p1a, r.p1b),
                     "odds": m["odds"][fav - 1], "book_odds": round(1 / (p * 1.08), 2),
                     "status": "won" if r.winner == fav else "lost", "kind": "auto"})
    s = _summary(bets, stake, {"no_price": no_price, "auto_rule": "our model's favourite at our pre-match price"})
    auto = [b for b in bets if b["kind"] == "auto"]
    s["at_book_margin"] = round(sum(_settle(b["book_odds"], b["status"], stake) for b in auto), 2) if auto else 0
    s["chance"] = _chance_stats(every, stake, bm.record())
    out["badminton"] = s
    s["suggested"] = _summary(_book_suggested(db, caller, "badminton", since, edge), stake, {})

    # hockey - my picks only
    hist = [p for p in history(sport="hockey", db=db, caller=caller)["picks"] if p["start"][:10] >= since.isoformat()]
    bets = [{"date": p["start"][:10], "label": p.get("tournament"), "pick": p["pick"], "other": p["other"],
             "odds": p["odds"], "status": p["status"], "kind": "mine"} for p in hist]
    out["hockey"] = _summary(bets, stake, {"auto_rule": None})
    out["hockey"]["suggested"] = _summary(_book_suggested(db, caller, "hockey", since, edge), stake, {})

    # football - no picks yet: the favourite and the suggested bets at the market's closing average
    out["football"] = _football(db, since, stake, edge)

    allb = [dict(b, sport=k) for k, v in out.items() for b in v.pop("_bets")]
    total = _summary(allb, stake, {})
    total.pop("_bets")
    sb = [dict(b, sport=k) for k, v in out.items() for b in v["suggested"].pop("_bets")]
    total["suggested"] = _summary(sb, stake, {})
    total["suggested"].pop("_bets")
    import suggest
    return {"days": days, "stake": stake, "edge": suggest.clamp_edge(edge), "since": since.isoformat(),
            "total": total, "sports": out}


BOOK_MARGIN = 0.08


def _chance_stats(every, stake, rec) -> dict:
    """Badminton without bookmakers' prices: ₹stake on our favourite in every
    played match, grouped by how sure we were. Settled at our fair price
    (1 / our chance) and at the price a bookmaker who agreed with us would
    offer after its ~8% margin. Break-even = the lowest price that would have
    paid on what actually came in."""
    def agg(xs):
        n = len(xs)
        if not n:
            return {"bets": 0}
        w = sum(x["won"] for x in xs)
        fair = sum(stake * (1 / x["p"] - 1) if x["won"] else -stake for x in xs)
        book = sum(stake * (1 / (x["p"] * (1 + BOOK_MARGIN)) - 1) if x["won"] else -stake for x in xs)
        return {"bets": n, "won": w, "said": round(sum(x["p"] for x in xs) / n, 3), "came_in": round(w / n, 3),
                "pl_fair": round(fair, 2), "pl_book": round(book, 2), "roi_book": round(book / (n * stake), 4),
                "break_even": round(n / w, 2) if w else None}
    bands = [dict(agg([x for x in every if lo / 100 <= x["p"] < hi / 100]), **{"from": lo, "to": hi})
             for lo, hi in ((50, 60), (60, 70), (70, 80), (80, 90), (90, 101))]
    at_least = [dict(agg([x for x in every if x["p"] >= lo / 100]), **{"from": lo}) for lo in (50, 60, 70, 80, 90)]
    names = {"MS": "Men's singles", "WS": "Women's singles", "MD": "Men's doubles", "WD": "Women's doubles", "XD": "Mixed doubles"}
    events = [dict(agg([x for x in every if x["event"] == e]), event=e, name=n) for e, n in names.items()]
    return {"margin": BOOK_MARGIN, "all": agg(every), "bands": bands, "at_least": at_least,
            "events": [e for e in events if e["bets"]],
            "long": (rec or {}).get("bands"), "long_since": (rec or {}).get("since"), "long_matches": (rec or {}).get("matches")}


def _football(db, since, stake, edge) -> dict:
    """Top-five league matches played since `since`, settled at the market's
    closing average (football-data.co.uk): Rs stake on the bookmakers'
    favourite every match, and - as its own line - the bets the rule would
    have made, our pre-match chance (football_model, from before the match)
    against that price. Also each threshold's record over the period and
    since 2023/24, for picking one."""
    from sqlalchemy import text
    import football as fb
    import football_model as fm
    import suggest
    names = {v[0]: v[1] for v in fb.LEAGUES.values()}

    def bets_from(day0, edge_):
        auto, sugg = [], []
        for comp, day, h, a, hg, ag, ah, ad, aa in db.execute(text(
                "SELECT comp, day, home, away, home_goals, away_goals, avg_h, avg_d, avg_a FROM football_matches "
                "WHERE comp = ANY(:c) AND day >= :d AND avg_h IS NOT NULL ORDER BY day"), {"c": list(names), "d": day0}):
            res = 1 if hg > ag else 2 if ag > hg else 3                 # home, away, draw
            prices = [ah, aa, ad]
            label = f"{names[comp]} · {h} v {a} {hg}-{ag}"
            side_name = lambda k: h if k == 1 else a if k == 2 else "Draw"
            other = lambda k: a if k == 1 else h if k == 2 else f"{h} v {a}"
            fav = min(range(3), key=lambda k: prices[k]) + 1
            auto.append({"date": day.isoformat(), "label": label, "pick": side_name(fav), "other": other(fav),
                         "odds": prices[fav - 1], "status": "won" if fav == res else "lost", "kind": "auto"})
            m = fm.before(comp, day, h, a)
            if not m or m["thin"]:
                continue
            v = suggest.verdict(m["probs"], prices, edge_)
            if v["verdict"] == "consider":
                k = v["side"]
                sugg.append({"date": day.isoformat(), "label": label, "pick": side_name(k), "other": other(k),
                             "odds": v["price"], "expected": v["expected"], "status": "won" if k == res else "lost",
                             "kind": "suggested"})
        return auto, sugg

    auto, sugg = bets_from(since, edge)
    out = _summary(auto, stake, {"auto_rule": "the bookmakers' favourite at the market's closing average"})
    out["suggested"] = _summary(sugg, stake, {})

    def rec(xs):
        n = len(xs)
        pl = sum(stake * (b["odds"] - 1) if b["status"] == "won" else -stake for b in xs)
        return {"bets": n, "won": sum(b["status"] == "won" for b in xs), "pl": round(pl, 2),
                "roi": round(pl / (stake * n), 4) if n else None}
    out["by_edge"] = [{"edge": e, "month": rec(bets_from(since, e)[1]), "long": rec(bets_from(fm.CLUB_TEST, e)[1])}
                      for e in suggest.EDGES]
    out["long_since"] = fm.CLUB_TEST.isoformat()
    last = db.execute(text("SELECT max(day) FROM football_matches WHERE comp = ANY(:c)"), {"c": list(names)}).scalar()
    out["results_to"] = last.isoformat() if last else None
    return out


def _tennis_suggested(db, since, edge) -> list:
    """Played tennis matches the rule would have bet on: our pre-match chance
    (tennis_model, from before the match) against the bookmakers' kept price."""
    from sqlalchemy import text
    import suggest
    import tennis_model
    import tennis_odds
    bets = []
    for r in db.execute(text("SELECT tour, winner_name, loser_name, score, play_date, tourney_name, round FROM tennis_matches "
                             "WHERE play_date >= :s"), {"s": since.isoformat()}).mappings():
        sc = (r["score"] or "").upper()
        if "W/O" in sc or sc.strip() in ("WO", "W.O."):
            continue
        p = tennis_model.before(r["tour"], r["play_date"], r["winner_name"], r["loser_name"])
        if p is None:
            continue
        k = tennis_odds.kept(db, r["tour"], r["winner_name"], r["loser_name"], date_of(r["play_date"]))
        pr = (k or {}).get("prices") or {}
        ow = (pr.get(tennis_odds._surname(r["winner_name"])) or {}).get("median")
        ol = (pr.get(tennis_odds._surname(r["loser_name"])) or {}).get("median")
        if not ow or not ol:
            continue
        v = suggest.verdict([p, 1 - p], [ow, ol], edge)
        if v["verdict"] != "consider":
            continue
        won = v["side"] == 1
        bets.append({"date": r["play_date"][:10], "label": f"{r['tourney_name']} · {r['round']}",
                     "pick": r["winner_name"] if won else r["loser_name"], "other": r["loser_name"] if won else r["winner_name"],
                     "odds": v["price"], "expected": v["expected"], "status": "won" if won else "lost", "kind": "suggested"})
    return bets


def _book_suggested(db, caller, sport, since, edge) -> list:
    """Played badminton / hockey matches I typed a price in for before the
    start, where the rule would have said consider."""
    import suggest
    bets = []
    q = db.query(BookOdds).filter(BookOdds.sport == sport, BookOdds.voter_id == caller.id, BookOdds.start >= datetime.combine(since, datetime.min.time(), tzinfo=timezone.utc))
    for b in q.all():
        if b.start and b.entered_at > b.start:
            continue
        ref = json.loads(b.ref or "{}")
        names = json.loads(b.names or "[]") or ["?", "?"]
        if sport == "badminton":
            import badminton_model as bm
            r = db.get(BadmintonResult, int(ref.get("id") or 0))
            m = bm.before(r.id) if r else None
            if not r or not m or r.status != "F" or not r.winner or r.score_status == 1:
                continue
            v = suggest.verdict([m["p1"], 1 - m["p1"]], [b.odds1, b.odds2], edge)
            winner = r.winner
        else:
            try:
                import hockey_model as hm
                import hockey as fih
            except ImportError:
                continue
            ms = fih.matches(int(ref.get("series_id") or 0))
            m = next((x for x in ms if x["id"] == ref.get("id")), None)
            mod = hm.before(ref.get("id")) if m else None
            if not m or not mod or m["state"] != "finished":
                continue
            hg, ag = m["home"]["goals"], m["away"]["goals"]
            if b.odds_draw:                   # normal time: home / away / draw
                v = suggest.verdict(mod["probs"], [b.odds1, b.odds2, b.odds_draw], edge)
                winner = 1 if hg > ag else 2 if ag > hg else 3
            else:
                v = suggest.verdict([mod["win"][0], mod["win"][1]], [b.odds1, b.odds2], edge)
                winner = m["winner"]
                if not winner:
                    continue
        if v["verdict"] != "consider":
            continue
        bets.append({"date": b.start.date().isoformat(), "label": b.label,
                     "pick": names[v["side"] - 1] if v["side"] < 3 else "Draw", "other": " v ".join(names) if v["side"] == 3 else names[2 - v["side"]],
                     "odds": v["price"], "expected": v["expected"],
                     "status": "won" if winner == v["side"] else "lost", "kind": "suggested"})
    return bets


def date_of(s):
    from datetime import date
    return date.fromisoformat(str(s)[:10])


def _first_kept(db):
    from sqlalchemy import func
    from models import TennisOdds
    d = db.query(func.min(TennisOdds.day)).scalar()
    return d.isoformat() if d else None


def _summary(bets: list, stake: float, extra: dict) -> dict:
    for b in bets:
        b["pl"] = _settle(b.get("odds"), b["status"], stake)
    done = [b for b in bets if b["pl"] is not None]
    pl = round(sum(b["pl"] for b in done), 2)
    daily = {}
    for b in sorted(done, key=lambda x: x["date"]):
        daily[b["date"]] = round(daily.get(b["date"], 0) + b["pl"], 2)
    run, curve = 0.0, []
    for d, v in daily.items():
        run = round(run + v, 2)
        curve.append({"date": d, "pl": v, "cum": run})
    part = lambda k: [b for b in done if b["kind"] == k]
    seg = lambda xs: {"bets": len(xs), "won": sum(b["status"] == "won" for b in xs),
                      "staked": round(stake * len(xs), 2), "pl": round(sum(b["pl"] for b in xs), 2),
                      "roi": round(sum(b["pl"] for b in xs) / (stake * len(xs)), 4) if xs else None}
    return {**seg(done), "mine": seg(part("mine")), "auto": seg(part("auto")), "curve": curve,
            "pending": sum(b["status"] == "pending" for b in bets),
            "unsettled": sum(b["status"] != "pending" and b["pl"] is None for b in bets),
            "recent": sorted(done, key=lambda x: x["date"], reverse=True)[:400], **extra, "_bets": bets}


# -- Suggestions: consider / skip, for every match still to play --------------

@router.get("/suggestions", response_model=dict)
def suggestions(sport: str, edge: float = 0.20, db: Session = Depends(get_db), caller: User = Depends(owner)):
    """For each upcoming match on the sport's Live tab (by its key there):
    our chance, the price (tennis: the bookmakers' kept pre-match median;
    badminton / hockey: the one I typed in) and the verdict (suggest.py)."""
    import suggest
    edge = suggest.clamp_edge(edge)
    out = {}
    if sport == "tennis":
        import tennis_live
        import tennis_model
        import tennis_odds
        for m in tennis_live.matches(db)["matches"]:
            if m["state"] != "upcoming" or len(m["players"]) != 2:
                continue
            a, b = (p["name"] for p in m["players"])
            bo = 5 if m["tour"] == "ATP" and m.get("level") == "G" else 3
            mod = tennis_model.predict(m["tour"], a, b, m.get("surface"), bo)
            if not mod:
                continue
            day = (_aware(m.get("start")) or datetime.now(timezone.utc)).date()
            k = tennis_odds.kept(db, m["tour"], a, b, day)
            pr = (k or {}).get("prices") or {}
            pa, pb = (pr.get(tennis_odds._surname(a)) or {}).get("median"), (pr.get(tennis_odds._surname(b)) or {}).get("median")
            v = suggest.verdict([mod["p1"], 1 - mod["p1"]], [pa, pb] if pa and pb else None, edge)
            out[m["espn"]] = {**v, "names": [a, b], "prices": [pa, pb] if pa and pb else None, "price_from": "bookmakers",
                              "thin": mod["thin"]}
    elif sport == "badminton":
        import badminton as bwf
        import badminton_model as bm
        books = {b.match_key: b for b in db.query(BookOdds).filter(BookOdds.sport == "badminton", BookOdds.voter_id == caller.id).all()}
        for t in bwf.live().get("tournaments", []):
            for m in t.get("matches", []):
                if m.get("state") != "upcoming":
                    continue
                mod = bm.for_match(m)
                if not mod:
                    continue
                b = books.get(str(m["id"]))
                v = suggest.verdict([mod["p1"], 1 - mod["p1"]], [b.odds1, b.odds2] if b else None, edge)
                out[str(m["id"])] = {**v, "names": [_badminton_names(m["side1"]), _badminton_names(m["side2"])],
                                     "prices": [b.odds1, b.odds2] if b else None, "price_from": (b.book or "bookmaker") if b else None,
                                     "thin": mod["thin"]}
    elif sport == "hockey":
        import hockey as fih
        try:
            import hockey_model as hm
        except ImportError:
            hm = None
        books = {b.match_key: b for b in db.query(BookOdds).filter(BookOdds.sport == "hockey", BookOdds.voter_id == caller.id).all()}
        for t in fih.live().get("tournaments", []):
            for m in t.get("matches", []):
                if m.get("state") != "upcoming" or not hm:
                    continue
                mod = hm.for_match(m)
                if not mod:
                    continue
                b = books.get(str(m["id"]))
                prices = [b.odds1, b.odds2] + ([b.odds_draw] if getattr(b, "odds_draw", None) else []) if b else None
                probs = mod["probs"] if prices and len(prices) == 3 else [mod["win"][0], mod["win"][1]]
                v = suggest.verdict(probs, prices, edge)
                out[str(m["id"])] = {**v, "names": [m["home"]["name"], m["away"]["name"]], "prices": prices,
                                     "price_from": (b.book or "bookmaker") if b else None, "three_way": bool(prices and len(prices) == 3)}
    return {"edge": edge, "suggestions": out}

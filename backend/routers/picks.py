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
    book: str | None = None


def _book_row(b: BookOdds) -> dict:
    late = bool(b.start and b.entered_at > b.start)
    return {"key": b.match_key, "book": b.book, "odds": [b.odds1, b.odds2], "names": json.loads(b.names or "[]"),
            "margin": round(1 / b.odds1 + 1 / b.odds2 - 1, 4), "start": b.start.isoformat() if b.start else None,
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
    if body.sport not in SPORTS:
        raise HTTPException(400, "Unknown sport")
    if not (1.01 <= body.odds1 <= 1000 and 1.01 <= body.odds2 <= 1000):
        raise HTTPException(400, "Odds are decimal, like 1.85")
    if 1 / body.odds1 + 1 / body.odds2 < 0.98:
        raise HTTPException(400, "Those two prices can't both be right - check them")
    m = _find(body.sport, body.key)
    if not m or m["state"] == "finished":
        raise HTTPException(409, "Only for a match on the Live tab that isn't over")
    b = db.query(BookOdds).filter_by(sport=body.sport, match_key=body.key, voter_id=caller.id).first()
    if not b:
        b = BookOdds(sport=body.sport, match_key=body.key, voter_id=caller.id)
        db.add(b)
    b.odds1, b.odds2 = round(body.odds1, 3), round(body.odds2, 3)
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

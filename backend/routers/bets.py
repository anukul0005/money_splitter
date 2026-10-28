"""My bets: the bets read from 1xbet's history emails (bet_history.py) and
what they add up to. Owner only, like Betting analytics (routers/tennis.py).

The inbox is connected with /gmail/connect?purpose=betting; /bets/sync
looks for new history emails, which also runs from the daily cron.
"""
from __future__ import annotations

import json
import re
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import bet_history
from database import get_db
from models import Bet, BetImport, BettingGmailConnection, User
from routers.tennis import owner

router = APIRouter(prefix="/bets", tags=["bets"])

ODDS_BUCKETS = [(0, 1.5, "under 1.5"), (1.5, 2.0, "1.5 – 2"), (2.0, 3.0, "2 – 3"), (3.0, 5.0, "3 – 5"), (5.0, 1e9, "5 +")]
STAKE_BUCKETS = [(0, 100, "under ₹100"), (100, 500, "₹100 – 499"), (500, 1000, "₹500 – 999"), (1000, 2000, "₹1,000 – 1,999"),
                 (2000, 1e12, "₹2,000 +")]


class SyncIn(BaseModel):
    password: str | None = None        # only if a zip ever comes password-protected


@router.get("/status", response_model=dict)
def status(db: Session = Depends(get_db), caller: User = Depends(owner)):
    conn = db.query(BettingGmailConnection).filter(BettingGmailConnection.user_id == caller.id).first()
    imports = db.query(BetImport).filter(BetImport.user_id == caller.id).order_by(BetImport.imported_at.desc()).limit(20).all()
    return {"connected": bool(conn), "periods": _periods(db, caller.id), "gmail_address": conn.gmail_address if conn else None,
            "last_synced_at": conn.last_synced_at if conn else None, "progress": bet_history.get_progress(caller.id),
            "imports": [{"subject": i.subject, "received_at": i.received_at, "imported_at": i.imported_at,
                         "bets_found": i.bets_found, "bets_new": i.bets_new, "error": i.error,
                         "periods": (json.loads(i.columns or "{}") or {}).get("periods")} for i in imports]}


@router.post("/sync", response_model=dict)
def sync(body: SyncIn | None = None, caller: User = Depends(owner)):
    try:
        bet_history.start_sync(caller.id, (body.password if body else None) or None)
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    return {"started": True}


@router.get("/sync/progress", response_model=dict)
def sync_progress(caller: User = Depends(owner)):
    return bet_history.get_progress(caller.id)


@router.delete("/gmail", status_code=204)
def disconnect(db: Session = Depends(get_db), caller: User = Depends(owner)):
    db.query(BettingGmailConnection).filter(BettingGmailConnection.user_id == caller.id).delete()
    db.commit()


def _periods(db: Session, user_id: int) -> list[dict]:
    """Each history export's period, newest first - the page shows one at a
    time, the latest by default (a newer export becomes the default)."""
    seen: dict[tuple, dict] = {}
    for i in db.query(BetImport).filter(BetImport.user_id == user_id, BetImport.error.is_(None)).all():
        for p in (json.loads(i.columns or "{}") or {}).get("periods") or []:
            if p and p[0] and p[1]:
                seen.setdefault((p[0], p[1]), {"from": p[0], "to": p[1], "bets": i.bets_found})
    return sorted(seen.values(), key=lambda p: (p["to"], p["from"]), reverse=True)


def _in_period(qry, frm: str, to: str):
    if frm:
        qry = qry.filter(Bet.placed_at >= frm)
    if to:
        qry = qry.filter(Bet.placed_at <= f"{to} 23:59")
    return qry


# ── what the bets add up to ──────────────────────────────────────────────────
def _market(pick: str | None, event: str | None) -> str:
    p = (pick or "").lower()
    if re.fullmatch(r"w[12]|x|1x|x2|12", p):
        kind = "Winner / double chance"
    elif p.startswith("total"):
        kind = "Totals (over / under)"
    elif p.startswith("handicap"):
        kind = "Handicap"
    elif "to win game" in p or "game" in p:
        kind = "Game markets"
    elif "correct score" in p or "exact" in p:
        kind = "Correct score"
    else:
        kind = "Other"
    return kind


def _part(event: str | None) -> str:
    e = (event or "").lower()
    m = re.search(r"(\d)(?:st|nd|rd|th) set", e)
    return f"Set {m.group(1)}" if m else "Whole match"


def _agg() -> dict:
    return {"bets": 0, "won": 0, "lost": 0, "staked": 0.0, "returned": 0.0}


def _add(a: dict, b: Bet) -> None:
    a["bets"] += 1
    a["staked"] += b.stake or 0
    a["returned"] += b.payout or 0
    a["won"] += b.status == "won"
    a["lost"] += b.status == "lost"


def _done(a: dict, label=None) -> dict:
    out = {**a, "staked": round(a["staked"], 2), "returned": round(a["returned"], 2),
           "profit": round(a["returned"] - a["staked"], 2),
           "roi": round(100 * (a["returned"] - a["staked"]) / a["staked"], 1) if a["staked"] else None,
           "win_rate": round(100 * a["won"] / (a["won"] + a["lost"]), 1) if (a["won"] + a["lost"]) else None}
    if label is not None:
        out["label"] = label
    return out


def _bucket(v, buckets):
    for lo, hi, label in buckets:
        if v is not None and lo <= v < hi:
            return label
    return "—"


@router.get("/summary", response_model=dict)
def summary(frm: str = "", to: str = "", db: Session = Depends(get_db), caller: User = Depends(owner)):
    """frm / to: one history period (YYYY-MM-DD); blank = the latest one."""
    if not frm and not to:
        latest = _periods(db, caller.id)
        if latest:
            frm, to = latest[0]["from"], latest[0]["to"]
    bets = [b for b in _in_period(db.query(Bet).filter(Bet.user_id == caller.id), frm, to).order_by(Bet.placed_at).all()
            if b.status != "open"]
    if not bets:
        return {"total": None, "period": {"from": frm, "to": to}}
    total = _agg()
    groups: dict[str, dict] = defaultdict(lambda: defaultdict(_agg))
    daily: dict[str, float] = defaultdict(float)
    for b in bets:
        _add(total, b)
        legs = (json.loads(b.raw or "{}") or {}).get("legs") or []
        league = (legs[0].get("league") or "") if legs else ""
        keys = {
            "month": (b.placed_at or "")[:7],
            "sport": b.sport or "—",
            "type": "Accumulator" if (b.legs or 1) > 1 else "Single",
            "odds": _bucket(b.odds, ODDS_BUCKETS),
            "stake": _bucket(b.stake, STAKE_BUCKETS),
            "market": _market(b.market, b.event) if (b.legs or 1) == 1 else "Accumulator",
        }
        if b.sport == "Tennis" and (b.legs or 1) == 1:
            tour = league.split(".")[0].strip() or "—"
            if tour in ("US Open", "Australian Open", "Roland Garros", "French Open", "Wimbledon"):
                tour = "Grand Slam"
            keys["tennis_tour"] = tour
            keys["tennis_part"] = _part(b.event)
            keys["tennis_event"] = league
        for g, k in keys.items():
            _add(groups[g][k], b)
        daily[(b.settled_at or b.placed_at or "")[:10]] += (b.payout or 0) - (b.stake or 0)
    # streaks, in the order bets were settled
    best = worst = run = 0
    last = None
    for b in sorted(bets, key=lambda x: x.settled_at or x.placed_at or ""):
        if b.status not in ("won", "lost"):
            continue
        run = run + 1 if b.status == last else 1
        last = b.status
        if b.status == "won":
            best = max(best, run)
        else:
            worst = max(worst, run)
    curve, cum = [], 0.0
    for d in sorted(daily):
        cum += daily[d]
        curve.append({"date": d, "profit": round(daily[d], 2), "cumulative": round(cum, 2)})
    profit = lambda b: (b.payout or 0) - (b.stake or 0)
    order = lambda g, key=None: sorted((_done(v, k) for k, v in groups[g].items()), key=key or (lambda x: -x["bets"]))
    statuses = defaultdict(int)
    for b in bets:
        statuses[b.status] += 1
    return {
        "period": {"from": frm, "to": to},
        "total": {**_done(total), "statuses": statuses, "avg_odds": round(sum(b.odds or 0 for b in bets) / len(bets), 2),
                  "avg_stake": round(total["staked"] / len(bets), 2), "first": bets[0].placed_at, "last": bets[-1].placed_at,
                  "best_win": max((profit(b) for b in bets), default=0), "worst_loss": min((profit(b) for b in bets), default=0),
                  "longest_win_streak": best, "longest_loss_streak": worst,
                  "currency": next((b.currency for b in bets if b.currency), "INR")},
        "by_month": order("month", lambda x: x["label"]),
        "by_sport": order("sport"), "by_type": order("type"), "by_market": order("market"),
        "by_odds": [x for lbl in [b[2] for b in ODDS_BUCKETS] for x in order("odds") if x["label"] == lbl],
        "by_stake": [x for lbl in [b[2] for b in STAKE_BUCKETS] for x in order("stake") if x["label"] == lbl],
        "tennis_tour": order("tennis_tour"), "tennis_part": order("tennis_part"),
        "tennis_events": order("tennis_event")[:15],
        "curve": curve,
    }


@router.get("/list", response_model=dict)
def list_bets(status: str = "", sport: str = "", q: str = "", page: int = 0, frm: str = "", to: str = "",
              db: Session = Depends(get_db), caller: User = Depends(owner)):
    if not frm and not to:
        latest = _periods(db, caller.id)
        if latest:
            frm, to = latest[0]["from"], latest[0]["to"]
    qry = _in_period(db.query(Bet).filter(Bet.user_id == caller.id), frm, to)
    if status:
        qry = qry.filter(Bet.status == status)
    if sport:
        qry = qry.filter(Bet.sport == sport)
    if q.strip():
        qry = qry.filter(Bet.event.ilike(f"%{q.strip()}%"))
    n = qry.count()
    rows = qry.order_by(Bet.placed_at.desc()).offset(page * 50).limit(50).all()
    return {"count": n, "page": page, "bets": [{
        "id": b.bet_key, "placed_at": b.placed_at, "settled_at": b.settled_at, "sport": b.sport, "event": b.event,
        "market": b.market, "bet_type": b.bet_type, "legs": b.legs, "odds": b.odds, "stake": b.stake, "payout": b.payout,
        "profit": round((b.payout or 0) - (b.stake or 0), 2) if b.status != "open" else None, "status": b.status,
        "currency": b.currency, "detail": json.loads(b.raw or "{}")} for b in rows]}

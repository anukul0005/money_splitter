"""Betting analytics: ATP and WTA tour-level results, 2000 to today, from
the tennis knowledge base (tennis_kb tables, kept current by tennis_sync).

Only for the people in ANALYTICS_USERS - anyone else is told it doesn't
exist (404), not that it's forbidden.
"""
from __future__ import annotations

from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

import tennis_stats
from auth import current_user
from database import get_db
from models import User

router = APIRouter(prefix="/tennis", tags=["tennis"])

ANALYTICS_USERS = {"anukul"}
ROUND_ORDER = ["F", "SF", "QF", "R16", "R32", "R64", "R128", "RR", "BR", "ER"]
LEVEL_ORDER = {"G": 0, "F": 1, "M": 2, "PM": 2, "A": 3, "P": 3, "I": 4, "D": 5}
LEVEL_NAME = {"G": "Grand Slam", "F": "Tour Finals", "M": "Masters 1000", "PM": "WTA 1000", "P": "WTA 500",
              "I": "WTA 250", "A": "Tour", "D": "Davis Cup"}
COLS = ("match_id, tour, tourney_name, surface, tourney_level, tourney_date, match_date, play_date, round, "
        "best_of, winner_id, winner_name, winner_ioc, winner_seed, winner_rank, winner_age, loser_id, loser_name, "
        "loser_ioc, loser_seed, loser_rank, loser_age, score, minutes")


def owner(caller: User = Depends(current_user)) -> User:
    if (caller.name or "").lower() not in ANALYTICS_USERS:
        raise HTTPException(404, "Not found")
    return caller


def _tour_sql(tour: str) -> tuple[str, dict]:
    t = (tour or "").upper()
    return (" AND tour = :tour", {"tour": t}) if t in ("ATP", "WTA") else ("", {})


def _match(r) -> dict:
    side = lambda p: {"id": r[f"{p}_id"], "name": r[f"{p}_name"], "ioc": r[f"{p}_ioc"],
                      "seed": r[f"{p}_seed"], "rank": r[f"{p}_rank"],
                      "age": round(r[f"{p}_age"]) if r[f"{p}_age"] else None}
    return {"id": r["match_id"], "tour": r["tour"], "round": r["round"], "best_of": r["best_of"],
            "score": r["score"], "minutes": r["minutes"], "date": r["play_date"],
            "exact_date": bool(r["match_date"]), "tournament": r["tourney_name"], "surface": r["surface"],
            "winner": side("winner"), "loser": side("loser")}


def _round_key(rnd: str | None) -> int:
    return ROUND_ORDER.index(rnd) if rnd in ROUND_ORDER else len(ROUND_ORDER)


@router.get("/summary", response_model=dict)
def summary(db: Session = Depends(get_db), _: User = Depends(owner)):
    r = db.execute(text("SELECT COUNT(*) n, SUM(CASE WHEN tour='ATP' THEN 1 ELSE 0 END) atp, "
                        "SUM(CASE WHEN tour='WTA' THEN 1 ELSE 0 END) wta, MIN(play_date) first, MAX(play_date) last "
                        "FROM tennis_matches")).mappings().first()
    meta = dict(db.execute(text("SELECT key, value FROM tennis_meta")).fetchall())
    return {**dict(r), "last_fetched": meta.get("last_fetched"), "last_update": meta.get("last_update")}


@router.get("/day", response_model=dict)
def day(date: str = "", tour: str = "all", db: Session = Depends(get_db), _: User = Depends(owner)):
    """One day's results, grouped like a scores app: tournament (biggest
    first) -> round (final first) -> matches. No date: the latest day."""
    tsql, tp = _tour_sql(tour)
    if not date:
        date = db.execute(text(f"SELECT MAX(play_date) FROM tennis_matches WHERE 1=1{tsql}"), tp).scalar()
    if not date:
        return {"date": None, "tournaments": [], "prev": None, "next": None}
    rows = db.execute(text(f"SELECT {COLS} FROM tennis_matches WHERE play_date = :d{tsql}"),
                      {"d": date, **tp}).mappings().all()
    groups: dict[tuple, dict] = {}
    for r in rows:
        k = (r["tour"], r["tourney_name"])
        g = groups.setdefault(k, {"tour": r["tour"], "name": r["tourney_name"], "surface": r["surface"],
                                  "level": r["tourney_level"], "level_name": LEVEL_NAME.get(r["tourney_level"] or "", ""),
                                  "whole_week": not r["match_date"], "rounds": defaultdict(list)})
        g["rounds"][r["round"] or "—"].append(_match(r))
    tournaments = []
    for g in sorted(groups.values(), key=lambda g: (LEVEL_ORDER.get(g["level"] or "", 6), g["tour"], g["name"] or "")):
        g["rounds"] = [{"round": rnd, "matches": ms} for rnd, ms in sorted(g["rounds"].items(), key=lambda x: _round_key(x[0]))]
        g["count"] = sum(len(r["matches"]) for r in g["rounds"])
        tournaments.append(g)
    prev = db.execute(text(f"SELECT MAX(play_date) FROM tennis_matches WHERE play_date < :d{tsql}"), {"d": date, **tp}).scalar()
    nxt = db.execute(text(f"SELECT MIN(play_date) FROM tennis_matches WHERE play_date > :d{tsql}"), {"d": date, **tp}).scalar()
    return {"date": date, "tournaments": tournaments, "count": len(rows), "prev": prev, "next": nxt}


@router.get("/players", response_model=list[dict])
def players(q: str, tour: str = "all", db: Session = Depends(get_db), _: User = Depends(owner)):
    """Players whose name contains q, most matches first."""
    q = (q or "").strip()
    if len(q) < 2:
        return []
    _, tp = _tour_sql(tour)
    tsql = " AND p.tour = :tour" if tp else ""
    rows = db.execute(text(f"""
        SELECT p.tour, p.player_id, p.name, p.ioc,
               (SELECT COUNT(*) FROM tennis_matches m WHERE m.tour = p.tour AND (m.winner_id = p.player_id OR m.loser_id = p.player_id)) n,
               (SELECT MAX(play_date) FROM tennis_matches m WHERE m.tour = p.tour AND (m.winner_id = p.player_id OR m.loser_id = p.player_id)) last
        FROM tennis_players p WHERE LOWER(p.name) LIKE :q{tsql}
        ORDER BY n DESC LIMIT 60"""), {"q": f"%{q.lower()}%", **tp}).mappings().all()
    return [dict(r) for r in rows if r["n"]][:15]


def _record(rows, pid) -> dict:
    w = sum(1 for r in rows if r["winner_id"] == pid)
    return {"won": w, "lost": len(rows) - w, "pct": round(100 * w / len(rows)) if rows else None}


@router.get("/player/{tour}/{player_id}", response_model=dict)
def player(tour: str, player_id: int, db: Session = Depends(get_db), _: User = Depends(owner)):
    """A player's profile for betting: record overall, by surface, by year,
    the last 12 months, and their recent matches."""
    tour = tour.upper()
    p = db.execute(text("SELECT tour, player_id, name, hand, dob, ioc, height FROM tennis_players "
                        "WHERE tour = :t AND player_id = :p"), {"t": tour, "p": player_id}).mappings().first()
    if not p:
        raise HTTPException(404, "No such player")
    rows = db.execute(text(f"SELECT {COLS} FROM tennis_matches WHERE tour = :t AND (winner_id = :p OR loser_id = :p) "
                           f"ORDER BY play_date DESC, match_id DESC"), {"t": tour, "p": player_id}).mappings().all()
    by_surface = defaultdict(list)
    by_year = defaultdict(list)
    for r in rows:
        by_surface[r["surface"] or "Unknown"].append(r)
        by_year[(r["play_date"] or "")[:4]].append(r)
    last = rows[0]["play_date"] if rows else None
    recent_cut = f"{int(last[:4]) - 1}{last[4:]}" if last else ""
    return {"player": dict(p), "record": _record(rows, player_id),
            "last_12_months": _record([r for r in rows if (r["play_date"] or "") > recent_cut], player_id),
            "by_surface": {s: _record(rs, player_id) for s, rs in sorted(by_surface.items(), key=lambda x: -len(x[1]))},
            "by_year": [{"year": y, **_record(rs, player_id)} for y, rs in sorted(by_year.items(), reverse=True)][:8],
            "titles": sum(1 for r in rows if r["round"] == "F" and r["winner_id"] == player_id),
            "matches": [_match(r) for r in rows[:40]]}


@router.get("/sets", response_model=dict)
def sets(db: Session = Depends(get_db), _: User = Depends(owner)):
    """Games-per-set histograms (tennis_stats): rows of [tour, surface,
    best_of, set, {games: count}] - the page works out any over/under line
    and filter from them - plus the tournaments for year-on-year."""
    d = tennis_stats.data(db)
    return {"rows": d["main"], "tournaments": d["tournaments"]}


@router.get("/sets/tournament", response_model=dict)
def sets_tournament(tour: str, name: str, db: Session = Depends(get_db), _: User = Depends(owner)):
    """One tournament's games-per-set histograms, year by year: [year, set, {games: count}]."""
    return {"tour": tour.upper(), "name": name, "rows": tennis_stats.tournament(db, tour.upper(), name)}


@router.get("/h2h", response_model=dict)
def h2h(tour: str, a: int, b: int, db: Session = Depends(get_db), _: User = Depends(owner)):
    """Every meeting between two players, newest first."""
    rows = db.execute(text(f"SELECT {COLS} FROM tennis_matches WHERE tour = :t AND "
                           f"((winner_id = :a AND loser_id = :b) OR (winner_id = :b AND loser_id = :a)) "
                           f"ORDER BY play_date DESC"), {"t": tour.upper(), "a": a, "b": b}).mappings().all()
    return {"a_wins": sum(1 for r in rows if r["winner_id"] == a), "b_wins": sum(1 for r in rows if r["winner_id"] == b),
            "matches": [_match(r) for r in rows]}

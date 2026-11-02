"""Badminton in the sports section: BWF live scores, results from 2018,
players, head-to-head, rankings and stats (data: badminton.py).

For the same people as tennis (routers.tennis.owner).
"""
from __future__ import annotations

import time
from collections import Counter, defaultdict
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

import badminton as bwf
from database import get_db
from models import BadmintonPlayer, BadmintonResult, BadmintonTournament, User
from routers.tennis import owner

router = APIRouter(prefix="/badminton", tags=["badminton"])

ROUNDS = ["Final", "SF", "QF", "R16", "R32", "R64", "R128"]


def _round_key(r: str | None) -> tuple:
    r = r or ""
    if r in ROUNDS:
        return (0, ROUNDS.index(r), r)
    if r.lower().startswith("qual"):
        tail = r.split(" ", 1)[-1]
        return (2, ROUNDS.index(tail) if tail in ROUNDS else 9, r)
    return (1, 0, r)              # group stages and the like


def _games(score: str | None) -> list[list[int]]:
    out = []
    for g in (score or "").split():
        a, _, b = g.partition("-")
        if a.isdigit() and b.isdigit():
            out.append([int(a), int(b)])
    return out


def _people(db: Session, rows) -> dict[int, BadmintonPlayer]:
    ids = {i for r in rows for i in (r.p1a, r.p1b, r.p2a, r.p2b) if i}
    if not ids:
        return {}
    return {p.id: p for p in db.query(BadmintonPlayer).filter(BadmintonPlayer.id.in_(ids)).all()}


def _p(people, pid) -> dict | None:
    if not pid:
        return None
    p = people.get(pid)
    return {"id": pid, "name": p.name if p else "?", "country": p.country if p else None}


def _match(r: BadmintonResult, people, tournaments=None) -> dict:
    t = (tournaments or {}).get(r.tournament_id)
    return {"id": r.id, "code": r.code, "tournament_id": r.tournament_id,
            "tournament": t.name if t else None, "level": t.level if t else None,
            "event": r.event, "round": r.round, "day": r.day.isoformat() if r.day else None,
            "state": "finished" if r.winner else ("upcoming" if r.status in (None, "N") else "live"),
            "winner": r.winner, "score_status": r.score_status, "games": _games(r.score), "minutes": r.minutes,
            "side1": {"players": [x for x in (_p(people, r.p1a), _p(people, r.p1b)) if x], "country": r.c1, "seed": r.seed1},
            "side2": {"players": [x for x in (_p(people, r.p2a), _p(people, r.p2b)) if x], "country": r.c2, "seed": r.seed2}}


def _tournament(t: BadmintonTournament) -> dict:
    return {"id": t.id, "name": t.name, "category": t.category, "level": t.level,
            "start": t.start_date.isoformat(), "end": t.end_date.isoformat(), "location": t.location,
            "country": t.country, "logo": t.logo}


# ── Summary / live ──────────────────────────────────────────────────────────

@router.get("/summary", response_model=dict)
def summary(db: Session = Depends(get_db), _: User = Depends(owner)):
    n, first, last = db.query(func.count(BadmintonResult.id), func.min(BadmintonResult.day),
                              func.max(BadmintonResult.day)).filter(BadmintonResult.winner > 0).one()
    total = db.query(func.count(BadmintonTournament.id)).filter(BadmintonTournament.start_date <= date.today()).scalar()
    done = db.query(func.count(BadmintonTournament.id)).filter(BadmintonTournament.synced.is_(True)).scalar()
    return {"matches": n, "first": first.isoformat() if first else None, "last": last.isoformat() if last else None,
            "tournaments": total, "tournaments_read": done, "sync": bwf.progress()}


@router.get("/live", response_model=dict)
def live(_: User = Depends(owner)):
    try:
        return bwf.live()
    except Exception as e:
        raise HTTPException(502, f"BWF's live scores didn't answer: {e}")


@router.get("/match/{tournament_id}/{code}", response_model=dict)
def match(tournament_id: int, code: str, finished: bool = True, _: User = Depends(owner)):
    try:
        return bwf.match_detail(tournament_id, code, finished)
    except Exception:
        raise HTTPException(502, "BWF doesn't have the numbers for this match")


def _same_side(*ids):
    """Matches with all of `ids` on one side (a player, or a pair together)."""
    ids = [i for i in ids if i]
    return or_(*[and_(*[or_(a == i, b == i) for i in ids])
                 for a, b in ((BadmintonResult.p1a, BadmintonResult.p1b), (BadmintonResult.p2a, BadmintonResult.p2b))])


@router.get("/game/{tournament_id}/{code}", response_model=dict)
def game(tournament_id: int, code: str, db: Session = Depends(get_db), _: User = Depends(owner)):
    """One match for its own page: the match, the two sides' head-to-head and their form going in."""
    r = (db.query(BadmintonResult)
         .filter(BadmintonResult.tournament_id == tournament_id, BadmintonResult.code == code).first())
    if r is None:
        raise HTTPException(404, "No such match on file")
    t = db.get(BadmintonTournament, tournament_id)
    tmap = {t.id: t} if t else {}
    s1, s2 = [i for i in (r.p1a, r.p1b) if i], [i for i in (r.p2a, r.p2b) if i]
    before = [BadmintonResult.winner > 0, BadmintonResult.id != r.id]
    if r.day:
        before.append(BadmintonResult.day <= r.day)
    h2h, form = [], [[], []]
    if s1 and s2:
        h2h = (db.query(BadmintonResult).filter(_same_side(*s1), _same_side(*s2), *before)
               .order_by(BadmintonResult.day.desc()).limit(20).all())
        h2h = [x for x in h2h if _side_of(x, s1[0]) != _side_of(x, s2[0])]
    for k, side in enumerate((s1, s2)):
        if side:
            form[k] = (db.query(BadmintonResult).filter(_same_side(*side), BadmintonResult.event == r.event, *before)
                       .order_by(BadmintonResult.day.desc(), BadmintonResult.id.desc()).limit(10).all())
    rows = [r, *h2h, *form[0], *form[1]]
    people = _people(db, rows)
    more = {x.tournament_id for x in rows} - set(tmap)
    if more:
        tmap.update({x.id: x for x in db.query(BadmintonTournament).filter(BadmintonTournament.id.in_(more)).all()})

    def won_by(x, side):
        return x.winner == (1 if side[0] in (x.p1a, x.p1b) else 2)
    return {"match": _match(r, people, tmap), "tournament": _tournament(t) if t else None,
            "h2h": {"wins": [sum(won_by(x, s1) for x in h2h), sum(won_by(x, s2) for x in h2h)],
                    "matches": [_match(x, people, tmap) for x in h2h]},
            "form": [{"w": sum(won_by(x, side) for x in f), "l": sum(not won_by(x, side) for x in f),
                      "results": ["W" if won_by(x, side) else "L" for x in f],
                      "matches": [_match(x, people, tmap) for x in f]} for f, side in zip(form, (s1, s2))]}


# ── Results ─────────────────────────────────────────────────────────────────

@router.get("/tournaments", response_model=dict)
def tournaments(year: int = 0, db: Session = Depends(get_db), _: User = Depends(owner)):
    years = sorted({d.year for (d,) in db.query(BadmintonTournament.start_date)
                    .filter(BadmintonTournament.start_date <= date.today()).all()}, reverse=True)
    year = year or (years[0] if years else date.today().year)
    ts = (db.query(BadmintonTournament)
          .filter(func.extract("year", BadmintonTournament.start_date) == year,
                  BadmintonTournament.start_date <= date.today())
          .order_by(BadmintonTournament.start_date.desc()).all())
    ids = [t.id for t in ts]
    counts = dict(db.query(BadmintonResult.tournament_id, func.count(BadmintonResult.id))
                  .filter(BadmintonResult.tournament_id.in_(ids)).group_by(BadmintonResult.tournament_id).all()) if ids else {}
    finals = (db.query(BadmintonResult).filter(BadmintonResult.tournament_id.in_(ids), BadmintonResult.round == "Final",
                                               BadmintonResult.winner > 0).all()) if ids else []
    people = _people(db, finals)
    champs = defaultdict(dict)
    for r in finals:
        side = (r.p1a, r.p1b) if r.winner == 1 else (r.p2a, r.p2b)
        champs[r.tournament_id][r.event] = [x for x in (_p(people, i) for i in side) if x]
    # Tournaments still to start (from the calendars), soonest first - whatever year is picked
    upcoming = (db.query(BadmintonTournament).filter(BadmintonTournament.start_date > date.today())
                .order_by(BadmintonTournament.start_date, BadmintonTournament.level).limit(12).all())
    return {"year": year, "years": years, "upcoming": [_tournament(t) for t in upcoming],
            "tournaments": [{**_tournament(t), "matches": counts.get(t.id, 0),
                             "champions": {e: champs[t.id][e] for e in bwf.EVENTS if e in champs[t.id]}} for t in ts]}


@router.get("/tournament/{tournament_id}", response_model=dict)
def tournament(tournament_id: int, db: Session = Depends(get_db), _: User = Depends(owner)):
    t = db.get(BadmintonTournament, tournament_id)
    if t is None:
        raise HTTPException(404, "No such tournament")
    rows = db.query(BadmintonResult).filter(BadmintonResult.tournament_id == tournament_id).all()
    people = _people(db, rows)
    events = {}
    for e in bwf.EVENTS:
        mine = [r for r in rows if r.event == e]
        rounds = defaultdict(list)
        for r in mine:
            rounds[r.round or "?"].append(r)
        events[e] = [{"round": k, "matches": [_match(r, people) for r in sorted(v, key=lambda r: (r.day or date.min, r.code))]}
                     for k, v in sorted(rounds.items(), key=lambda kv: _round_key(kv[0]))]
    return {"tournament": _tournament(t), "events": events}


# ── Players / head-to-head ──────────────────────────────────────────────────

def _involving(pid: int):
    return or_(BadmintonResult.p1a == pid, BadmintonResult.p1b == pid,
               BadmintonResult.p2a == pid, BadmintonResult.p2b == pid)


def _side_of(r: BadmintonResult, pid: int) -> int:
    return 1 if pid in (r.p1a, r.p1b) else 2


@router.get("/players", response_model=list[dict])
def players(q: str, db: Session = Depends(get_db), _: User = Depends(owner)):
    q = q.strip()
    if len(q) < 2:
        return []
    ps = db.query(BadmintonPlayer).filter(BadmintonPlayer.name.ilike(f"%{q}%")).limit(40).all()
    out = []
    for p in ps:
        n = db.query(func.count(BadmintonResult.id)).filter(_involving(p.id), BadmintonResult.winner > 0).scalar()
        out.append({"id": p.id, "name": p.name, "country": p.country, "avatar": p.avatar, "matches": n})
    return sorted(out, key=lambda x: -x["matches"])[:20]


@router.get("/player/{player_id}", response_model=dict)
def player(player_id: int, db: Session = Depends(get_db), _: User = Depends(owner)):
    p = db.get(BadmintonPlayer, player_id)
    if p is None:
        raise HTTPException(404, "No such player")
    rows = (db.query(BadmintonResult).filter(_involving(player_id), BadmintonResult.winner > 0)
            .order_by(BadmintonResult.day.desc(), BadmintonResult.id.desc()).all())
    people = _people(db, rows)
    tmap = {t.id: t for t in db.query(BadmintonTournament)
            .filter(BadmintonTournament.id.in_({r.tournament_id for r in rows})).all()} if rows else {}
    ev, yr = defaultdict(lambda: [0, 0]), defaultdict(lambda: [0, 0])
    opp, partners, titles, finals_lost = defaultdict(lambda: [0, 0]), defaultdict(lambda: [0, 0]), [], 0
    games_won = games_lost = deciders_won = deciders = 0
    for r in rows:
        me = _side_of(r, player_id)
        won = r.winner == me
        ev[r.event][0 if won else 1] += 1
        if r.day:
            yr[r.day.year][0 if won else 1] += 1
        them = (r.p2a, r.p2b) if me == 1 else (r.p1a, r.p1b)
        opp[tuple(sorted(i for i in them if i))][0 if won else 1] += 1
        mate = [i for i in ((r.p1a, r.p1b) if me == 1 else (r.p2a, r.p2b)) if i and i != player_id]
        if mate:
            partners[mate[0]][0 if won else 1] += 1
        gs = _games(r.score)
        for a, b in gs:
            mine, theirs = (a, b) if me == 1 else (b, a)
            games_won += mine > theirs
            games_lost += theirs > mine
        if len(gs) == 3 and r.score_status == 0:
            deciders += 1
            deciders_won += won
        if r.round == "Final":
            if won:
                t = tmap.get(r.tournament_id)
                titles.append({"tournament": t.name if t else "?", "level": t.level if t else None,
                               "event": r.event, "day": r.day.isoformat() if r.day else None})
            else:
                finals_lost += 1
    def named(key):
        return [x for x in (_p(people, i) for i in key) if x]
    w = sum(v[0] for v in ev.values())
    l = sum(v[1] for v in ev.values())
    return {"player": {"id": p.id, "name": p.name, "country": p.country, "avatar": p.avatar},
            "record": [w, l], "games": [games_won, games_lost], "deciders": [deciders_won, deciders],
            "events": [{"event": e, "w": v[0], "l": v[1]} for e, v in sorted(ev.items(), key=lambda kv: -sum(kv[1]))],
            "years": [{"year": y, "w": v[0], "l": v[1]} for y, v in sorted(yr.items(), reverse=True)],
            "titles": titles, "finals_lost": finals_lost,
            "opponents": [{"players": named(k), "w": v[0], "l": v[1]}
                          for k, v in sorted(opp.items(), key=lambda kv: -sum(kv[1]))[:12]],
            "partners": [{"player": _p(people, k), "w": v[0], "l": v[1]}
                         for k, v in sorted(partners.items(), key=lambda kv: -sum(kv[1]))[:6]],
            "recent": [_match(r, people, tmap) for r in rows[:30]]}


@router.get("/h2h", response_model=dict)
def h2h(a: int, b: int, db: Session = Depends(get_db), _: User = Depends(owner)):
    rows = (db.query(BadmintonResult).filter(_involving(a), _involving(b), BadmintonResult.winner > 0)
            .order_by(BadmintonResult.day.desc()).all())
    rows = [r for r in rows if _side_of(r, a) != _side_of(r, b)]
    people = _people(db, rows)
    people.update({p.id: p for p in db.query(BadmintonPlayer).filter(BadmintonPlayer.id.in_([a, b])).all()})
    tmap = {t.id: t for t in db.query(BadmintonTournament)
            .filter(BadmintonTournament.id.in_({r.tournament_id for r in rows})).all()} if rows else {}
    wa = sum(1 for r in rows if r.winner == _side_of(r, a))
    return {"a": _p(people, a) or {"id": a}, "b": _p(people, b) or {"id": b}, "wins": [wa, len(rows) - wa],
            "matches": [_match(r, people, tmap) for r in rows]}


# ── Rankings / stats ────────────────────────────────────────────────────────

@router.get("/rankings", response_model=dict)
def rankings(event: str = "MS", db: Session = Depends(get_db), _: User = Depends(owner)):
    if event not in bwf.EVENTS:
        raise HTTPException(400, "MS, WS, MD, WD or XD")
    try:
        data = bwf.rankings(event)
    except Exception:
        raise HTTPException(502, "BWF's rankings didn't answer")
    ids = {pl["id"] for r in data["rows"] for pl in r["players"] if pl["id"]}
    known = {p.id: p.country for p in db.query(BadmintonPlayer).filter(BadmintonPlayer.id.in_(ids)).all()} if ids else {}
    rows = [{**r, "players": [{**pl, "country": known.get(pl["id"])} for pl in r["players"]]} for r in data["rows"]]
    return {"week": data["week"], "rows": rows}


_stats: dict[tuple, tuple[float, dict]] = {}


@router.get("/stats", response_model=dict)
def stats(event: str = "MS", since: int = 2018, db: Session = Depends(get_db), _: User = Depends(owner)):
    if event not in bwf.EVENTS:
        raise HTTPException(400, "MS, WS, MD, WD or XD")
    key = (event, since)
    hit = _stats.get(key)
    if hit and time.time() - hit[0] < 1800:
        return hit[1]
    rows = (db.query(BadmintonResult).filter(BadmintonResult.event == event, BadmintonResult.winner > 0,
                                             BadmintonResult.day >= date(since, 1, 1)).all())
    tmap = {t.id: t for t in db.query(BadmintonTournament).all()}
    played = [r for r in rows if r.score_status == 0 and len(_games(r.score)) >= 2]
    three = sum(1 for r in played if len(_games(r.score)) == 3)
    first_won = sum(1 for r in played if (_games(r.score)[0][0] > _games(r.score)[0][1]) == (r.winner == 1))
    all_games = [g for r in played for g in _games(r.score)]
    deuce = sum(1 for a, b in all_games if a >= 20 and b >= 20)
    mins = [r.minutes for r in played if r.minutes and 10 <= r.minutes <= 200]
    seeded = [(r.seed1, r.seed2, r.winner) for r in played if bool(r.seed1) != bool(r.seed2)]
    seed_won = sum(1 for s1, s2, w in seeded if (w == 1) == bool(s1))
    # players (singles) or pairs (doubles): wins, losses, titles
    rec = defaultdict(lambda: [0, 0, 0])
    countries = Counter()
    for r in rows:
        for side in (1, 2):
            k = tuple(sorted(i for i in ((r.p1a, r.p1b) if side == 1 else (r.p2a, r.p2b)) if i))
            if not k:
                continue
            won = r.winner == side
            rec[k][0 if won else 1] += 1
            if won and r.round == "Final":
                rec[k][2] += 1
                countries[(r.c1 if side == 1 else r.c2) or "?"] += 1
    top = sorted(rec.items(), key=lambda kv: (-kv[1][2], -kv[1][0]))[:15]
    longest = sorted([r for r in played if r.minutes and r.minutes <= 200], key=lambda r: -r.minutes)[:5]
    people = _people(db, longest)
    ids = {i for k, _ in top for i in k}
    people.update({p.id: p for p in db.query(BadmintonPlayer).filter(BadmintonPlayer.id.in_(ids)).all()} if ids else {})
    pct = lambda a, b: round(100 * a / b, 1) if b else None
    out = {"event": event, "since": since, "matches": len(rows),
           "three_games": pct(three, len(played)), "first_game_winner_wins": pct(first_won, len(played)),
           "deuce_games": pct(deuce, len(all_games)), "avg_minutes": round(sum(mins) / len(mins)) if mins else None,
           "seeded_beat_unseeded": pct(seed_won, len(seeded)),
           "retired_or_walkover": sum(1 for r in rows if r.score_status in (1, 2, 3)),
           "top": [{"players": [x for x in (_p(people, i) for i in k) if x], "w": v[0], "l": v[1], "titles": v[2]}
                   for k, v in top],
           "countries": [{"country": c, "titles": n} for c, n in countries.most_common(10)],
           "longest": [_match(r, people, tmap) for r in longest]}
    _stats[key] = (time.time(), out)
    return out

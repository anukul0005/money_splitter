"""Our own badminton odds, made from the BWF results on file (2018 on) - no
bookmaker feed covers badminton.

Each player has a rating per event (MS WS MD WD XD) in rally terms: the
difference between two sides' ratings (a pair = the mean of its two) is the
log-odds that side 1 wins any one rally. After every match each player's
rating moves by LR x (the share of points their side won - the share
expected); new players move faster for their first NEW matches. Walkovers
teach nothing; a retirement only nudges.

From the rally chance a game to 21 (win by 2, capped at 30) and a best-of-3
are worked out exactly: the chance each side wins, and that it goes to 3
games. The winner's chance is taken on a damped difference (C), which
calibrates it, and the 3-games chance is recalibrated likewise (T3) - fitted on the history, tested on 2024 on (the backtest in
`record`): what we say is 75% comes in ~75% of the time.

The replay runs in order, so every finished match gets the prediction it had
before it was played (kept odds), and upcoming ones get today's ratings.
Rebuilt in memory (a few seconds) whenever new results come in.
"""
from __future__ import annotations

import math
import threading
import time
from collections import defaultdict
from datetime import date

LR = 0.3            # rating step per unit of point share off the expected
KNEW, NEW = 2.5, 10  # faster for a player's first NEW matches in an event
C = 0.75            # damping of the difference for the winner's chance (calibration)
T3 = (-0.5, 0.65)   # the 3-games chance recalibrated on its log-odds (fitted 2018-23: rallies
                    # aren't quite independent, so the raw chance runs high in close matches)
TEST_FROM = date(2024, 1, 1)
CHECK_EVERY = 10 * 60
VERSION = "rally-v2"

_lock = threading.Lock()
_state: dict = {"R": {}, "N": {}, "past": {}, "built": 0.0, "mark": None, "record": None}
_games: dict[float, float] = {}


def _game(q: float) -> float:
    """The chance of winning a game from 0-0 at rally chance q."""
    q = round(q, 3)
    if q in _games:
        return _games[q]
    memo: dict = {}

    def g(a, b):
        if (a >= 21 and a - b >= 2) or a == 30:
            return 1.0
        if (b >= 21 and b - a >= 2) or b == 30:
            return 0.0
        k = (a, b)
        if k not in memo:
            memo[k] = q * g(a + 1, b) + (1 - q) * g(a, b + 1)
        return memo[k]
    _games[q] = v = g(0, 0)
    return v


def _sig(x: float) -> float:
    return 1 / (1 + math.exp(-max(-30, min(30, x))))


def probs(diff: float) -> tuple[float, float]:
    """(side 1 wins the match, it goes to 3 games) from the rating difference."""
    g = _game(_sig(C * diff))
    win = g * g * (3 - 2 * g)                 # 2-0, or 1-1 then the decider
    g3 = _game(_sig(diff))
    raw = min(max(2 * g3 * (1 - g3), 1e-4), 1 - 1e-4)
    return win, _sig(T3[0] + T3[1] * math.log(raw / (1 - raw)))


def _points(score: str | None):
    a = b = n = 0
    for gm in (score or "").split():
        x, _, y = gm.partition("-")
        if not (x.isdigit() and y.isdigit()):
            return None
        a, b, n = a + int(x), b + int(y), n + 1
    return (a, b, n) if a + b >= 20 else None


def _rows(db):
    from sqlalchemy import text
    return db.execute(text("""
        SELECT r.id, r.event, r.day, r.winner, r.score_status, r.p1a, r.p1b, r.p2a, r.p2b, r.score
        FROM badminton_results r
        WHERE r.winner IN (1, 2) AND r.p1a IS NOT NULL AND r.p2a IS NOT NULL AND r.day IS NOT NULL
        ORDER BY r.day, r.time_utc NULLS LAST, r.id""")).fetchall()


def build(db) -> dict:
    R, N, past = {}, defaultdict(int), {}
    rec = {"n": 0, "right": 0, "ll": 0.0, "brier": 0.0, "n3": 0, "ll3": 0.0, "bands": defaultdict(lambda: [0, 0, 0.0])}
    for mid, ev, day, w, ss, p1a, p1b, p2a, p2b, score in _rows(db):
        s1, s2 = [p for p in (p1a, p1b) if p], [p for p in (p2a, p2b) if p]
        r1 = sum(R.get((ev, p), 0.0) for p in s1) / len(s1)
        r2 = sum(R.get((ev, p), 0.0) for p in s2) / len(s2)
        pw, p3 = probs(r1 - r2)
        past[mid] = (pw, p3, min(N[(ev, p)] for p in s1 + s2) < 3)
        if ss == 1:                            # a walkover: nothing to learn
            continue
        pts = _points(score) if ss == 0 else None
        if day >= TEST_FROM:
            y = 1 if w == 1 else 0
            pc = min(max(pw, 1e-4), 1 - 1e-4)
            rec["n"] += 1
            rec["right"] += (pw > 0.5) == (y == 1)
            rec["ll"] -= y * math.log(pc) + (1 - y) * math.log(1 - pc)
            rec["brier"] += (pw - y) ** 2
            fav = max(pw, 1 - pw)
            b = rec["bands"][min(int((fav - 0.5) * 10), 4)]
            b[0] += 1; b[1] += (pw > 0.5) == (y == 1); b[2] += fav
            if pts:
                y3 = 1 if pts[2] == 3 else 0
                p3c = min(max(p3, 1e-4), 1 - 1e-4)
                rec["n3"] += 1
                rec["ll3"] -= y3 * math.log(p3c) + (1 - y3) * math.log(1 - p3c)
        q = _sig(r1 - r2)
        g = (pts[0] / (pts[0] + pts[1]) - q) if pts else ((1.0 if w == 1 else 0.0) - pw) * 0.02
        for side, sign in ((s1, 1), (s2, -1)):
            for p in side:
                k = (ev, p)
                R[k] = R.get(k, 0.0) + sign * LR * (KNEW if N[k] < NEW else 1.0) * g
                N[k] += 1
    n = max(rec["n"], 1)
    record = {"since": TEST_FROM.isoformat(), "matches": rec["n"], "right": round(rec["right"] / n, 3),
              "log_loss": round(rec["ll"] / n, 4), "brier": round(rec["brier"] / n, 4),
              "three_games_log_loss": round(rec["ll3"] / max(rec["n3"], 1), 4),
              "bands": [{"from": 50 + 10 * k, "to": 60 + 10 * k, "matches": v[0],
                         "said": round(v[2] / v[0], 3), "came_in": round(v[1] / v[0], 3)}
                        for k, v in sorted(rec["bands"].items()) if v[0]],
              "version": VERSION}
    with _lock:
        _state.update(R=R, N=dict(N), past=past, built=time.time(), record=record)
    return record


def _mark(db):
    from sqlalchemy import text
    return tuple(db.execute(text("SELECT count(*), max(id) FROM badminton_results WHERE winner IN (1, 2)")).one())


def loop() -> None:
    """From server start: built now, and again whenever new results are on file."""
    from database import get_session_factory
    time.sleep(15)
    while True:
        try:
            db = get_session_factory()()
            try:
                m = _mark(db)
                if m != _state["mark"]:
                    t = time.time()
                    rec = build(db)
                    _state["mark"] = m
                    print(f"[badminton-model] built in {time.time() - t:.1f}s: {len(_state['R'])} ratings, "
                          f"{rec['right']:.1%} right since {rec['since']}", flush=True)
            finally:
                db.close()
        except Exception as e:
            print(f"[badminton-model] {e}", flush=True)
        time.sleep(CHECK_EVERY)


def _odds(p: float) -> float:
    return round(min(max(1 / max(p, 1e-6), 1.01), 100.0), 2)


def shape(pw: float, p3: float, thin: bool) -> dict:
    """Fair decimal odds (no bookmaker's margin) from the chances."""
    return {"p1": round(pw, 3), "p3": round(p3, 3), "odds": [_odds(pw), _odds(1 - pw)],
            "three": _odds(p3), "two": _odds(1 - p3), "thin": thin, "source": "model"}


def predict(event: str, s1: list, s2: list) -> dict | None:
    """Now, from today's ratings. `thin`: someone has under 3 matches on file."""
    s1, s2 = [p for p in s1 if p], [p for p in s2 if p]
    if not s1 or not s2 or not _state["built"]:
        return None
    R, N = _state["R"], _state["N"]
    r1 = sum(R.get((event, p), 0.0) for p in s1) / len(s1)
    r2 = sum(R.get((event, p), 0.0) for p in s2) / len(s2)
    pw, p3 = probs(r1 - r2)
    return shape(pw, p3, min(N.get((event, p), 0) for p in s1 + s2) < 3)


def before(match_id) -> dict | None:
    """A finished match's prediction from before it was played."""
    hit = _state["past"].get(match_id)
    return shape(*hit) if hit else None


def for_match(m: dict) -> dict | None:
    """A match as the API shapes it (side1/side2 players with ids, event, state)."""
    if m.get("state") == "finished" and m.get("id") in _state["past"]:
        return before(m["id"])
    ids = lambda s: [p.get("id") for p in (s or {}).get("players") or []]
    return predict(m.get("event") or "", ids(m.get("side1")), ids(m.get("side2")))


def record() -> dict | None:
    return _state["record"]

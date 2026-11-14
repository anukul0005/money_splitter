"""Our own tennis odds, from the results on file (tennis_matches, 2000 on) -
the bookmakers' kept prices are the other side of the comparison.

Each player has a rating per tour, plus a surface part: the share of games
won against the share expected moves both by LR (faster for a player's first
matches). The chance of winning the match is a logistic of the rating
difference - steeper over five sets - plus a little for ranking points.
Fitted on the history and tested on 2024 on: 65% of winners picked, and what
it calls 75% comes in ~72%, 84% ~85%. Against the bookmakers' prices it's
weaker (they know about injuries and withdrawals; results don't), which is
why suggestions (suggest.py) only bet on a clear edge.

Players are keyed by name: the older results and ESPN's number them differently.
The replay keeps every recent match's pre-match chance, for the P/L back-test.
"""
from __future__ import annotations

import math
import re
import threading
import time
from collections import defaultdict
from datetime import date, timedelta

import tennis_kb as kb

LR = 0.15            # rating step per unit of games share off the expected
KNEW, NEW = 2.0, 15  # faster for a player's first NEW matches
C3 = 2.5             # rating difference -> match chance, best of three
C5 = C3 * 1.3        # best of five
SW = 0.3             # weight of the surface part
RP = 0.2             # x log(ranking points ratio)
KEEP_DAYS = 150      # recent matches whose pre-match chance is kept
CHECK_EVERY = 30 * 60
VERSION = "games-v1"

_GAME = re.compile(r"(\d+)-(\d+)")
_lock = threading.Lock()
_state: dict = {"R": {}, "RS": {}, "N": {}, "pts": {}, "pre": {}, "built": 0.0, "mark": None}


def _sig(x: float) -> float:
    return 1 / (1 + math.exp(-max(-30, min(30, x))))


def _games(score: str):
    s = (score or "").upper()
    if "W/O" in s or s.strip() in ("WO", "W.O.") or "DEF" in s:
        return None, "wo"
    a = b = 0
    for m in _GAME.finditer(re.sub(r"\(\d+\)", "", s)):
        a += int(m.group(1)); b += int(m.group(2))
    return (a, b), ("ret" if "RET" in s or "ABD" in s else "ok")


def build(db) -> int:
    from sqlalchemy import text
    R, RS, N, pts, pre = defaultdict(float), defaultdict(float), defaultdict(int), {}, {}
    keep_from = (date.today() - timedelta(days=KEEP_DAYS)).isoformat()
    n = 0
    for tour, day, surf, bo, wn, ln, score, wrp, lrp in db.execute(text("""
            SELECT tour, play_date, surface, best_of, winner_name, loser_name, score, winner_rank_points, loser_rank_points
            FROM tennis_matches WHERE play_date IS NOT NULL ORDER BY play_date, tourney_date, match_num""")):
        g, kind = _games(score)
        if kind == "wo":
            continue
        surf = surf or "Hard"
        w, l = kb.norm(wn), kb.norm(ln)
        kw, kl = (tour, w), (tour, l)
        dw = R[kw] + SW * RS[(tour, w, surf)] - R[kl] - SW * RS[(tour, l, surf)]
        x = dw * (C5 if bo == 5 else C3)
        if wrp and lrp:
            x += RP * (math.log(wrp) - math.log(lrp))
        if day >= keep_from:
            pre[(tour, day[:10], w, l)] = _sig(x)
        if wrp:
            pts[kw] = wrp
        if lrp:
            pts[kl] = lrp
        n += 1
        if kind == "ret" or not g or g[0] + g[1] < 6:
            continue
        d = g[0] / (g[0] + g[1]) - _sig(dw)
        for k, sgn in ((kw, 1), (kl, -1)):
            f = KNEW if N[k] < NEW else 1.0
            R[k] += sgn * LR * f * d
            RS[(k[0], k[1], surf)] += sgn * LR * f * d
            N[k] += 1
    with _lock:
        _state.update(R=dict(R), RS=dict(RS), N=dict(N), pts=pts, pre=pre, built=time.time())
    return n


def loop() -> None:
    """From server start: built now, and again whenever new results are on file."""
    from database import get_session_factory
    from sqlalchemy import text
    time.sleep(30)
    while True:
        try:
            db = get_session_factory()()
            try:
                mark = tuple(db.execute(text("SELECT count(*), max(play_date) FROM tennis_matches")).one())
                if mark != _state["mark"]:
                    t = time.time()
                    n = build(db)
                    _state["mark"] = mark
                    print(f"[tennis-model] built in {time.time() - t:.1f}s from {n} matches", flush=True)
            finally:
                db.close()
        except Exception as e:
            print(f"[tennis-model] {e}", flush=True)
        time.sleep(CHECK_EVERY)


def predict(tour: str, a: str, b: str, surface: str | None = None, best_of: int = 3) -> dict | None:
    """Player a's chance against b now. None until built or if neither is known."""
    if not _state["built"]:
        return None
    tour = (tour or "").upper()
    R, RS, N, pts = _state["R"], _state["RS"], _state["N"], _state["pts"]
    ka, kb_ = (tour, kb.norm(a)), (tour, kb.norm(b))
    if ka not in N and kb_ not in N:
        return None
    s = surface or "Hard"
    d = R.get(ka, 0.0) + SW * RS.get((tour, ka[1], s), 0.0) - R.get(kb_, 0.0) - SW * RS.get((tour, kb_[1], s), 0.0)
    x = d * (C5 if best_of == 5 else C3)
    pa, pb = pts.get(ka), pts.get(kb_)
    if pa and pb:
        x += RP * (math.log(pa) - math.log(pb))
    p = _sig(x)
    return {"p1": round(p, 3), "odds": [round(min(1 / p, 100), 2), round(min(1 / (1 - p), 100), 2)],
            "thin": min(N.get(ka, 0), N.get(kb_, 0)) < 10, "source": "model"}


def before(tour: str, day: str, winner: str, loser: str) -> float | None:
    """A played match's pre-match chance for the winner (kept KEEP_DAYS)."""
    return _state["pre"].get(((tour or "").upper(), str(day)[:10], kb.norm(winner), kb.norm(loser)))

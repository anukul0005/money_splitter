"""Our own field-hockey odds, from the FIH results on file (hockey_matches:
senior outdoor internationals, 2016 on - hockey.sync_history).

Each team has an attack and a defence strength. Expected goals for a side =
exp(base + its attack - the other's defence); after each match the strengths
move by LR x (goals scored - expected), faster for a team's first matches.
Goals are taken as Poisson, which gives the chance of each side winning in
normal time and of a draw - and of winning overall, a draw going to a
shoot-out about evenly. Fitted on the history and tested on 2024 on: the
winner of 68.7% of decided matches picked, and the win / draw / loss call
scores 0.939 log-loss against 0.979 for the base rates alone (`record`).

Teams are FIH's team ids (men's and women's sides are different ids).
"""
from __future__ import annotations

import math
import threading
import time
from collections import defaultdict
from datetime import date

LR = 0.06           # strength step per goal off the expected
KNEW, NEW = 1.5, 8  # faster for a team's first NEW matches
LR_BASE = 0.005     # how fast the scoring level (per gender) drifts
SO_EDGE = 0.0       # shoot-outs: no edge for the stronger side (close to a coin toss)
FROM = date(2016, 1, 1)     # results used from here on
TEST_FROM = date(2024, 1, 1)
CHECK_EVERY = 30 * 60
VERSION = "poisson-v1"

_lock = threading.Lock()
_state: dict = {"A": {}, "D": {}, "N": {}, "base": {}, "past": {}, "built": 0.0, "mark": None, "record": None}


def _pois(lam: float, k: int) -> float:
    return math.exp(-lam) * lam ** k / math.factorial(k)


def outcome(lh: float, la: float) -> tuple[float, float, float]:
    """(home wins, draw, away wins) in normal time from expected goals."""
    ph = [_pois(lh, k) for k in range(16)]
    pa = [_pois(la, k) for k in range(16)]
    win = sum(ph[i] * pa[j] for i in range(16) for j in range(i))
    draw = sum(ph[i] * pa[i] for i in range(16))
    return win, draw, max(0.0, 1 - win - draw)


def _lams(A, D, base, g, h, a):
    b = base.get(g, math.log(2.0))
    cap = lambda x: min(max(x, 0.05), 15.0)             # a lopsided mismatch can't run away
    return cap(math.exp(b + A.get(h, 0.0) - D.get(a, 0.0))), cap(math.exp(b + A.get(a, 0.0) - D.get(h, 0.0)))


def _shape(lh, la, thin):
    w, d, l = outcome(lh, la)
    win1 = w + d * (0.5 + SO_EDGE)
    return {"probs": [round(w, 3), round(l, 3), round(d, 3)],      # home, away, draw (normal time)
            "win": [round(win1, 3), round(1 - win1, 3)],          # overall, a draw to a shoot-out
            "goals": [round(lh, 2), round(la, 2)], "thin": thin, "source": "model",
            "odds": [round(min(1 / max(win1, 1e-3), 100), 2), round(min(1 / max(1 - win1, 1e-3), 100), 2)]}


def build(db, lr: float = LR, keep: bool = True) -> dict:
    from sqlalchemy import text
    A, D, N, base, past = defaultdict(float), defaultdict(float), defaultdict(int), {}, {}
    n = n2 = ll3 = ll2 = right = 0
    for mid, g, day, h, a, gh, ga, sh, sa in db.execute(text("""
            SELECT id, gender, day, home_id, away_id, home_goals, away_goals, home_so, away_so
            FROM hockey_matches WHERE day >= :since AND home_goals IS NOT NULL AND away_goals IS NOT NULL AND day IS NOT NULL
            ORDER BY day, start NULLS LAST, id"""), {"since": FROM}):
        lh, la = _lams(A, D, base, g, h, a)
        thin = min(N[h], N[a]) < 5
        past[mid] = (lh, la, thin)
        if day >= TEST_FROM and not thin:
            w, d, l = outcome(lh, la)
            p = w if gh > ga else l if ga > gh else d
            n += 1
            ll3 -= math.log(max(p, 1e-6))
            if gh != ga:
                n2 += 1
                pw = w / (w + l) if w + l > 0 else 0.5
                ll2 -= math.log(max(pw if gh > ga else 1 - pw, 1e-6))
                right += (pw > 0.5) == (gh > ga)
        for side, opp, scored, lam in ((h, a, gh, lh), (a, h, ga, la)):
            f = KNEW if N[side] < NEW else 1.0
            fo = KNEW if N[opp] < NEW else 1.0
            A[side] += lr * f * (scored - lam) / max(lam, 0.5)
            D[opp] -= lr * fo * (scored - lam) / max(lam, 0.5)
        base[g] = base.get(g, math.log(2.0)) + LR_BASE * ((gh - lh) + (ga - la))
        N[h] += 1
        N[a] += 1
    rec = {"since": TEST_FROM.isoformat(), "matches": n, "log_loss_3way": round(ll3 / max(n, 1), 4),
           "decided": n2, "right": round(right / max(n2, 1), 3), "log_loss_winner": round(ll2 / max(n2, 1), 4),
           "version": VERSION}
    if keep:
        with _lock:
            _state.update(A=dict(A), D=dict(D), N=dict(N), base=base, past=past, built=time.time(), record=rec)
    return rec


def loop() -> None:
    from database import get_session_factory
    from sqlalchemy import text
    time.sleep(40)
    while True:
        try:
            db = get_session_factory()()
            try:
                mark = tuple(db.execute(text("SELECT count(*), max(id) FROM hockey_matches")).one())
                if mark != _state["mark"] and mark[0]:
                    t = time.time()
                    build(db)
                    _state["mark"] = mark
                    print(f"[hockey-model] built in {time.time() - t:.1f}s from {mark[0]} matches", flush=True)
            finally:
                db.close()
        except Exception as e:
            print(f"[hockey-model] {e}", flush=True)
        time.sleep(CHECK_EVERY)


def predict(gender: str | None, home: int, away: int) -> dict | None:
    if not _state["built"] or not home or not away:
        return None
    N = _state["N"]
    if home not in N and away not in N:
        return None
    lh, la = _lams(_state["A"], _state["D"], _state["base"], gender, home, away)
    return _shape(lh, la, min(N.get(home, 0), N.get(away, 0)) < 5)


def before(match_id) -> dict | None:
    hit = _state["past"].get(match_id)
    return _shape(*hit) if hit else None


def for_match(m: dict) -> dict | None:
    """A match as hockey.py shapes it (home / away with FIH team ids)."""
    if m.get("state") == "finished" and m.get("id") in _state["past"]:
        return before(m["id"])
    g = {"Men": "M", "Women": "F", "M": "M", "F": "F", "W": "F"}.get(str(m.get("gender") or ""), None)
    return predict(g, (m.get("home") or {}).get("id"), (m.get("away") or {}).get("id"))


def record() -> dict | None:
    return _state["record"]

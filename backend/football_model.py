"""Our own football odds, from the results on file (football_matches).

Each team has an attack and a defence strength. Expected goals for a side =
exp(base + half the home edge + its attack - the other's defence), and after
each match the strengths move by LR x (goals scored - expected), faster for a
team's first few matches. Goals are taken as Poisson with the Dixon-Coles
correction for low scores (0-0 and 1-1 a little likelier than independence
says), giving home win / draw / away win.

Two pools, fitted apart:
  * clubs - the top five leagues and the Champions League. A new season pulls
    every strength back toward the middle (REGRESS) and a promoted side starts
    below it (PROMO). Each league's level against the others is learnt from
    the Champions League alone (the only matches across leagues).
  * national teams - from 2000, friendlies counting less than competitive
    matches, no home edge at a neutral ground.

Tuned on the history (research: scratchpad fb_research): smaller steps beat
larger, shots on target added nothing. Tested from 2023/24 on, against
Pinnacle's closing prices the clubs score 0.983 log-loss to Pinnacle's 0.959
- a sharp bookmaker is better, as everywhere - and the national teams 0.870
against 1.050 for the base rates (`record`).
"""
from __future__ import annotations

import math
import threading
import time
from collections import defaultdict
from datetime import date

CLUB = {"lr": 0.025, "knew": 2.0, "new": 6, "rho": -0.08}
NATION = {"lr": 0.05, "knew": 2.0, "new": 6, "rho": 0.0}
HOME0 = 0.25            # home edge in log goals, learnt per competition from here
LR_BASE = 0.003         # how fast a competition's scoring level and home edge drift
LR_LEAGUE = 0.01        # a league's level against the others, from Champions League games
REGRESS = 0.85          # a new season: strengths x this
PROMO = -0.15           # a side new to a league starts this far below the middle
FOREIGN = -0.10         # a Champions League club from outside the five leagues, at first
CLUB_TEST, NATION_TEST = date(2023, 7, 1), date(2022, 1, 1)
CHECK_EVERY = 30 * 60
VERSION = "dc-poisson-v1"
LEAGUE_CODES = ("E0", "SP1", "I1", "D1", "F1", "ISL")

_lock = threading.Lock()
_state: dict = {"built": 0.0, "mark": None, "record": None}


def _pois(l: float, k: int) -> float:
    return math.exp(-l) * l ** k / math.factorial(k)


def outcome(lh: float, la: float, rho: float = 0.0) -> tuple[float, float, float]:
    """(home wins, draw, away wins)."""
    ph = [_pois(lh, k) for k in range(11)]
    pa = [_pois(la, k) for k in range(11)]
    w = d = l = 0.0
    for i in range(11):
        for j in range(11):
            p = ph[i] * pa[j]
            if rho and i <= 1 and j <= 1:
                p *= {(0, 0): 1 - lh * la * rho, (0, 1): 1 + lh * rho, (1, 0): 1 + la * rho, (1, 1): 1 - rho}[(i, j)]
            if i > j:
                w += p
            elif i == j:
                d += p
            else:
                l += p
    t = w + d + l
    return w / t, d / t, l / t


def _weight(tournament: str | None) -> float:
    t = (tournament or "").lower()
    return 0.6 if "friendly" in t else 0.9 if "qualification" in t else 1.0


class _Pool:
    def __init__(self, p: dict):
        self.p = p
        self.A, self.D, self.N = defaultdict(float), defaultdict(float), defaultdict(int)
        self.base = defaultdict(lambda: math.log(1.35))
        self.home = defaultdict(lambda: HOME0)
        self.season, self.league = {}, {}
        self.LA, self.LD = defaultdict(float), defaultdict(float)

    def lams(self, comp, h, a, neutral):
        hv = 0.0 if neutral else self.home[comp]
        b = self.base[comp]
        xa = xd = ya = yd = 0.0
        if comp == "CL":
            lh_, la_ = self.league.get(h, "X"), self.league.get(a, "X")
            xa, xd, ya, yd = self.LA[lh_], self.LD[lh_], self.LA[la_], self.LD[la_]
        cap = lambda x: min(max(x, 0.05), 8.0)
        return (cap(math.exp(b + hv / 2 + self.A[h] + xa - self.D[a] - yd)),
                cap(math.exp(b - hv / 2 + self.A[a] + ya - self.D[h] - xd)))

    def season_turn(self, comp, season, team):
        if comp in LEAGUE_CODES:
            if team in self.season and self.season[team] != season:
                self.A[team] *= REGRESS
                self.D[team] *= REGRESS
            if team not in self.season and self.N[team] == 0 and season and season > "1213":
                self.A[team], self.D[team] = PROMO, PROMO
            self.season[team] = season
            self.league[team] = comp
        elif comp == "CL" and team not in self.league and self.N[team] == 0:
            self.A[team], self.D[team] = FOREIGN, FOREIGN

    def learn(self, comp, h, a, hg, ag, lh, la, neutral, wt=1.0):
        p = self.p
        for side, opp, sc, lam in ((h, a, hg, lh), (a, h, ag, la)):
            f = (p["knew"] if self.N[side] < p["new"] else 1.0) * wt
            fo = (p["knew"] if self.N[opp] < p["new"] else 1.0) * wt
            g = (sc - lam) / max(lam, 0.5)
            self.A[side] += p["lr"] * f * g
            self.D[opp] -= p["lr"] * fo * g
            if comp == "CL":
                ls, lo = self.league.get(side, "X"), self.league.get(opp, "X")
                if ls != lo:
                    self.LA[ls] += LR_LEAGUE * g
                    self.LD[lo] -= LR_LEAGUE * g
        self.base[comp] += LR_BASE * wt * ((hg - lh) + (ag - la))
        if not neutral:
            self.home[comp] += LR_BASE * wt * ((hg - lh) - (ag - la))
        self.N[h] += 1
        self.N[a] += 1


def _shape(lh, la, rho, thin) -> dict:
    w, d, l = outcome(lh, la, rho)
    odds = lambda p: round(min(1 / max(p, 1e-3), 100), 2)
    return {"probs": [round(w, 3), round(l, 3), round(d, 3)],          # home, away, draw (as hockey)
            "odds": [odds(w), odds(l), odds(d)], "goals": [round(lh, 2), round(la, 2)], "thin": thin, "source": "model"}


def build(db) -> dict:
    from sqlalchemy import text
    clubs, nations = _Pool(CLUB), _Pool(NATION)
    past = {}
    st = {k: defaultdict(float) for k in ("club", "nation")}
    for comp, season, tour, day, h, a, hg, ag, neutral, ph, pd, pa in db.execute(text("""
            SELECT comp, season, tournament, day, home, away, home_goals, away_goals, neutral, pin_h, pin_d, pin_a
            FROM football_matches ORDER BY day, id""")):
        nat = comp == "INTL"
        pool = nations if nat else clubs
        if not nat:
            pool.season_turn(comp, season, h)
            pool.season_turn(comp, season, a)
        lh, la = pool.lams(comp, h, a, neutral)
        thin = min(pool.N[h], pool.N[a]) < 5
        past[(comp, day, h, a)] = (lh, la, thin)
        test = NATION_TEST if nat else CLUB_TEST
        if day >= test and not thin:
            w, d, l = outcome(lh, la, pool.p["rho"])
            y = 0 if hg > ag else 1 if hg == ag else 2
            s = st["nation" if nat else "club"]
            s["n"] += 1
            s["ll"] -= math.log(max((w, d, l)[y], 1e-6))
            s["right"] += max(range(3), key=lambda k: (w, d, l)[k]) == y
            s[f"y{y}"] += 1
            if ph and pd and pa:
                inv = (1 / ph, 1 / pd, 1 / pa)
                q = [x / sum(inv) for x in inv]
                s["nb"] += 1
                s["llb"] -= math.log(q[y])
                s["llm"] -= math.log(max((w, d, l)[y], 1e-6))
        pool.learn(comp, h, a, hg, ag, lh, la, neutral, _weight(tour) if nat else 1.0)

    def rec(s, since):
        n = max(s["n"], 1)
        tot = sum(s[f"y{k}"] for k in range(3)) or 1
        base = -sum(s[f"y{k}"] * math.log(s[f"y{k}"] / tot) for k in range(3) if s[f"y{k}"]) / tot
        out = {"since": since.isoformat(), "matches": int(s["n"]), "right": round(s["right"] / n, 3),
               "log_loss": round(s["ll"] / n, 4), "base_log_loss": round(base, 4)}
        if s["nb"]:
            out.update(with_pinnacle=int(s["nb"]), ours_there=round(s["llm"] / s["nb"], 4), pinnacle=round(s["llb"] / s["nb"], 4))
        return out
    record = {"clubs": rec(st["club"], CLUB_TEST), "nations": rec(st["nation"], NATION_TEST), "version": VERSION}
    with _lock:
        _state.update(clubs=clubs, nations=nations, past=past, built=time.time(), record=record)
    return record


def loop() -> None:
    from database import get_session_factory
    from sqlalchemy import text
    time.sleep(60)
    while True:
        try:
            db = get_session_factory()()
            try:
                mark = tuple(db.execute(text("SELECT count(*), max(id) FROM football_matches")).one())
                if mark[0] and mark != _state["mark"]:
                    t = time.time()
                    rec = build(db)
                    _state["mark"] = mark
                    print(f"[football-model] built in {time.time() - t:.1f}s from {mark[0]} matches: "
                          f"clubs {rec['clubs']['right']:.1%} right", flush=True)
            finally:
                db.close()
        except Exception as e:
            print(f"[football-model] {e}", flush=True)
        time.sleep(CHECK_EVERY)


def predict(comp: str, home: str, away: str, neutral: bool = False) -> dict | None:
    """`comp` as stored (E0... / CL / INTL), names as stored."""
    if not _state["built"] or not home or not away:
        return None
    pool = _state["nations"] if comp == "INTL" else _state["clubs"]
    if pool.N.get(home, 0) == 0 and pool.N.get(away, 0) == 0:
        return None
    lh, la = pool.lams(comp, home, away, neutral)
    return _shape(lh, la, pool.p["rho"], min(pool.N.get(home, 0), pool.N.get(away, 0)) < 5)


def before(comp: str, day: date, home: str, away: str) -> dict | None:
    hit = (_state.get("past") or {}).get((comp, day, home, away))
    if not hit:
        return None
    return _shape(*hit[:2], (CLUB if comp != "INTL" else NATION)["rho"], hit[2])


def record() -> dict | None:
    return _state["record"]

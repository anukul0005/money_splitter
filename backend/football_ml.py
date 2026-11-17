"""The football betting model: logistic regression that starts from the
market's closing chance and learns small corrections from what's known
before kick-off (the winner of the walk-forward test in the ML lesson).

    z = logit(m) + b + sum_j w_j * (x_j - mu_j) / s_j        p = sigmoid(z)

m is the side's no-vig chance from the closing average. Rows: both sides of
every top-five league match from 2016/17 (history from 2010/11 feeds form,
the table and the elite flag). Features: the market's own log-odds again
(so the fit can correct its calibration - favourites slightly underrated,
longshots overrated), home, points per game over 5 and
12, points and goal difference beyond the price, share of shots on target,
league positions, elite club, losses in 5 (and elite x losses), and -
where both line-ups are stored - each side's rotation (regulars missing).

Two fits: without rotation (any match), and with it (used once both XIs
are known). Each is tested walk-forward - trained on every season before,
tested on the next - and refitted on everything for today's predictions.
Rebuilt daily (loop). Results in `state`; `predict` prices a match.
"""
from __future__ import annotations

import json
import math
import threading
import time
from collections import defaultdict, deque
from datetime import date

import numpy as np

import football as fb

FIRST_SEASON = "1617"
CODES = list(fb.CO_UK_OF)                       # E0 SP1 I1 D1 F1
BASE = ["mlogit", "home", "ppg5", "ppg12", "pvp12", "gdvp6", "sot6", "rank", "opp_rank", "elite", "losses5", "elite_x_losses5"]
ROT = BASE + ["rot", "opp_rot"]
LABELS = {"mlogit": "Market's own log-odds (favourite-longshot bias)", "home": "Playing at home", "ppg5": "Points per game, last 5", "ppg12": "Points per game, last 12",
          "pvp12": "Points beyond the price, last 12", "gdvp6": "Goal difference beyond the price, last 6",
          "sot6": "Share of shots on target, last 6", "rank": "League position", "opp_rank": "Opponent's league position",
          "elite": "Elite club (top 3 in 3 of the last 4 seasons)", "losses5": "Losses in the last 5",
          "elite_x_losses5": "Elite club on a losing run", "rot": "Own regulars missing", "opp_rot": "Opponent's regulars missing"}
LAMBDA = 2.0
state: dict = {"built": False}
_lock = threading.Lock()


def _logit(p):
    return math.log(p / (1 - p))


def _sig(z):
    return 1 / (1 + np.exp(-z))


def _season_order(s: str) -> int:
    return int(s[:2])


class _History:
    """Each club's recent league games, the tables as they stand and the
    final ones - walked forward match by match."""

    def __init__(self, k_gd: float, c_gd: float):
        self.games = defaultdict(lambda: deque(maxlen=12))            # (comp, team) -> games
        self.table = defaultdict(lambda: defaultdict(lambda: [0, 0, 0]))  # (comp, season) -> team -> pts, gd, played
        self.final: dict[tuple, int] = {}
        self.seasons: dict[str, list[str]] = defaultdict(list)          # comp -> seasons in order
        self.k, self.c = k_gd, c_gd

    def close_season(self, comp: str, season: str):
        t = self.table[(comp, season)]
        for i, team in enumerate(sorted(t, key=lambda x: (-t[x][0], -t[x][1]))):
            self.final[(comp, season, team)] = i + 1

    def prev(self, comp: str, season: str, n: int) -> list[str]:
        ss = [s for s in self.seasons[comp] if _season_order(s) < _season_order(season)]
        return ss[-n:]

    def rank(self, comp: str, season: str, team: str) -> int:
        t = self.table[(comp, season)]
        if t[team][2] >= 5:
            order = sorted(t, key=lambda x: (-t[x][0], -t[x][1]))
            return order.index(team) + 1
        p = self.prev(comp, season, 1)
        return self.final.get((comp, p[0], team), 18) if p else 10

    def feats(self, comp: str, season: str, team: str) -> dict | None:
        g = list(self.games[(comp, team)])
        if len(g) < 6:
            return None
        l5, l6 = g[-5:], g[-6:]
        sf = sum(x["sf"] for x in l6 if x["sf"] is not None)
        sa = sum(x["sa"] for x in l6 if x["sa"] is not None)
        tops = [self.final.get((comp, s, team), 99) <= 3 for s in self.prev(comp, season, 4)]
        elite = int(len(tops) >= 4 and sum(tops) >= 3)
        losses5 = sum(x["pts"] == 0 for x in l5)
        return {"ppg5": sum(x["pts"] for x in l5) / 5, "ppg12": sum(x["pts"] for x in g) / len(g),
                "pvp12": sum(x["pts"] - x["xpts"] for x in g) / len(g), "gdvp6": sum(x["gd"] - x["xgd"] for x in l6) / 6,
                "sot6": sf / (sf + sa) if sf + sa else 0.5, "rank": self.rank(comp, season, team), "elite": elite,
                "losses5": losses5, "elite_x_losses5": elite * losses5,
                "form": "".join("W" if x["pts"] == 3 else "D" if x["pts"] == 1 else "L" for x in reversed(g))}

    def add(self, m: dict):
        comp, season = m["comp"], m["season"]
        if not self.seasons[comp] or self.seasons[comp][-1] != season:
            if self.seasons[comp]:
                self.close_season(comp, self.seasons[comp][-1])
            self.seasons[comp].append(season)
        probs = m.get("probs")
        xgd = self.k * (probs[0] - probs[2]) + self.c if probs else 0.0
        for team, gf, ga, sf, sa, home in ((m["home"], m["hg"], m["ag"], m["hsot"], m["asot"], True),
                                           (m["away"], m["ag"], m["hg"], m["asot"], m["hsot"], False)):
            pts = 3 if gf > ga else 1 if gf == ga else 0
            if probs:
                pw = probs[0] if home else probs[2]
                xpts, xg = 3 * pw + probs[1], xgd if home else -xgd
            else:
                xpts, xg = 1.4, 0.0
            self.games[(comp, team)].append({"pts": pts, "gd": gf - ga, "xpts": xpts, "xgd": xg, "sf": sf, "sa": sa})
            c = self.table[(comp, season)][team]
            c[0] += pts; c[1] += gf - ga; c[2] += 1


def _matches(db) -> list[dict]:
    from sqlalchemy import text
    out = []
    for comp, season, day, h, a, hg, ag, ph, pd, pa, hs, as_, tour in db.execute(text(
            "SELECT comp, season, day, home, away, home_goals, away_goals, avg_h, avg_d, avg_a, home_sot, away_sot, tournament "
            "FROM football_matches WHERE comp = ANY(:c) AND season IS NOT NULL ORDER BY day, id"), {"c": CODES}):
        m = {"comp": comp, "season": season, "day": day, "home": h, "away": a, "hg": hg, "ag": ag, "hsot": hs, "asot": as_,
             "odds": (ph, pd, pa) if ph and pd and pa else None, "espn": tour == "espn"}
        if m["odds"]:
            inv = [1 / x for x in m["odds"]]
            s = sum(inv)
            m["probs"] = [x / s for x in inv]
        out.append(m)
    return out


def _fit(X, off, y, lam=LAMBDA, iters=40):
    A = np.hstack([np.ones((len(X), 1)), X])
    w = np.zeros(A.shape[1])
    R = lam * np.eye(A.shape[1]); R[0, 0] = 0
    for _ in range(iters):
        p = _sig(off + A @ w)
        g = A.T @ (y - p) - R @ w
        H = (A * (p * (1 - p))[:, None]).T @ A + R
        step = np.linalg.solve(H, g)
        w += step
        if np.abs(step).max() < 1e-9:
            break
    return w


def _logloss(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def build(db) -> dict:
    """Walk every match forward, build the rows, test walk-forward, refit on everything."""
    import football_lineups as fl
    ms = _matches(db)
    priced = [m for m in ms if m.get("probs")]
    X1 = np.array([m["probs"][0] - m["probs"][2] for m in priced])
    Y1 = np.array([m["hg"] - m["ag"] for m in priced])
    k_gd, c_gd = (float(v) for v in np.polyfit(X1, Y1, 1))
    try:
        rot = fl.rotation_table(db)
    except Exception:
        rot = {}
    hist = _History(k_gd, c_gd)
    rows = []
    for m in ms:
        if m.get("probs") and not m["espn"] and m["season"] >= FIRST_SEASON:
            fh, fa = hist.feats(m["comp"], m["season"], m["home"]), hist.feats(m["comp"], m["season"], m["away"])
            if fh and fa:
                for side, f, fo, team, opp, i in (("H", fh, fa, m["home"], m["away"], 0), ("A", fa, fh, m["away"], m["home"], 2)):
                    gd = (m["hg"] - m["ag"]) * (1 if side == "H" else -1)
                    rt = rot.get((m["comp"], team, m["day"]))
                    ro = rot.get((m["comp"], opp, m["day"]))
                    rows.append({"season": m["season"], "day": m["day"], "comp": m["comp"], "team": team, "opp": opp,
                                 "odds": m["odds"][i], "m": m["probs"][i], "y": int(gd > 0),
                                 "fav": int(m["odds"][i] <= m["odds"][2 - i]), "close": int(abs(m["odds"][0] - m["odds"][2]) <= 0.6),
                                 "home": int(side == "H"), "mlogit": _logit(m["probs"][i]), **{k: f[k] for k in BASE if k in f}, "opp_rank": fo["rank"],
                                 "rot": rt, "opp_rot": ro})
        hist.add(m)
    seasons = sorted({r["season"] for r in rows}, key=_season_order)
    tests = seasons[5:]

    def run(feats, use):
        rs = [r for r in rows if use(r)]
        X = np.array([[r[f] for f in feats] for r in rs], float)
        off = np.array([_logit(r["m"]) for r in rs]); y = np.array([r["y"] for r in rs], float)
        per, all_p, all_i = {}, [], []
        for ts in tests:
            tr = np.array([_season_order(r["season"]) < _season_order(ts) for r in rs])
            te = np.array([r["season"] == ts for r in rs])
            if tr.sum() < 2000 or te.sum() == 0:
                continue
            mu, sd = X[tr].mean(0), X[tr].std(0); sd[sd == 0] = 1
            w = _fit((X[tr] - mu) / sd, off[tr], y[tr])
            p = _sig(off[te] + w[0] + ((X[te] - mu) / sd) @ w[1:])
            idx = np.where(te)[0]
            all_p += list(p); all_i += list(idx)
            per[ts] = _score([rs[i] for i in idx], p, y[te], off[te])
        total = _score([rs[i] for i in all_i], np.array(all_p), y[all_i], off[all_i]) if all_i else None
        mu, sd = X.mean(0), X.std(0); sd[sd == 0] = 1
        w = _fit((X - mu) / sd, off, y)
        return {"feats": feats, "n": len(rs), "w": [float(v) for v in w], "mu": [float(v) for v in mu], "sd": [float(v) for v in sd],
                "test": total, "per_season": per}

    plain = run(BASE, lambda r: True)
    covered = [r for r in rows if r["rot"] is not None and r["opp_rot"] is not None]
    with_rot = run(ROT, lambda r: r["rot"] is not None and r["opp_rot"] is not None) if len(covered) > 0.5 * len(rows) else None
    new = {"built": True, "at": time.strftime("%Y-%m-%d %H:%M"), "rows": len(rows), "with_lineups": len(covered),
           "xgd": [k_gd, c_gd], "plain": plain, "rotation": with_rot, "hist": hist, "labels": LABELS,
           "lineup_regulars": _regulars_now(db)}
    with _lock:
        state.clear(); state.update(new)
    return new


def _score(rs, p, y, off):
    """Log-loss against the market's, and Rs 100 on each side whose chance x price beats 1."""
    m = _sig(off)
    bets = [(r, q) for r, q in zip(rs, p) if q * r["odds"] > 1]
    pl = sum((r["odds"] - 1) * 100 if r["y"] else -100 for r, _ in bets)
    fav = [(r, q) for r, q in bets if r["fav"]]
    plf = sum((r["odds"] - 1) * 100 if r["y"] else -100 for r, _ in fav)
    return {"rows": len(rs), "ll": round(_logloss(y, p), 5), "ll_market": round(_logloss(y, m), 5),
            "bets": len(bets), "pl": round(pl), "roi": round(pl / (100 * len(bets)), 4) if bets else None,
            "fav_bets": len(fav), "fav_roi": round(plf / (100 * len(fav)), 4) if fav else None}


def _regulars_now(db) -> dict[tuple[str, str], dict[str, int]]:
    """{(comp, team): {player id: starts}} - regulars from each club's last five stored league XIs."""
    import football_lineups as fl
    from sqlalchemy import text
    last = defaultdict(list)
    for comp, team, starters in db.execute(text(
            "SELECT comp, team, starters FROM football_lineups WHERE team IS NOT NULL AND day >= current_date - 120 ORDER BY day")):
        last[(comp, team)].append(json.loads(starters))
    return {k: fl.regulars(v[-5:]) for k, v in last.items() if len(v) >= 5}


def predict(comp: str, home: str, away: str, odds: tuple, day: date | None = None,
            xi_home: list[str] | None = None, xi_away: list[str] | None = None) -> dict | None:
    """Both sides' chances for a match of league `comp` (co.uk code) at prices
    (home, draw, away); with the rotation fit when both starting XIs (ESPN
    player ids) are given. Each side: our chance, the market's, chance x
    price, and the features' pushes on the log-odds, largest first."""
    if not state.get("built") or comp not in CODES or not (odds and all(odds)):
        return None
    hist: _History = state["hist"]
    season = fb._season_code(fb.current_season_start(day))
    fh, fa = hist.feats(comp, season, home), hist.feats(comp, season, away)
    if not (fh and fa):
        return None
    inv = [1 / x for x in odds]
    s = sum(inv)
    probs = [x / s for x in inv]
    regs = state.get("lineup_regulars") or {}

    def missing(team, xi):
        reg = regs.get((comp, team))
        if reg is None or not xi:
            return None
        return sum(1 for pid in reg if pid not in set(xi))
    rh, ra = missing(home, xi_home), missing(away, xi_away)
    use_rot = state.get("rotation") is not None and rh is not None and ra is not None
    fit = state["rotation"] if use_rot else state["plain"]
    out = {"model": "with line-ups" if use_rot else "before line-ups", "fit_at": state["at"], "sides": {}}
    for side, f, fo, i, rt, ro, team in (("home", fh, fa, 0, rh, ra, home), ("away", fa, fh, 2, ra, rh, away)):
        x = {**{k: f[k] for k in BASE if k in f}, "home": int(side == "home"), "mlogit": _logit(probs[i]),
             "opp_rank": fo["rank"], "rot": rt, "opp_rot": ro}
        z = _logit(probs[i]) + fit["w"][0]
        pushes = []
        for j, name in enumerate(fit["feats"]):
            c = fit["w"][j + 1] * ((x[name] - fit["mu"][j]) / fit["sd"][j])
            z += c
            pushes.append({"feature": name, "label": LABELS[name], "value": x[name], "push": round(c, 4)})
        p = float(1 / (1 + math.exp(-z)))
        pushes.sort(key=lambda d: -abs(d["push"]))
        out["sides"][side] = {"team": team, "p": round(p, 4), "market": round(probs[i], 4), "odds": odds[i],
                              "ev": round(p * odds[i] - 1, 4), "bet": p * odds[i] > 1, "pushes": pushes[:4],
                              "form": f["form"], "rotation": rt}
    return out


def summary() -> dict:
    """The model's state for the app: when built, size, and the walk-forward test."""
    if not state.get("built"):
        return {"built": False}
    def strip(f):
        if not f:
            return None
        return {"n": f["n"], "test": f["test"], "per_season": f["per_season"],
                "weights": {LABELS[k]: round(f["w"][j + 1], 4) for j, k in enumerate(f["feats"])}, "intercept": round(f["w"][0], 4)}
    return {"built": True, "at": state["at"], "rows": state["rows"], "with_lineups": state["with_lineups"],
            "plain": strip(state["plain"]), "rotation": strip(state["rotation"])}


def loop() -> None:
    """Build after start-up, then daily (line-ups and results keep arriving)."""
    from database import get_session_factory
    time.sleep(240)
    while True:
        try:
            db = get_session_factory()()
            try:
                st = build(db)
                t = st["plain"]["test"] or {}
                print(f"[football-ml] built on {st['rows']} rows ({st['with_lineups']} with line-ups); "
                      f"test log-loss {t.get('ll')} v market {t.get('ll_market')}, ROI {t.get('roi')} on {t.get('bets')} bets", flush=True)
            finally:
                db.close()
        except Exception as e:
            print(f"[football-ml] {type(e).__name__}: {e}", flush=True)
        time.sleep(24 * 3600)

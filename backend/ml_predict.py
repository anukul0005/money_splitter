"""Step 5 - spending predictions: tomorrow, the next 7 days, and by category,
each as a likely range (10th / 50th / 90th percentile), not one number.

    python ml_predict.py <user>          # walk-forward backtest + forecasts

Three models, compared on the same walk-forward backtest (trained only on
what came before each forecast day, tested on what followed):

  baseline   same-weekday median of the last 8 weeks (daily) / median of the
             last 8 weeks (weekly); range from the last 8 weeks' spread
  gbm        scikit-learn HistGradientBoosting, one quantile model each for
             the 10th, 50th and 90th percentile, on log(1 + amount)
  forest     RandomForest on log(1 + amount); the range from its trees

Personal spending only (shared is too sparse); salary is never used.
Ranges are then calibrated: widened or narrowed so that the 80% range
held the actual amount about 80% of the time in the backtest.
"""
from __future__ import annotations

import math
import statistics
from collections import defaultdict
from datetime import date, timedelta

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor

SINCE = "2024-01-01"
BIG_DAY = 1500
QUANTILES = (0.1, 0.5, 0.9)
TOP_CATEGORIES = ("Food & Dining", "Transport", "Groceries", "Alcohol")


# ── data ───────────────────────────────────────────────────────────────────
def series(db, user):
    """Daily personal totals (zero days included), per-category daily totals,
    and the user's daily shared-outing count, SINCE to the last spending day."""
    from ml_analysis import _rows
    personal, shared = _rows(db, user)
    last = max(r["date"] for r in personal)
    days = [date.fromisoformat(SINCE) + timedelta(days=i)
            for i in range((date.fromisoformat(last) - date.fromisoformat(SINCE)).days + 1)]
    tot, cat = defaultdict(float), defaultdict(lambda: defaultdict(float))
    for r in personal:
        tot[r["date"]] += r["amount"]
        c = r["category"] if r["category"] in TOP_CATEGORIES else "Everything else"
        cat[c][r["date"]] += r["amount"]
    outings = defaultdict(int)
    for d in {r["date"] for r in shared}:
        outings[d] = 1
    iso = [d.isoformat() for d in days]
    return (days, np.array([tot[d] for d in iso]),
            {c: np.array([cat[c][d] for d in iso]) for c in (*TOP_CATEGORIES, "Everything else")},
            np.array([outings[d] for d in iso], dtype=float))


# ── features (only data before index t) ───────────────────────────────────
def _days_since_big(y, t):
    for k in range(1, 61):
        if t - k >= 0 and y[t - k] > BIG_DAY:
            return k
    return 60


def daily_features(days, y, out, t):
    d = days[t] if t < len(days) else days[-1] + timedelta(days=t - len(days) + 1)
    past = y[max(0, t - 56):t]
    same_wd = [y[t - 7 * k] for k in range(1, 9) if t - 7 * k >= 0]
    return [d.weekday(), int(d.weekday() >= 5), d.day, d.month,
            y[t - 1] if t >= 1 else 0, y[t - 7] if t >= 7 else 0, y[t - 14] if t >= 14 else 0,
            y[max(0, t - 7):t].mean() if t else 0, y[max(0, t - 28):t].mean() if t else 0,
            float(np.median(y[max(0, t - 28):t])) if t else 0,
            float(np.quantile(past, .9)) if len(past) else 0,
            float(np.median(same_wd)) if same_wd else 0,
            _days_since_big(y, t), out[max(0, t - 7):t].sum()]


def weekly_features(days, y, out, t):
    """Forecast origin t: the 7 days t..t+6, from data before t."""
    d = days[t] if t < len(days) else days[-1] + timedelta(days=t - len(days) + 1)
    wk = [y[max(0, t - 7 * (k + 1)):t - 7 * k].sum() for k in range(8) if t - 7 * k > 0]
    return [d.weekday(), d.month, d.day,
            y[max(0, t - 7):t].sum(), y[max(0, t - 28):t].sum() / 4, y[max(0, t - 56):t].sum() / 8,
            float(np.median(wk)) if wk else 0, max(wk) if wk else 0,
            y[max(0, t - 28):t - 21].sum() if t >= 28 else 0,
            _days_since_big(y, t), out[max(0, t - 28):t].sum()]


def weekly_target(y, t):
    return y[t:t + 7].sum()


# ── models ─────────────────────────────────────────────────────────────────
class Baseline:
    def __init__(self, weekly=False):
        self.weekly = weekly

    def predict(self, y, t):
        if self.weekly:
            wk = [y[t - 7 * (k + 1):t - 7 * k].sum() for k in range(8) if t - 7 * (k + 1) >= 0]
            return np.quantile(wk, QUANTILES) if wk else np.zeros(3)
        same = [y[t - 7 * k] for k in range(1, 9) if t - 7 * k >= 0]
        past = y[max(0, t - 56):t]
        if not same:
            return np.zeros(3)
        lo, hi = np.quantile(past, [.1, .9])
        return np.array([lo, float(np.median(same)), hi])


class GBM:
    def fit(self, X, y):
        ly = np.log1p(y)
        self.m = [HistGradientBoostingRegressor(loss="quantile", quantile=q, max_iter=200, learning_rate=0.05,
                                                max_leaf_nodes=15, min_samples_leaf=15, random_state=0).fit(X, ly)
                  for q in QUANTILES]
        return self

    def predict(self, X):
        p = np.expm1(np.column_stack([m.predict(X) for m in self.m]))
        p = np.maximum(p, 0)
        return np.sort(p, axis=1)             # quantiles never cross


class Forest:
    def fit(self, X, y):
        self.m = RandomForestRegressor(n_estimators=150, min_samples_leaf=8, max_features=0.6,
                                       random_state=0, n_jobs=1).fit(X, np.log1p(y))
        return self

    def predict(self, X):
        per_tree = np.stack([t.predict(X) for t in self.m.estimators_])     # trees x rows
        return np.maximum(np.expm1(np.quantile(per_tree, QUANTILES, axis=0).T), 0)


# ── backtest ───────────────────────────────────────────────────────────────
def pinball(y, p):
    return float(np.mean([max(q * (y - p[i]), (q - 1) * (y - p[i])) for i, q in enumerate(QUANTILES)]))


def backtest(days, y, out, weekly=False, test_days=182, refit_every=14):
    """Walk-forward: for each forecast day t in the last test_days, models see
    only data before t. Learned models are refit every refit_every days."""
    n = len(y) - (7 if weekly else 0)
    start = max(n - test_days, 120)
    feats = weekly_features if weekly else daily_features
    target = (lambda t: weekly_target(y, t)) if weekly else (lambda t: y[t])
    first = 56
    res = {k: [] for k in ("baseline", "gbm", "forest")}
    gbm = forest = None
    for i, t in enumerate(range(start, n)):
        if i % refit_every == 0:
            idx = list(range(first, t - (6 if weekly else 0)))   # targets fully known before t
            X = np.array([feats(days, y, out, j) for j in idx])
            Y = np.array([target(j) for j in idx])
            gbm, forest = GBM().fit(X, Y), Forest().fit(X, Y)
        x = np.array([feats(days, y, out, t)])
        actual = target(t)
        res["baseline"].append((actual, Baseline(weekly).predict(y, t)))
        res["gbm"].append((actual, gbm.predict(x)[0]))
        res["forest"].append((actual, forest.predict(x)[0]))
    return res


def score(pairs, widen=1.0):
    ys = np.array([a for a, _ in pairs])
    ps = np.array([widen_range(p, widen) for _, p in pairs])
    cover = np.mean((ys >= ps[:, 0]) & (ys <= ps[:, 2]))
    return {"mae": float(np.mean(np.abs(ys - ps[:, 1]))), "pinball": float(np.mean([pinball(a, p) for a, p in zip(ys, ps)])),
            "coverage": float(cover), "width": float(np.mean(ps[:, 2] - ps[:, 0])), "n": len(ys)}


def widen_range(p, k):
    """Scale the interval around the median by k (in log space, so it stays positive)."""
    lo, mid, hi = np.log1p(np.maximum(p, 0))
    return np.maximum(np.expm1([mid - (mid - lo) * k, mid, mid + (hi - mid) * k]), 0)


def calibrate(pairs, target=0.8):
    """The widening factor that makes the 10-90 range hold ~80% in the backtest."""
    best = min((abs(score(pairs, k)["coverage"] - target), k) for k in np.arange(0.5, 3.01, 0.05))
    return float(best[1])


# ── forecasts for now ──────────────────────────────────────────────────────
def forecast(days, y, out, model_cls, widen_d=1.0, widen_w=1.0):
    t = len(y)                                    # tomorrow = the day after the data ends
    idx = list(range(56, t))
    Xd = np.array([daily_features(days, y, out, j) for j in idx]); Yd = y[56:t]
    tom = model_cls().fit(Xd, Yd).predict(np.array([daily_features(days, y, out, t)]))[0]
    idx_w = list(range(56, t - 6))
    Xw = np.array([weekly_features(days, y, out, j) for j in idx_w]); Yw = np.array([weekly_target(y, j) for j in idx_w])
    wk = model_cls().fit(Xw, Yw).predict(np.array([weekly_features(days, y, out, t)]))[0]
    return widen_range(tom, widen_d), widen_range(wk, widen_w)


def main():
    import argparse, os, sys, types
    sys.modules.setdefault("pywebpush", types.SimpleNamespace(WebPushException=Exception, webpush=None))
    ap = argparse.ArgumentParser(); ap.add_argument("user"); args = ap.parse_args()
    from sqlalchemy import func
    from database import get_session_factory
    from models import User
    db = get_session_factory()(); db.connection().exec_driver_sql("SET TRANSACTION READ ONLY")
    user = db.query(User).filter(func.lower(User.name) == args.user.lower()).one()
    days, y, cats, out = series(db, user)
    db.rollback(); db.close()
    print(f"{len(y)} days {days[0]} to {days[-1]}, total Rs {y.sum():,.0f}, zero days {np.mean(y == 0) * 100:.0f}%\n")

    report = {}
    for label, weekly in (("TOMORROW (daily)", False), ("NEXT 7 DAYS", True)):
        res = backtest(days, y, out, weekly=weekly)
        print(label, "- walk-forward backtest over the last", len(res["gbm"]), "forecast days")
        print(f"  {'model':9} {'MAE':>8} {'pinball':>8} {'raw 80% cover':>14} {'calibrated cover':>17} {'avg range':>10}")
        for m, pairs in res.items():
            raw = score(pairs); k = calibrate(pairs); cal = score(pairs, k)
            report[(label, m)] = (raw, k, cal)
            print(f"  {m:9} {raw['mae']:>8,.0f} {raw['pinball']:>8,.0f} {raw['coverage'] * 100:>13.0f}% "
                  f"{cal['coverage'] * 100:>16.0f}% {cal['width']:>10,.0f}  (widen x{k:.2f})")
        print()

    # per-category weekly
    print("BY CATEGORY, next 7 days - MAE (Rs): baseline vs gbm vs forest")
    for c, yc in cats.items():
        r = backtest(days, yc, out, weekly=True)
        print(f"  {c:16} " + "  ".join(f"{m} {score(p)['mae']:>6,.0f}" for m, p in r.items()))


if __name__ == "__main__":
    main()


# ── the app's forecast (GET /stats/predictions) ───────────────────────────
# Each forecast uses the model that did best on the walk-forward backtest,
# with the widening that made its 80% range hold ~80% of actual outcomes
# there (measured 2026-10-11 on the user's 2024-26 data; re-run main() to
# refresh). (model, widen)
PLAN = {
    "next_day": ("gbm", 1.20),
    "next_7_days": ("gbm", 1.60),
    "Food & Dining": ("forest", 1.65),
    "Transport": ("baseline", 1.85),
    "Groceries": ("gbm", 1.55),
    "Alcohol": ("baseline", 1.45),
    "Everything else": ("gbm", 1.70),
}
MODELS = {"gbm": GBM, "forest": Forest}


def _weekly(days, y, out, model, widen):
    t = len(y)
    if model == "baseline":
        p = Baseline(weekly=True).predict(y, t)
    else:
        idx = list(range(56, t - 6))
        X = np.array([weekly_features(days, y, out, j) for j in idx])
        Y = np.array([weekly_target(y, j) for j in idx])
        p = MODELS[model]().fit(X, Y).predict(np.array([weekly_features(days, y, out, t)]))[0]
    return widen_range(p, widen)


_cache: dict = {}


def predict_now(db, user) -> dict:
    days, y, cats, out = series(db, user)
    # Same user, same data, same day: the same answer - fitting takes seconds.
    key = (user.id, date.today().isoformat(), len(y), round(float(y.sum()), 2))
    if key in _cache:
        return _cache[key]
    last = days[-1]
    t = len(y)
    m, k = PLAN["next_day"]
    idx = list(range(56, t))
    Xd = np.array([daily_features(days, y, out, j) for j in idx])
    nd = widen_range(MODELS[m]().fit(Xd, y[56:t]).predict(np.array([daily_features(days, y, out, t)]))[0], k)
    wk = _weekly(days, y, out, *PLAN["next_7_days"])
    rng = lambda p: {"low": round(float(p[0])), "likely": round(float(p[1])), "high": round(float(p[2]))}
    cat_out = []
    for c, yc in cats.items():
        mdl, kk = PLAN[c]
        cat_out.append({"category": c, "model": mdl, **rng(_weekly(days, yc, out, mdl, kk))})
    cat_out.sort(key=lambda x: -x["likely"])
    typical_week = float(np.median([y[i:i + 7].sum() for i in range(max(0, t - 91), t - 6)]))
    # The same 7-day model re-run as if it were each of the last 4 weeks -
    # trained only on what came before that week - against what was spent:
    # an honest predicted-vs-actual record from the first day.
    checks = []
    for k in range(4, 0, -1):
        o = t - 7 * k
        if o < 120:
            continue
        p = _weekly(days[:o], y[:o], out[:o], *PLAN["next_7_days"])
        checks.append({"from": days[o].isoformat(), "to": days[o + 6].isoformat(), **rng(p),
                       "actual": round(float(y[o:o + 7].sum()))})
    for c in cat_out:
        # A top end beyond two typical weeks of *all* spending isn't a range a
        # person can use: the page says so rather than drawing it.
        c["unpredictable"] = c["high"] > 2 * typical_week
    stale = (date.today() - last).days
    result = {
        "data_until": last.isoformat(), "days_since_data": stale,
        "next_day": {"date": (last + timedelta(days=1)).isoformat(), "model": PLAN["next_day"][0], **rng(nd)},
        "next_7_days": {"from": (last + timedelta(days=1)).isoformat(), "to": (last + timedelta(days=7)).isoformat(),
                        "model": PLAN["next_7_days"][0], **rng(wk)},
        "categories": cat_out,
        "typical_week": round(typical_week),
        "checks": checks,
        "coverage": 80,
    }
    _cache.clear()
    _cache[key] = result
    return result


REFRESH_AFTER = 5     # personal expenses added (or removed) before retraining


def _personal_count(db, user) -> int:
    from auth import caller_groups
    from models import Expense
    ids = [g.id for g in caller_groups(db, user, history=False) if len(g.members) == 1]
    return db.query(Expense).filter(Expense.group_id.in_(ids)).count() if ids else 0


def predict_cached(db, user, force: bool = False) -> dict:
    """The saved forecast while fewer than REFRESH_AFTER personal expenses
    have changed since it was made; otherwise a fresh one, saved. Saved on
    the user's row, so it survives the server sleeping or restarting."""
    import json
    from datetime import datetime, timezone
    count = _personal_count(db, user)
    if user.forecast_json and user.forecast_basis is not None and not force:
        changed = abs(count - user.forecast_basis)
        if changed < REFRESH_AFTER:
            saved = json.loads(user.forecast_json)
            return {**saved, "cached": True, "changes_since": changed, "refresh_after": REFRESH_AFTER}
    result = predict_now(db, user)
    result["computed_at"] = datetime.now(timezone.utc).isoformat()
    user.forecast_json = json.dumps(result)
    user.forecast_basis = count
    db.commit()
    return {**result, "cached": False, "changes_since": 0, "refresh_after": REFRESH_AFTER}

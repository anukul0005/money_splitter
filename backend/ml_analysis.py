"""On-demand "ML analysis" for the app (GET /stats/ml-analysis).

The same Step 4 analysis as ml_step4.py, but built live from the database
instead of the Step 3 CSVs, so it's current whenever it's opened:

  personal  every expense in the user's personal (single-member) groups
  shared    the user's share of every shared-group expense, whole-day
            expenses as their category parts

Times come from txn_time, else the Early/Day/Night label the user gave.
Salary is never used (the user started earning only after Sep 2025).
Returns the findings plus the series the page charts.
"""
from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import date, timedelta

import ml_step4 as m4
from ml_step3 import category_of, hour_of, time_period
from models import Expense, Group, Member
from routers.stats import _member_share
from spend_categories import categorize

SINCE = "2024-01-01"


def _rows(db, user) -> tuple[list[dict], list[dict]]:
    from sqlalchemy import func
    me = user.name.lower()
    mine = [gid for (gid,) in db.query(Member.group_id).filter(func.lower(Member.name) == me)]
    groups = {g.id: g for g in db.query(Group).filter(Group.id.in_(mine))}
    personal, shared = [], []
    for e in db.query(Expense).filter(Expense.group_id.in_(mine), Expense.date >= SINCE):
        if not e.date or e.amount <= 0:
            continue
        h = hour_of(e.txn_time)
        period = time_period(h) if h is not None else (e.time_period or "Unknown")
        base = {"date": e.date[:10], "month": e.date[:7], "hour": h, "time_period": period}
        if len(groups[e.group_id].members) == 1:
            cat, sub = category_of(e)
            if not sub:
                # Older entries have a category but no subcategory (the field
                # came later): the keyword rules read it from the description.
                c2, s2 = categorize(e.title or "", e.amount)
                sub = s2 if c2 == cat else ""
            personal.append({**base, "amount": float(e.amount), "category": cat, "subcategory": sub})
            continue
        share = _member_share(e, me) or 0.0
        if share <= 0:
            continue
        slices = [(p.category, p.subcategory or "", p.amount) for p in e.parts] if e.parts else [(*category_of(e), e.amount)]
        for cat, sub, amt in slices:
            shared.append({**base, "amount": share * (amt / e.amount), "category": cat, "subcategory": sub})
    return personal, shared


def run(db, user) -> dict:
    m4.BOOT_N = 500                       # fewer resamples: this runs on a request
    personal, shared = _rows(db, user)
    if not personal:
        return {"empty": True}
    end = date.fromisoformat(max(r["date"] for r in personal + shared))
    start = date.fromisoformat(SINCE)
    _, fp = m4.analyse("personal", personal, start, end, None)
    s_start = max(start, date.fromisoformat(min(r["date"] for r in shared))) if shared else start
    fs = m4.analyse("shared", shared, s_start, end, None)[1] if shared else None
    _, late = m4.late_night_food(personal)
    _, wants = m4.unnecessary(personal, end)

    def weekend_series(rows, s):
        days = [s + timedelta(days=i) for i in range((end - s).days + 1)]
        tot = defaultdict(float)
        for r in rows:
            tot[r["date"]] += r["amount"]
        bm = defaultdict(lambda: {"we": [], "wd": []})
        for d in days:
            bm[d.isoformat()[:7]]["we" if d.weekday() >= 5 else "wd"].append(tot.get(d.isoformat(), 0))
        return [{"m": m, "diff": round(statistics.fmean(v["we"]) - statistics.fmean(v["wd"]), 2)}
                for m, v in sorted(bm.items()) if v["we"] and v["wd"]]

    food = defaultdict(lambda: {"x": 0, "y": 0.0})
    for r in personal:
        if r["category"] == "Food & Dining":
            food[r["month"]]["y"] += r["amount"]
            if r["hour"] in m4.LATE_NIGHT_HOURS:
                food[r["month"]]["x"] += 1

    six = (end.replace(day=1) - timedelta(days=150)).isoformat()[:7]
    twelve = (end.replace(day=1) - timedelta(days=330)).isoformat()[:7]
    trend = defaultdict(lambda: [0.0, 0.0])
    for r in personal:
        if m4.is_discretionary(r):
            k = r["category"] if m4.DISCRETIONARY.get(r["category"]) is None else f"{r['category']} > {r['subcategory'] or 'other eating out'}"
            if r["month"] >= six: trend[k][0] += r["amount"]
            elif r["month"] >= twelve: trend[k][1] += r["amount"]

    clean = lambda d: {k: (round(v, 2) if isinstance(v, float) else v) for k, v in d.items()}
    return {
        "window": [SINCE, end.isoformat()],
        "counts": {"personal": len(personal), "shared": len(shared)},
        "time_of_day": {"personal": {p: clean(v) for p, v in fp["time_of_day"]["per_period"].items()},
                        "shared": {p: clean(v) for p, v in fs["time_of_day"]["per_period"].items()} if fs else None,
                        "night_minus_early": round(fp["time_of_day"]["night_minus_early_per_day"], 2),
                        "ci": [round(x, 2) for x in fp["time_of_day"]["ci"]]},
        "weekend": {"personal": clean({k: v for k, v in fp["weekend"].items() if k != "ci"}) | {"ci": [round(x, 2) for x in fp["weekend"]["ci"]]},
                    "shared": (clean({k: v for k, v in fs["weekend"].items() if k != "ci"}) | {"ci": [round(x, 2) for x in fs["weekend"]["ci"]]}) if fs else None,
                    "series": weekend_series(personal, start)},
        "late_night_food": {"months": [{"m": m, "x": v["x"], "y": round(v["y"], 2)} for m, v in sorted(food.items())],
                            "per_order": round(late["slope_total_per_order"], 2), "ci": [round(x, 2) for x in late["ci"]],
                            "other_per_order": round(late["slope_other_per_order"], 2),
                            "orders": late["late_orders"], "amount": round(late["late_amount"], 2)},
        "avg_payment": {"personal": {p: clean(v) for p, v in fp["avg_payment"].items()},
                        "shared": {p: clean(v) for p, v in fs["avg_payment"].items()} if fs else None},
        "wants": {"total": round(wants["discretionary_total"], 2), "share": round(wants["share_of_all"] * 100, 1),
                  "items": [{"k": k.replace("Food & Dining > ", "").replace("Shopping > ", ""), "amt": round(a, 2), "n": n,
                             "trend": round((trend[k][0] - trend[k][1]) / trend[k][1] * 100) if trend[k][1] else None}
                            for k, a, n in wants["ranked"][:8]]},
    }

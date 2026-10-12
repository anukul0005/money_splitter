"""Step 7 - the spending insights dashboard (GET /stats/insights).

Built live from the database on every open (no cache), so new transactions
show straight away. Personal spending plus the user's share of shared
spending, whole-day expenses as their category parts; salary is never used.

  summary    today, yesterday, this week, this month - each against the usual
             amount by the same point (same weekday / same days of the week /
             same days of the month), so a part-week isn't compared to a whole one
  daily      the last 30 days, with the unusual-day line
  patterns   by category, time of day and weekday, over 30 / 90 / 365 days
  unusual    categories up 30%+ and Rs 500+ on their normal in the last 30
             days; days above the last year's 90th percentile
  progress   this month against previous months; against the savings
             budgets (Step 6); the current 7-day forecast (Step 5) against
             what's been spent so far, and its last 4 weeks' checks

The forecast and budgets come from their saved results (refreshed after 5
expense changes). GET /stats/insights/version is the cheap "has anything
changed?" check the page polls.
"""
from __future__ import annotations

import calendar
import json
import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from ml_analysis import _rows

IST = timezone(timedelta(hours=5, minutes=30))
WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
PERIODS = ["Early", "Day", "Night"]
WINDOWS = (30, 90, 365)
TOP_CATEGORIES = 7


def today_ist() -> date:
    return datetime.now(IST).date()


def signature(db, user) -> str:
    """Changes whenever an expense is added, removed or its amount edited."""
    from sqlalchemy import func
    from auth import caller_groups
    from models import Expense
    ids = [g.id for g in caller_groups(db, user, history=False)]
    if not ids:
        return "0"
    n, top, tot = db.query(func.count(Expense.id), func.max(Expense.id),
                           func.coalesce(func.sum(Expense.amount), 0)).filter(Expense.group_id.in_(ids)).one()
    return f"{n}:{top}:{round(float(tot), 2)}"


def _months_back(d: date, k: int) -> date:
    """First day of the month k months before d's month."""
    m = d.year * 12 + d.month - 1 - k
    return date(m // 12, m % 12 + 1, 1)


def build(db, user) -> dict:
    personal, shared = _rows(db, user)
    today = today_ist()
    iso_today = today.isoformat()
    for r in personal:
        r["mine"] = True
    for r in shared:
        r["mine"] = False
    rows = [r for r in personal + shared if r["date"] <= iso_today]
    if len(personal) < 30:
        return {"empty": True}

    day_all, day_mine = defaultdict(float), defaultdict(float)
    for r in rows:
        day_all[r["date"]] += r["amount"]
        if r["mine"]:
            day_mine[r["date"]] += r["amount"]

    def total(a: date, b: date, mine=False) -> float:            # a..b inclusive
        src = day_mine if mine else day_all
        return sum(src.get((a + timedelta(days=i)).isoformat(), 0.0) for i in range((b - a).days + 1))

    # ── summary: each against the usual amount by the same point ──
    yday = today - timedelta(days=1)
    monday = today - timedelta(days=today.weekday())
    first = today.replace(day=1)
    dim = calendar.monthrange(today.year, today.month)[1]
    usual_day = lambda d: statistics.fmean(total(d - timedelta(days=7 * k), d - timedelta(days=7 * k)) for k in range(1, 9))
    usual_week = statistics.fmean(total(monday - timedelta(days=7 * k), today - timedelta(days=7 * k)) for k in range(1, 13))
    prev = []
    for k in range(1, 7):
        f = _months_back(today, k)
        last_day = min(today.day, calendar.monthrange(f.year, f.month)[1])
        prev.append(total(f, f.replace(day=last_day)))
    avg_daily_90 = total(today - timedelta(days=90), yday) / 90
    month_so_far = total(first, today)
    summary = {
        "today": {"date": iso_today, "amount": round(total(today, today)), "personal": round(total(today, today, True)),
                  "usual": round(usual_day(today))},
        "yesterday": {"date": yday.isoformat(), "amount": round(total(yday, yday)), "personal": round(total(yday, yday, True)),
                      "usual": round(usual_day(yday))},
        "week": {"from": monday.isoformat(), "amount": round(total(monday, today)),
                 "personal": round(total(monday, today, True)), "usual": round(usual_week)},
        "month": {"from": first.isoformat(), "amount": round(month_so_far), "personal": round(total(first, today, True)),
                  "usual": round(statistics.fmean(prev)), "last_month": round(prev[0]),
                  "projected": round(month_so_far + avg_daily_90 * (dim - today.day)), "day": today.day, "days": dim},
    }

    # ── the last 30 days, and what counts as an unusual day ──
    year_days = sorted(day_all.get((today - timedelta(days=i)).isoformat(), 0.0) for i in range(1, 366))
    threshold = year_days[int(len(year_days) * 0.9)]
    daily = [{"d": (today - timedelta(days=i)).isoformat(),
              "amount": round(day_all.get((today - timedelta(days=i)).isoformat(), 0.0)),
              "personal": round(day_mine.get((today - timedelta(days=i)).isoformat(), 0.0))}
             for i in range(29, -1, -1)]

    # ── patterns over 30 / 90 / 365 days ──
    def patterns(n: int) -> dict:
        start = (today - timedelta(days=n - 1)).isoformat()
        rs = [r for r in rows if r["date"] >= start]
        tot = sum(r["amount"] for r in rs) or 1.0
        cats, per, wd = defaultdict(float), defaultdict(float), [0.0] * 7
        for r in rs:
            cats[r["category"]] += r["amount"]
            per[r["time_period"]] += r["amount"]
            wd[date.fromisoformat(r["date"]).weekday()] += r["amount"]
        ranked = sorted(cats.items(), key=lambda x: -x[1])
        top = ranked[:TOP_CATEGORIES]
        rest = sum(v for _, v in ranked[TOP_CATEGORIES:])
        if rest:
            top.append(("Everything else", rest))
        n_wd = [sum(1 for i in range(n) if (today - timedelta(days=i)).weekday() == w) for w in range(7)]
        timed = sum(per[p] for p in PERIODS) or 1.0
        return {"days": n, "total": round(tot), "per_day": round(tot / n),
                "categories": [{"name": c, "amount": round(v), "share": round(v / tot * 100, 1)} for c, v in top],
                "periods": [{"name": p, "amount": round(per[p]), "per_day": round(per[p] / n),
                             "share": round(per[p] / timed * 100, 1)} for p in PERIODS],
                "untimed": round(sum(v for k, v in per.items() if k not in PERIODS)),
                "weekdays": [{"day": WEEKDAYS[w], "per_day": round(wd[w] / max(n_wd[w], 1))} for w in range(7)]}

    # ── unusual: rising categories, expensive days ──
    recent_from = (today - timedelta(days=29)).isoformat()
    normal_from = (today - timedelta(days=364)).isoformat()
    scale = 30 / 335
    now_c, norm_c = defaultdict(float), defaultdict(float)
    now_s, norm_s = defaultdict(float), defaultdict(float)
    for r in rows:
        if r["date"] >= recent_from:
            now_c[r["category"]] += r["amount"]
            now_s[(r["category"], r["subcategory"] or "")] += r["amount"]
        elif r["date"] >= normal_from:
            norm_c[r["category"]] += r["amount"] * scale
            norm_s[(r["category"], r["subcategory"] or "")] += r["amount"] * scale
    rising = []
    for c, now in now_c.items():
        if c == "Uncategorized":
            continue                      # nothing to act on until it's classified
        norm = norm_c.get(c, 0.0)
        if now >= norm * 1.3 and now - norm >= 500:
            subs = sorted(((s, v - norm_s.get((cc, s), 0.0)) for (cc, s), v in now_s.items() if cc == c), key=lambda x: -x[1])
            biggest = max((r for r in rows if r["date"] >= recent_from and r["category"] == c), key=lambda r: r["amount"])
            rising.append({"category": c, "recent_30": round(now), "normal_30": round(norm),
                           "up_pct": round((now - norm) / norm * 100) if norm >= 50 else None,
                           "driver": subs[0][0] if subs and subs[0][0] else None,
                           "biggest": {"title": biggest["title"] or biggest["subcategory"] or c,
                                       "amount": round(biggest["amount"]), "date": biggest["date"]}})
    rising.sort(key=lambda x: -(x["recent_30"] - x["normal_30"]))
    big_days = []
    for d in daily:
        if d["amount"] > threshold:
            items = sorted((r for r in rows if r["date"] == d["d"]), key=lambda r: -r["amount"])[:3]
            big_days.append({"date": d["d"], "amount": d["amount"], "times": round(d["amount"] / max(threshold, 1), 1),
                             "top": [{"title": r["title"] or r["subcategory"] or r["category"],
                                      "amount": round(r["amount"]), "category": r["category"],
                                      "shared": not r["mine"]} for r in items]})
    big_days.reverse()

    # ── progress: previous months ──
    months = []
    for k in range(6, 0, -1):
        f = _months_back(today, k)
        last = f.replace(day=calendar.monthrange(f.year, f.month)[1])
        months.append({"m": f.isoformat()[:7], "amount": round(total(f, last)), "personal": round(total(f, last, True))})
    months.append({"m": first.isoformat()[:7], "amount": round(month_so_far), "personal": round(total(first, today, True)),
                   "projected": summary["month"]["projected"], "current": True})

    # ── progress: savings budgets (Step 6) ──
    budgets = None
    recs = json.loads(user.recs_json) if getattr(user, "recs_json", None) else None
    if recs and not recs.get("empty"):
        import ml_recommend as mr
        plan = json.loads(user.savings_plan_json) if getattr(user, "savings_plan_json", None) else None
        targets = plan["targets"] if plan else {r["key"]: r["budget"] for r in recs["recommendations"]}
        spent = mr.areas([r for r in rows if r["date"] >= first.isoformat()])
        pace = today.day / dim
        items = [{"key": k, "title": mr.REDUCE.get(k, (k,))[0], "budget": round(b), "so_far": round(spent.get(k, 0.0)),
                  "pace": round(b * pace)} for k, b in targets.items()]
        items.sort(key=lambda x: -(x["so_far"] - x["pace"]))
        overall = recs["patterns"]["monthly_total"] - recs["save_month"]
        budgets = {"source": "plan" if plan else "suggested", "items": items,
                   "overall": {"budget": round(overall), "so_far": round(month_so_far), "pace": round(overall * pace)}}

    # ── progress: the forecast (Step 5) against what's happened ──
    # Personal spending is known only up to its last statement/entry: days
    # after that aren't counted as zero, they're "not in yet".
    personal_until = max(r["date"] for r in rows if r["mine"])
    forecast = None
    fc = json.loads(user.forecast_json) if getattr(user, "forecast_json", None) else None
    if fc:
        w = fc["next_7_days"]
        a, b = date.fromisoformat(w["from"]), date.fromisoformat(w["to"])
        upto = min(b, today, date.fromisoformat(personal_until))
        nd = fc["next_day"]
        forecast = {
            "week": {**{k: w[k] for k in ("from", "to", "low", "likely", "high")},
                     "spent": round(total(a, upto, True)) if upto >= a else 0,
                     "days_in": max((upto - a).days + 1, 0), "done": upto >= b},
            "day": {**{k: nd[k] for k in ("date", "low", "likely", "high")},
                    "spent": round(day_mine.get(nd["date"], 0.0)) if nd["date"] <= personal_until else None},
            "checks": fc.get("checks", []),
            "made": fc.get("computed_at"),
        }

    return {
        "today": iso_today,
        "data_until": max(r["date"] for r in rows),
        "personal_until": personal_until,
        "summary": summary,
        "daily": daily, "threshold": round(threshold),
        "patterns": {str(n): patterns(n) for n in WINDOWS},
        "unusual": {"categories": rising[:6], "days": big_days, "expected_days": 3},
        "progress": {"months": months, "budgets": budgets, "forecast": forecast},
        "signature": signature(db, user),
        "built_at": datetime.now(timezone.utc).isoformat(),
    }

"""Step 6 - personalized savings recommendations (GET /stats/recommendations).

From the user's spending (personal, plus their share of shared spending;
salary never used):

  1. high-spending patterns - top categories, time of day, day of week
  2. each category's last 30 days against its own 12-month average
  3. overspending flags - a category up 30%+ and Rs 500+ on its normal, and
     unusually expensive days
  4. saving opportunities - wants only, each with a realistic cut (REDUCE),
     plus two habits: late-night food and quick-commerce grocery runs
  5. potential savings a month and a year, from the 12-month averages
  6. advice from the LLM (category totals only - no payee names), with
     built-in tips when it's unavailable
  7. ranked by monthly saving x how easy the change is
  8. tracking - once the user starts the plan, actual spending since then
     against the baseline it was started from

Cached on the user's row like the forecast: refreshed after 5 expenses
change, or when the plan is started or stopped.
"""
from __future__ import annotations

import json
import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from ml_analysis import _rows

LATE_NIGHT_HOURS = {22, 23, 0}
EASE_WEIGHT = {3: 1.0, 2: 0.7, 1: 0.4}
EASE_LABEL = {3: "Easy", 2: "Medium", 1: "Hard"}
REFRESH_AFTER = 5
MIN_MONTHLY = 300          # ignore areas smaller than this a month
DAYS_PER_MONTH = 30.44

# area key -> (title, realistic cut, ease 1-3, fallback tip)
REDUCE = {
    "late_night_food": ("Late-night food", 0.50, 3,
                        "Eat a proper dinner and keep a snack at home, so 10 pm–1 am orders become the exception."),
    "Food & Dining > Food delivery": ("Food delivery", 0.40, 3,
                                      "Order on weekends only, and cook or pick up on weekdays."),
    "Food & Dining > Restaurants": ("Eating out", 0.25, 2,
                                    "Cap restaurant meals to a set number a week and choose one cheaper place you like."),
    "Food & Dining > Street food & snacks": ("Snacks & street food", 0.20, 2,
                                            "Carry a snack from home for the afternoon slump."),
    "Food & Dining > other eating out": ("Other eating out", 0.20, 2,
                                         "Plan meals for the week so fewer of them are bought on the go."),
    "Food & Dining > Tea & coffee": ("Tea & coffee", 0.20, 2, "Make tea or coffee at home or at work most days."),
    "Food & Dining > Juice & beverages": ("Drinks & juices", 0.30, 3, "Carry a water bottle; buy drinks only as a treat."),
    "Food & Dining > Sweets & bakery": ("Sweets & bakery", 0.30, 3, "Keep sweets to weekends."),
    "Alcohol": ("Alcohol", 0.30, 2, "Set alcohol-free days each week and buy for home rather than at bars."),
    "Tobacco & Paan": ("Tobacco & paan", 0.50, 1, "Cut down a step at a time - fewer each week."),
    "Entertainment": ("Entertainment", 0.20, 2, "Review subscriptions and plan outings rather than booking on impulse."),
    "Shopping > Clothing & footwear": ("Clothes & shoes", 0.30, 2,
                                       "Make a list before buying and wait 48 hours on anything not on it."),
    "Shopping > Online shopping": ("Online shopping", 0.25, 2, "Leave items in the cart for a day before buying."),
    "Shopping > Electronics & mobile": ("Gadgets", 0.20, 1, "Upgrade only when something actually stops working."),
    "Transport > Cab & auto": ("Cabs & autos", 0.15, 2, "Use the metro or a bus for regular routes; keep cabs for late nights."),
    "Groceries > Quick commerce": ("Quick-commerce runs", 0.15, 2,
                                   "Do one planned weekly grocery shop instead of many small Blinkit/Zepto orders."),
}


def _key(r) -> str | None:
    c, s = r["category"], r.get("subcategory") or ""
    if c in ("Alcohol", "Tobacco & Paan", "Entertainment"):
        return c
    if c == "Food & Dining":
        return f"Food & Dining > {s or 'other eating out'}"
    k = f"{c} > {s}"
    return k if k in REDUCE else None


def areas(rows, scale: float = 1.0) -> dict:
    """Spending per saving area (REDUCE keys) in rows, times scale.
    Late-night food is its own area, not also counted in its food subcategory."""
    out = defaultdict(float)
    for r in rows:
        if r["category"] == "Food & Dining" and r["hour"] in LATE_NIGHT_HOURS:
            out["late_night_food"] += r["amount"]
            continue
        k = _key(r)
        if k:
            out[k] += r["amount"]
    return {k: v * scale for k, v in out.items()}


def _llm(facts: dict) -> dict | None:
    """Short summary + one practical tip per area, from category totals only."""
    from statement_extractor import GROQ_MODEL
    import expense_classifier as ec
    import urllib.request
    prompt = ("You are a practical personal-finance coach for someone in India. From these spending facts "
              "(rupees, monthly averages over the last 12 months, and recent changes), write: a 2-3 sentence "
              "summary of where money goes and the biggest realistic win; and for each recommendation key, one "
              "specific, doable action in under 25 words. Plain, friendly, no lecturing, no percentages already "
              "given. Respond with ONLY JSON: {\"summary\": string, \"tips\": {\"<key>\": string}}")
    payload = json.dumps({"model": GROQ_MODEL, "temperature": 0.3, "response_format": {"type": "json_object"},
                          "messages": [{"role": "system", "content": prompt},
                                       {"role": "user", "content": json.dumps(facts, ensure_ascii=False)}]}).encode()
    for url, key, extra in ec._providers():
        req = urllib.request.Request(url, data=payload, method="POST", headers={
            "Authorization": f"Bearer {key}", "Content-Type": "application/json", "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            **extra})
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                out = json.loads(json.loads(resp.read().decode())["choices"][0]["message"]["content"])
            if isinstance(out.get("tips"), dict):
                return out
        except Exception:
            continue
    return None


def build(db, user) -> dict:
    personal, shared = _rows(db, user)
    rows = personal + shared
    if len(personal) < 30:
        return {"empty": True}
    end = date.fromisoformat(max(r["date"] for r in rows))
    year_from = end - timedelta(days=365)
    recent_from = end - timedelta(days=30)
    year = [r for r in rows if date.fromisoformat(r["date"]) > year_from]
    months = 12.0

    # ── 1. high-spending patterns (last 12 months) ──
    cat_tot = defaultdict(float)
    for r in year:
        cat_tot[r["category"]] += r["amount"]
    total_month = sum(cat_tot.values()) / months
    per_period, per_dow = defaultdict(float), defaultdict(float)
    for r in year:
        per_period[r["time_period"]] += r["amount"]
        per_dow[date.fromisoformat(r["date"]).weekday()] += r["amount"]
    dows = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"]
    timed = sum(v for k, v in per_period.items() if k != "Unknown") or 1
    top_period = max((k for k in per_period if k != "Unknown"), key=lambda k: per_period[k], default=None)
    top_dow = max(per_dow, key=lambda k: per_dow[k])
    patterns = {
        "monthly_total": round(total_month),
        "top_categories": [{"category": c, "monthly": round(v / months), "share": round(v / sum(cat_tot.values()) * 100, 1)}
                           for c, v in sorted(cat_tot.items(), key=lambda x: -x[1])[:5]],
        "top_period": {"name": top_period, "share": round(per_period[top_period] / timed * 100, 1)} if top_period else None,
        "top_day": {"name": dows[top_dow], "share": round(per_dow[top_dow] / sum(per_dow.values()) * 100, 1)},
    }

    # ── 2-5. areas: 12-month monthly average, last 30 days, saving ──
    # the 11 months before the recent 30 days are the "normal"; the year as a whole is the baseline
    before = [r for r in year if date.fromisoformat(r["date"]) <= recent_from]
    recent = [r for r in year if date.fromisoformat(r["date"]) > recent_from]
    base_m = areas(year, 1 / months)
    normal_30 = areas(before, DAYS_PER_MONTH / max((recent_from - year_from).days, 1))
    recent_30 = areas(recent, DAYS_PER_MONTH / 30)

    recs, flags = [], []
    for k, (title, cut, ease, tip) in REDUCE.items():
        base = base_m.get(k, 0.0)
        if base < MIN_MONTHLY:
            continue
        save = base * cut
        if save < 100:
            continue
        recs.append({"key": k, "title": title, "monthly_now": round(base), "budget": round(base - save),
                     "save_month": round(save), "save_year": round(save * 12), "cut_pct": round(cut * 100),
                     "ease": ease, "ease_label": EASE_LABEL[ease], "recent_30": round(recent_30.get(k, 0)),
                     "tip": tip, "score": round(save * EASE_WEIGHT[ease], 1)})
    recs.sort(key=lambda x: -x["score"])
    for k in set(recent_30) | set(normal_30):
        now, norm = recent_30.get(k, 0), normal_30.get(k, 0)
        if now >= norm * 1.3 and now - norm >= 500:
            flags.append({"key": k, "title": REDUCE.get(k, (k,))[0], "recent_30": round(now), "normal_30": round(norm),
                          "up_pct": round((now - norm) / norm * 100) if norm else None})
    flags.sort(key=lambda x: -(x["recent_30"] - x["normal_30"]))

    # unusually expensive days in the last 30, against the year's 90th percentile
    day_tot = defaultdict(float)
    for r in year:
        day_tot[r["date"]] += r["amount"]
    span = [(year_from + timedelta(days=i)).isoformat() for i in range(1, 366)]
    vals = sorted(day_tot.get(d, 0) for d in span)
    p90 = vals[int(len(vals) * .9)]
    big_recent = [d for d in span if d > recent_from.isoformat() and day_tot.get(d, 0) > p90]
    day_flag = {"threshold": round(p90), "days": len(big_recent), "expected": 3}

    # ── 8. tracking an active plan ──
    plan = json.loads(user.savings_plan_json) if getattr(user, "savings_plan_json", None) else None
    tracking = None
    if plan:
        start = date.fromisoformat(plan["started"])
        since = [r for r in rows if date.fromisoformat(r["date"]) >= start]
        n_days = max((end - start).days + 1, 1)
        actual = areas(since, DAYS_PER_MONTH / n_days)
        items = []
        for k, b in plan["baseline"].items():
            a = actual.get(k, 0.0)
            items.append({"key": k, "title": REDUCE.get(k, (k,))[0], "baseline": round(b), "target": round(plan["targets"].get(k, b)),
                          "actual": round(a), "saved_month": round(b - a)})
        items.sort(key=lambda x: -x["saved_month"])
        tracking = {"started": plan["started"], "days": n_days, "items": items,
                    "saved_month": round(sum(i["saved_month"] for i in items)),
                    "target_month": round(sum(i["baseline"] - i["target"] for i in items)),
                    "too_early": n_days < 14}

    total_save = sum(r["save_month"] for r in recs)
    # ── 6. LLM advice ──
    facts = {"monthly_spending": round(total_month),
             "top_categories": patterns["top_categories"],
             "busiest_time": patterns["top_period"], "busiest_day": patterns["top_day"],
             "recommendations": [{k: r[k] for k in ("key", "title", "monthly_now", "save_month", "ease_label")} for r in recs],
             "rising": [{k: f[k] for k in ("title", "recent_30", "normal_30")} for f in flags[:4]]}
    advice = _llm(facts)
    summary = None
    if advice:
        summary = advice.get("summary")
        for r in recs:
            t = (advice.get("tips") or {}).get(r["key"])
            if isinstance(t, str) and t.strip():
                r["tip"] = t.strip()
    if not summary:
        top = recs[0] if recs else None
        summary = (f"You spend about ₹{total_month:,.0f} a month. "
                   + (f"The biggest realistic win is {top['title'].lower()}: about ₹{top['save_month']:,} a month. " if top else "")
                   + (f"Together these changes could save about ₹{total_save:,} a month." if recs else ""))
    return {
        "data_until": end.isoformat(), "patterns": patterns, "flags": flags[:5], "day_flag": day_flag,
        "recommendations": recs, "save_month": total_save, "save_year": total_save * 12,
        "summary": summary, "advice_by": "llm" if advice else "rules", "tracking": tracking,
        "plan_active": bool(plan),
    }


def _count(db, user) -> int:
    from auth import caller_groups
    from models import Expense
    ids = [g.id for g in caller_groups(db, user, history=False)]
    return db.query(Expense).filter(Expense.group_id.in_(ids)).count() if ids else 0


def cached(db, user, force: bool = False) -> dict:
    count = _count(db, user)
    if user.recs_json and user.recs_basis is not None and not force:
        changed = abs(count - user.recs_basis)
        if changed < REFRESH_AFTER:
            return {**json.loads(user.recs_json), "cached": True, "changes_since": changed, "refresh_after": REFRESH_AFTER}
    result = build(db, user)
    result["computed_at"] = datetime.now(timezone.utc).isoformat()
    user.recs_json = json.dumps(result)
    user.recs_basis = count
    db.commit()
    return {**result, "cached": False, "changes_since": 0, "refresh_after": REFRESH_AFTER}


def start_plan(db, user) -> dict:
    """Record today's baseline and targets, so later spending can be compared."""
    current = cached(db, user)
    recs = current.get("recommendations") or []
    plan = {"started": (date.fromisoformat(current["data_until"]) + timedelta(days=1)).isoformat(),
            "baseline": {r["key"]: r["monthly_now"] for r in recs},
            "targets": {r["key"]: r["budget"] for r in recs}}
    user.savings_plan_json = json.dumps(plan)
    db.commit()
    return cached(db, user, force=True)


def stop_plan(db, user) -> dict:
    user.savings_plan_json = None
    db.commit()
    return cached(db, user, force=True)

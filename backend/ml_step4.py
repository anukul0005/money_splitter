"""Step 4 of the spending dataset - discover spending patterns.

    python ml_step4.py <user> [--since 2024-01-01] [--src ../ml_data/step3] [--out ../ml_data/step4]

Answers the Step 4 questions on Step 3's personal and shared datasets with
like-for-like comparisons, never raw totals alone:

  - per calendar day, counting days with no spending as zero, so a period
    or day type isn't "bigger" just because it has more days in it;
  - split into how often (payments per day) x how much (per payment);
  - compared within the same day or the same month where the question
    allows, so trips, seasons and one-off months don't decide it;
  - average payment sizes also standardised to one category mix, so a
    time of day isn't "expensive" only because that's when alcohol is
    bought;
  - every difference with a 95% bootstrap interval. A pattern is not a
    cause - the report says which comparisons are fair, not why.

Reads the user's salary day from the database (read-only); writes
report.md and findings.json. Plain Python - no numpy needed.
"""
from __future__ import annotations

import argparse
import calendar
import csv
import json
import os
import random
import statistics
from collections import Counter, defaultdict
from datetime import date, timedelta

HERE = os.path.dirname(__file__)
PERIODS = ("Early", "Day", "Night")
LATE_NIGHT_HOURS = {22, 23, 0}          # the late end of Night: 10 pm - 1 am
# Discretionary ("wants"): what could be cut without changing how one lives.
# Groceries, transport, housing, bills, health, education and services are
# treated as needs; Travel and Personal Care are reported separately.
DISCRETIONARY = {
    "Alcohol": None, "Tobacco & Paan": None, "Entertainment": None,
    "Food & Dining": {"Restaurants", "Food delivery", "Street food & snacks", "Sweets & bakery",
                      "Juice & beverages", "Tea & coffee"},
    "Shopping": {"Online shopping", "Clothing & footwear", "Malls", "Gift cards & vouchers",
                 "Electronics & mobile", "Sports"},
}
rng = random.Random(42)
RULE_TEXT = {"last_working": "the last working day", "last": "the last day", None: "the last working day", "": "the last working day"}


def boot(xs: list[float], stat=statistics.fmean, n: int = 2000) -> tuple[float, float]:
    """95% bootstrap interval of stat(xs)."""
    if len(xs) < 2:
        return (float("nan"), float("nan"))
    vals = sorted(stat([xs[rng.randrange(len(xs))] for _ in xs]) for _ in range(n))
    return vals[int(n * .025)], vals[int(n * .975)]


def inr(v: float) -> str:
    return f"Rs {v:,.0f}"


def ci(lo_hi) -> str:
    lo, hi = lo_hi
    return f"(95% CI {inr(lo)} to {inr(hi)})"


def payday(year: int, month: int, rule: str | None) -> date:
    last = date(year, month, calendar.monthrange(year, month)[1])
    if rule in (None, "", "last_working"):
        while last.weekday() >= 5:
            last -= timedelta(days=1)
        return last
    if rule == "last":
        return last
    return date(year, month, min(int(rule), last.day))


def load(path: str, since: str) -> list[dict]:
    rows = []
    for r in csv.DictReader(open(path, encoding="utf8")):
        if r["date"] >= since:
            r["amount"] = float(r["amount"])
            r["hour"] = int(r["hour"]) if r["hour"] != "" else None
            rows.append(r)
    return rows


def is_discretionary(r) -> bool:
    subs = DISCRETIONARY.get(r["category"], "no")
    return subs is None or (subs != "no" and r["subcategory"] in subs)


def analyse(name: str, rows: list[dict], start: date, end: date, salary_rule: str | None) -> tuple[list[str], dict]:
    out, F = [f"## {name.title()} spending", ""], {}
    days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    out.append(f"{len(rows)} payments, {inr(sum(r['amount'] for r in rows))}, over {len(days)} calendar days "
               f"({start} to {end}); days with no spending count as zero.")
    out.append("")

    # ── Q1 / Q5: time of day ──────────────────────────────────────────────
    timed = [r for r in rows if r["time_period"] in PERIODS]
    per_day = {p: defaultdict(float) for p in PERIODS}
    cnt = {p: defaultdict(int) for p in PERIODS}
    for r in timed:
        per_day[r["time_period"]][r["date"]] += r["amount"]
        cnt[r["time_period"]][r["date"]] += 1
    out += ["### 1. Do I spend more in the evening than in the morning?", "",
            "Spend per calendar day in each period = how often x how much:", "",
            "| period | per day | payments per day | avg payment | median payment |", "|---|---:|---:|---:|---:|"]
    q1 = {}
    for p in PERIODS:
        daily = [per_day[p].get(d.isoformat(), 0.0) for d in days]
        amts = [r["amount"] for r in timed if r["time_period"] == p]
        q1[p] = {"per_day": statistics.fmean(daily), "freq": sum(cnt[p].values()) / len(days),
                 "avg": statistics.fmean(amts) if amts else 0, "median": statistics.median(amts) if amts else 0}
        out.append(f"| {p} | {inr(q1[p]['per_day'])} | {q1[p]['freq']:.2f} | {inr(q1[p]['avg'])} | {inr(q1[p]['median'])} |")
    diff = [per_day["Night"].get(d.isoformat(), 0) - per_day["Early"].get(d.isoformat(), 0) for d in days]
    both = [d for d in days if per_day["Night"].get(d.isoformat()) and per_day["Early"].get(d.isoformat())]
    night_wins = sum(1 for d in both if per_day["Night"][d.isoformat()] > per_day["Early"][d.isoformat()])
    out += ["", f"Same day, Night minus Early: {inr(statistics.fmean(diff))} a day {ci(boot(diff))}."]
    if both:
        out.append(f"On the {len(both)} days with spending in both, Night was higher on {night_wins} "
                   f"({night_wins / len(both) * 100:.0f}%).")
    ratio_f = q1["Night"]["freq"] / q1["Early"]["freq"] if q1["Early"]["freq"] else float("nan")
    ratio_a = q1["Night"]["avg"] / q1["Early"]["avg"] if q1["Early"]["avg"] else float("nan")
    out.append(f"Night has {ratio_f:.1f}x as many payments a day and {ratio_a:.2f}x the payment size - "
               f"{'mostly frequency' if ratio_f > ratio_a else 'mostly size'}.")
    out.append("")
    F["time_of_day"] = {"per_period": q1, "night_minus_early_per_day": statistics.fmean(diff),
                        "ci": boot(diff), "days_both": len(both), "night_higher_days": night_wins}

    # Q5 - average payment, raw and standardised to one category mix
    cats = Counter(r["category"] for r in timed)
    mix = {c: n / len(timed) for c, n in cats.items()}
    out += ["### 5. Which time period has the highest average payment?", "",
            "| period | raw average | category-adjusted average | raw rank vs adjusted |", "|---|---:|---:|---|"]
    q5 = {}
    for p in PERIODS:
        by_cat = defaultdict(list)
        for r in timed:
            if r["time_period"] == p:
                by_cat[r["category"]].append(r["amount"])
        overall = statistics.fmean([r["amount"] for r in timed if r["time_period"] == p] or [0])
        # each category's average in this period, weighted by the overall mix;
        # a category never bought in this period falls back to its overall average
        adj = sum(w * (statistics.fmean(by_cat[c]) if by_cat[c] else
                       statistics.fmean([r["amount"] for r in timed if r["category"] == c])) for c, w in mix.items())
        q5[p] = {"raw": overall, "adjusted": adj}
    raw_rank = sorted(PERIODS, key=lambda p: -q5[p]["raw"])
    adj_rank = sorted(PERIODS, key=lambda p: -q5[p]["adjusted"])
    for p in PERIODS:
        out.append(f"| {p} | {inr(q5[p]['raw'])} | {inr(q5[p]['adjusted'])} | #{raw_rank.index(p) + 1} raw, #{adj_rank.index(p) + 1} adjusted |")
    out += ["", f"Highest raw: {raw_rank[0]}; highest once the category mix is held equal: {adj_rank[0]}."
            + (" The raw lead is partly what gets bought then." if raw_rank[0] != adj_rank[0] else ""), ""]
    F["avg_payment"] = q5

    # ── Q2: weekend vs weekday, within each month ─────────────────────────
    day_total = defaultdict(float)
    for r in rows:
        day_total[r["date"]] += r["amount"]
    by_month = defaultdict(lambda: {"we": [], "wd": []})
    for d in days:
        by_month[d.isoformat()[:7]]["we" if d.weekday() >= 5 else "wd"].append(day_total.get(d.isoformat(), 0.0))
    we_all = [v for m in by_month.values() for v in m["we"]]
    wd_all = [v for m in by_month.values() for v in m["wd"]]
    month_diff = [statistics.fmean(m["we"]) - statistics.fmean(m["wd"]) for m in by_month.values() if m["we"] and m["wd"]]
    higher = sum(1 for x in month_diff if x > 0)
    pay_we = sum(1 for r in rows if date.fromisoformat(r["date"]).weekday() >= 5)
    pay_wd = len(rows) - pay_we
    n_we = sum(1 for d in days if d.weekday() >= 5); n_wd = len(days) - n_we
    out += ["### 2. Do weekend days cost more than weekdays?", "",
            f"- per day: weekend {inr(statistics.fmean(we_all))}, weekday {inr(statistics.fmean(wd_all))}",
            f"- payments per day: weekend {pay_we / n_we:.2f}, weekday {pay_wd / n_wd:.2f}; "
            f"average payment: weekend {inr(sum(r['amount'] for r in rows if date.fromisoformat(r['date']).weekday() >= 5) / max(pay_we, 1))}, "
            f"weekday {inr(sum(r['amount'] for r in rows if date.fromisoformat(r['date']).weekday() < 5) / max(pay_wd, 1))}",
            f"- within the same month, weekend minus weekday: {inr(statistics.fmean(month_diff))} a day {ci(boot(month_diff))}; "
            f"weekends cost more in {higher} of {len(month_diff)} months.", ""]
    F["weekend"] = {"weekend_per_day": statistics.fmean(we_all), "weekday_per_day": statistics.fmean(wd_all),
                    "within_month_diff": statistics.fmean(month_diff), "ci": boot(month_diff),
                    "months_weekend_higher": higher, "months": len(month_diff)}

    # ── Q3: the week after payday vs the week before, month by month ──────
    out += ["### 3. Does spending rise after salary day?", ""]
    if salary_rule is not None:
        pairs = []
        y, m = start.year, start.month
        while date(y, m, 1) <= end:
            pd = payday(y, m, salary_rule)
            before = [pd - timedelta(days=i) for i in range(1, 8)]
            after = [pd + timedelta(days=i) for i in range(1, 8)]
            if before[-1] >= start and after[-1] <= end:
                b = sum(day_total.get(d.isoformat(), 0) for d in before)
                a = sum(day_total.get(d.isoformat(), 0) for d in after)
                pairs.append((pd, b, a))
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        d7 = [a - b for _, b, a in pairs]
        up = sum(1 for x in d7 if x > 0)
        out += [f"Payday: {RULE_TEXT.get(salary_rule, 'day ' + str(salary_rule))} of each month. Compared the 7 days after it with the 7 days before it, "
                f"month by month ({len(pairs)} paydays):", "",
                f"- average week before {inr(statistics.fmean([b for _, b, _ in pairs]))}, week after {inr(statistics.fmean([a for _, _, a in pairs]))}",
                f"- after minus before: {inr(statistics.fmean(d7))} a week {ci(boot(d7))}; median {inr(statistics.median(d7))}",
                f"- the week after was higher in {up} of {len(pairs)} months", ""]
        F["payday"] = {"rule": salary_rule, "paydays": len(pairs), "after_minus_before": statistics.fmean(d7),
                       "ci": boot(d7), "months_higher": up}
    else:
        out += ["No salary day saved for this user - set it in Account > Salary.", ""]
    return out, F


def late_night_food(rows: list[dict]) -> tuple[list[str], dict]:
    food = [r for r in rows if r["category"] == "Food & Dining"]
    by_m = defaultdict(lambda: {"late_n": 0, "late": 0.0, "other": 0.0})
    for r in food:
        m = by_m[r["month"]]
        if r["hour"] in LATE_NIGHT_HOURS:
            m["late_n"] += 1; m["late"] += r["amount"]
        else:
            m["other"] += r["amount"]
    months = sorted(by_m)
    xs = [by_m[m]["late_n"] for m in months]
    tot = [by_m[m]["late"] + by_m[m]["other"] for m in months]
    oth = [by_m[m]["other"] for m in months]

    def slope(x, y):
        mx, my = statistics.fmean(x), statistics.fmean(y)
        sxx = sum((a - mx) ** 2 for a in x)
        return sum((a - mx) * (b - my) for a, b in zip(x, y)) / sxx if sxx else float("nan")

    def corr(x, y):
        try:
            return statistics.correlation(x, y)
        except statistics.StatisticsError:
            return float("nan")

    s_tot, s_oth = slope(xs, tot), slope(xs, oth)
    idx = list(range(len(months)))
    boots = sorted(slope([xs[i] for i in b], [tot[i] for i in b])
                   for b in ([idx[rng.randrange(len(idx))] for _ in idx] for _ in range(2000)))
    late_total = sum(by_m[m]["late"] for m in months)
    out = ["### 4. Do late-night food orders raise monthly food spending? (personal)", "",
           f"Late night = food payments from 10 pm to 1 am. {sum(xs)} of them over {len(months)} months, "
           f"{inr(late_total)} - {late_total / max(sum(tot), 1) * 100:.0f}% of food spending.", "",
           f"- each extra late-night food order in a month goes with {inr(s_tot)} more total food spending that month "
           f"(95% CI {inr(boots[50])} to {inr(boots[1949])}); correlation {corr(xs, tot):.2f}",
           f"- and with {inr(s_oth)} more spent on the *other* food that month (correlation {corr(xs, oth):.2f}) - "
           + ("late-night orders come on top of other meals, not instead of them."
              if s_oth > 0 else "other food spending dips a little, so late-night orders partly replace other meals."),
           f"- average late-night food payment {inr(late_total / max(sum(xs), 1))}", ""]
    return out, {"months": len(months), "late_orders": sum(xs), "late_amount": late_total,
                 "slope_total_per_order": s_tot, "ci": (boots[50], boots[1949]), "slope_other_per_order": s_oth,
                 "corr_total": corr(xs, tot)}


def unnecessary(rows: list[dict], end: date) -> tuple[list[str], dict]:
    total = sum(r["amount"] for r in rows)
    disc = [r for r in rows if is_discretionary(r)]
    six = (end.replace(day=1) - timedelta(days=150)).isoformat()[:7]
    twelve = (end.replace(day=1) - timedelta(days=330)).isoformat()[:7]
    key = lambda r: r["category"] if DISCRETIONARY.get(r["category"]) is None else f"{r['category']} > {r['subcategory']}"
    agg = defaultdict(lambda: {"amt": 0.0, "n": 0, "recent": 0.0, "prior": 0.0, "night": 0.0})
    for r in disc:
        a = agg[key(r)]
        a["amt"] += r["amount"]; a["n"] += 1
        if r["month"] >= six: a["recent"] += r["amount"]
        elif r["month"] >= twelve: a["prior"] += r["amount"]
        if r["time_period"] == "Night": a["night"] += r["amount"]
    dtotal = sum(a["amt"] for a in agg.values())
    out = ["### 6. Which categories make up most of the unnecessary spending? (personal)", "",
           "Unnecessary = discretionary wants: alcohol, tobacco, entertainment, eating out and food delivery "
           "(not groceries), and non-essential shopping. Needs - groceries, transport, rent, bills, health, "
           "education - are left out.", "",
           f"Discretionary spending: {inr(dtotal)}, {dtotal / total * 100:.0f}% of all spending.", "",
           "| category | amount | share of wants | payments | avg | last 6 mo vs 6 before | at night |",
           "|---|---:|---:|---:|---:|---:|---:|"]
    ranked = sorted(agg.items(), key=lambda x: -x[1]["amt"])
    for k, a in ranked[:12]:
        trend = f"{(a['recent'] - a['prior']) / a['prior'] * 100:+.0f}%" if a["prior"] else "new"
        out.append(f"| {k} | {inr(a['amt'])} | {a['amt'] / dtotal * 100:.0f}% | {a['n']} | {inr(a['amt'] / a['n'])} | "
                   f"{trend} | {a['night'] / a['amt'] * 100:.0f}% |")
    out.append("")
    return out, {"discretionary_total": dtotal, "share_of_all": dtotal / total,
                 "ranked": [(k, a["amt"], a["n"]) for k, a in ranked]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("user")
    ap.add_argument("--since", default="2024-01-01")
    ap.add_argument("--src", default=os.path.join(HERE, "..", "ml_data", "step3"))
    ap.add_argument("--out", default=os.path.join(HERE, "..", "ml_data", "step4"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    from sqlalchemy import func
    from database import get_session_factory
    from models import User
    db = get_session_factory()()
    db.connection().exec_driver_sql("SET TRANSACTION READ ONLY")
    u = db.query(User).filter(func.lower(User.name) == args.user.lower()).one()
    salary_rule, salary = u.salary_day, u.monthly_salary
    db.rollback(); db.close()

    personal = load(os.path.join(args.src, "features_personal.csv"), args.since)
    shared = load(os.path.join(args.src, "features_shared.csv"), args.since)
    end = date.fromisoformat(max(r["date"] for r in personal + shared))
    report = ["# Step 4 - spending patterns", "",
              f"Window: {args.since} to {end}. Salary: {inr(salary) if salary else 'not set'}, credited "
              f"{RULE_TEXT.get(salary_rule, f'on day {salary_rule}') if salary_rule else '(day not set)'}.", "",
              "Every comparison is per calendar day (no-spend days count as zero), split into how often x how much, "
              "and made within the same day or month where possible. These are patterns, not causes.", ""]
    findings = {"window": [args.since, end.isoformat()], "salary": salary, "salary_day": salary_rule}

    p_start = date.fromisoformat(args.since)
    lines, findings["personal"] = analyse("personal", personal, p_start, end, salary_rule)
    report += lines
    lines, findings["late_night_food"] = late_night_food(personal)
    report += lines
    lines, findings["unnecessary"] = unnecessary(personal, end)
    report += lines
    s_start = max(p_start, date.fromisoformat(min(r["date"] for r in shared)))
    lines, findings["shared"] = analyse("shared", shared, s_start, end, salary_rule)
    report += lines

    open(os.path.join(args.out, "report.md"), "w", encoding="utf8").write("\n".join(report) + "\n")
    json.dump(findings, open(os.path.join(args.out, "findings.json"), "w", encoding="utf8"), indent=1, default=str)
    print("\n".join(report))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()

"""Step 3 of the spending dataset - feature engineering.

    python ml_step3.py [--src ../ml_data/step2/transactions_clean.csv] [--out ../ml_data/step3]

Takes Step 2's spending rows (is_spending = 1 - transfers, P2P and
gambling would distort the day and category totals) and adds:

  hour                  0-23, from the transaction time
  time_period           Morning 10:00-13:59, Afternoon 14:00-17:59,
                        Evening 18:00-22:59, Night 23:00-09:59;
                        Unknown when the statement has no time
  day_of_week           Monday ... Sunday
  is_weekend            Yes (Saturday, Sunday) / No
  month                 YYYY-MM - trends over time
  month_name            January ... December - seasonality across years
  daily_total           all spending on that date
  category_daily_total  spending on that date in this row's category

Writes features.csv and a short summary.md. No network, no database.
"""
from __future__ import annotations

import argparse
import csv
import os
from collections import Counter, defaultdict
from datetime import date

HERE = os.path.dirname(__file__)

# (first hour, last hour, label) - Night wraps past midnight.
PERIODS = [(10, 13, "Morning"), (14, 17, "Afternoon"), (18, 22, "Evening")]


def time_period(hour: int | None) -> str:
    if hour is None:
        return "Unknown"
    for lo, hi, name in PERIODS:
        if lo <= hour <= hi:
            return name
    return "Night"          # 23:00-09:59


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.join(HERE, "..", "ml_data", "step2", "transactions_clean.csv"))
    ap.add_argument("--out", default=os.path.join(HERE, "..", "ml_data", "step3"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    rows = [r for r in csv.DictReader(open(args.src, encoding="utf8")) if r["is_spending"] == "1"]
    day_tot: dict[str, float] = defaultdict(float)
    cat_day_tot: dict[tuple, float] = defaultdict(float)
    for r in rows:
        day_tot[r["date"]] += float(r["amount"])
        cat_day_tot[(r["date"], r["category"])] += float(r["amount"])

    out = []
    for r in rows:
        d = date.fromisoformat(r["date"])
        t = (r.get("time") or "").strip()
        hour = int(t[:2]) if len(t) >= 2 and t[:2].isdigit() else None
        out.append({
            "txn_id": r["txn_id"], "date": r["date"], "time": t, "amount": r["amount"],
            "paid_to": r["paid_to"], "merchant": r["merchant"],
            "category": r["category"], "subcategory": r["subcategory"], "mapping_method": r["mapping_method"],
            "hour": "" if hour is None else hour,
            "time_period": time_period(hour),
            "day_of_week": d.strftime("%A"),
            "is_weekend": "Yes" if d.weekday() >= 5 else "No",
            "month": r["date"][:7],
            "month_name": d.strftime("%B"),
            "daily_total": round(day_tot[r["date"]], 2),
            "category_daily_total": round(cat_day_tot[(r["date"], r["category"])], 2),
        })
    out.sort(key=lambda x: (x["date"], x["time"], x["txn_id"]))

    with open(os.path.join(args.out, "features.csv"), "w", newline="", encoding="utf8") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0])); w.writeheader(); w.writerows(out)

    # ── summary: does each feature come out sensibly? ──
    total = sum(float(r["amount"]) for r in out)
    def share(key):
        c, n = defaultdict(float), Counter()
        for r in out:
            c[r[key]] += float(r["amount"]); n[r[key]] += 1
        return c, n
    lines = ["# Step 3 - features", "",
             f"{len(out)} spending payments, Rs {total:,.0f}, {len(day_tot)} days with spending, "
             f"{out[0]['date']} to {out[-1]['date']}.", ""]
    for key, order in (("time_period", ["Morning", "Afternoon", "Evening", "Night", "Unknown"]),
                       ("day_of_week", ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
                       ("is_weekend", ["No", "Yes"])):
        c, n = share(key)
        lines += [f"## {key}", "", "| value | payments | amount | share | avg payment |", "|---|---:|---:|---:|---:|"]
        for v in order:
            if n[v]:
                lines.append(f"| {v} | {n[v]} | Rs {c[v]:,.0f} | {c[v] / total * 100:.1f}% | Rs {c[v] / n[v]:,.0f} |")
        lines.append("")
    dt = sorted(day_tot.values())
    lines += ["## daily_total", "",
              f"- median day Rs {dt[len(dt) // 2]:,.0f}, average Rs {sum(dt) / len(dt):,.0f}, "
              f"90th percentile Rs {dt[int(len(dt) * .9)]:,.0f}, biggest Rs {dt[-1]:,.0f}", ""]
    open(os.path.join(args.out, "summary.md"), "w", encoding="utf8").write("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()

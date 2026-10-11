"""Step 3 of the spending dataset - feature engineering, as two datasets.

    python ml_step3.py <user> [--src ../ml_data/step2/transactions_clean.csv] [--out ../ml_data/step3]

Personal and shared spending behave differently (who decides, who pays,
what it's for), so each gets its own dataset and its own model:

  features_personal.csv  the user's own spending: Step 2's statement
                         payments in their personal (single-member)
                         groups, plus cash expenses entered there by hand.
                         amount = what was paid.
  features_shared.csv    every expense in the user's shared groups,
                         whoever paid. amount = the user's share;
                         paid_amount = the whole bill. Time is the
                         statement time when the user paid by PhonePe,
                         else the Early/Day/Night label the user gave.
                         A whole-day expense counts as its category parts.

Both get:
  hour                  0-23, from the time (blank when only a label is known)
  time_period           Early 01:00-10:59, Day 11:00-17:59,
                        Night 18:00-00:59; Unknown when nothing is known
  day_of_week           Monday ... Sunday
  is_weekend            Yes (Saturday, Sunday) / No
  month                 YYYY-MM - trends over time
  month_name            January ... December - seasonality across years
  daily_total           this dataset's spending on that date
  category_daily_total  this dataset's spending on that date in this category

Reads the database read-only; writes the two CSVs and summary.md.
"""
from __future__ import annotations

import argparse
import csv
import os
from collections import Counter, defaultdict
from datetime import date

from sqlalchemy import func

from database import get_session_factory
from models import Expense, Group, Member, User
from routers.stats import _history_category, _member_share
from spend_categories import TAXONOMY

HERE = os.path.dirname(__file__)

# (first hour, last hour, label) - Night (18:00-00:59) wraps past midnight.
PERIODS = [(1, 10, "Early"), (11, 17, "Day")]
LABELS = ("Early", "Day", "Night")


def time_period(hour: int | None) -> str:
    if hour is None:
        return "Unknown"
    for lo, hi, name in PERIODS:
        if lo <= hour <= hi:
            return name
    return "Night"          # 18:00-00:59


def hour_of(t: str | None) -> int | None:
    t = (t or "").strip()
    return int(t[:2]) if len(t) >= 2 and t[:2].isdigit() else None


def category_of(e) -> tuple[str, str]:
    if not (e.category or "").strip():
        return "Uncategorized", ""            # never categorised - not the same as "Other"
    if e.category in TAXONOMY:
        return e.category, e.subcategory or ""
    return _history_category(e.category), ""


def add_features(rows: list[dict]) -> list[dict]:
    day_tot, cat_day = defaultdict(float), defaultdict(float)
    for r in rows:
        day_tot[r["date"]] += r["amount"]
        cat_day[(r["date"], r["category"])] += r["amount"]
    for r in rows:
        d = date.fromisoformat(r["date"])
        h = hour_of(r["time"])
        r["hour"] = "" if h is None else h
        r["time_period"] = time_period(h) if h is not None else (r.pop("label", None) or "Unknown")
        r.pop("label", None)
        r["day_of_week"] = d.strftime("%A")
        r["is_weekend"] = "Yes" if d.weekday() >= 5 else "No"
        r["month"] = r["date"][:7]
        r["month_name"] = d.strftime("%B")
        r["daily_total"] = round(day_tot[r["date"]], 2)
        r["category_daily_total"] = round(cat_day[(r["date"], r["category"])], 2)
        r["amount"] = round(r["amount"], 2)
    rows.sort(key=lambda x: (x["date"], x["time"], x["txn_id"]))
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("user")
    ap.add_argument("--src", default=os.path.join(HERE, "..", "ml_data", "step2", "transactions_clean.csv"))
    ap.add_argument("--out", default=os.path.join(HERE, "..", "ml_data", "step3"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    db = get_session_factory()()
    db.connection().exec_driver_sql("SET TRANSACTION READ ONLY")
    me = args.user.lower()
    user = db.query(User).filter(func.lower(User.name) == me).one()
    mine = [gid for (gid,) in db.query(Member.group_id).filter(func.lower(Member.name) == me)]
    groups = {g.id: g for g in db.query(Group).filter(Group.id.in_(mine))}
    personal = {gid for gid, g in groups.items() if len(g.members) == 1}
    expenses = db.query(Expense).filter(Expense.group_id.in_(mine)).all()
    by_ref = {}
    for e in expenses:
        for ref in (e.txn_ref or "").split(","):
            if ref.strip():
                by_ref[ref.strip()] = e

    stmt = {r["txn_id"]: r for r in csv.DictReader(open(args.src, encoding="utf8")) if r["is_spending"] == "1"}
    skipped = Counter()

    # ── personal ──────────────────────────────────────────────────────────
    pers = []
    for tid, r in stmt.items():
        e = by_ref.get(tid)
        if e is None or e.group_id not in personal:
            continue                         # shared payments are in the shared set
        pers.append({"txn_id": tid, "source": "statement", "date": r["date"], "time": r["time"],
                     "amount": float(r["amount"]), "paid_to": r["paid_to"], "merchant": r["merchant"],
                     "category": r["category"], "subcategory": r["subcategory"],
                     "mapping_method": r["mapping_method"], "group_name": groups[e.group_id].name})
    for e in expenses:
        if e.group_id not in personal or e.txn_ref or not e.date or e.amount <= 0:
            if e.group_id in personal and not e.txn_ref and not e.date:
                skipped["personal cash entry without a date"] += 1
            continue
        cat, sub = category_of(e)
        pers.append({"txn_id": f"app-{e.id}", "source": "app (cash/hand-entered)", "date": e.date[:10],
                     "time": e.txn_time or "", "label": e.time_period, "amount": float(e.amount),
                     "paid_to": e.title or "", "merchant": e.title or "", "category": cat, "subcategory": sub,
                     "mapping_method": e.category_source or "app_entry", "group_name": groups[e.group_id].name})

    # ── shared ────────────────────────────────────────────────────────────
    shared = []
    for e in expenses:
        if e.group_id in personal:
            continue
        share = _member_share(e, me) or 0.0
        if share <= 0:
            continue
        if not e.date:
            skipped["shared expense without a date"] += 1
            continue
        g = groups[e.group_id]
        base = {"source": "statement" if e.txn_ref else "app", "date": e.date[:10], "time": e.txn_time or "",
                "label": e.time_period, "paid_to": e.title or "", "merchant": e.title or "",
                "mapping_method": e.category_source or "app_entry", "group_name": g.name,
                "people": len(g.members), "paid_by_me": "Yes" if (e.paid_by or "").lower() == me else "No",
                "paid_amount": round(e.amount, 2)}
        slices = [(p.category, p.subcategory or "", p.amount) for p in e.parts] if e.parts else [(*category_of(e), e.amount)]
        for i, (cat, sub, amt) in enumerate(slices):
            shared.append({"txn_id": f"exp-{e.id}" + (f"-part{i + 1}" if e.parts else ""), **base,
                           "amount": share * (amt / e.amount if e.amount else 0),
                           "category": cat, "subcategory": sub})

    db.rollback(); db.close()

    lines = ["# Step 3 - features (personal and shared)", ""]
    for name, rows in (("personal", pers), ("shared", shared)):
        rows = add_features(rows)
        cols = ["txn_id", "source", "date", "time", "amount"] + (["paid_amount", "paid_by_me", "people"] if name == "shared" else []) + \
               ["paid_to", "merchant", "category", "subcategory", "mapping_method", "group_name", "hour", "time_period",
                "day_of_week", "is_weekend", "month", "month_name", "daily_total", "category_daily_total"]
        with open(os.path.join(args.out, f"features_{name}.csv"), "w", newline="", encoding="utf8") as f:
            w = csv.DictWriter(f, fieldnames=cols); w.writeheader(); w.writerows(rows)
        total = sum(r["amount"] for r in rows)
        days = {r["date"] for r in rows}
        lines += [f"## {name}: {len(rows)} rows, Rs {total:,.0f}, {len(days)} days, {rows[0]['date']} to {rows[-1]['date']}", ""]
        lines.append("Source: " + ", ".join(f"{k} {v}" for k, v in Counter(r["source"] for r in rows).most_common()))
        for key, order in (("time_period", ["Early", "Day", "Night", "Unknown"]), ("is_weekend", ["No", "Yes"])):
            c, n = defaultdict(float), Counter()
            for r in rows:
                c[r[key]] += r["amount"]; n[r[key]] += 1
            lines += ["", f"| {key} | rows | amount | share |", "|---|---:|---:|---:|"]
            lines += [f"| {v} | {n[v]} | Rs {c[v]:,.0f} | {c[v] / total * 100:.1f}% |" for v in order if n[v]]
        cats = defaultdict(float)
        for r in rows:
            cats[r["category"]] += r["amount"]
        lines += ["", "Top categories: " + ", ".join(f"{k} Rs {v:,.0f}" for k, v in sorted(cats.items(), key=lambda x: -x[1])[:6]), ""]
    if skipped:
        lines += ["Left out: " + ", ".join(f"{k}: {v}" for k, v in skipped.items()), ""]
    open(os.path.join(args.out, "summary.md"), "w", encoding="utf8").write("\n".join(lines) + "\n")
    old = os.path.join(args.out, "features.csv")
    if os.path.exists(old):
        os.remove(old)                       # replaced by the two files above
    print("\n".join(lines))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()

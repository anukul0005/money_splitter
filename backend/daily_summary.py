"""Yesterday's spending, for the opt-in daily summary (see routers/cron.py
and emailer.send_daily_summary).

Amounts are the user's own share - all of a solo group's expense, their
split of a shared one - the same measure History uses by default, so the
summary and the app never disagree about what was spent.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta

from auth import caller_groups
from models import Expense
from routers.stats import _history_category, _member_share

AVG_DAYS = 30


def _shares(db, user, start: date, end: date) -> list[dict]:
    """Every expense in the user's groups dated start..end, with their share."""
    groups = caller_groups(db, user, history=False)
    if not groups:
        return []
    members = {g.id: g for g in groups}
    me = user.name.lower()
    out = []
    for e in (db.query(Expense)
              .filter(Expense.group_id.in_(list(members)),
                      Expense.date >= start.isoformat(),
                      Expense.date <= end.isoformat() + "~")):   # "~" sorts after any time suffix
        g = members[e.group_id]
        share = e.amount if len(g.members) == 1 else (_member_share(e, me) or 0.0)
        if share <= 0 or not e.date:
            continue
        others = [m.name for m in g.members if m.name.lower() != me]
        out.append({
            "day": e.date[:10], "share": share,
            # Who it was shared with - many shared groups are named by date
            # ("07 oct 26"), which says nothing in a summary.
            "with": ", ".join(others),
            "shared": bool(others),
            "title": (e.title or e.category or "Expense").strip(),
            "category": _history_category(e.category),
        })
    return out


def summarise(db, user, day: date) -> dict:
    """`day` (yesterday, in the caller's terms) against the 30 days before
    it and against the same point of the month before."""
    month_start = day.replace(day=1)
    prev_month_start = (month_start - timedelta(days=1)).replace(day=1)
    window_start = min(day - timedelta(days=AVG_DAYS), prev_month_start)
    rows = _shares(db, user, window_start, day)

    iso = day.isoformat()
    items = sorted((r for r in rows if r["day"] == iso), key=lambda r: -r["share"])
    total = sum(r["share"] for r in items)
    by_cat: dict[str, float] = defaultdict(float)
    for r in items:
        by_cat[r["category"]] += r["share"]

    avg_from = (day - timedelta(days=AVG_DAYS)).isoformat()
    avg = sum(r["share"] for r in rows if avg_from <= r["day"] < iso) / AVG_DAYS

    mtd = sum(r["share"] for r in rows if month_start.isoformat() <= r["day"] <= iso)
    # Same point last month - capped at that month's length (the 31st
    # against a 30-day month compares with the whole of it).
    prev_end = min(prev_month_start.replace(day=28) + timedelta(days=4), month_start) - timedelta(days=1)
    prev_cut = min(prev_month_start + timedelta(days=day.day - 1), prev_end).isoformat()
    prev_mtd = sum(r["share"] for r in rows if prev_month_start.isoformat() <= r["day"] <= prev_cut)

    return {
        "day": day, "total": total, "items": items,
        "categories": sorted(by_cat.items(), key=lambda x: -x[1]),
        "avg": avg, "mtd": mtd, "prev_mtd": prev_mtd,
        "month_done": (day + timedelta(days=1)).day == 1,
    }

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from collections import defaultdict
import json as _json
from database import get_db
from models import Group
from schemas import GroupStats, CategoryStat, MemberStat, TimelineStat

router = APIRouter(prefix="/stats", tags=["stats"])


@router.get("/user-summary", response_model=dict)
def get_user_summary(name: str, db: Session = Depends(get_db)):
    """Cross-group personal stats for a named member."""
    from routers.settlements import _calculate

    groups = db.query(Group).all()
    total_paid  = 0.0
    total_share = 0.0
    groups_count = 0
    pending_net = 0.0

    for g in groups:
        if g.is_historical:
            continue
        member_names_lower = [m.name.lower() for m in g.members]
        if name.lower() not in member_names_lower:
            continue
        groups_count += 1

        for e in g.expenses:
            payer = e.paid_by.lower()
            settled_members = [s.lower() for s in (_json.loads(e.settled_by) if e.settled_by else [])]
            user_settled = name.lower() in settled_members and payer != name.lower()

            if payer == name.lower():
                total_paid += e.amount

            if e.split_json:
                try:
                    splits = _json.loads(e.split_json)
                    for k, v in splits.items():
                        if k.lower() == name.lower():
                            member_share = float(v)
                            total_share += member_share
                            if user_settled:
                                total_paid += member_share
                            break
                except Exception:
                    pass
            else:
                participates = True
                if e.participants:
                    parts = [p.strip().lower() for p in e.participants.split(',')]
                    participates = name.lower() in parts
                if participates:
                    member_share = e.individual_amount if e.individual_amount else (e.amount / max(e.divider, 1))
                    total_share += member_share
                    if user_settled:
                        total_paid += member_share

        # Net from pending transactions is correct; raw paid-share stays positive
        # for creditor even when all debtors have settled.
        settlement = _calculate(g)
        pending_net += sum(t.amount for t in settlement.transactions if t.to_member.lower()   == name.lower())
        pending_net -= sum(t.amount for t in settlement.transactions if t.from_member.lower() == name.lower())

    return {
        "name": name,
        "total_paid":  round(total_paid,  2),
        "total_share": round(total_share, 2),
        "net":         round(pending_net, 2),
        "groups_count": groups_count,
    }


@router.get("/user-group-balances", response_model=list[dict])
def get_user_group_balances(name: str, db: Session = Depends(get_db)):
    """Per-group net balance for a named user (non-historical, non-zero balance only)."""
    from routers.settlements import _calculate

    groups = db.query(Group).all()
    result = []

    for g in groups:
        if g.is_historical:
            continue
        member_names_lower = [m.name.lower() for m in g.members]
        if name.lower() not in member_names_lower:
            continue

        settlement = _calculate(g)
        # Use pending transactions rather than raw paid-share net.
        # Raw net stays positive for the creditor even after all debtors settle,
        # because settlement only adjusts debtor paid amounts. Transactions
        # correctly reflect zero outstanding debt once everyone has settled.
        pending_to   = sum(t.amount for t in settlement.transactions if t.to_member.lower()   == name.lower())
        pending_from = sum(t.amount for t in settlement.transactions if t.from_member.lower() == name.lower())
        pending_net  = round(pending_to - pending_from, 2)
        if abs(pending_net) > 0.01:
            result.append({
                "group_id": g.id,
                "name": g.name,
                "emoji": g.emoji or "💰",
                "net": pending_net,
                "category": g.category or "",
            })

    # owe first (negative net), then owed (positive), each sorted by abs amount desc
    result.sort(key=lambda x: (x["net"] >= 0, -abs(x["net"])))
    return result


def _expense_participants(e, group_member_names: list[str]) -> list[str]:
    """Names of everyone who has a share in this expense."""
    if e.split_json:
        try:
            return list(_json.loads(e.split_json).keys())
        except Exception:
            return []
    if e.participants:
        return [p.strip() for p in e.participants.split(",")]
    return group_member_names


def _member_share(e, name: str) -> float | None:
    """The named member's share of this expense, or None if they don't participate."""
    if e.split_json:
        try:
            splits = _json.loads(e.split_json)
            for k, v in splits.items():
                if k.lower() == name.lower():
                    return float(v)
            return None
        except Exception:
            return None
    if e.participants:
        parts = [p.strip().lower() for p in e.participants.split(",")]
        if name.lower() not in parts:
            return None
    return e.individual_amount if e.individual_amount else (e.amount / max(e.divider, 1))


@router.get("/global-analytics", response_model=dict)
def get_global_analytics(name: str = "", db: Session = Depends(get_db)):
    """Cross-group analytics: overall by expense category + per-person category breakdown.

    When `name` is given, the per-person breakdown shows that user's own
    category-wise share of expenses shared with each other member
    (i.e. "my spends with X, by category").
    """
    groups = db.query(Group).all()

    by_category: dict[str, float] = defaultdict(float)
    by_category_count: dict[str, int] = defaultdict(int)
    by_category_display: dict[str, str] = {}
    by_person_category: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))

    for g in groups:
        if g.is_historical:
            continue
        if name:
            member_names_lower = [m.name.lower() for m in g.members]
            if name.lower() not in member_names_lower:
                continue

        group_member_names = [m.name for m in g.members]

        for e in g.expenses:
            raw_cat = (e.category or "Other").strip()
            key = raw_cat.lower()
            if key not in by_category_display:
                by_category_display[key] = raw_cat
            by_category[key] += e.amount
            by_category_count[key] += 1

            if name:
                member_share = _member_share(e, name)
                if member_share is None:
                    continue
                for p in _expense_participants(e, group_member_names):
                    if p.lower() == name.lower():
                        continue
                    by_person_category[p][raw_cat] += member_share
            else:
                payer = e.paid_by or "Unknown"
                by_person_category[payer][raw_cat] += e.amount

    cat_list = [
        {"category": by_category_display[k], "total": round(v, 2), "count": by_category_count[k]}
        for k, v in sorted(by_category.items(), key=lambda x: -x[1])
    ]
    person_cat_out = {
        person: sorted(
            [{"category": cat, "total": round(amt, 2)} for cat, amt in cats.items()],
            key=lambda x: -x["total"],
        )
        for person, cats in by_person_category.items()
    }
    return {"by_category": cat_list, "by_person_category": person_cat_out}


@router.get("/overview/all", response_model=list[dict])
def get_overview(db: Session = Depends(get_db)):
    """Returns per-group totals for the homepage chart."""
    groups = db.query(Group).all()
    return [
        {
            "id": g.id,
            "name": g.name,
            "emoji": g.emoji,
            "total": round(sum(e.amount for e in g.expenses), 2),
            "is_historical": g.is_historical,
        }
        for g in groups
    ]


# NOTE: /{group_id} must stay LAST — literal routes above must be registered first
# so FastAPI matches them before the catch-all int parameter route.
@router.get("/{group_id}", response_model=GroupStats)
def get_group_stats(group_id: int, db: Session = Depends(get_db)):
    group = db.query(Group).filter(Group.id == group_id).first()
    if not group:
        raise HTTPException(404, "Group not found")

    expenses = group.expenses
    total = round(sum(e.amount for e in expenses), 2)

    by_cat: dict[str, float] = defaultdict(float)
    by_cat_display: dict[str, str] = {}
    by_member: dict[str, float] = defaultdict(float)
    by_date: dict[str, float] = defaultdict(float)

    for e in expenses:
        raw = (e.category or "Other").strip()
        key = raw.lower()
        if key not in by_cat_display:
            by_cat_display[key] = raw
        by_cat[key] += e.amount
        by_member[e.paid_by] += e.amount
        if e.date:
            raw = str(e.date)
            if len(raw) >= 7:
                by_date[raw[:7]] += e.amount

    return GroupStats(
        group_id=group_id,
        total=total,
        by_category=[CategoryStat(category=by_cat_display[k], total=round(v, 2)) for k, v in sorted(by_cat.items(), key=lambda x: -x[1])],
        by_member=[MemberStat(member=k, total_paid=round(v, 2)) for k, v in sorted(by_member.items(), key=lambda x: -x[1])],
        by_date=[TimelineStat(date=k, total=round(v, 2)) for k, v in sorted(by_date.items())],
    )

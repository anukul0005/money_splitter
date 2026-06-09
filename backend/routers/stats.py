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
    groups = db.query(Group).all()
    total_paid  = 0.0
    total_share = 0.0
    groups_count = 0

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

            # What this person paid
            if payer == name.lower():
                total_paid += e.amount

            # What this person's share is
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
                # Equal split — check participation
                participates = True
                if e.participants:
                    parts = [p.strip().lower() for p in e.participants.split(',')]
                    participates = name.lower() in parts
                if participates:
                    member_share = e.individual_amount if e.individual_amount else (e.amount / max(e.divider, 1))
                    total_share += member_share
                    if user_settled:
                        total_paid += member_share

    return {
        "name": name,
        "total_paid":  round(total_paid,  2),
        "total_share": round(total_share, 2),
        "net":         round(total_paid - total_share, 2),
        "groups_count": groups_count,
    }


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
            # Normalise to YYYY-MM for timeline grouping
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
        user_balance = next(
            (b for b in settlement.balances if b.member.lower() == name.lower()),
            None,
        )
        if user_balance and abs(user_balance.net) > 0.01:
            result.append({
                "group_id": g.id,
                "name": g.name,
                "emoji": g.emoji or "💰",
                "net": round(user_balance.net, 2),
                "category": g.category or "",
            })

    # owe first (negative net), then owed (positive net), each sorted by abs amount desc
    result.sort(key=lambda x: (x["net"] >= 0, -abs(x["net"])))
    return result


@router.get("/global-analytics", response_model=dict)
def get_global_analytics(name: str = "", db: Session = Depends(get_db)):
    """Cross-group analytics: overall by expense category + per-person category breakdown."""
    groups = db.query(Group).all()

    by_category: dict[str, float] = defaultdict(float)
    by_category_count: dict[str, int] = defaultdict(int)
    by_category_display: dict[str, str] = {}
    by_person_category: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))

    for g in groups:
        if g.is_historical:
            continue
        # Filter to groups containing the named member (if name provided)
        if name:
            member_names_lower = [m.name.lower() for m in g.members]
            if name.lower() not in member_names_lower:
                continue

        for e in g.expenses:
            raw_cat = (e.category or "Other").strip()
            key = raw_cat.lower()
            if key not in by_category_display:
                by_category_display[key] = raw_cat
            by_category[key] += e.amount
            by_category_count[key] += 1

            payer = e.paid_by or "Unknown"
            by_person_category[payer][raw_cat] += e.amount

    # Build sorted by_category list
    cat_list = [
        {
            "category": by_category_display[k],
            "total": round(v, 2),
            "count": by_category_count[k],
        }
        for k, v in sorted(by_category.items(), key=lambda x: -x[1])
    ]

    # Convert person->category dicts to sorted lists
    person_cat_out = {
        person: sorted(
            [{"category": cat, "total": round(amt, 2)} for cat, amt in cats.items()],
            key=lambda x: -x["total"],
        )
        for person, cats in by_person_category.items()
    }

    return {
        "by_category": cat_list,
        "by_person_category": person_cat_out,
    }

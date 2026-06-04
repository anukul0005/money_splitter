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

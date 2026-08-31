from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database import get_db
from models import Activity, ActivitySeen, Group, Member
from schemas import ActivityOut

router = APIRouter(prefix="/activity", tags=["activity"])


def _visible_group_ids(name: str, db: Session) -> list[int]:
    """Groups the named user is a member of — the only feed rows they may see."""
    rows = (
        db.query(Member.group_id)
        .filter(Member.name.ilike(name.strip()))
        .distinct()
        .all()
    )
    return [r[0] for r in rows]


def _last_seen(name: str, db: Session):
    row = db.query(ActivitySeen).filter(ActivitySeen.user_name.ilike(name.strip())).first()
    return row.last_seen_at if row else None


def _is_unread(created_at, last_seen) -> bool:
    if created_at is None:
        return False
    if last_seen is None:
        return True
    a, b = created_at, last_seen
    # Rows can come back naive (SQLite) or aware (Postgres); compare like for like
    if (a.tzinfo is None) != (b.tzinfo is None):
        a = a.replace(tzinfo=None)
        b = b.replace(tzinfo=None)
    return a > b


@router.get("/", response_model=list[ActivityOut])
def list_activity(name: str, limit: int = 40, db: Session = Depends(get_db)):
    """The feed for one user: activity in their groups only, newest first."""
    group_ids = _visible_group_ids(name, db)
    if not group_ids:
        return []

    last_seen = _last_seen(name, db)
    rows = (
        db.query(Activity)
        .filter(Activity.group_id.in_(group_ids))
        .order_by(Activity.created_at.desc(), Activity.id.desc())
        .limit(max(1, min(limit, 100)))
        .all()
    )

    out: list[ActivityOut] = []
    for r in rows:
        item = ActivityOut.model_validate(r)
        item.unread = _is_unread(r.created_at, last_seen)
        out.append(item)
    return out


@router.get("/unread-count", response_model=dict)
def unread_count(name: str, db: Session = Depends(get_db)):
    group_ids = _visible_group_ids(name, db)
    if not group_ids:
        return {"count": 0}

    last_seen = _last_seen(name, db)
    q = db.query(Activity).filter(Activity.group_id.in_(group_ids))
    if last_seen is not None:
        q = q.filter(Activity.created_at > last_seen)
    return {"count": q.count()}


@router.post("/seen", response_model=dict)
def mark_seen(name: str, db: Session = Depends(get_db)):
    """Move the user's high-water mark to now, clearing the unread badge."""
    clean = name.strip()
    row = db.query(ActivitySeen).filter(ActivitySeen.user_name.ilike(clean)).first()
    now = datetime.now(timezone.utc)
    if row:
        row.last_seen_at = now
    else:
        db.add(ActivitySeen(user_name=clean, last_seen_at=now))
    db.commit()
    return {"ok": True}

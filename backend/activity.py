"""In-app activity feed.

Every entry is tied to a group, and the feed query only ever returns entries
for groups the asking user is a member of. That is what keeps a change
invisible to users it doesn't affect: if p4 isn't in the group, no query of
p4's feed can reach the row.
"""

from sqlalchemy.orm import Session

from models import Activity


def record_activity(db: Session, group, actor: str | None, verb: str, summary: str | None = None) -> None:
    """Append one entry to the feed. Never raises — a feed write must not be
    able to fail the user action that triggered it."""
    try:
        if group is None:
            return
        db.add(Activity(
            group_id=group.id,
            group_name=group.name,
            actor=(actor or "").strip() or None,
            verb=verb,
            summary=summary,
        ))
    except Exception as e:  # pragma: no cover - defensive
        print(f"[activity] failed to record '{verb}': {e}")

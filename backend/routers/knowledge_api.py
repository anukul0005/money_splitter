"""Reading and rebuilding the knowledge base.

Search is scoped to the caller's groups, exactly like every other read in this
app. The index spans everybody's expenses, so an unscoped search would be a
way to read what other people drink.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from auth import current_user, is_member
from database import get_db
from knowledge import DRINK, FOOD, reindex_all, search, stats
from models import Group, User

router = APIRouter(prefix="/knowledge", tags=["knowledge"])


def _my_group_ids(db: Session, caller: User) -> list[int]:
    return [g.id for g in db.query(Group).all() if is_member(g, caller)]


@router.get("/stats", response_model=dict)
def knowledge_stats(db: Session = Depends(get_db),
                    caller: User = Depends(current_user)):
    """How much has been indexed, and how much of it linked to the catalogue."""
    mine = _my_group_ids(db, caller)
    out = stats(db)
    out["your_groups"] = len(mine)
    return out


@router.get("/search", response_model=list[dict])
def knowledge_search(q: str, kind: str = "", limit: int = 20,
                     db: Session = Depends(get_db),
                     caller: User = Depends(current_user)):
    """Nearest food or drink expenses to a phrase, by cosine similarity."""
    if not q.strip():
        raise HTTPException(400, "Search for something")
    if kind and kind not in (DRINK, FOOD):
        raise HTTPException(400, f"kind must be {DRINK} or {FOOD}")
    return search(db, q, kind or None, _my_group_ids(db, caller),
                  limit=max(1, min(limit, 50)))


@router.post("/reindex", response_model=dict)
def knowledge_reindex(db: Session = Depends(get_db),
                      caller: User = Depends(current_user)):
    """Rebuild every vector from every expense.

    Admin only. It rewrites rows belonging to everybody, and it is the one
    operation here whose cost grows with the whole table rather than with the
    caller's own data.
    """
    if not caller.is_admin:
        raise HTTPException(403, "Only an admin can rebuild the index")
    return reindex_all(db)

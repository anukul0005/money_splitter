"""Field hockey in the sports section: FIH live scores, tournaments and
results, standings, stats, head-to-heads and world rankings (data: hockey.py).

For the same people as tennis and badminton (routers.tennis.owner).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

import hockey as fih
from models import User
from routers.tennis import owner

router = APIRouter(prefix="/hockey", tags=["hockey"])


def _fih(what: str, fn, *args):
    try:
        return fn(*args)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"FIH's {what} didn't answer: {type(e).__name__}")


@router.get("/live", response_model=dict)
def live(_: User = Depends(owner)):
    return _fih("live scores", fih.live)


@router.get("/events", response_model=dict)
def events(status: str = "r", page: int = 1, _: User = Depends(owner)):
    if status not in ("r", "l,u"):
        raise HTTPException(400, "status is r or l,u")
    return _fih("tournaments", fih.events, status, max(1, page), 20)


@router.get("/event/{series_id}", response_model=dict)
def event(series_id: int, _: User = Depends(owner)):
    """One tournament whole: its matches, the table and its leaders."""
    e = _fih("tournament", fih.event, series_id)
    if e is None:
        raise HTTPException(404, "No such tournament")
    return {"event": e, "matches": _fih("fixtures", fih.matches, series_id),
            "standings": _fih("standings", fih.standings, series_id)}


@router.get("/stats/{series_id}", response_model=dict)
def stats(series_id: int, _: User = Depends(owner)):
    return _fih("stats", fih.stats, series_id)


@router.get("/h2h/{match_id}", response_model=dict)
def h2h(match_id: int, _: User = Depends(owner)):
    return _fih("head-to-head", fih.h2h, match_id)


@router.get("/rankings", response_model=dict)
def rankings(gender: str = "m", _: User = Depends(owner)):
    if gender not in ("m", "f"):
        raise HTTPException(400, "gender is m or f")
    return _fih("rankings", fih.rankings, gender)

"""Lessons: the interactive learning pages (betting models from scratch, the
six models on my teams), served behind the app's login. The pages live in
backend/lessons/ as self-contained HTML; the app shows them in a sandboxed
frame (pages/Lesson.jsx), so their sliders and calculators keep working.

They're built on one person's bets and teams, so only LESSON_USERS see them.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse

from auth import current_user
from models import User

router = APIRouter(prefix="/lessons", tags=["lessons"])

DIR = Path(__file__).resolve().parent.parent / "lessons"
LESSON_USERS = {"anukul"}
LESSONS = [
    {"slug": "betting-models", "file": "betting-models.html", "title": "Betting models from scratch",
     "about": "The arithmetic, six models from first principles, then the live model worked by hand on a real pick - with interview questions."},
    {"slug": "six-models", "file": "six-models.html", "title": "Six models, on my teams",
     "about": "Logistic, GAM, LightGBM, random forest, neural net and Bayesian on this weekend's matches, and how each scored on six unseen seasons."},
]


def reader(caller: User = Depends(current_user)) -> User:
    if (caller.name or "").lower() not in LESSON_USERS:
        raise HTTPException(404, "Not found")
    return caller


@router.get("", response_model=list[dict])
def list_lessons(_: User = Depends(reader)):
    return [{k: x[k] for k in ("slug", "title", "about")} for x in LESSONS]


@router.get("/{slug}", response_class=HTMLResponse)
def lesson(slug: str, _: User = Depends(reader)):
    x = next((x for x in LESSONS if x["slug"] == slug), None)
    if not x:
        raise HTTPException(404, "No such lesson")
    return HTMLResponse((DIR / x["file"]).read_text(encoding="utf-8"), headers={"Cache-Control": "private, max-age=300"})

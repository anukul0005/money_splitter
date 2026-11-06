"""Recipes: the cookbook package (an Indian recipe recommender with
nutrition, weight-loss planning and costing) behind the app's login.

cookbook is self-contained; this file is its host - it hands it the app's
LLM (ai_text) and keys, and keeps each person's profile and kitchen."""
from __future__ import annotations

import json
import threading

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import ai_text
import cookbook
from auth import current_user
from cookbook import body, engine, foods, indb, prices
from database import get_db, get_settings
from models import RecipeKitchen, User

router = APIRouter(prefix="/recipes", tags=["recipes"])

cookbook.configure(ai_text.chat_json, lambda name: getattr(get_settings(), name, ""))


def _warm():
    try:
        indb.dishes()
    except Exception as e:  # pragma: no cover - retried on first use
        print(f"[recipes] INDB not loaded yet: {e}")


# INDB is downloaded and parsed once; started now so the first question doesn't wait on it
threading.Thread(target=_warm, daemon=True).start()


def _kitchen(db: Session, user: User) -> RecipeKitchen:
    k = db.query(RecipeKitchen).filter(RecipeKitchen.user_id == user.id).first()
    if not k:
        k = RecipeKitchen(user_id=user.id)
        db.add(k)
    return k


def _read(k: RecipeKitchen) -> tuple[dict, list]:
    try:
        profile = json.loads(k.profile_json or "{}")
    except ValueError:
        profile = {}
    try:
        pantry = json.loads(k.pantry_json or "[]")
    except ValueError:
        pantry = []
    return profile, pantry


def _sources() -> dict:
    return {
        "indb": {"name": indb.SOURCE, "url": indb.SOURCE_URL,
                 "dishes": len(indb._dishes) if indb._dishes is not None else None},
        "usda": {"name": foods.SOURCE, "url": foods.SOURCE_URL, "own_key": bool(get_settings().fdc_api_key)},
        "prices": {"mandi": prices.mandi_on(), "url": prices.SOURCE_URL},
    }


@router.get("/me")
def me(db: Session = Depends(get_db), caller: User = Depends(current_user)):
    profile, pantry = _read(_kitchen(db, caller))
    return {"profile": profile, "pantry": pantry, "targets": body.targets(profile), "sources": _sources()}


class KitchenIn(BaseModel):
    profile: dict | None = None
    pantry: list[str] | None = None


@router.put("/me")
def save_me(payload: KitchenIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    k = _kitchen(db, caller)
    if payload.profile is not None:
        keep = ("age", "sex", "height_cm", "weight_kg", "activity", "pace", "diet")
        k.profile_json = json.dumps({x: payload.profile.get(x) for x in keep if payload.profile.get(x) not in (None, "")})
    if payload.pantry is not None:
        items = list(dict.fromkeys(" ".join(str(p).split())[:40] for p in payload.pantry if str(p).strip()))
        k.pantry_json = json.dumps(items[:80])
    db.commit()
    profile, pantry = _read(k)
    return {"profile": profile, "pantry": pantry, "targets": body.targets(profile)}


class AskIn(BaseModel):
    question: str


@router.post("/ask")
def ask(payload: AskIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    if len(payload.question.strip()) < 3:
        raise HTTPException(400, "Ask something - e.g. a high-protein breakfast under 350 calories")
    profile, pantry = _read(_kitchen(db, caller))
    db.rollback()       # nothing to save; don't hold the row while the LLM thinks
    try:
        return engine.ask(payload.question, pantry, profile)
    except Exception as e:
        print(f"[recipes] ask failed: {e!r}")
        raise HTTPException(502, "Couldn't work that out just now - try again in a moment")


class PlanIn(BaseModel):
    days: int = 7
    diet: str = "any"


@router.post("/plan")
def make_plan(payload: PlanIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    profile, _ = _read(_kitchen(db, caller))
    db.rollback()
    try:
        return engine.plan(profile, payload.days, payload.diet)
    except Exception as e:
        print(f"[recipes] plan failed: {e!r}")
        raise HTTPException(502, "Couldn't make the plan just now - try again in a moment")

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
    k = _kitchen(db, caller)
    profile, pantry = _read(k)
    try:
        plan = json.loads(k.plan_json) if k.plan_json else None
    except ValueError:
        plan = None
    return {"profile": profile, "pantry": pantry, "targets": body.targets(profile), "sources": _sources(),
            "plan": plan, "log": _log(k, plan)}


def _log(k: RecipeKitchen, plan: dict | None) -> dict:
    """What's been eaten against the current plan ({} for a new plan)."""
    try:
        log = json.loads(k.log_json) if k.log_json else {}
    except ValueError:
        log = {}
    if not plan or log.get("plan") != plan.get("made_at"):
        return {}
    return log.get("days") or {}


MEALS = ("breakfast", "lunch", "dinner", "snack")


class LogIn(BaseModel):
    day: int
    meal: str
    text: str | None = None            # what was eaten, in any words
    planned: list[dict] | None = None  # [{name, servings}] - eaten as planned
    add: bool = False                  # add to what's logged for the meal, rather than replace it


@router.post("/log")
def log_meal(payload: LogIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """A meal of the plan as actually eaten - worked out and kept."""
    if payload.meal not in MEALS or not 1 <= payload.day <= 7:
        raise HTTPException(400, "Which day and meal?")
    if not (payload.text or "").strip() and not payload.planned:
        raise HTTPException(400, "Say what you had")
    k = _kitchen(db, caller)
    plan = json.loads(k.plan_json) if k.plan_json else None
    if not plan:
        raise HTTPException(400, "Make a plan first - meals are tracked against it")
    db.rollback()
    try:
        entry = engine.read_meal(payload.text, payload.planned)
    except Exception as e:
        print(f"[recipes] read meal failed: {e!r}")
        raise HTTPException(502, "Couldn't read that just now - try again")
    if not entry["items"]:
        raise HTTPException(400, "Couldn't tell what was eaten - try naming the dishes")
    k = _kitchen(db, caller)
    days = _log(k, plan)
    day = days.setdefault(str(payload.day), {})
    old = day.get(payload.meal)
    if payload.add and old:
        # This dish replaces itself if it was there; the rest of the meal stays
        names = {i["name"] for i in entry["items"]}
        items = [i for i in old["items"] if i["name"] not in names] + entry["items"]
        known = [i["nutrition"] for i in items if i.get("nutrition")]
        costs = [i["cost"] for i in items if i.get("cost") is not None]
        entry = {"text": old.get("text"), "items": items, "unknown": [i["said"] for i in items if not i.get("nutrition")],
                 "totals": engine._sum(known), "cost": round(sum(costs)) if costs else None}
    from datetime import datetime, timezone
    entry["logged_at"] = datetime.now(timezone.utc).isoformat()
    day[payload.meal] = entry
    k.log_json = json.dumps({"plan": plan.get("made_at"), "days": days})
    db.commit()
    return {"log": days, "entry": entry}


class UnlogIn(BaseModel):
    day: int
    meal: str


@router.post("/log/remove")
def unlog_meal(payload: UnlogIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    k = _kitchen(db, caller)
    plan = json.loads(k.plan_json) if k.plan_json else None
    days = _log(k, plan)
    days.get(str(payload.day), {}).pop(payload.meal, None)
    k.log_json = json.dumps({"plan": (plan or {}).get("made_at"), "days": days})
    db.commit()
    return {"log": days}


def _keep_plan(db: Session, user: User, plan: dict) -> None:
    """The plan just made, kept - Recipes shows it again next time."""
    if plan.get("mode") != "plan" or not plan.get("days"):
        return
    from datetime import datetime, timezone
    plan["made_at"] = datetime.now(timezone.utc).isoformat()
    # The week runs Friday to Thursday: day 1 is the Friday on or before today (India time)
    from datetime import timedelta
    today = datetime.now(timezone(timedelta(hours=5, minutes=30))).date()
    plan["starts"] = (today - timedelta(days=(today.weekday() - 4) % 7)).isoformat()
    k = _kitchen(db, user)
    k.plan_json = json.dumps(plan)
    db.commit()


class KitchenIn(BaseModel):
    profile: dict | None = None
    pantry: list[str] | None = None
    confirm: bool = False       # "still the same" - the details checked, unchanged


@router.put("/me")
def save_me(payload: KitchenIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    k = _kitchen(db, caller)
    if payload.profile is not None:
        keep = ("age", "sex", "height_cm", "weight_kg", "activity", "pace", "diet")
        from datetime import datetime, timezone
        old, _ = _read(k)
        new = {x: payload.profile.get(x) for x in keep if payload.profile.get(x) not in (None, "")}
        # When the numbers last changed - Recipes asks for an update a fortnight on
        changed = any(str(new.get(x)) != str(old.get(x)) for x in keep)
        fresh = changed or payload.confirm or not old.get("updated_at")
        new["updated_at"] = datetime.now(timezone.utc).isoformat() if fresh else old["updated_at"]
        k.profile_json = json.dumps(new)
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
        out = engine.ask(payload.question, pantry, profile)
    except Exception as e:
        print(f"[recipes] ask failed: {e!r}")
        raise HTTPException(502, "Couldn't work that out just now - try again in a moment")
    _keep_plan(db, caller, out)
    return out


class DishIn(BaseModel):
    name: str
    servings: float = 1.0
    recipe: dict | None = None     # a suggestion already written - its ingredients and steps


@router.post("/dish")
def dish(payload: DishIn, caller: User = Depends(current_user)):
    """One dish's own page: breakdown, priced ingredients, method, photo."""
    if not payload.name.strip():
        raise HTTPException(400, "Which dish?")
    try:
        return engine.dish(payload.name.strip()[:200], payload.servings, payload.recipe)
    except Exception as e:
        print(f"[recipes] dish failed: {e!r}")
        raise HTTPException(502, "Couldn't open that dish just now - try again")


class PlanIn(BaseModel):
    days: int = 7
    diet: str = "any"


@router.post("/plan")
def make_plan(payload: PlanIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    profile, _ = _read(_kitchen(db, caller))
    db.rollback()
    try:
        out = engine.plan(profile, payload.days, payload.diet)
    except Exception as e:
        print(f"[recipes] plan failed: {e!r}")
        raise HTTPException(502, "Couldn't make the plan just now - try again in a moment")
    _keep_plan(db, caller, out)
    return out

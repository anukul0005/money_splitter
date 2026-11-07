"""Recommend's chat box and mic (Drinks and Food): a message in plain words,
typed or said, read into one of two things -

  - a recommendation: the page's own settings (state or city, people,
    budget, sizes / kinds, cuisine...) filled in, and the page runs it;
  - a question about a bottle or a place ("what does Black & White cost in
    Delhi", "how strong is Old Monk", "is Nutriobox veg"): answered from the
    app's own price and product data - the drinks / food search - never
    from the AI's memory.

The AI only reads the words; every price, strength and size it reports
comes from the data, and every setting is checked against the options the
page actually has.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import ai_text
from auth import current_user, require_full_access
from database import get_db
from models import User

router = APIRouter(prefix="/ask", tags=["ask"])

_DRINKS = """You read a message from someone in India about buying alcohol. Return ONLY JSON:
{
  "intent": "recommend" (they want something suggested for an evening / a budget) or "lookup" (they ask about a particular bottle - its price, strength, sizes, where it's cheaper),
  "brand": for a lookup, the bottle's brand as said ("Black & White", "Old Monk") else null,
  "state": one of the states listed, if they name one or a city in it (Gurgaon/Gurugram -> the Haryana entry, Noida -> Uttar Pradesh), else null,
  "people": number or null (count the user: "me and 2 friends" = 3),
  "with": [names from the friends listed that they mention] or [],
  "budget_min": number or null, "budget_max": number or null - rupees for the WHOLE group ("under 1000" = max 1000, min null; "around 1000" = 800 to 1200; "500 each" = 500 x people),
  "bottles": [any of "180" (quarter), "375" (half), "750" (full), "other", "beer", "rtd"] or [],
  "kinds": [any of "whisky", "rum", "vodka", "gin"] or [],
  "reply": one short friendly line saying what you understood - no prices or strengths (those come from the data)
}"""

_FOOD = """You read a message from someone in India about eating out. Return ONLY JSON:
{
  "intent": "recommend" (they want places suggested) or "lookup" (they ask about a particular restaurant / place by name),
  "place": for a lookup, the place's name as said, else null,
  "city": one of the cities listed if they name it (or a place in it), else null,
  "people": number or null (count the user),
  "with": [names from the friends listed that they mention] or [],
  "budget_min": number or null, "budget_max": number or null - rupees for the WHOLE table ("around 2000" = 1600 to 2400; "500 a head" = 500 x people),
  "cuisine": one of the cuisines listed, or null,
  "kind": one of the kinds of place listed (its value), or null,
  "veg": true if they want pure-veg places only, else false,
  "reply": one short friendly line saying what you understood - no prices (those come from the data)
}"""


class AskIn(BaseModel):
    text: str
    mode: str = "drinks"            # drinks | food
    places: list[str] = []          # the states (drinks) or cities (food) the page offers
    friends: list[str] = []
    cuisines: list[str] = []
    kinds: list[dict] = []          # food: [{value, name}]


def _num(v):
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _pick(v, options: list[str]):
    """The option meant, matched without minding case - else None."""
    s = str(v or "").strip().lower()
    if not s:
        return None
    for o in options:
        if o.lower() == s:
            return o
    hits = [o for o in options if s in o.lower() or o.lower() in s]
    return hits[0] if len(hits) == 1 else None


def _drinks_answer(found: dict, brand: str, state: str | None) -> str:
    """A bottle's prices and strength, said from the search's own rows."""
    rows = [r for r in found.get("results") or [] if r.get("price")]
    if not rows:
        unpriced = [r for r in found.get("results") or [] if r.get("not_currently_sold")]
        if unpriced:
            return f"{unpriced[0]['brand']} is registered{' in ' + state if state else ''} but not on sale at a listed price right now."
        return f"I couldn't find {brand}{' in ' + state if state else ''} in the price lists."
    lines = []
    for r in rows[:4]:
        size = r.get("size_name") or f"{r['size_ml']} ml"
        line = f"{r['brand']} · {size}: ₹{r['price']:,} in {r['state']}"
        if r.get("abv"):
            line += f" · {r['abv']:g}% ABV" + ("" if r.get("abv_known") else " (usual for its kind)")
        if r.get("cheapest_region") and r["cheapest_region"] != r["state"]:
            line += f" · cheapest in {r['cheapest_region']}"
        lines.append(line)
    more = len(rows) - len(lines)
    return "\n".join(lines) + (f"\n…and {more} more below." if more > 0 else "")


def _food_answer(found: dict, place: str) -> str:
    rows = found.get("results") or []
    if not rows:
        return f"I couldn't find {place} in the listings - add it if you know its prices."
    lines = []
    for r in rows[:3]:
        price = f"₹{r['for_two']:,}" + (f"–{r['for_two_max']:,}" if r.get("for_two_max") else "") + " for two" if r.get("for_two") else "no price yet"
        bits = [r["name"], r.get("area") or r.get("city"), price, r.get("kind_name")]
        if r.get("veg_only"):
            bits.append("pure veg")
        if r.get("cuisines"):
            bits.append(", ".join(r["cuisines"][:3]))
        lines.append(" · ".join(str(b) for b in bits if b))
    return "\n".join(lines)


@router.post("/understand")
def understand(payload: AskIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    text = payload.text.strip()
    if len(text) < 2:
        raise HTTPException(400, "Say what you're after")
    drinks = payload.mode != "food"
    if drinks:
        require_full_access(caller)
    lists = [f"{'States' if drinks else 'Cities'}: " + ", ".join(payload.places[:60]),
             "Friends: " + ", ".join(payload.friends[:80])]
    if not drinks:
        lists += ["Cuisines: " + ", ".join(payload.cuisines[:80]),
                  "Kinds of place: " + ", ".join(f"{k.get('value')} ({k.get('name')})" for k in payload.kinds[:20])]
    try:
        got = ai_text.chat_json(_DRINKS if drinks else _FOOD, "\n".join(lists) + f"\n\nMessage: {text[:600]}",
                                temperature=0, timeout=30, extra={"reasoning_effort": "low"})
    except Exception as e:
        print(f"[ask] understand failed: {e!r}")
        raise HTTPException(502, "Couldn't read that just now - try again, or use Edit details")

    where = _pick(got.get("state" if drinks else "city"), payload.places)
    lo, hi = _num(got.get("budget_min")), _num(got.get("budget_max"))
    if lo and hi and hi < lo:
        lo, hi = hi, lo
    out = {
        "intent": "lookup" if got.get("intent") == "lookup" else "recommend",
        "where": where,
        "people": int(_num(got.get("people")) or 0) or None,
        "with": [f for f in (_pick(n, payload.friends) for n in got.get("with") or []) if f],
        "budget_min": round(lo) if lo else None,
        "budget_max": round(hi) if hi else None,
        "reply": (got.get("reply") or "").strip()[:300] or None,
    }
    if drinks:
        out["bottles"] = [b for b in got.get("bottles") or [] if b in ("180", "375", "750", "other", "beer", "rtd")]
        out["kinds"] = [k for k in got.get("kinds") or [] if k in ("whisky", "rum", "vodka", "gin")]
    else:
        out["cuisine"] = _pick(got.get("cuisine"), payload.cuisines)
        kinds = [k.get("value") for k in payload.kinds if k.get("value")]
        out["kind"] = _pick(got.get("kind"), kinds)
        out["veg"] = bool(got.get("veg"))

    # A question about one bottle or place: answered from the data itself
    name = str(got.get("brand" if drinks else "place") or "").strip()
    if out["intent"] == "lookup" and len(name) >= 2:
        out["q"] = name
        try:
            if drinks:
                from routers.recommend import search as drinks_search
                found = drinks_search(state=where or "", q=name, bottle="any", kind="", budget_min=None,
                                      budget_max=None, db=db, caller=caller)
                out["answer"] = _drinks_answer(found, name, where)
            else:
                from routers.food import search as food_search
                found = food_search(city=where or "", q=name, cuisine="any", kind="any", veg=False, db=db, caller=caller)
                out["answer"] = _food_answer(found, name)
        except HTTPException as e:
            out["answer"] = str(e.detail)
    elif out["intent"] == "lookup":
        out["intent"] = "recommend"
    return out

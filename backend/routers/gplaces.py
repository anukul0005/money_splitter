"""Places - find any restaurant on Google, and what you've had there.

Backs the Recommend page's Places tab. Every Google call is counted
(GooglePlacesUsage) against the free monthly allowance and shown to everyone
on that tab; daily caps stop well short of it, so the app can't run up a
bill. Searches and place details are cached (GooglePlaceSearch,
GooglePlace) and a repeat look - by anyone - is free.

Your history at a place is read from your own expenses: the venue the food
indexer read (knowledge_items), the expense's venue, title and the
statement's merchant name, matched loosely against the place's name - so it
covers every branch of a chain. What you ate comes from receipt items and
an expense's itemised parts.
"""
from __future__ import annotations

import json
import re
from collections import Counter
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text as sql
from sqlalchemy.orm import Session

import google_places as gp
from auth import current_user, is_member
from database import get_db
from models import Expense, Group, GooglePlace, GooglePlaceSearch, GooglePlacesUsage, User

router = APIRouter(prefix="/gplaces", tags=["places"])

IST = timezone(timedelta(hours=5, minutes=30))
# Google's free calls a month for what we ask (Text Search Pro / Place
# Details Enterprise), and our own daily stop - matching the Cloud quotas.
FREE = {"search": 5000, "details": 1000}
DAILY = {"search": 150, "details": 30}
SEARCH_TTL_DAYS = 7
DETAILS_TTL_DAYS = 14


# ── Usage counter ─────────────────────────────────────────────────────────────

def _today() -> str:
    return datetime.now(IST).date().isoformat()


def _bump(db: Session, kind: str) -> None:
    db.execute(sql("""INSERT INTO google_places_usage (day, kind, count) VALUES (:d, :k, 1)
                      ON CONFLICT (day, kind) DO UPDATE SET count = google_places_usage.count + 1"""),
               {"d": _today(), "k": kind})
    db.commit()


def _usage(db: Session) -> dict:
    today = _today()
    month = today[:7]
    rows = db.query(GooglePlacesUsage).filter(GooglePlacesUsage.day.like(f"{month}%")).all()
    out = {"month": month, "today": today}
    for k in FREE:
        out[k] = {
            "month": sum(r.count for r in rows if r.kind == k),
            "today": sum(r.count for r in rows if r.kind == k and r.day == today),
            "cached_month": sum(r.count for r in rows if r.kind == f"{k}_cached"),
            "free": FREE[k], "daily_cap": DAILY[k],
        }
    return out


def _allow(db: Session, kind: str) -> None:
    u = _usage(db)[kind]
    if u["month"] >= FREE[kind]:
        raise HTTPException(429, f"This month's free Google {kind} allowance is used up - "
                                 "it resets on the 1st. Places already looked up still open.")
    if u["today"] >= DAILY[kind]:
        raise HTTPException(429, f"Today's Google {kind} limit ({DAILY[kind]}) is reached - "
                                 "try again tomorrow. Places already looked up still open.")


@router.get("/usage")
def usage(db: Session = Depends(get_db), _: User = Depends(current_user)):
    return _usage(db)


# ── Your history at a place ───────────────────────────────────────────────────

_GENERIC = {"restaurant", "restaurants", "the", "pvt", "ltd", "private", "limited", "and", "co",
            "family", "veg", "pure", "cafe", "café"}


def _norm(s: str | None) -> str:
    s = (s or "").lower().replace("’", "'").replace("'", "")
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def _core(name: str) -> str:
    """ "Haldiram's - Noida Sector-18" -> "haldirams": the brand part of a
    Google name, without the branch, as one squashed string."""
    head = re.split(r"\s[-–|]\s|,|\(|\|", name or "")[0]
    words = [w for w in _norm(head).split() if w not in _GENERIC] or _norm(head).split()
    return "".join(words)


def _squash(s: str | None) -> str:
    return _norm(s).replace(" ", "")


def _matches(core: str, texts: list[str | None]) -> bool:
    if len(core) < 3:
        return False
    for t in texts:
        sq = _squash(t)
        if not sq:
            continue
        if core in sq:
            return True
        # the expense names a shorter form of the place ("Sagar" for Sagar Ratna
        # wouldn't, but "Sagar Ratna" for "Sagar Ratna Restaurants" does)
        if len(sq) >= 5 and sq in core:
            return True
    return False


def _candidates(db: Session, caller: User) -> tuple[dict, list]:
    groups = {g.id: g for g in db.query(Group).all() if is_member(g, caller)}
    if not groups:
        return groups, []
    rows = db.execute(sql("""
        SELECT e.id, e.date, e.title, e.amount, e.divider, e.group_id, e.venue, e.merchant,
               k.venue AS kvenue, k.matched_brand
        FROM expenses e LEFT JOIN knowledge_items k ON k.expense_id = e.id
        WHERE e.group_id = ANY(:g)
    """), {"g": list(groups)}).mappings().all()
    return groups, rows


def _visits(core: str, rows) -> list:
    return [r for r in rows
            if _matches(core, [r["kvenue"], r["matched_brand"], r["venue"], r["merchant"], r["title"]])]


_NOT_FOOD = re.compile(r"\b(tax|gst|cgst|sgst|vat|service|charge|discount|round|total|tip|packing|delivery)\b", re.I)


def _history(db: Session, name: str, rows, groups) -> dict:
    hits = _visits(_core(name), rows)
    if not hits:
        return {"visits": 0}
    hits.sort(key=lambda r: r["date"] or "", reverse=True)
    ids = [r["id"] for r in hits]
    items: Counter = Counter()
    for e in db.query(Expense).filter(Expense.id.in_(ids)).all():
        got = False
        try:
            rec = json.loads(e.receipt_json) if e.receipt_json else None
        except ValueError:
            rec = None
        for it in (rec or {}).get("items") or []:
            label = " ".join(str(it.get("label") or "").split())
            if label and not _NOT_FOOD.search(label) and len(label) <= 60:
                items[label.title()] += 1
                got = True
        if not got:
            for p in e.parts or []:
                if p.label and not _NOT_FOOD.search(p.label):
                    items[" ".join(p.label.split()).title()] += 1
    per_head = [r["amount"] / max(r["divider"] or 1, 1) for r in hits]
    return {
        "visits": len(hits),
        "last_visit": (hits[0]["date"] or "")[:10] or None,
        "first_visit": (hits[-1]["date"] or "")[:10] or None,
        "avg_bill": round(sum(r["amount"] for r in hits) / len(hits)),
        "avg_per_head": round(sum(per_head) / len(per_head)),
        "spent_share": round(sum(per_head)),
        "ordered": [{"item": k, "times": v} for k, v in items.most_common(8)],
        "list": [{"id": r["id"], "date": (r["date"] or "")[:10] or None, "title": r["title"],
                  "amount": r["amount"], "per_head": round(r["amount"] / max(r["divider"] or 1, 1), 2),
                  "group": groups[r["group_id"]].name, "group_id": r["group_id"]} for r in hits[:30]],
    }


# ── Search and details ────────────────────────────────────────────────────────

def _brief_out(p: GooglePlace) -> dict:
    return {"place_id": p.place_id, "name": p.name, "address": p.address,
            "lat": p.lat, "lon": p.lon, "type": p.kind}


def _save(db: Session, h: dict) -> GooglePlace:
    p = db.get(GooglePlace, h["place_id"]) or GooglePlace(place_id=h["place_id"], views=0)
    p.name, p.address, p.lat, p.lon, p.kind = h["name"], h["address"], h["lat"], h["lon"], h["type"]
    db.add(p)
    return p


@router.get("/search")
def search(q: str, lat: float | None = None, lon: float | None = None,
           db: Session = Depends(get_db), caller: User = Depends(current_user)):
    q = " ".join(q.split())
    if len(q) < 2:
        raise HTTPException(400, "Type at least 2 letters to search")
    if len(q) > 120:
        raise HTTPException(400, "That's a long name - shorten it a little")
    near = (round(lat, 2), round(lon, 2)) if lat is not None and lon is not None else None
    qkey = f"{_norm(q)}@{near[0]},{near[1]}" if near else _norm(q)
    cached = db.get(GooglePlaceSearch, qkey)
    fresh = cached and cached.at and cached.at > datetime.now(timezone.utc) - timedelta(days=SEARCH_TTL_DAYS)
    if fresh:
        ids = json.loads(cached.place_ids)
        places = {p.place_id: p for p in db.query(GooglePlace).filter(GooglePlace.place_id.in_(ids)).all()}
        results = [_brief_out(places[i]) for i in ids if i in places]
        _bump(db, "search_cached")
        from_cache = True
    else:
        if not gp.available():
            raise HTTPException(503, "Google Places isn't set up on the server")
        _allow(db, "search")
        try:
            hits = gp.search(q, near=near, limit=8)
        except gp.PlacesError as e:
            raise HTTPException(502, str(e))
        _bump(db, "search")
        for h in hits:
            _save(db, h)
        row = cached or GooglePlaceSearch(qkey=qkey)
        row.place_ids, row.at = json.dumps([h["place_id"] for h in hits]), datetime.now(timezone.utc)
        db.add(row)
        db.commit()
        results = hits
        from_cache = False
    groups, rows = _candidates(db, caller)
    for r in results:
        r["my_visits"] = len(_visits(_core(r["name"]), rows))
    return {"results": results, "from_cache": from_cache, "usage": _usage(db)}


@router.get("/place/{place_id}")
def place(place_id: str, refresh: bool = False,
          db: Session = Depends(get_db), caller: User = Depends(current_user)):
    p = db.get(GooglePlace, place_id)
    now = datetime.now(timezone.utc)
    have = p is not None and bool(p.details_json) and p.details_at is not None
    need = (not have or p.details_at < now - timedelta(days=DETAILS_TTL_DAYS)
            # a manual refresh, at most once an hour
            or (refresh and p.details_at < now - timedelta(hours=1)))
    called = False
    if need:
        if not gp.available():
            if not have:
                raise HTTPException(503, "Google Places isn't set up on the server")
        else:
            try:
                _allow(db, "details")
                d = gp.details(place_id)
            except HTTPException:
                if not have:
                    raise
                d = None                    # out of calls: show what we have
            except gp.PlacesError as e:
                if not have:
                    raise HTTPException(502, str(e))
                d = None
            if d:
                _bump(db, "details")
                p = _save(db, d)
                p.details_json, p.details_at = json.dumps(d), now
                called = True
    if not called:
        _bump(db, "details_cached")
        p = db.get(GooglePlace, place_id)
    p.views = (p.views or 0) + 1
    p.last_viewed_by, p.last_viewed_at = caller.name, datetime.now(timezone.utc)
    db.commit()
    d = json.loads(p.details_json)
    groups, rows = _candidates(db, caller)
    return {**d, "fetched_at": p.details_at.isoformat() if p.details_at else None,
            "from_cache": not called,
            # Google's "open now" holds only when it was asked - an older answer shows the hours instead
            "open_now": d.get("open_now") if p.details_at > now - timedelta(hours=1) else None,
            "history": _history(db, p.name or "", rows, groups),
            "usage": _usage(db)}


@router.get("/recent")
def recent(db: Session = Depends(get_db), _: User = Depends(current_user)):
    """Places anyone opened lately - opening one again costs nothing."""
    ps = (db.query(GooglePlace).filter(GooglePlace.details_json.isnot(None))
          .order_by(GooglePlace.last_viewed_at.desc().nullslast()).limit(12).all())
    out = []
    for p in ps:
        d = json.loads(p.details_json)
        out.append({**_brief_out(p), "rating": d.get("rating"), "price_level": d.get("price_level"),
                    "views": p.views})
    return out

"""Bottles I've had - see bottles.py for how they're read from expenses."""
from __future__ import annotations

from collections import defaultdict

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

import bottles
from auth import current_user, is_member
from database import get_db
from models import DrinkBottle, DrinkScan, Group, User

router = APIRouter(prefix="/drinks", tags=["drinks"])

SIZE_ORDER = {"quarter": 1, "half": 2, "pint": 3, "can": 4, "bottle": 5, "full": 6}


def _mine(db: Session, caller: User):
    """The caller's drink expenses they had a share in, with their groups."""
    from routers.stats import _member_share
    groups = {g.id: g for g in db.query(Group).all() if is_member(g, caller)}
    expenses = bottles.drink_expenses(db, list(groups)) if groups else []
    mine = [e for e in expenses
            if len(groups[e.group_id].members) == 1 or _member_share(e, caller.name) is not None
            or (e.paid_by or "").lower() == caller.name.lower()]
    return groups, expenses, mine


def _key(b: DrinkBottle) -> tuple[str, str]:
    return bottles.bottle_key(b.name), str(b.size_ml or b.size or "")


@router.get("/my-bottles", response_model=dict)
def my_bottles(db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """Every bottle the caller has had: times bought, bottles in all, the
    average price of one (over the purchases that say what it cost) and the
    last time. Starts reading any drink expense not read yet."""
    groups, expenses, mine = _mine(db, caller)
    scanned = {s.expense_id: s.text_hash for s in db.query(DrinkScan).filter(
        DrinkScan.expense_id.in_([e.id for e in expenses])).all()} if expenses else {}
    unread = sum(1 for e in expenses if scanned.get(e.id) != bottles._hash(e))
    if unread:
        bottles.scan_in_background(list(groups))

    by_id = {e.id: e for e in mine}
    rows = db.query(DrinkBottle).filter(DrinkBottle.expense_id.in_(list(by_id))).all() if by_id else []
    agg: dict[tuple, dict] = {}
    spellings: dict[tuple, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for b in rows:
        k = _key(b)
        e = by_id[b.expense_id]
        a = agg.setdefault(k, {"size": b.size, "size_ml": b.size_ml, "times": 0, "bottles": 0,
                               "priced": 0, "spent": 0.0, "last": None})
        a["times"] += 1
        a["bottles"] += b.qty
        if b.price_each:
            a["priced"] += b.qty
            a["spent"] += b.price_each * b.qty
        if e.date and (a["last"] is None or e.date > a["last"]):
            a["last"] = e.date[:10]
        spellings[k][b.name] += 1
    out = []
    for k, a in agg.items():
        name = max(spellings[k].items(), key=lambda x: x[1])[0]
        out.append({"name": name, "size": a["size"], "size_ml": a["size_ml"], "times": a["times"],
                    "bottles": a["bottles"], "avg_price": round(a["spent"] / a["priced"]) if a["priced"] else None,
                    "priced": a["priced"], "last": a["last"]})
    out.sort(key=lambda x: (-x["times"], x["name"].lower(), SIZE_ORDER.get(x["size"] or "", 9)))
    return {"bottles": out, "brands": _brands(out), "reading": bottles.status()["running"], "unread": unread}


def _brands(sizes: list[dict]) -> list[dict]:
    """The same bottles, one entry per brand ("Old Monk"), its sizes inside -
    quarter, half, full, or not said - so a brand is listed once."""
    by: dict[str, dict] = {}
    for s in sizes:
        k = bottles.bottle_key(s["name"])
        b = by.setdefault(k, {"name": s["name"], "times": 0, "bottles": 0, "last": None, "sizes": [], "_n": defaultdict(int)})
        b["times"] += s["times"]
        b["bottles"] += s["bottles"]
        b["_n"][s["name"]] += s["times"]
        if s["last"] and (b["last"] is None or s["last"] > b["last"]):
            b["last"] = s["last"]
        b["sizes"].append(s)
    out = []
    for b in by.values():
        b["name"] = max(b.pop("_n").items(), key=lambda x: x[1])[0]       # the spelling used most
        b["sizes"].sort(key=lambda s: (SIZE_ORDER.get(s["size"] or "", 9) if s["size"] else 10, s["size_ml"] or 0))
        prices = [s["avg_price"] for s in b["sizes"] if s["avg_price"] is not None]
        b["price_low"], b["price_high"] = (min(prices), max(prices)) if prices else (None, None)
        out.append(b)
    out.sort(key=lambda x: (-x["times"], x["name"].lower()))
    return out


@router.get("/my-bottles/purchases", response_model=list[dict])
def bottle_purchases(name: str, size: str = "", db: Session = Depends(get_db),
                     caller: User = Depends(current_user)):
    """Each time the caller had this bottle (name + size as listed): date,
    description, how many, the price of one, which group. Newest first."""
    groups, _, mine = _mine(db, caller)
    by_id = {e.id: e for e in mine}
    want = (bottles.bottle_key(name), size)
    rows = db.query(DrinkBottle).filter(DrinkBottle.expense_id.in_(list(by_id))).all() if by_id else []
    out = []
    for b in rows:
        if _key(b) != want:
            continue
        e = by_id[b.expense_id]
        out.append({"expense_id": e.id, "date": (e.date or "")[:10] or None, "title": e.title or e.notes,
                    "notes": e.notes, "qty": b.qty, "price_each": b.price_each, "amount": e.amount,
                    "group": groups[e.group_id].name, "group_id": e.group_id})
    out.sort(key=lambda x: x["date"] or "", reverse=True)
    return out

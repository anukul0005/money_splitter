"""People at an expense who aren't in its group.

Tea with Apoorv and Utkarsh, and Anjali and Nandini came along for just this
one: they go on the expense as guests, not as group members. A guest is a
note ("with Anjali, Nandini") unless charged. A charged guest's share comes
off what the members split, and they owe it to whoever paid - a Loan from
the payer to them, so it shows (and is settled) on the Loans page, outside
the group. Settle-up treats a charged share like one already repaid to the
payer (settlements._calculate), so the group still adds up.
"""
from __future__ import annotations

import json
from datetime import date, timedelta

from fastapi import HTTPException

DUE_DAYS = 7          # a charged guest's share is due a week after the expense


def parse(raw: str | None) -> list[dict]:
    try:
        out = json.loads(raw) if raw else []
    except (ValueError, TypeError):
        return []
    return [g for g in out if isinstance(g, dict) and g.get("name")] if isinstance(out, list) else []


def charged(exp) -> float:
    """What the expense's guests were charged - off the payer's "paid"."""
    return round(sum(float(g.get("amount") or 0) for g in parse(getattr(exp, "guests", None)) if g.get("charge")), 2)


def clean(db, caller, group, raw: str | None, amount: float) -> list[dict]:
    """The guests sent with an expense, checked: names not already in the
    group, each once; a charged one a positive amount, all of them together
    less than the expense; someone with an account only if they share a
    group with the caller (as for any loan)."""
    from routers.loans import _known_people, _resolve_person
    members = {m.name.lower() for m in group.members}
    people = None
    out, seen = [], set()
    for g in parse(raw):
        name = " ".join(str(g["name"]).split())[:100]
        if not name or name.lower() in seen:
            continue
        if name.lower() in members:
            raise HTTPException(400, f"{name} is already in this group - split with them instead")
        seen.add(name.lower())
        row = {"name": name, "charge": bool(g.get("charge"))}
        if row["charge"]:
            try:
                amt = round(float(g.get("amount") or 0), 2)
            except (TypeError, ValueError):
                amt = 0
            if amt <= 0:
                raise HTTPException(400, f"Give {name}'s share, or don't charge them")
            people = people if people is not None else _known_people(db, caller)
            resolved = _resolve_person(db, people, name)
            if not resolved:
                raise HTTPException(400, f"{name} has an account but shares no group with you - "
                                         "add them as a note only, or use another name")
            row.update(name=resolved, amount=amt)
        out.append(row)
    total = sum(g.get("amount", 0) for g in out if g["charge"])
    if total >= amount - 0.005 and total:
        raise HTTPException(400, "Guests' shares must come to less than the whole expense")
    return out


def _note(exp, group) -> str:
    what = exp.title or exp.category or "an expense"
    return f"Share of {what} ({group.name}{', ' + exp.date[:10] if exp.date else ''}) - paid by {exp.paid_by}"


def sync(db, caller, group, exp, guests: list[dict]) -> None:
    """Store `guests` on the expense, each charged one with its loan: made,
    updated, or - no longer charged - removed. A loan already part-repaid
    can't be removed by an edit."""
    from models import Loan
    old = {g["name"].lower(): g.get("loan_id") for g in parse(exp.guests) if g.get("loan_id")}
    start = (exp.date or "")[:10] or date.today().isoformat()
    try:
        due = (date.fromisoformat(start) + timedelta(days=DUE_DAYS)).isoformat()
    except ValueError:
        start, due = date.today().isoformat(), (date.today() + timedelta(days=DUE_DAYS)).isoformat()
    keep = set()
    for g in guests:
        if not g["charge"]:
            continue
        loan = db.get(Loan, old.get(g["name"].lower())) if old.get(g["name"].lower()) else None
        if loan is None:
            loan = Loan(borrower=g["name"], has_interest=False, rate_pct=3.6, created_by=caller.name,
                        card_ref=f"exp:{exp.id}")
            db.add(loan)
        loan.lender, loan.principal = exp.paid_by, g["amount"]
        loan.start_date, loan.due_date, loan.note = start, due, _note(exp, group)
        db.flush()
        g["loan_id"] = loan.id
        keep.add(loan.id)
    for name, lid in old.items():
        if lid not in keep:
            loan = db.get(Loan, lid)
            if loan is None:
                continue
            if loan.payments:
                raise HTTPException(400, f"{loan.borrower} has already paid towards their share - "
                                         "keep them charged, or remove that payment on the Loans page first")
            db.delete(loan)
    exp.guests = json.dumps(guests) if guests else None


def drop(db, exp) -> None:
    """The expense is going: its guests' loans go too, unless already
    part-repaid (that money really moved, so the loan stays)."""
    from models import Loan
    for g in parse(exp.guests):
        loan = db.get(Loan, g["loan_id"]) if g.get("loan_id") else None
        if loan is not None and not loan.payments:
            db.delete(loan)


def describe(exp) -> str:
    """ "with guests Anjali (₹100 charged), Nandini" for the activity line."""
    gs = parse(exp.guests)
    if not gs:
        return ""
    return "with guests " + ", ".join(
        f"{g['name']} (₹{float(g['amount']):,.0f} charged)" if g.get("charge") else g["name"] for g in gs)

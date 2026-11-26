"""The salary dashboard (GET /salary/dashboard): each month's pay set
against where it went - spent, invested, or still there.

  spent = monthly expenses (the caller's own monthly groups)
        + the caller's share in shared groups
        + credit card spends, each bill in the month it's made (a bill on
          23 Nov covers 24 Oct - 23 Nov: November), counted automatically
          unless already entered in a group, passed on as a loan, or fixed
          by the caller (_card_lines)
        + recurring bills (the caller's share)
        + loan repayments the caller made
  invested = investments the statement imports set aside (StatementSkip,
             kind "investment") + ones entered by hand (ManualInvestment -
             what the PhonePe statement can't see: SIPs from the bank, EPF...)
  left = salary - spent - invested

Only for someone who has entered their salary (Account page); the same
salary is used for every month shown.
"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import caller_groups, current_user
from database import get_db
from models import (CreditCardStatement, Expense, Loan, ManualInvestment, RecurringBill, RecurringCharge,
                    SalaryCardSkip, StatementSkip, User)


def line_key(statement_id: int, t: dict | None = None) -> str:
    """A card line's name for SalaryCardSkip - stable across reads of the bill."""
    if t is None:
        return f"{statement_id}:bill"
    return f"{statement_id}:{(t.get('date') or '')[:10]}:{float(t.get('amount') or 0):.2f}:{(t.get('description') or '')[:120]}"

router = APIRouter(prefix="/salary", tags=["salary"])

# ── card lines: counted on their own, fixed by hand only when needed ──────────
# Every card spend counts as the caller's - in the salary month of the bill it
# came on (a bill made on 23 Nov covers 24 Oct - 23 Nov: November) - unless:
#   passed    passed on to someone as a loan (Loans)
#   group     it's a card-paid expense the caller entered in a group or
#             their monthly group (same amount within a rupee, within 3
#             days) - counted there instead
# and the caller can fix any line, or every line from one merchant from now
# on (a "rule:<merchant>" row), as:
#   mine      counts
#   group     already in a group
#   not_mine  someone else's, a refund, a transfer - not spending
CHECKS = ("mine", "group", "not_mine")


def _bill_ym(s) -> str | None:
    return s.period or (s.statement_date or "")[:7] or None


def _card_lines(db: Session, caller: User, want: set[str], groups: dict | None = None) -> list[dict]:
    """Every card spend on the bills of the months `want`, each with its
    status and why. `groups` ({id: {name, ...}}) lets entered expenses match."""
    from datetime import date as _d, timedelta
    from card_bills import card_name
    from models import CreditCard
    marks = {}
    rules = {}
    for k, st in db.query(SalaryCardSkip.line_key, SalaryCardSkip.status).filter(SalaryCardSkip.user_id == caller.id):
        if k.startswith("rule:"):
            rules[k[5:]] = st
        else:
            marks[k] = st or "group"
    passed = {ref: who for ref, who in db.query(Loan.card_ref, Loan.borrower).filter(
        Loan.card_ref.like("bill:%"), Loan.lender.ilike(caller.name))}
    cards = {c.id: c for c in db.query(CreditCard).filter(CreditCard.user_id == caller.id)}
    stmts = db.query(CreditCardStatement).filter(CreditCardStatement.user_id == caller.id).all()
    out = []
    for s in stmts:
        ym = _bill_ym(s)
        if ym not in want:
            continue
        card = card_name(cards[s.card_id]) if s.card_id in cards else s.bank
        try:
            details = json.loads(s.details_json) if s.details_json else None
        except ValueError:
            details = None
        # The bill's own cycle as printed on it; failing that, the day after
        # the card's previous bill to this one's date
        summ = (details or {}).get("summary") or {}
        frm, to = summ.get("period_from"), summ.get("period_to") or summ.get("statement_date") or s.statement_date
        if not frm and s.statement_date:
            before = [x.statement_date for x in stmts if x.card_id == s.card_id and x.bank == s.bank
                      and x.statement_date and x.statement_date < s.statement_date]
            if before:
                frm = (_d.fromisoformat(max(before)) + timedelta(days=1)).isoformat()
        bill = {"bill_id": s.id, "bill_date": s.statement_date, "card": card, "ym": ym,
                "bill_from": frm, "bill_to": to}
        lines = (details or {}).get("transactions") or []
        if lines:
            for i, t in enumerate(lines):
                if t.get("excluded") or t.get("type") != "debit" or not t.get("date"):
                    continue
                key = line_key(s.id, t)
                title = t.get("description") or "Card spend"
                out.append({**bill, "key": key, "date": t["date"][:10], "amount": round(float(t.get("amount") or 0), 2),
                            "title": title, "merchant": merchant_name(title), "category": t.get("category"),
                            "passed_to": passed.get(f"bill:{s.id}:{i}")})
        elif s.total_due:
            out.append({**bill, "key": line_key(s.id), "date": s.statement_date or f"{ym}-01", "amount": round(s.total_due, 2),
                        "title": f"{card} bill (not broken down yet)", "merchant": card, "category": None,
                        "passed_to": None, "whole_bill": True})

    # card-paid expenses already entered, to match lines against
    entered = []
    if groups and out:
        lo = min(l["date"] for l in out)
        entered = (db.query(Expense.date, Expense.amount, Expense.title, Expense.group_id, Expense.venue)
                   .filter(Expense.group_id.in_(list(groups)), Expense.payment_mode == "credit_card",
                           Expense.paid_by.ilike(caller.name), Expense.date >= lo).all())

    # 1. each line against the card expenses already entered - one each
    used = set()
    for l in sorted(out, key=lambda l: l["date"]):
        l["payee"] = l["merchant"]                      # what the statement calls it
        l["payee_key"] = _merchant_key(l["merchant"])
        if l.get("whole_bill"):
            continue
        try:
            ld = _d.fromisoformat(l["date"])
        except ValueError:
            continue
        for j, (d, amt, title, gid, venue) in enumerate(entered):
            if j in used or not d or abs((amt or 0) - l["amount"]) > 1:
                continue
            try:
                if abs((_d.fromisoformat(d[:10]) - ld).days) > 3:
                    continue
            except ValueError:
                continue
            used.add(j)
            l["entered"] = {"title": title, "venue": venue, "group_id": gid}
            break

    # 2. the name you gave it: the matched expense's place or description;
    #    else one a matched line of the same payee got; else a place saved
    #    on the payee; else your latest description of a payment to it
    def tidy(t):
        t = " ".join((t or "").split())
        return t[:1].upper() + t[1:] if t else None
    #    A known brand (Swiggy, Blinkit...) keeps its name - one order's
    #    description isn't every order's - and shows that description as a note.
    for l in out:
        l["brand"] = not l.get("whole_bill") and _brand(l["title"]) is not None
    learnt = {}
    for l in sorted(out, key=lambda l: l["date"]):
        if l.get("entered") and not l["brand"]:
            learnt[l["payee_key"]] = tidy(l["entered"]["venue"] or l["entered"]["title"])
    keys = {l["payee_key"] for l in out if not l["brand"]} - set(learnt)
    if keys:
        from merchant_memory import key as _mkey, labels_for
        for k, lab in labels_for(db, keys, caller.name).items():
            if lab.venue:
                learnt.setdefault(k, tidy(lab.venue))
        keys -= set(learnt)
        if keys and groups:
            for m, t, v in (db.query(Expense.merchant, Expense.title, Expense.venue)
                            .filter(Expense.group_id.in_(list(groups)), Expense.merchant.isnot(None))
                            .order_by(Expense.date.desc())):
                k = _merchant_key(merchant_name(m))
                if k in keys and k not in learnt:
                    name = v or (t if t and _mkey(t) != _mkey(m) else None)
                    if name:
                        learnt[k] = tidy(name)
    for l in out:
        n = tidy(l["entered"]["venue"] or l["entered"]["title"]) if l.get("entered") else learnt.get(l["payee_key"])
        if not n or _merchant_key(n) == l["payee_key"]:
            continue
        if l["brand"]:
            l["note"] = n                     # "We fit - Swiggy order", on this line only
        else:
            l["merchant"] = n

    # 3. counted or not, and why
    for l in out:
        if l["key"] in marks:
            l["status"], l["why"], l["fixed"] = marks[l["key"]], "fixed by you", "line"
        elif l["passed_to"]:
            l["status"], l["why"] = "passed", f"passed on to {l['passed_to']}"
        elif l.get("entered"):
            e = l["entered"]
            l["status"], l["why"] = "group", f"entered as {e['title'] or 'an expense'} in {groups[e['group_id']]['name']}"
            l["group_id"] = e["group_id"]
        elif l["payee_key"] in rules:
            l["status"], l["why"], l["fixed"] = rules[l["payee_key"]], f"your rule for {l['payee']}", "rule"
        else:
            l["status"], l["why"] = "mine", None
        l.pop("entered", None)
    return out

# ── merchants: a statement's payee, an expense's place, as one name ────────────
_BRANDS = ["swiggy", "zomato", "blinkit", "zepto", "instamart", "bigbasket", "amazon", "flipkart", "myntra", "ajio",
           "nykaa", "uber", "ola", "rapido", "airbnb", "makemytrip", "goibibo", "irctc", "indigo", "netflix",
           "spotify", "hotstar", "youtube", "google", "apple", "anthropic", "openai", "jio", "airtel", "vodafone",
           "starbucks", "mcdonald", "dominos", "kfc", "subway", "haldiram", "barista", "decathlon", "ikea",
           "dmart", "reliance", "croma", "samsung", "bookmyshow", "district", "zepto", "licious", "eatsure",
           "paytm", "phonepe", "cred", "tata", "bluestone", "tanishq", "pvr", "inox", "blinkit"]
_BRAND_NAMES = {"mcdonald": "McDonald's", "makemytrip": "MakeMyTrip", "bookmyshow": "BookMyShow", "ikea": "IKEA",
                "kfc": "KFC", "irctc": "IRCTC", "pvr": "PVR", "inox": "INOX", "dmart": "DMart", "openai": "OpenAI"}
_NOISE = set("""in ind india ka dl hr up mh tn wb ts us gb com www co pvt ltd private limited llp inc payments payment
pay si misc store stores retail services service bangalore bengaluru gurgaon gurugram mumbai delhi new noida pune
hyderabad chennai kolkata ghaziabad faridabad food food1 online order the and of""".split())
_PREFIX = re.compile(r"^(?:raz\*|razorpay\*?|payu\*?|pyu\*|paytm\*?|cybs\*?|ecom\s|pos\s|upi[-/ ]|#|\*)+", re.I)


# Other names a brand goes by on statements and in expenses
_ALIASES = {"blink commerce": "Blinkit", "abnb": "Airbnb", "bundl technologies": "Swiggy",
            "zomato media": "Zomato", "uber india": "Uber", "ani technologies": "Ola"}


def _brand(text: str | None) -> str | None:
    low = (text or "").lower()
    for a, name in _ALIASES.items():
        if re.search(rf"(?<![a-z]){a}", low):
            return name
    for b in _BRANDS:
        if re.search(rf"(?<![a-z]){b}", low):
            return _BRAND_NAMES.get(b, b.title())
    return None


def merchant_name(text: str | None) -> str:
    """ "RAZ*Swiggy Bangalore KA IN" -> "Swiggy"; "UPI-LILI RAI" -> "Lili Rai";
    "AIRBNB PAYMENTS IND,GURGAON HOTELS" -> "Airbnb"."""
    t = _PREFIX.sub("", (text or "").strip())
    t = re.sub(r"^m\s*/?\s*s\.?\s+", "", re.split(r"[,|]", t)[0], flags=re.I)     # "M/S", "MS"
    if b := _brand(t):
        return b
    words = [w for w in re.findall(r"[A-Za-z][A-Za-z'&.]*", t) if w.lower().strip(".") not in _NOISE and len(w) > 1]
    return " ".join(w.capitalize() if w.isupper() or w.islower() else w for w in words[:3])[:40] or (text or "Other")[:40]


def _merchant_key(name: str) -> str:
    return "".join(ch for ch in name.lower() if ch.isalnum())


KINDS = ["Mutual funds / SIP", "Stocks", "FD / RD", "PPF / EPF", "NPS", "Gold", "Insurance", "Crypto", "Other"]

# What a statement's investment payee is, by name.
_KIND_WORDS = [
    ("NPS", r"\bnps\b|pension"),
    ("PPF / EPF", r"\bppf\b|\bepf\b|provident"),
    ("Insurance", r"\blic\b|insurance|policy|premium"),
    ("Gold", r"gold|mmtc|augmont"),
    ("Crypto", r"crypto|coindcx|wazirx|coinswitch|bitcoin"),
    ("FD / RD", r"fixed deposit|\bfd\b|recurring deposit|\brd\b"),
    ("Mutual funds / SIP", r"\bsip\b|mutual|\bmf\b|\bamc\b|fund|clearing corp|iccl|bse star|cams|kfin"),
    ("Stocks", r"zerodha|upstox|angel|dhan|kite|stock|securities|broking|groww|indmoney|smallcase"),
]

# The 50/30/20 split: what has to be paid, and what is chosen.
NEEDS = {"Groceries", "Transport", "Housing", "Bills & Utilities", "Health", "Education", "Loan repayments"}


def _kind_of(name: str) -> str:
    low = (name or "").lower()
    return next((k for k, rx in _KIND_WORDS if re.search(rx, low)), "Other")


def _ym_range(end: str, n: int) -> list[str]:
    y, m = map(int, end.split("-"))
    out = []
    for i in range(n - 1, -1, -1):
        t = y * 12 + (m - 1) - i
        out.append(f"{t // 12}-{t % 12 + 1:02d}")
    return out


def _manual_out(r: ManualInvestment) -> dict:
    return {"id": r.id, "month": r.month, "end_month": r.end_month, "recurring": bool(r.recurring),
            "amount": r.amount, "kind": r.kind, "note": r.note}


def _manual_in_month(r: ManualInvestment, ym: str) -> bool:
    if r.recurring:
        return r.month <= ym and (not r.end_month or ym <= r.end_month)
    return r.month == ym


@router.get("/dashboard", response_model=dict)
def dashboard(months: int = 12, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    if not caller.monthly_salary:
        raise HTTPException(400, {"code": "no_salary", "message": "Enter your monthly salary on the Account page first."})
    from routers.stats import _history_category, get_history
    from spend_categories import categorize

    today = date.today()
    cur = f"{today.year}-{today.month:02d}"
    yms = _ym_range(cur, max(3, min(months, 36)))
    want = set(yms)
    me = caller.name.lower()

    blank = lambda: {"monthly": 0.0, "groups": 0.0, "cards": 0.0, "recurring": 0.0, "repayments": 0.0}
    spend = {ym: blank() for ym in yms}
    cats = {ym: defaultdict(float) for ym in yms}
    top_groups = {ym: defaultdict(float) for ym in yms}

    # ── expenses: the History page's own rows (group, month, category, total, share) ──
    hist = get_history(db=db, caller=caller)
    gmeta = {g["id"]: g for g in hist["groups"]}
    for gid, ym, cat, total, share, *_ in hist["rows"]:
        if ym not in want or not share:
            continue
        g = gmeta.get(gid, {})
        solo = len(g.get("members", [])) <= 1
        spend[ym]["monthly" if solo else "groups"] += share
        cats[ym][cat] += share
        if not solo:
            top_groups[ym][gid] += share

    # each shared group's month: how many expenses, from when to when
    gstat = defaultdict(lambda: {"count": 0, "first": None, "last": None})
    shared = [gid for gid, g in gmeta.items() if len(g.get("members", [])) > 1]
    if shared:
        for gid, d in (db.query(Expense.group_id, Expense.date)
                       .filter(Expense.group_id.in_(shared), Expense.date >= yms[0])):
            if d and d[:7] in want:
                st = gstat[(gid, d[:7])]
                st["count"] += 1
                st["first"] = min(st["first"] or d[:10], d[:10])
                st["last"] = max(st["last"] or d[:10], d[:10])

    # ── credit cards: each bill's lines in that bill's month, counted unless
    #    already entered in a group, passed on, or fixed by the caller ──
    card = {ym: defaultdict(float) for ym in yms}          # status -> amount
    card_n = {ym: defaultdict(int) for ym in yms}
    for l in _card_lines(db, caller, want, gmeta):
        card[l["ym"]][l["status"]] += l["amount"]
        card_n[l["ym"]][l["status"]] += 1
        if l["status"] == "mine":
            cats[l["ym"]][_history_category(l["category"]) if l["category"] else "Card bill (no breakup)"] += l["amount"]
    for ym in yms:
        spend[ym]["cards"] = card[ym]["mine"]

    # ── recurring bills: the caller's share, as payer or as a member ──
    for ch in db.query(RecurringCharge).filter(RecurringCharge.member.ilike(caller.name)):
        if ch.period in want:
            spend[ch.period]["recurring"] += ch.share
            cats[ch.period][_history_category(categorize(ch.bill.title, ch.share)[0])] += ch.share
    for bill in db.query(RecurringBill).filter(RecurringBill.payer.ilike(caller.name)):
        members = [m for m in bill.members.split(",") if m]
        own = round(bill.amount / max(len(members), 1), 2)
        for period in {c.period for c in bill.charges}:
            if period in want:
                spend[period]["recurring"] += own
                cats[period][_history_category(categorize(bill.title, own)[0])] += own

    # ── loan repayments the caller made ──
    for ln in db.query(Loan).filter(Loan.borrower.ilike(caller.name)):
        for p in ln.payments:
            if p.date[:7] in want:
                spend[p.date[:7]]["repayments"] += p.amount
                cats[p.date[:7]]["Loan repayments"] += p.amount

    # ── investments ──
    auto = []
    for s in (db.query(StatementSkip)
              .filter(StatementSkip.user_name.ilike(caller.name), StatementSkip.kind == "investment")
              .order_by(StatementSkip.date.desc())):
        if s.date[:7] in want:
            auto.append({"id": s.id, "date": s.date, "merchant": s.merchant, "amount": s.amount,
                         "kind": _kind_of(s.merchant), "source": s.source})
    manual = db.query(ManualInvestment).filter(ManualInvestment.user_id == caller.id) \
        .order_by(ManualInvestment.month.desc(), ManualInvestment.id.desc()).all()

    out = {}
    for ym in yms:
        sp = {k: round(v, 2) for k, v in spend[ym].items()}
        a = [x for x in auto if x["date"][:7] == ym]
        m = [r for r in manual if _manual_in_month(r, ym)]
        by_kind = defaultdict(float)
        for x in a:
            by_kind[x["kind"]] += x["amount"]
        for r in m:
            by_kind[r.kind] += r.amount
        c = {k: round(v, 2) for k, v in sorted(cats[ym].items(), key=lambda kv: -kv[1]) if v >= 1}
        out[ym] = {
            "spend": sp,
            "spent": round(sum(sp.values()), 2),
            "invest": {"auto": round(sum(x["amount"] for x in a), 2),
                       "manual": round(sum(r.amount for r in m), 2),
                       "by_kind": {k: round(v, 2) for k, v in sorted(by_kind.items(), key=lambda kv: -kv[1])}},
            "cats": c,
            "needs": round(sum(v for k, v in c.items() if k in NEEDS), 2),
            "cards": {"gross": round(sum(card[ym].values()), 2),
                      **{k: round(card[ym][k], 2) for k in ("mine", "group", "not_mine", "passed")},
                      "count": sum(card_n[ym].values()), "counted": card_n[ym]["mine"]},
            # in date order - each with how many expenses and who else was in it
            "groups": sorted(
                [{"id": gid, "name": gmeta[gid]["name"], "emoji": gmeta[gid]["emoji"], "value": round(v, 2),
                  "count": gstat[(gid, ym)]["count"], "first": gstat[(gid, ym)]["first"], "last": gstat[(gid, ym)]["last"],
                  "with": [m for m in gmeta[gid].get("members", []) if m.lower() != me]}
                 for gid, v in top_groups[ym].items() if gid in gmeta],
                key=lambda g: (g["first"] or "9999", g["name"])),
        }
        out[ym]["invested"] = round(out[ym]["invest"]["auto"] + out[ym]["invest"]["manual"], 2)

    return {
        "salary": caller.monthly_salary, "salary_day": caller.salary_day, "today": today.isoformat(),
        "months": yms, "by_month": out, "kinds": KINDS,
        "needs_categories": sorted(NEEDS),     # everything else in "cats" is a want
        "investments": {"auto": auto, "manual": [_manual_out(r) for r in manual]},
    }


class ManualInvestmentIn(BaseModel):
    month: str
    amount: float
    kind: str
    recurring: bool = False
    end_month: str | None = None
    note: str | None = None


def _check(p: ManualInvestmentIn) -> None:
    ym = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
    if not ym.match(p.month) or (p.end_month and not ym.match(p.end_month)):
        raise HTTPException(400, "Pick a month")
    if p.end_month and p.end_month < p.month:
        raise HTTPException(400, "The last month can't be before the first")
    if not (0 < p.amount < 1e9):
        raise HTTPException(400, "Enter an amount")
    if p.kind not in KINDS:
        raise HTTPException(400, "Pick what kind of investment it is")


@router.post("/investments", response_model=dict, status_code=201)
def add_investment(payload: ManualInvestmentIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    _check(payload)
    r = ManualInvestment(user_id=caller.id, month=payload.month, amount=round(payload.amount, 2),
                         kind=payload.kind, recurring=payload.recurring,
                         end_month=payload.end_month if payload.recurring else None,
                         note=(payload.note or "").strip()[:200] or None)
    db.add(r)
    db.commit()
    return _manual_out(r)


@router.put("/investments/{inv_id}", response_model=dict)
def edit_investment(inv_id: int, payload: ManualInvestmentIn, db: Session = Depends(get_db),
                    caller: User = Depends(current_user)):
    _check(payload)
    r = db.query(ManualInvestment).filter(ManualInvestment.id == inv_id, ManualInvestment.user_id == caller.id).first()
    if not r:
        raise HTTPException(404, "No such investment")
    r.month, r.amount, r.kind, r.recurring = payload.month, round(payload.amount, 2), payload.kind, payload.recurring
    r.end_month = payload.end_month if payload.recurring else None
    r.note = (payload.note or "").strip()[:200] or None
    db.commit()
    return _manual_out(r)


@router.delete("/investments/{inv_id}", status_code=204)
def delete_investment(inv_id: int, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    db.query(ManualInvestment).filter(ManualInvestment.id == inv_id, ManualInvestment.user_id == caller.id).delete()
    db.commit()


# ── what a "where the money went" line is made of ──────────────────────────

SOURCES = ("monthly", "groups", "cards", "recurring", "repayments")


@router.get("/items", response_model=dict)
def items(month: str, source: str, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """The expenses behind one line of the dashboard for one month - the same
    rules as /dashboard, so they add up to its figure: {items: [{date, title,
    detail, amount}], less: [...things taken off (cards)], total}."""
    if source not in SOURCES or not re.match(r"^\d{4}-(0[1-9]|1[0-2])$", month):
        raise HTTPException(400, "Pick a month and a line")
    from routers.stats import _member_share, get_history
    me = caller.name.lower()
    out, less = [], []

    if source in ("monthly", "groups", "cards"):
        hist = get_history(db=db, caller=caller)
        groups = {g["id"]: g for g in hist["groups"]}
        gids = list(groups)

    if source in ("monthly", "groups") and gids:
        solo = source == "monthly"
        ids = [gid for gid, g in groups.items() if (len(g["members"]) <= 1) == solo]
        for e in (db.query(Expense).filter(Expense.group_id.in_(ids or [-1]), Expense.date.like(f"{month}%"))
                  .order_by(Expense.date.desc())):
            share = float(e.amount or 0) if solo else (_member_share(e, me) or 0.0)
            if share < 0.005:
                continue
            g = groups[e.group_id]
            title = e.title or e.merchant or e.category or "Expense"
            detail = [x for x in (e.category, None if solo else f"{g['emoji'] or ''} {g['name']}".strip()) if x]
            if not solo and abs(share - (e.amount or 0)) >= 0.5:
                detail.append(f"your share of Rs {e.amount:,.0f}")
            row = {"date": (e.date or "")[:10], "title": title, "detail": " · ".join(detail), "amount": round(share, 2)}
            if solo:
                row.update(id=e.id, payee=e.merchant or e.title or "")    # can be moved to P2P / investments
            out.append(row)

    elif source == "cards":
        from card_bills import card_name
        skipped = {k for (k,) in db.query(SalaryCardSkip.line_key).filter(SalaryCardSkip.user_id == caller.id)}
        from models import CreditCard
        cards = {c.id: c for c in db.query(CreditCard).filter(CreditCard.user_id == caller.id)}
        for s in db.query(CreditCardStatement).filter(CreditCardStatement.user_id == caller.id):
            card = card_name(cards[s.card_id]) if s.card_id in cards else s.bank
            try:
                details = json.loads(s.details_json) if s.details_json else None
            except ValueError:
                details = None
            lines = (details or {}).get("transactions") or []
            if lines:
                for t in lines:
                    if t.get("excluded") or t.get("type") != "debit" or not (t.get("date") or "").startswith(month):
                        continue
                    key = line_key(s.id, t)
                    row = {"date": t["date"][:10], "title": t.get("description") or "Card spend",
                           "detail": " · ".join(x for x in (card, t.get("category")) if x),
                           "amount": round(float(t.get("amount") or 0), 2), "key": key}
                    out.append(row)
                    if key in skipped:
                        less.append({**row, "detail": "you marked it already counted", "marked": True})
            elif (s.period or (s.statement_date or "")[:7]) == month and s.total_due:
                key = line_key(s.id)
                row = {"date": s.statement_date or "", "title": f"{card} bill", "detail": "not broken down yet - counted in full",
                       "amount": round(s.total_due, 2), "key": key}
                out.append(row)
                if key in skipped:
                    less.append({**row, "detail": "you marked it already counted", "marked": True})
        if gids:
            for e in (db.query(Expense).filter(Expense.group_id.in_(gids), Expense.payment_mode == "credit_card",
                                               Expense.paid_by.ilike(caller.name), Expense.date.like(f"{month}%"))):
                less.append({"date": (e.date or "")[:10], "title": e.title or e.merchant or "Card expense",
                             "detail": f"already counted in {groups[e.group_id]['name']}", "amount": round(e.amount or 0, 2)})
        for ln in db.query(Loan).filter(Loan.card_ref.isnot(None), Loan.lender.ilike(caller.name),
                                        Loan.start_date.like(f"{month}%")):
            less.append({"date": ln.start_date, "title": ln.note or "Card spend passed on",
                         "detail": f"passed on to {ln.borrower} as a loan", "amount": round(ln.principal, 2)})

    elif source == "recurring":
        for ch in db.query(RecurringCharge).filter(RecurringCharge.member.ilike(caller.name), RecurringCharge.period == month):
            out.append({"date": month, "title": ch.bill.title, "detail": f"your share · {ch.bill.payer} pays it",
                        "amount": round(ch.share, 2)})
        for bill in db.query(RecurringBill).filter(RecurringBill.payer.ilike(caller.name)):
            if any(c.period == month for c in bill.charges):
                members = [m for m in bill.members.split(",") if m]
                out.append({"date": month, "title": bill.title,
                            "detail": f"your share of Rs {bill.amount:,.0f} · you pay it",
                            "amount": round(bill.amount / max(len(members), 1), 2)})

    elif source == "repayments":
        for ln in db.query(Loan).filter(Loan.borrower.ilike(caller.name)):
            for p in ln.payments:
                if p.date.startswith(month):
                    out.append({"date": p.date, "title": f"Repaid {ln.lender}", "detail": ln.note or "loan repayment",
                                "amount": round(p.amount, 2)})

    gross = round(sum(x["amount"] for x in out), 2)
    taken = round(sum(x["amount"] for x in less), 2)
    total = max(0.0, round(gross - taken, 2)) if source == "cards" else gross
    out.sort(key=lambda x: (-x["amount"], x["date"]))
    less.sort(key=lambda x: -x["amount"])
    return {"month": month, "source": source, "items": out, "less": less, "gross": gross, "total": total}


class CardSkipIn(BaseModel):
    key: str
    counted: bool = True           # True: already counted elsewhere - leave it out; False: count it again


@router.post("/card-skips", response_model=dict)
def card_skip(payload: CardSkipIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """Mark a card spend as already counted (in a group, say) - or count it again."""
    key = (payload.key or "").strip()[:300]
    sid = key.split(":", 1)[0]
    if not sid.isdigit() or not db.query(CreditCardStatement.id).filter(
            CreditCardStatement.id == int(sid), CreditCardStatement.user_id == caller.id).first():
        raise HTTPException(404, "No such card spend")
    row = db.query(SalaryCardSkip).filter(SalaryCardSkip.user_id == caller.id, SalaryCardSkip.line_key == key).first()
    if payload.counted and not row:
        db.add(SalaryCardSkip(user_id=caller.id, line_key=key))
    elif not payload.counted and row:
        db.delete(row)
    db.commit()
    return {"key": key, "counted": payload.counted}


# ── moving a monthly expense out: it was money to a person, or an investment ──
# What the statement rules missed: the expense leaves the monthly group and
# joins that month's "to people" / investments (StatementSkip) - the same
# place an import puts what it recognises. With `remember`, the payee is
# labelled so later imports skip it on their own (PayeeLabel, source "user").

class MoveIn(BaseModel):
    expense_id: int
    kind: str                 # "people" (P2P) | "investment"
    remember: bool = False


def _own_solo_expense(db: Session, caller: User, expense_id: int) -> Expense:
    from models import Group
    e = db.get(Expense, expense_id)
    g = db.get(Group, e.group_id) if e else None
    if not e or not g or len(g.members) != 1 or g.members[0].name.lower() != caller.name.lower():
        raise HTTPException(404, "Only your own monthly expenses can be moved")
    return e


@router.post("/move", response_model=dict)
def move_expense(payload: MoveIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    from models import PayeeLabel
    from routers.expenses import _norm
    if payload.kind not in ("people", "investment"):
        raise HTTPException(400, "P2P or investment")
    e = _own_solo_expense(db, caller, payload.expense_id)
    payee = (e.merchant or e.title or "Payment")[:200]
    undo = {"group_id": e.group_id, "date": e.date, "title": e.title, "merchant": e.merchant, "amount": e.amount,
            "category": e.category, "subcategory": e.subcategory, "txn_time": e.txn_time, "txn_ref": e.txn_ref,
            "payment_mode": e.payment_mode, "notes": e.notes}
    skip = StatementSkip(user_name=caller.name, kind=payload.kind, date=(e.date or "")[:10], time=e.txn_time,
                         merchant=payee, amount=e.amount, txn_id=e.txn_ref,
                         reason="moved here by you from monthly expenses", source="manual")
    db.add(skip)
    db.delete(e)
    label = None
    key = _norm(payee)
    if payload.remember and key:
        decision = "p2p" if payload.kind == "people" else "investment"
        label = db.query(PayeeLabel).filter(PayeeLabel.user_name.ilike(caller.name), PayeeLabel.payee_key == key).first()
        if label:
            undo["label_was"] = {"decision": label.decision, "category": label.category,
                                 "subcategory": label.subcategory, "source": label.source}
            label.decision, label.category, label.subcategory, label.source = decision, None, None, "user"
        else:
            label = PayeeLabel(user_name=caller.name, payee_key=key, payee=payee, decision=decision, source="user",
                               note="moved from monthly expenses")
            db.add(label)
            undo["label_new"] = True
    db.commit()
    return {"skip_id": skip.id, "kind": payload.kind, "remembered": bool(label), "undo": undo}


class MoveBackIn(BaseModel):
    skip_id: int
    undo: dict


@router.post("/move-back", response_model=dict)
def move_back(payload: MoveBackIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """Undo a move: the expense is back in its monthly group, the payee label as it was."""
    from models import Group, PayeeLabel
    from routers.expenses import _norm
    skip = db.get(StatementSkip, payload.skip_id)
    if not skip or skip.user_name.lower() != caller.name.lower():
        raise HTTPException(404, "Nothing to undo")
    u = payload.undo or {}
    g = db.get(Group, int(u.get("group_id") or 0))
    if not g or len(g.members) != 1 or g.members[0].name.lower() != caller.name.lower():
        raise HTTPException(404, "That monthly group is gone")
    e = Expense(group_id=g.id, date=u.get("date") or skip.date, title=u.get("title"), merchant=u.get("merchant"),
                amount=skip.amount, paid_by=caller.name, participants=None, divider=1, individual_amount=skip.amount,
                category=u.get("category"), subcategory=u.get("subcategory"), category_source="user",
                txn_time=u.get("txn_time"), txn_ref=u.get("txn_ref"), payment_mode=u.get("payment_mode"),
                notes=u.get("notes"))
    db.add(e)
    db.delete(skip)
    key = _norm(skip.merchant)
    label = db.query(PayeeLabel).filter(PayeeLabel.user_name.ilike(caller.name), PayeeLabel.payee_key == key).first()
    if label and u.get("label_new"):
        db.delete(label)
    elif label and u.get("label_was"):
        w = u["label_was"]
        label.decision, label.category, label.subcategory, label.source = (w.get("decision"), w.get("category"),
                                                                          w.get("subcategory"), w.get("source"))
    db.commit()
    return {"ok": True, "expense_id": e.id}



# ── checking card lines ───────────────────────────────────────────────────────

def _month(month: str) -> str:
    if not re.match(r"^\d{4}-(0[1-9]|1[0-2])$", month or ""):
        raise HTTPException(400, "Pick a month")
    return month


def _prev(ym: str) -> str:
    y, m = int(ym[:4]), int(ym[5:])
    return f"{y - 1}-12" if m == 1 else f"{y}-{m - 1:02d}"


@router.get("/cards", response_model=dict)
def card_lines(month: str, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """One salary month's card spends - the lines of the bills made that month
    - each counted or not, and why; the bills themselves; the caller's rules."""
    month = _month(month)
    from routers.stats import get_history
    hist = get_history(db=db, caller=caller)
    lines = _card_lines(db, caller, {month}, {g["id"]: g for g in hist["groups"]})
    lines.sort(key=lambda l: (l["date"], -l["amount"]), reverse=True)
    bills = {}
    for l in lines:
        b = bills.setdefault(l["bill_id"], {"bill_id": l["bill_id"], "card": l["card"], "bill_date": l["bill_date"],
                                            "from": l["bill_from"], "to": l["bill_to"],
                                            "counted": 0.0, "not_counted": 0.0, "lines": 0})
        b["counted" if l["status"] == "mine" else "not_counted"] += l["amount"]
        b["lines"] += 1
    for b in bills.values():
        b["counted"], b["not_counted"] = round(b["counted"], 2), round(b["not_counted"], 2)
    tot = defaultdict(float)
    for l in lines:
        tot[l["status"]] += l["amount"]
    rules = [{"merchant_key": k[5:], "status": st} for k, st in db.query(SalaryCardSkip.line_key, SalaryCardSkip.status)
             .filter(SalaryCardSkip.user_id == caller.id, SalaryCardSkip.line_key.like("rule:%"))]
    names = {l["payee_key"]: l["merchant"] for l in lines}
    for r in rules:
        r["merchant"] = names.get(r["merchant_key"], r["merchant_key"])
    return {"month": month, "lines": lines, "bills": sorted(bills.values(), key=lambda b: b["bill_date"] or ""),
            "totals": {k: round(v, 2) for k, v in tot.items()}, "rules": rules}


class CardCheckIn(BaseModel):
    keys: list[str]
    status: str                   # mine | group | not_mine | auto (back to what the app works out)
    remember: bool = False        # and every line from the same merchant, from now on


@router.post("/card-check", response_model=dict)
def card_check(payload: CardCheckIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    if payload.status not in (*CHECKS, "auto"):
        raise HTTPException(400, "Mine, in a group, not mine - or back to automatic")
    keys = list(dict.fromkeys(k.strip()[:300] for k in payload.keys if k and k.strip()))[:500]
    if not keys:
        raise HTTPException(400, "Nothing to fix")
    own = {sid for (sid,) in db.query(CreditCardStatement.id).filter(CreditCardStatement.user_id == caller.id)}
    for k in keys:
        if k.startswith("rule:"):
            continue
        sid = k.split(":", 1)[0]
        if not sid.isdigit() or int(sid) not in own:
            raise HTTPException(404, "No such card spend")
    if payload.remember:
        # a rule for each line's merchant; the line itself then follows the rule
        rule_keys = []
        for k in keys:
            if k.startswith("rule:"):
                rule_keys.append(k)
            else:
                desc = k.split(":", 3)[3] if k.count(":") >= 3 else ""
                mk = _merchant_key(merchant_name(desc))
                if mk:
                    rule_keys.append(f"rule:{mk}")
        line_keys = [k for k in keys if not k.startswith("rule:")]
        for r in db.query(SalaryCardSkip).filter(SalaryCardSkip.user_id == caller.id,
                                                 SalaryCardSkip.line_key.in_(line_keys)):
            db.delete(r)
        keys = list(dict.fromkeys(rule_keys))
        if not keys:
            raise HTTPException(400, "Couldn't tell the merchant - fix just this one")
    rows = {r.line_key: r for r in db.query(SalaryCardSkip).filter(
        SalaryCardSkip.user_id == caller.id, SalaryCardSkip.line_key.in_(keys))}
    for k in keys:
        r = rows.get(k)
        if payload.status == "auto":
            if r:
                db.delete(r)
        elif r:
            r.status = payload.status
        else:
            db.add(SalaryCardSkip(user_id=caller.id, line_key=k, status=payload.status))
    db.commit()
    return {"keys": keys, "status": payload.status}


# ── the month by merchant ─────────────────────────────────────────────────────

@router.get("/merchants", response_model=dict)
def merchants(month: str, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """Where one month's money went, by merchant, against the month before:
    card lines that count (by their bill's month), the caller's own monthly expenses, and their
    share of group expenses - one name for a payee across all three
    (merchant_name), so Swiggy on a card and a Swiggy order in a group add up."""
    month = _month(month)
    prev = _prev(month)
    from routers.stats import _member_share, get_history
    me = caller.name.lower()
    rows = []                                  # (ym, name, amount, item)
    hist = get_history(db=db, caller=caller)
    groups = {g["id"]: g for g in hist["groups"]}
    for l in _card_lines(db, caller, {month, prev}, groups):
        if l["status"] == "mine":
            rows.append((l["ym"], l["merchant"], l["amount"],
                         {"date": l["date"], "title": l["title"], "amount": l["amount"], "source": l["card"]}))
    if groups:
        for e in db.query(Expense).filter(Expense.group_id.in_(list(groups)),
                                          (Expense.date.like(f"{month}%")) | (Expense.date.like(f"{prev}%"))):
            g = groups[e.group_id]
            solo = len(g["members"]) <= 1
            share = float(e.amount or 0) if solo else (_member_share(e, me) or 0.0)
            if share < 0.005:
                continue
            name = (_brand(e.venue) or _brand(e.merchant) or _brand(e.title) or e.venue
                    or (merchant_name(e.merchant) if e.merchant else None)
                    or " ".join((e.title or e.category or "Expense").split())[:40])
            rows.append((e.date[:7], name, share,
                         {"date": (e.date or "")[:10], "title": e.title or e.merchant or e.category or "Expense",
                          "amount": round(share, 2), "source": "Monthly" if solo else g["name"],
                          "group_id": e.group_id}))
    agg: dict[str, dict] = {}
    for ym, name, amt, item in rows:
        k = _merchant_key(name) or name
        m = agg.setdefault(k, {"name": name, "amount": 0.0, "count": 0, "prev_amount": 0.0, "prev_count": 0, "items": []})
        if ym == month:
            m["amount"] += amt
            m["count"] += 1
            m["items"].append(item)
        else:
            m["prev_amount"] += amt
            m["prev_count"] += 1
    now = [m for m in agg.values() if m["count"]]
    for m in now:
        m["amount"], m["prev_amount"] = round(m["amount"], 2), round(m["prev_amount"], 2)
        m["items"].sort(key=lambda x: x["date"], reverse=True)
    now.sort(key=lambda m: -m["amount"])
    gone = [m for m in agg.values() if not m["count"] and m["prev_count"]]
    return {"month": month, "prev": prev,
            "total": round(sum(m["amount"] for m in now), 2),
            "prev_total": round(sum(m["prev_amount"] for m in agg.values()), 2),
            "merchants": now,
            "gone": {"count": len(gone), "amount": round(sum(m["prev_amount"] for m in gone), 2),
                     "top": [{"name": m["name"], "amount": round(m["prev_amount"], 2)}
                             for m in sorted(gone, key=lambda m: -m["prev_amount"])[:5]]}}

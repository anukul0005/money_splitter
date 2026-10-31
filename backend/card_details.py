"""A credit card bill's detailed breakup, read from its statement PDF
(GET/POST /credit-cards/bills/{id}/details).

  1. the bill's own email (saved when the bill was found) -> its PDF,
     unlocked with the card's password (then the older saved ones); a
     bank's trailing terms-and-offers pages are dropped (SKIP_LAST_PAGES)
  2. the statement summary (previous balance, payments, purchases, fees,
     interest, total due...) from the first pages, via the LLM
  3. every transaction, in page-sized chunks, via the LLM - a chunk whose
     answer was cut off, failed, or lists clearly fewer rows than the chunk
     has date-and-amount lines is split in half and read again
  4. each spend categorised with the app's own taxonomy (the same AI
     categoriser expenses use, keyword rules as the fallback)
  5. totals by category, the biggest merchants, and a check that the
     transactions add up to the bill

Runs in a background thread (a long statement is several AI calls) and is
saved on the bill (details_json), so it's read once and opens instantly
after. The statement text goes to the same LLM providers the bill amount
already does; nothing is stored beyond the parsed result.
"""
from __future__ import annotations

import json
import re
import threading
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from itertools import combinations

_status: dict[int, dict] = {}       # bill id -> {"status": "reading"|"error", "step", "progress", "error"}
_lock = threading.Lock()


def _num(v):
    return round(float(v), 2) if isinstance(v, (int, float)) else None


_TIME = re.compile(r"^\s*(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([AaPp][Mm])?\s*$")


def _time(v) -> str | None:
    """The model's time as "HH:MM", or None for anything that isn't a real
    time of day ("14:32", "2:32 PM", "14:32:05" all fine; "25:00" isn't)."""
    m = _TIME.match(v) if isinstance(v, str) else None
    if not m:
        return None
    h, mins, ampm = int(m.group(1)), int(m.group(2)), (m.group(3) or "").lower()
    if ampm:
        if not 1 <= h <= 12:
            return None
        h = h % 12 + (12 if ampm == "pm" else 0)
    return f"{h:02d}:{mins:02d}" if h < 24 and mins < 60 else None


# Words that say where or what kind of company, not which merchant - left
# out so "Decathlon Sports Gurgaon" and "Decathlon Noida" group together.
_NOISE = {
    "pvt", "ltd", "limited", "private", "india", "in", "ind", "co", "company", "corp", "llp", "inc", "the",
    "systems", "services", "solutions", "technologies", "retail", "store", "stores", "payments", "online",
    "gurgaon", "gurugram", "delhi", "new", "noida", "bangalore", "bengaluru", "mumbai", "pune", "hyderabad",
    "chennai", "kolkata", "ghaziabad", "faridabad", "indirapuram", "jaipur", "lucknow", "chandigarh", "ahmedabad",
}


def merchant(desc: str) -> str:
    """A short merchant name for grouping: no reference numbers, places,
    company suffixes or payment-gateway prefixes."""
    d = re.sub(r"^(upi|pos|ecom|nfc|www\.|razorpay\*?|payu\*?|paytm\*?|bbps)[\s/*-]*", "", desc.strip(), flags=re.I)
    d = re.sub(r"[\d#*/_.-]{3,}.*$", "", d)
    words = [w for w in re.split(r"[\s,]+", d) if w and not w.isdigit() and w.lower() not in _NOISE][:2]
    return " ".join(words).title() or desc[:30].title()


_PLACE_TAIL = _NOISE - {"retail", "store", "stores", "systems", "services", "solutions", "technologies",
                         "payments", "online", "the", "company", "co"}
_SUFFIX = {"pvt", "ltd", "limited", "private", "llp", "inc", "corp"}


def merchant_name(desc: str) -> str:
    """The merchant's name as shown - whole ("Sri Ram And Son"), less the
    gateway prefix, reference numbers, company suffixes and the city and
    country on the end. merchant() stays the short key lines are grouped by."""
    d = re.sub(r"^[^\w]+", "", desc.strip())                       # "#AMAZON IN"
    d = re.sub(r"^(upi|pos|ecom|nfc|www\.|razorpay\*?|payu\*?|paytm\*?|bbps)[\s/*-]*", "", d, flags=re.I)
    d = d.split(",")[0]                    # "AIRBNB PAYMENTS IND,GURGAON HOTELS": the merchant comes before the comma
    d = re.sub(r"[\d#*/_.-]{3,}.*$", "", d)
    words = [w for w in re.split(r"\s+", d) if w and not w.isdigit() and w.lower() not in _SUFFIX]
    while len(words) > 1 and words[-1].lower() in _PLACE_TAIL:
        words.pop()
    return " ".join(words).title()[:40] or desc[:30].title()


def _spend(t: dict) -> bool:
    return t["type"] == "debit" and t.get("kind") not in ("fee", "interest", "tax")


def known_categories(db, txns: list[dict], user_name: str) -> dict[str, tuple]:
    """{description: (category, subcategory, who)} for the spends whose merchant
    someone has filed by hand - the shared merchant memory (merchant_memory,
    MerchantLabel), by the merchant's full name. These are what the merchant
    is: no AI is asked about them."""
    import merchant_memory as mm
    keys = {t["description"]: mm.key(merchant_name(t["description"])) for t in txns if _spend(t)}
    labels = mm.labels_for(db, set(keys.values()), user_name)
    out = {}
    for desc, k in keys.items():
        lab = labels.get(k)
        if lab:
            who = "you" if (lab.taught_by or "").lower() == (user_name or "").lower() else "shared"
            out[desc] = (lab.category, lab.subcategory, who)
    return out


def apply_known(txns: list[dict], known: dict) -> None:
    for t in txns:
        got = known.get(t["description"]) if _spend(t) else None
        if got:
            t["category"], t["subcategory"], t["category_by"] = got[0], got[1], got[2]


_CARD_NOTE = ("Merchant name from a credit card statement, often abbreviated and followed by city and country: "
              "'SERV'/'SERVICE STN'/'FILLING' is a fuel station, 'SI' is a standing-instruction subscription, "
              "'US'/'HK'/'CZ'/'SG' at the end means a merchant abroad. Software, AI and cloud subscriptions "
              "(e.g. Claude, ChatGPT, Google Cloud, Apify) are Entertainment > Subscriptions.")


def user_history(db, user_name: str) -> dict[str, tuple[str, str | None]]:
    """How the user has filed each merchant before, by merchant() key - the
    most common category among their own categorised expenses."""
    from collections import Counter
    from sqlalchemy import func
    from models import Expense, Member
    groups = [g for (g,) in db.query(Member.group_id).filter(func.lower(Member.name) == user_name.strip().lower())]
    seen: dict[str, Counter] = defaultdict(Counter)
    for title, cat, sub in (db.query(Expense.title, Expense.category, Expense.subcategory)
                            .filter(Expense.group_id.in_(groups), Expense.category.isnot(None), Expense.title.isnot(None))):
        if cat and cat not in ("Other", "Small vendors", "One-off payments", "Uncategorized"):
            seen[merchant(title).lower()][(cat, sub)] += 1
    return {k: c.most_common(1)[0][0] for k, c in seen.items() if k}


def _categorise(txns: list[dict], history: dict | None = None, known: dict | None = None) -> None:
    """The AI categoriser decides; it's told what card-statement names look
    like and, where there is one, how the user filed the same merchant before."""
    import expense_classifier as ec
    from spend_categories import categorize
    history = history or {}
    known = known or {}
    # Merchants someone has filed by hand aren't asked about
    spends = [t for t in txns if t["type"] == "debit" and t["kind"] in ("purchase", "emi", "other")
              and t["description"] not in known]
    names = sorted({t["description"] for t in spends})
    answer: dict[str, tuple[str, str | None]] = {}

    def note(n):
        past = history.get(merchant(n).lower())
        return _CARD_NOTE + (f" The user has filed this merchant as {past[0]} > {past[1] or '-'} before." if past else "")
    for start in range(0, len(names), 20):
        batch = names[start:start + 20]
        items = [{"id": i, "description": n, "notes": note(n), "amount": next(t["amount"] for t in spends if t["description"] == n),
                  "group": "credit card statement"} for i, n in enumerate(batch)]
        # The statement was just read with the same AI: its per-minute limit
        # is the usual reason this fails - wait and try again before rules
        for attempt in range(3):
            try:
                for r in ec._chat(items).get("results", []):
                    if isinstance(r, dict) and isinstance(r.get("id"), int) and r["id"] < len(batch):
                        answer[batch[r["id"]]] = ec._clean(r.get("category"), r.get("subcategory"))
                break
            except Exception as e:
                print(f"[card_details] categoriser try {attempt + 1}: {e}")
                if attempt < 2:
                    time.sleep(15 * (attempt + 1))
    for t in txns:
        if t["type"] == "credit":
            t["category"], t["subcategory"] = "Payments & refunds", None
        elif t["kind"] in ("fee", "interest", "tax"):
            t["category"], t["subcategory"] = "Card fees & interest", t["kind"].title()
        elif t["description"] in known:
            k = known[t["description"]]
            t["category"], t["subcategory"], t["category_by"] = k[0], k[1], k[2]
        else:
            got = answer.get(t["description"])
            t["category_by"] = "ai" if got else "rules"
            got = got or categorize(t["description"], t["amount"])
            # A card swipe is a shop, never a person - only a UPI line can pay one
            if not answer.get(t["description"]) and got[0] in ("One-off payments", "Small vendors") \
                    and not re.match(r"\s*upi", t["description"], re.I):
                got = ("Other", "Unclassified merchant")
            t["category"], t["subcategory"] = got[0], got[1]


def read_statement(text: str, history: dict | None = None, progress=None, known_for=None) -> dict:
    """The statement's summary and transactions read by code (statement_parser),
    the spends categorised (AI), and the breakup put together (assemble)."""
    import statement_parser as sp
    step = progress or (lambda text, frac=None: None)
    step("Reading the bill's summary…", 0.4)
    summary = sp.parse_summary(text)
    anchor = summary.get("statement_date") or summary.get("period_to") or summary.get("due_date")
    year = int(anchor[:4]) if anchor else date.today().year
    step("Reading the transactions…", 0.55)
    txns = sp.parse_transactions(text, year)
    # A line printed without its year ("18 OCT") read with the statement's: a
    # December line on a January statement belongs to the year before
    if anchor:
        latest = date.fromisoformat(anchor) + timedelta(days=10)
        for t in txns:
            if t["date"] and t["date"] > latest.isoformat():
                d = date.fromisoformat(t["date"])
                try:
                    t["date"] = d.replace(year=d.year - 1).isoformat()
                except ValueError:
                    t["date"] = d.replace(year=d.year - 1, day=28).isoformat()
    step("Sorting spends into categories…", 0.75)
    _categorise(txns, history, known_for(txns) if known_for else None)
    txns.sort(key=lambda t: (t["date"] or "", -t["amount"]))
    out = assemble(summary, txns, datetime.now(timezone.utc).isoformat())
    # The text it was read from, kept with the bill: a layout the parser doesn't
    # read yet is fixed from it (never sent to the app - see credit_cards.bill_details)
    out["source_text"] = text[:200_000]
    out["reader"] = "code"
    return out


def _within(t: dict, lo: date, hi: date) -> bool:
    try:
        return lo <= date.fromisoformat(t["date"]) <= hi
    except (TypeError, ValueError):
        return True                      # no date: can't tell, so it stays


def _drop_to(lines: list[dict], target: float, budget: int = 2_000_000) -> list[dict] | None:
    """The fewest lines to leave out so the rest add up to `target` (to the
    rupee), or None. Lines with a vague description ("Purchase", "Cash
    withdrawal", fees - what an interest illustration is made of) are tried first."""
    excess = round(sum(t["amount"] for t in lines) - target, 2)
    if abs(excess) <= 1:
        return []
    if excess < 0:
        return None
    vague = lambda t: len((t.get("description") or "").split()) <= 3 or not re.search(r"[A-Z]{3,}", t.get("description") or "")
    cands = sorted([t for t in lines if t["amount"] <= excess + 1], key=lambda t: (not vague(t), t["amount"]))
    tried = 0
    for k in range(1, min(len(cands), 12) + 1):
        for combo in combinations(cands, k):
            tried += 1
            if tried > budget:
                return None
            if abs(sum(t["amount"] for t in combo) - excess) <= 1:
                return list(combo)
    return None


def reconcile(summary: dict, txns: list[dict], period: tuple | None = None) -> None:
    """Leave out what isn't this bill's - marked `excluded` (with why), never
    deleted, so a line's place in the list stays put. Statements carry sample
    rows (Axis prints an interest-calculation illustration: "Household goods
    purchase 25,000", "Cash withdrawal from ATM", dated years back), and those
    read as transactions. First anything dated outside the bill's period;
    then, if what's left still doesn't add up to the statement's own
    purchases & debits (and payments & credits), the fewest lines whose
    leaving out makes it add up."""
    for t in txns:
        t.pop("excluded", None)
    start, end = summary.get("period_from"), summary.get("period_to")
    if not (start and end) and period:
        start, end = period                  # the bill's own (statement date based) - see credit_cards._cycle
    try:
        lo = date.fromisoformat(start) - timedelta(days=5)
        hi = date.fromisoformat(end) + timedelta(days=5)
    except (TypeError, ValueError):
        lo = hi = None
    if lo:
        for t in txns:
            if not _within(t, lo, hi):
                t["excluded"] = "dated outside this bill"
    # Fees, interest and taxes may be stated apart from purchases - and one may
    # already include another (SBI's fees & charges carry their GST): every mix
    parts = [summary.get(k) or 0 for k in ("fees_charges", "interest", "taxes")]
    extras = sorted({round(sum(x for x, on in zip(parts, (m & 1, m & 2, m & 4)) if on), 2) for m in range(8)} - {0})
    for kind, key in (("debit", "purchases_debits"), ("credit", "payments_credits")):
        want = summary.get(key)
        if want is None:
            continue
        lines = [t for t in txns if t["type"] == kind and not t.get("excluded")]
        # purchases & debits may or may not count the fees - whichever the lines match
        targets = [want] + ([round(want + x, 2) for x in extras] if kind == "debit" else [])
        drops = [d for d in (_drop_to(lines, target) for target in targets) if d is not None]
        if drops:
            for t in min(drops, key=len):
                t["excluded"] = "not in this bill's totals"


def rerule(txns: list[dict]) -> None:
    """Lines the rules filed (the AI didn't answer when the bill was read) are
    filed again by today's rules - a rule added later reaches bills read before it."""
    from spend_categories import categorize
    for t in txns:
        if t.get("category_by") != "rules" or t["type"] != "debit" or t.get("kind") in ("fee", "interest", "tax"):
            continue
        got = categorize(t["description"], t["amount"])
        if got[0] in ("One-off payments", "Small vendors") and not re.match(r"\s*upi", t["description"], re.I):
            got = ("Other", "Unclassified merchant")
        t["category"], t["subcategory"] = got[0], got[1]


def assemble(summary: dict, txns: list[dict], read_at: str | None, period: tuple | None = None) -> dict:
    """The bill's breakup from its lines - only the ones that are the bill's
    (see reconcile). Run on every read, and again whenever a saved bill is
    shown, so a fix here reaches bills read before it."""
    reconcile(summary, txns, period)
    live = [t for t in txns if not t.get("excluded")]
    debits = round(sum(t["amount"] for t in live if t["type"] == "debit"), 2)
    credits = round(sum(t["amount"] for t in live if t["type"] == "credit"), 2)
    by_cat = defaultdict(lambda: [0.0, 0])
    by_merchant = defaultdict(lambda: [0.0, 0])
    names: dict[str, str] = {}
    for t in live:
        if t["type"] == "debit" and t["category"] != "Card fees & interest":
            by_cat[t["category"]][0] += t["amount"]
            by_cat[t["category"]][1] += 1
            key = merchant(t["description"])
            by_merchant[key][0] += t["amount"]
            by_merchant[key][1] += 1
            names.setdefault(key, merchant_name(t["description"]))
    fees = round(sum(t["amount"] for t in live if t["category"] == "Card fees & interest"), 2)
    spent = round(debits - fees, 2)

    # previous balance - payments/credits + debits = total due, when the
    # statement states the pieces: says whether the list is complete.
    check = None
    prev, total = summary.get("previous_balance"), summary.get("total_due")
    if prev is not None and total is not None:
        expected = round(prev - credits + debits, 2)
        check = {"expected": expected, "total_due": total, "ok": abs(expected - total) <= 2}
    elif summary.get("purchases_debits") is not None:
        expected = debits
        check = {"expected": expected, "total_due": summary["purchases_debits"],
                 "ok": abs(expected - summary["purchases_debits"]) <= 2 or abs(spent - summary["purchases_debits"]) <= 2}
    return {
        "summary": summary,
        "transactions": txns,
        "totals": {"spent": spent, "fees": fees, "debits": debits, "credits": credits, "count": len(live),
                   "left_out": len(txns) - len(live),
                   "categorised_by_ai": sum(1 for t in live if t.get("category_by") == "ai"),
                   "categorised": sum(1 for t in live if t.get("category_by"))},
        "by_category": [{"category": c, "amount": round(v[0], 2), "count": v[1],
                         "share": round(v[0] / spent * 100, 1) if spent else 0}
                        for c, v in sorted(by_cat.items(), key=lambda x: -x[1][0])],
        "top_merchants": [{"name": names.get(m, m), "amount": round(v[0], 2), "count": v[1]}
                          for m, v in sorted(by_merchant.items(), key=lambda x: -x[1][0])[:6]],
        "check": check,
        "read_at": read_at,
    }


# Pages at the end of a bank's statement that are never transactions -
# terms and conditions, offers, ads. Skipped before anything is read, so
# they can't turn into "transactions" and don't cost AI calls. ICICI ends
# every statement with 8 such pages.
SKIP_LAST_PAGES = {"ICICI Bank": 8}
MIN_PAGES = 3           # never read fewer than this, whatever the rule says


# A heading after which a bank's statement has nothing but offers, rewards
# and terms. SBI Card's "Savings and Benefits" section comes after the last
# transaction: that page's text before the heading is kept, it and every
# page after it are not read.
STOP_AT = {"SBI Card": re.compile(r"^[^\w\n]*savings\s*(?:and|&)\s*benefits", re.I | re.M)}


def pages_to_read(bank: str, total: int) -> int:
    """How many pages, from the start, hold the statement itself."""
    skip = SKIP_LAST_PAGES.get(bank, 0)
    return max(total - skip, min(MIN_PAGES, total))


def statement_text(bank: str, pages: list[str]) -> tuple[str, int]:
    """(the statement's own text, how many pages it came from): the pages
    pages_to_read keeps, cut at the bank's STOP_AT heading when it has one."""
    keep = pages_to_read(bank, len(pages))
    stop = STOP_AT.get(bank)
    if stop:
        for i, page in enumerate(pages):
            for m in stop.finditer(page):
                text = "\n".join(pages[:i] + [page[:m.start()]])
                # A mention before the statement has even started (a
                # contents line on page 1) isn't the end of it.
                if len(text.strip()) >= 300:
                    return text, i + 1
    return "\n".join(pages[:keep]), keep


def pdf_pages(pdf_bytes: bytes, passwords: list[str]) -> list[str] | None:
    """The PDF's text page by page - opened with no password, then each saved
    one in turn (the card's own first)."""
    import io
    import pdfplumber
    for pw in [None, *passwords]:
        try:
            with pdfplumber.open(io.BytesIO(pdf_bytes), password=pw) as pdf:
                return [(p.extract_text() or "") for p in pdf.pages]
        except Exception:
            continue
    return None


def status(bill_id: int) -> dict | None:
    with _lock:
        return dict(_status[bill_id]) if bill_id in _status else None


def start(user_id: int, bill_id: int) -> None:
    with _lock:
        if _status.get(bill_id, {}).get("status") == "reading":
            return
        _status[bill_id] = {"status": "reading", "step": "Opening the statement email…", "progress": 0.01}
    threading.Thread(target=_run, args=(user_id, bill_id), daemon=True).start()


def _step(bill_id: int, text: str, frac: float | None = None) -> None:
    with _lock:
        last = _status.get(bill_id, {}).get("progress", 0)
        _status[bill_id] = {"status": "reading", "step": text,
                            "progress": round(max(last, frac), 3) if frac is not None else last}


def read_bill(db, user_id: int, bill_id: int, step=lambda text, frac=None: None) -> dict:
    """Open the bill's statement email, unlock its PDF with the saved
    passwords, read it and save the breakup on the bill (details_json).
    Raises RuntimeError saying what stopped it. Used by the "Read" button
    (via start) and by the daily auto-sync (card_autosync.py)."""
    import secret_box
    from models import BankPassword, CreditCard, CreditCardStatement, GmailConnection, User
    from statement_sync import _gmail_service, best_statement_pdf
    bill = db.get(CreditCardStatement, bill_id)
    conn = db.query(GmailConnection).filter(GmailConnection.user_id == user_id).first()
    if not bill or not conn:
        raise RuntimeError("Gmail isn't connected" if bill else "Bill not found")
    step("Opening the statement email…", 0.03)
    service = _gmail_service(conn)
    msg = service.users().messages().get(userId="me", id=bill.gmail_message_id, format="full").execute()
    card = db.get(CreditCard, bill.card_id) if bill.card_id else None
    # Every saved password up front: with two PDFs in the email (the bill and
    # its terms), each has to be opened to tell which is the bill
    passwords = [p for p in (secret_box.decrypt(b.password_encrypted) for b in
                             db.query(BankPassword).filter(BankPassword.user_id == user_id)) if p]
    if card:
        from card_bills import passwords_for
        passwords = passwords_for(card, passwords)
    pdf = best_statement_pdf(service, bill.gmail_message_id, msg.get("payload", {}), passwords)
    if not pdf and card:
        # The saved email carries no PDF (a "bill is ready" note, or an app
        # like CRED's): the bank's own statement email nearby, if there is one.
        step("Looking for the bank's statement email…", 0.07)
        from datetime import date as _date
        import card_bills
        around = _date.fromisoformat(bill.statement_date) if bill.statement_date else _date.today()
        other = card_bills.find_pdf_email(service, card, around)
        if other:
            m2 = service.users().messages().get(userId="me", id=other, format="full").execute()
            pdf = best_statement_pdf(service, other, m2.get("payload", {}), passwords)
            if pdf and not db.query(CreditCardStatement).filter(
                    CreditCardStatement.gmail_message_id == other, CreditCardStatement.id != bill.id).first():
                bill.gmail_message_id = other            # read from the right email from now on
                bill.email_subject = card_bills._header(m2, "subject")[:300]
                bill.email_from = card_bills._header(m2, "from")[:200]
    if not pdf:
        raise RuntimeError("Neither this bill's email nor any statement email from the bank around it has a "
                           "PDF attached, so there's no breakup to read")
    step("Unlocking the PDF…", 0.12)
    pages = pdf_pages(pdf, passwords)
    if not pages or len("".join(pages).strip()) < 100:
        raise RuntimeError("The PDF couldn't be opened with the saved passwords")
    bank = card.bank if card else bill.bank
    text, used = statement_text(bank, pages)
    step(f"Read pages 1–{used} of {len(pages)}", 0.33)
    owner = db.get(User, user_id)
    details = read_statement(text, user_history(db, owner.name) if owner else None, step,
                             (lambda ts: known_categories(db, ts, owner.name)) if owner else None)
    # stopped_at: whether the bank's end-of-statement heading (STOP_AT) was
    # found - so a layout change that stops it matching shows up.
    step("Saving…", 0.98)
    details["pages"] = {"read": used, "total": len(pages),
                        "stopped_at": STOP_AT[bank].pattern if bank in STOP_AT and
                        any(STOP_AT[bank].search(p) for p in pages[:used]) else None}
    bill.details_json = json.dumps(details)
    db.commit()
    return details


def _run(user_id: int, bill_id: int) -> None:
    from database import get_session_factory
    db = get_session_factory()()
    try:
        read_bill(db, user_id, bill_id, lambda text, frac=None: _step(bill_id, text, frac))
        with _lock:
            _status.pop(bill_id, None)
    except Exception as e:
        print(f"[card_details] bill {bill_id}: {e}")
        with _lock:
            _status[bill_id] = {"status": "error", "error": str(e)[:300]}
    finally:
        db.close()

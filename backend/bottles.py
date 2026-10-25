"""Bottles I've had: every bottle and can a person's drink expenses bought,
read from what they wrote - the description, the notes, a scanned receipt.

Most drink expenses don't name a bottle at all ("English Wine and Beer
Shop", "RG SONS and OTHERS LLP"); the ones that do write it every which way
("oldm(hf+qr+qr)", "Smirnoff full bottle", "Beer(3) from Vandyk",
"Jagermeister 750"). The knowledge base's catalogue matching can't be
trusted for this - it linked 38 shop payments to "London Dry English Gin"
on the word "English". So the LLM reads each expense and lists the bottles
it names: brand, size, how many, and the price of each when the text or the
amount says it - an expense that was only these bottles gives its amount
(split by count for one kind of bottle). Pegs, shots and cocktails at a bar
aren't bottles; a shop's name alone names none.

Each expense is read once (DrinkScan, keyed on its text, so an edit reads
it again): when the categoriser files it as Alcohol (expense_classifier),
and anything still unread when the page is opened (routers/drinks.py).
"""
from __future__ import annotations

import hashlib
import json
import re
import threading
import time
import urllib.error
import urllib.request

from statement_extractor import GROQ_MODEL, _candidates

BATCH = 15
SIZES_ML = {"quarter": 180, "half": 375, "full": 750, "pint": 330, "can": 500, "bottle": 650}
_BEER = re.compile(r"beer|lager|ale\b|stout|kingfisher|budweiser|tuborg|carlsberg|heineken|bira|hoegaarden|"
                   r"corona|simba|godfather|haywards|kf\b|strong", re.I)
# Words that say what kind of drink, not which one: "Magic Moments Vodka" and
# "Magic Moments" are one bottle.
_KIND_WORDS = {"vodka", "whisky", "whiskey", "rum", "gin", "beer", "lager", "wine", "brandy", "tequila",
               "premium", "blended", "scotch", "dry", "bottle", "the"}


def bottle_key(name: str) -> str:
    """Which bottle a name is, for counting visits to it - case, spacing,
    punctuation and kind-of-drink words aside."""
    from places import _words
    words = [w for w in _words(name) if w not in _KIND_WORDS]
    return "".join(words) or "".join(_words(name))

_PROMPT = """You read expenses an Indian user typed for alcohol and list the BOTTLES (and cans) each one bought.
For each item you get its description, notes, any receipt lines, and the amount in rupees.

Rules:
- A bottle is a sealed bottle or can bought, usually from a liquor shop: "Old Monk", "Smirnoff full bottle",
  "Jagermeister 750", "Beer(3)", "2 KF strong". A whole bottle bought at a bar counts too.
- NOT bottles: pegs, shots, glasses, cocktails, pitchers, a bar bill, food, mixers (soda, coke, water, ice).
- Each item says where it was filed. A "Bar" item is an evening at a bar, pub or brewpub - it has NO bottles
  unless the text explicitly counts bottles or cans ("2 Bud Magnum", "bucket of 5 KF"). "Beer at <place>",
  "Andheri west beer", "Beer Cafe" (a bar chain), "Effingut" / "Toit" / "Social" (brewpubs) are evenings out:
  empty list.
- A shop or bar name alone ("English Wine and Beer Shop", "Vandyk Spirits", "RG SONS LLP", "Manjunath Wines",
  "The Liquor Tap", "Social") names no bottle: return an empty list for it. Shop names carry words like wine
  shop, beer shop, wines, spirits, liquor, beverages, enterprises, LLP, bar, tap, pub.
- A liquor BRAND named on its own IS one bottle of it: "Royal Ranthambore", "J&B", "Black Dog Gold",
  "Bacardi Orange", "Old Monk", "Magic Moments" - Indian whisky, rum, vodka, gin and beer brands count.
- Give the product as it's sold, without the size: "Old Monk", "Smirnoff", "Magic Moments",
  "Kingfisher Strong" (KF strong), "Budweiser", "Jagermeister", "Royal Ranthambore". A plain "beer" with no
  brand: "Beer". Keep every variant word the text gives: "Black Dog Gold", "Absolut Passion Fruit",
  "Smirnoff Minty Jamun", "Cherrapunji Gin" (a brand known for one spirit keeps that word: gin, rum).
- size: "quarter" (180 ml, qr/qtr/pauwa), "half" (375 ml, hf/adha/addha), "full" (750 ml, bottle of spirits),
  "pint" (330 ml beer), "can" (500 ml beer can), "bottle" (650 ml BEER bottle only - a spirit's
  "bottle" is "full"), or another size in ml.
  size_ml: the millilitres. null when the text gives no size and it isn't obvious.
- qty: how many of that bottle ("oldm(hf+qr+qr)" is Old Monk half x1 and Old Monk quarter x2).
- price_each: the rupee price of ONE such bottle when the text states it, or when the amount is clearly for
  just these bottles and there is one kind of bottle (amount / qty). Otherwise null - never guess a price.

Respond with ONLY JSON:
{"results": [{"id": <item id>, "bottles": [{"name": str, "size": str|null, "size_ml": int|null,
  "qty": int, "price_each": number|null}]}]}
One result per item id."""

_lock = threading.Lock()
_status = {"running": False}


def _text(e) -> str:
    """What the expense says about itself - what is read, and hashed."""
    parts = [e.title or "", e.notes or ""]
    if e.receipt_json:
        try:
            parts += [str(i.get("label") or "") for i in json.loads(e.receipt_json).get("items", [])]
        except (ValueError, AttributeError):
            pass
    return " | ".join(p.strip() for p in parts if p and p.strip())


def _hash(e) -> str:
    return hashlib.sha256(f"{_text(e)}|{e.amount}".encode()).hexdigest()


def _ask(items: list[dict]) -> dict:
    payload = json.dumps({
        "model": GROQ_MODEL, "temperature": 0, "response_format": {"type": "json_object"},
        "messages": [{"role": "system", "content": _PROMPT},
                     {"role": "user", "content": json.dumps({"items": items}, ensure_ascii=False)}],
    }).encode()
    last: Exception | None = None
    for url, key, extra in _candidates():
        req = urllib.request.Request(url, data=payload, method="POST", headers={
            "Authorization": f"Bearer {key}", "Content-Type": "application/json", "Accept": "application/json",
            # Groq's Cloudflare front-end blocks urllib's default user agent.
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            **extra})
        # Back-to-back batches run into a free key's per-minute limit: wait
        # as long as the 429 says (when short) and retry the same key.
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    reply = json.loads(json.loads(r.read().decode())["choices"][0]["message"]["content"])
                if isinstance(reply, dict) and isinstance(reply.get("results"), list):
                    return reply
                last = ValueError("reply has no results list")
                break
            except urllib.error.HTTPError as err:
                last = err
                wait = float(err.headers.get("retry-after") or 0) if err.code == 429 else 0
                if err.code == 429 and attempt < 2:
                    time.sleep(min(max(wait, 5), 60) + 0.5)
                    continue
                break
            except (urllib.error.URLError, KeyError, ValueError, TimeoutError) as err:
                last = err
                break
    raise last or RuntimeError("No LLM key configured")


def _num(v):
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _clean(b: dict) -> dict | None:
    name = " ".join(str(b.get("name") or "").split())[:120]
    if len(name) < 2:
        return None
    size = (str(b.get("size")).strip().lower()[:30] or None) if b.get("size") else None
    if size == "bottle" and not _BEER.search(name):
        size, b = "full", {**b, "size_ml": 750}      # a spirit's "bottle" is a full one
    ml = _num(b.get("size_ml"))
    ml = int(ml) if ml and 30 <= ml <= 5000 else SIZES_ML.get(size or "")
    try:
        qty = max(1, min(int(b.get("qty") or 1), 100))
    except (TypeError, ValueError):
        qty = 1
    price = _num(b.get("price_each"))
    # No beer bottle or can costs ₹800: a price like that is a bar bill read
    # as one bottle, and is no price at all.
    ceiling = 800 if _BEER.search(name) else 100000
    price = round(price, 2) if price and 20 <= price <= ceiling else None
    return {"name": name, "size": size, "size_ml": ml, "qty": qty, "price_each": price}


def scan(db, expenses) -> int:
    """Read these expenses for bottles - those unread or edited since - and
    store what each bought. Returns how many were read. The caller commits."""
    from models import DrinkBottle, DrinkScan

    seen = {s.expense_id: s for s in db.query(DrinkScan).filter(
        DrinkScan.expense_id.in_([e.id for e in expenses])).all()} if expenses else {}
    todo = [e for e in expenses if e.id not in seen or seen[e.id].text_hash != _hash(e)]
    done = 0
    for start in range(0, len(todo), BATCH):
        chunk = todo[start:start + BATCH]
        items = [{"id": i, "description": e.title or "", "notes": e.notes or "",
                  "receipt": _text(e) if e.receipt_json else "", "amount": e.amount,
                  "filed_as": " > ".join(x for x in (e.category, e.subcategory) if x)}
                 for i, e in enumerate(chunk)]
        try:
            reply = _ask(items)
        except Exception as err:          # LLM down: left unread, tried again next time
            print(f"[bottles] read failed: {err}")
            continue
        got = {}
        for r in reply.get("results", []):
            if isinstance(r, dict) and isinstance(r.get("id"), int) and 0 <= r["id"] < len(chunk):
                got[r["id"]] = [c for c in (_clean(b) for b in (r.get("bottles") or []) if isinstance(b, dict)) if c]
        for i, e in enumerate(chunk):
            if i not in got:
                continue                   # skipped by the model: read again next time
            db.query(DrinkBottle).filter(DrinkBottle.expense_id == e.id).delete()
            for b in got[i]:
                db.add(DrinkBottle(expense_id=e.id, **b))
            if e.id in seen:
                seen[e.id].text_hash = _hash(e)
            else:
                db.add(DrinkScan(expense_id=e.id, text_hash=_hash(e)))
            done += 1
        db.flush()
    return done


def drink_expenses(db, group_ids: list[int]):
    """The drink expenses in these groups: filed Alcohol, or that the
    knowledge base reads as a drink."""
    from sqlalchemy import or_, select
    from models import Expense, KnowledgeItem
    drinkish = select(KnowledgeItem.expense_id).where(KnowledgeItem.kind == "drink")
    return (db.query(Expense)
            .filter(Expense.group_id.in_(group_ids),
                    or_(Expense.category == "Alcohol", Expense.id.in_(drinkish))).all())


def status() -> dict:
    with _lock:
        return dict(_status)


def scan_in_background(group_ids: list[int]) -> bool:
    """Read anything unread in these groups, in a thread - the first visit
    can mean a couple of hundred expenses. False when one is already running."""
    with _lock:
        if _status["running"]:
            return False
        _status["running"] = True

    def run():
        from database import get_session_factory
        db = get_session_factory()()
        try:
            scan(db, drink_expenses(db, group_ids))
            db.commit()
        except Exception as err:
            db.rollback()
            print(f"[bottles] background read failed: {err}")
        finally:
            db.close()
            with _lock:
                _status["running"] = False

    threading.Thread(target=run, daemon=True, name="bottles-scan").start()
    return True

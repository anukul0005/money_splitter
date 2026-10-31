"""Categorise hand-entered expenses with the LLM, in the background.

An expense saved from the add/edit form has no category of its own - the
form only asks for a description (and optional notes). It's stored with
category_source "pending" and its id queued here; a single worker thread
picks it up, works out a category and subcategory from spend_categories.
TAXONOMY, and writes them back with category_source "llm".

Fewer calls, spread over both Groq keys:
  - ids arriving within WINDOW seconds of each other go to the LLM as one
    request (up to BATCH), not one request each;
  - the same text is only ever asked about once: an expense whose
    description + notes match one already categorised by the LLM copies
    that answer instead;
  - successive requests alternate between GROQ_API_KEY and GROQ_API_KEY_2
    (each the other's fallback), with OpenRouter after both.
"Pending" doubles as the retry queue: whatever the worker couldn't finish
(LLM down, process restarted) is picked up by the next run or at startup.
"""
from __future__ import annotations

import itertools
import json
import queue
import threading
import time
import urllib.error
import urllib.request

from sqlalchemy import case, func

from spend_categories import TAXONOMY, categorize
from statement_extractor import GROQ_MODEL, _candidates

WINDOW = 3      # seconds to wait for more ids before calling the LLM
BATCH = 20      # expenses per request

_queue: "queue.Queue[int]" = queue.Queue()
_started = False
_start_lock = threading.Lock()
_turn = itertools.count()   # which Groq key goes first, alternating per request
_memo: dict[str, tuple[str, str | None]] = {}   # text key -> (category, subcategory)
_venues: dict[str, str | None] = {}              # text key -> venue

_TAXONOMY_LINES = "\n".join(f"  {c}: {', '.join(subs)}" for c, subs in TAXONOMY.items())
_SYSTEM_PROMPT = f"""You categorise personal expenses an Indian user typed into an expense app.
Each item has a description (what the money was for, or who it was paid to), optional notes, the amount in rupees and the name of the group it was added to.

Pick the category and subcategory that best describe what the money was spent on, from this list ONLY:
{_TAXONOMY_LINES}

Rules:
- Use the exact category and subcategory spellings above.
- Judge by what was bought: "dinner at Punjab Grill" is Food & Dining > Restaurants, "Uber to office" is Transport > Cab & auto, "Blinkit milk" is Groceries > Quick commerce, "beer" is Alcohol.
- "FL" in a payee name ("NEW SINDHI BASTI FL", "RAWER ROAD 2 FL") marks a foreign-liquor shop: Alcohol > Liquor store.
- Company names stand for their outlets: "Connaught Plaza Restaurants" runs McDonald's, "Burrito Restaurants" runs Taco Bell, "Jubilant Foodworks" runs Domino's.
- The notes often list the items bought - use them.
- If nothing fits, use Other > Unclassified merchant.
- venue: the name of the restaurant, cafe, bar, dhaba, sweet shop or food outlet the money was spent at, when the description or notes name one - "Lunch at seth sethani" -> "Seth Sethani", "MCDONALDS" -> "McDonald's", "Mamagoto - Binge central noida" -> "Mamagoto". Use its usual spelling, without area, city or branch. null when no specific place is named: generic words ("morning bf", "chicken", "snacks"), a delivery app alone ("Zomato", "Swiggy"), a grocery or other shop, a liquor shop (an "FL" payee), a mall, or a person's name. For a company that runs a chain, give the chain ("Connaught Plaza Restaurants" -> "McDonald's").

Respond with ONLY a JSON object:
{{"results": [{{"id": <the item's id>, "category": string, "subcategory": string, "venue": string or null}}]}}
Return exactly one result per item id you were given."""


def available() -> bool:
    return bool(_candidates())


def _text_key(title: str | None, notes: str | None) -> str:
    return f"{(title or '').strip().lower()}|{(notes or '').strip().lower()}"


def _providers() -> list[tuple[str, str, dict]]:
    """All configured providers, the Groq keys rotated so successive
    requests start on alternate keys - the load is shared rather than one
    key taking every call until it's rate-limited."""
    cands = _candidates()
    groq = [c for c in cands if "groq.com" in c[0]]
    rest = [c for c in cands if "groq.com" not in c[0]]
    if len(groq) > 1:
        i = next(_turn) % len(groq)
        groq = groq[i:] + groq[:i]
    return groq + rest


def _chat(items: list[dict]) -> dict:
    payload = json.dumps({
        "model": GROQ_MODEL,
        "messages": [{"role": "system", "content": _SYSTEM_PROMPT},
                     {"role": "user", "content": json.dumps({"items": items}, ensure_ascii=False)}],
        "response_format": {"type": "json_object"},
        "temperature": 0,
    }).encode()
    last_error: Exception | None = None
    for url, api_key, extra in _providers():
        req = urllib.request.Request(url, data=payload, method="POST", headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            # Groq's Cloudflare front-end blocks urllib's default user agent.
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "application/json",
            **extra,
        })
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                data = json.loads(resp.read().decode())
            reply = json.loads(data["choices"][0]["message"]["content"])
            if isinstance(reply, dict) and isinstance(reply.get("results"), list):
                return reply
            last_error = ValueError("reply has no results list")
        except (urllib.error.URLError, KeyError, ValueError, TimeoutError) as e:
            last_error = e   # rate-limited, bad key or bad reply: next provider
    raise last_error or RuntimeError("No LLM key configured")


def _clean(cat, sub) -> tuple[str, str | None]:
    if cat not in TAXONOMY:
        return "Other", "Unclassified merchant"
    return cat, sub if sub in TAXONOMY[cat] else None


def _rules(title: str | None) -> tuple[str, str | None] | None:
    """The keyword rules imports use - the fallback when no LLM answers.
    Only a confident match counts; their catch-alls say nothing here."""
    cat, sub = categorize(title or "", 0)
    return None if cat in ("Small vendors", "One-off payments", "Other") else (cat, sub)


def _process(ids: set[int]) -> None:
    from database import get_session_factory
    from models import Expense, Group

    db = get_session_factory()()
    try:
        # The queued ids first, then any older leftovers still pending -
        # this is the retry path. An id no longer pending (edited again
        # meanwhile and already done, or deleted) simply isn't found.
        rows = (db.query(Expense)
                .filter(Expense.category_source == "pending")
                .order_by(case((Expense.id.in_(ids), 0), else_=1), Expense.id)
                .limit(BATCH * 3).all())
        if not rows:
            return
        groups = {g.id: g.name for g in db.query(Group.id, Group.name)
                  .filter(Group.id.in_({e.group_id for e in rows}))}

        todo: dict[str, list] = {}
        for e in rows:
            key = _text_key(e.title, e.notes)
            if key in _memo and key in _venues:
                e.category, e.subcategory = _memo[key]
                e.venue = _venues[key]
                e.category_source = "llm"
                continue
            prior = (db.query(Expense.category, Expense.subcategory, Expense.venue)
                     .filter(Expense.category_source == "llm", Expense.id != e.id,
                             func.lower(func.trim(Expense.title)) == (e.title or "").strip().lower(),
                             func.lower(func.trim(func.coalesce(Expense.notes, ""))) == (e.notes or "").strip().lower())
                     .first())
            if prior and prior.category:
                _memo[key] = (prior.category, prior.subcategory)
                _venues[key] = prior.venue
                e.category, e.subcategory, e.venue = prior.category, prior.subcategory, prior.venue
                e.category_source = "llm"
                continue
            todo.setdefault(key, []).append(e)
        db.commit()

        keys = list(todo)
        for start in range(0, len(keys), BATCH):
            chunk = keys[start:start + BATCH]
            items = []
            for i, key in enumerate(chunk):
                e = todo[key][0]
                items.append({"id": i, "description": e.title or "", "notes": e.notes or "",
                              "amount": e.amount, "group": groups.get(e.group_id, "")})
            answers: dict[int, tuple[str, str | None]] = {}
            venues: dict[int, str | None] = {}
            try:
                for r in _chat(items).get("results", []):
                    if isinstance(r, dict) and isinstance(r.get("id"), int):
                        answers[r["id"]] = _clean(r.get("category"), r.get("subcategory"))
                        venues[r["id"]] = canonical_venue(db, clean_venue(r.get("venue")))
            except Exception as err:
                print(f"[classify] LLM unavailable, using rules: {err}")
            for i, key in enumerate(chunk):
                got = answers.get(i)
                source = "llm"
                if got is None:
                    got, source = _rules(todo[key][0].title), "rules"
                if got is None:
                    continue          # stays pending - retried on the next run
                if source == "llm":
                    _memo[key] = got
                    _venues[key] = venues.get(i)
                for e in todo[key]:
                    e.category, e.subcategory = got
                    e.venue = venues.get(i) if source == "llm" else None
                    e.category_source = source
            db.commit()
        _guard(db, rows)
        _teach(db, rows)
        _reindex(db, rows)
        _bottles(db, rows)
    finally:
        db.close()


def clean_venue(v) -> str | None:
    if not isinstance(v, str):
        return None
    v = " ".join(v.split()).strip(" -,.")
    return v[:120] if 2 <= len(v) and v.lower() not in ("null", "none", "n/a", "unknown") else None


def _squash(v: str) -> str:
    return "".join(ch for ch in v.lower() if ch.isalnum())


def canonical_venue(db, v: str | None) -> str | None:
    """An existing spelling of the same place when there is one - "Zafar
    Omlet Corner" becomes the "Zafar Omelet Corner" already on file - so one
    place doesn't split into two in the knowledge base. See places.py."""
    from places import canonical
    return canonical(db, v)


def _bottles(db, rows) -> None:
    """A drink expense just categorised: read the bottles it names, for
    "Bottles I've had" (bottles.py). Never allowed to break categorising."""
    drinks = [e for e in rows if e.category == "Alcohol"]
    if not drinks:
        return
    try:
        import bottles
        bottles.scan(db, drinks)
        db.commit()
    except Exception as err:
        db.rollback()
        print(f"[classify] bottle reading failed: {err}")


def _guard(db, rows) -> None:
    """Answers no plausible payment has: more than a tea stall is ever paid
    (spend_categories.TEA_STALL_MAX) is unclassified and no place to eat,
    whatever the description led the LLM to say."""
    from spend_categories import UNCLASSIFIED, tea_stall_overpaid
    from merchant_memory import split_place
    for e in rows:
        if e.category_source in ("llm", "rules") and tea_stall_overpaid(e.amount, e.title, e.merchant, e.venue):
            e.category, e.subcategory = UNCLASSIFIED
            e.venue = None
        elif e.category_source in ("llm", "rules", "merchant", "import"):
            split_place(e)       # a big Khao Pio bill is the liquor shop, not the snacks counter
    db.commit()


def _teach(db, rows) -> None:
    """A statement payment the person described, now categorised, says what
    its payee is - for every later import of it, theirs and other people's
    (merchant_memory)."""
    try:
        import merchant_memory
        for e in rows:
            if e.category_source != "pending":
                merchant_memory.recognise_place(db, e)    # a known place the AI missed
                merchant_memory.learn_from(db, e)
                merchant_memory.fill_venue(db, e)   # "lunch" at a place someone named
        ids = {e.id for e in rows}
        others = [i for i in merchant_memory.touched(db) if i not in ids]
        db.commit()
    except Exception as err:  # learning must never break categorising
        db.rollback()
        print(f"[classify] merchant learning failed: {err}")
        return
    if others:   # earlier payments to a payee just learnt - this thread can wait on them
        from models import Expense
        _reindex(db, db.query(Expense).filter(Expense.id.in_(others)).all())


def _reindex(db, rows) -> None:
    """The knowledge base indexes an expense when it's saved, before it has
    a category - so once categorised (and its venue read), index it again."""
    try:
        from knowledge import index_expense
        for e in rows:
            if e.category_source != "pending":
                index_expense(db, e)
        db.commit()
    except Exception as err:  # the knowledge base must never break categorising
        db.rollback()
        print(f"[classify] re-indexing failed: {err}")


def _worker() -> None:
    while True:
        ids = {_queue.get()}
        deadline = time.monotonic() + WINDOW
        while len(ids) < BATCH:
            left = deadline - time.monotonic()
            if left <= 0:
                break
            try:
                ids.add(_queue.get(timeout=left))
            except queue.Empty:
                break
        try:
            _process(ids)
        except Exception as e:  # pragma: no cover - the worker must never die
            print(f"[classify] batch failed: {e}")


def _ensure_worker() -> None:
    global _started
    with _start_lock:
        if not _started:
            threading.Thread(target=_worker, daemon=True, name="expense-classifier").start()
            _started = True


def enqueue(expense_id: int) -> None:
    """Queue one saved expense for categorising; returns immediately."""
    _ensure_worker()
    _queue.put(expense_id)


def sweep() -> None:
    """Startup: queue whatever was left pending by the last process."""
    from database import get_session_factory
    from models import Expense

    db = get_session_factory()()
    try:
        ids = [i for (i,) in db.query(Expense.id).filter(Expense.category_source == "pending").limit(200)]
    finally:
        db.close()
    for i in ids:
        enqueue(i)

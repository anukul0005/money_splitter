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

_TAXONOMY_LINES = "\n".join(f"  {c}: {', '.join(subs)}" for c, subs in TAXONOMY.items())
_SYSTEM_PROMPT = f"""You categorise personal expenses an Indian user typed into an expense app.
Each item has a description (what the money was for, or who it was paid to), optional notes, the amount in rupees and the name of the group it was added to.

Pick the category and subcategory that best describe what the money was spent on, from this list ONLY:
{_TAXONOMY_LINES}

Rules:
- Use the exact category and subcategory spellings above.
- Judge by what was bought: "dinner at Punjab Grill" is Food & Dining > Restaurants, "Uber to office" is Transport > Cab & auto, "Blinkit milk" is Groceries > Quick commerce, "beer" is Alcohol.
- The notes often list the items bought - use them.
- If nothing fits, use Other > Unclassified merchant.

Respond with ONLY a JSON object:
{{"results": [{{"id": <the item's id>, "category": string, "subcategory": string}}]}}
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
            if key in _memo:
                e.category, e.subcategory = _memo[key]
                e.category_source = "llm"
                continue
            prior = (db.query(Expense.category, Expense.subcategory)
                     .filter(Expense.category_source == "llm", Expense.id != e.id,
                             func.lower(func.trim(Expense.title)) == (e.title or "").strip().lower(),
                             func.lower(func.trim(func.coalesce(Expense.notes, ""))) == (e.notes or "").strip().lower())
                     .first())
            if prior and prior.category:
                _memo[key] = (prior.category, prior.subcategory)
                e.category, e.subcategory = prior.category, prior.subcategory
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
            try:
                for r in _chat(items).get("results", []):
                    if isinstance(r, dict) and isinstance(r.get("id"), int):
                        answers[r["id"]] = _clean(r.get("category"), r.get("subcategory"))
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
                for e in todo[key]:
                    e.category, e.subcategory = got
                    e.category_source = source
            db.commit()
    finally:
        db.close()


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

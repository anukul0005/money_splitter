"""Reading a photographed notebook page of expenses - handwritten, Hindi
and English mixed - into rows: an item, a total and each person's share.

    खर्च का विवरण
    सोने का सेट          T.        R        A
      गला सेट         2,40,000    150     90 th
      मांग टीका          70,000     50     20 th

A vision model (Gemini 3.8 Flash, Google AI Studio free tier - GEMINI_API_KEY)
transcribes the table; it gets digits mostly right and handwriting words often wrong, so:
  1. the prompt carries what this person has taught it before (LedgerHint):
     which column letter is whom in this group, and words it misread;
  2. arithmetic fixes what it can - a share written in thousands ("150"
     beside a total of 2,40,000) is scaled when that makes the row add up,
     and a row with no total gets the sum of its shares;
  3. a row that still doesn't add up is flagged for the review screen,
     where the person corrects it before anything is saved - and those
     corrections become the next page's hints (routers/ledger.py).
"""
from __future__ import annotations

import base64
import io
import itertools
import json
import os
import re
import urllib.error
import urllib.request

# Google AI Studio's OpenAI-compatible endpoint, so the request below is the
# same shape the rest of the app already uses. Flash is the model that stays
# free on the Google AI Studio free tier (generous daily quota, no card); the
# Pro tier is tiny and moving behind billing, so it is not the default. 3.8 is
# the current Flash - 2.5-flash is retired for new keys. Override with
# LEDGER_VISION_MODEL (e.g. gemini-3.8-pro) if ever needed.
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
VISION_MODEL = os.getenv("LEDGER_VISION_MODEL", "gemini-3.8-flash")

_PROMPT = """This photo is one of two things. Decide which first.

(A) A PRINTED bill, tax invoice, cash memo or shop receipt - a seller's name, GST/GSTIN, HSN codes, Qty/Rate,
CGST/SGST/IGST, MRP, a grand total. Its columns are NOT people. Reply with only JSON:
{{"kind": "bill", "merchant": "the seller's shop or brand name", "date": "YYYY-MM-DD" or null,
"items": [{{"label": "what the line item is, in plain words - the product description, never the HSN code",
"amount": the line's final amount including its tax}}],
"subtotal": number or null, "tax": total tax or null, "total": the grand total payable}}

(B) A HANDWRITTEN Indian expense page, Hindi (Devanagari) and English mixed. It is a table:
the first column names the item, then amount columns headed by people's letters or names. Rules:
- Copy each item exactly as written, in its own script; do not guess a meaning first. Then give a short English gloss.
  Common words: सोने का सेट = gold set, गला = necklace, मांग टीका = maang tikka, अंगूठी = ring, साड़ी = saree,
  सूट = suit, सामान = items, खर्च = expense, किराया = rent, कुल = total.
- A heading with indented lines under it is a section; the indented lines are its items.
- 'th' or 'k' after a number means thousand; '00' or '-' means zero/none; '/-' just ends an amount.
- The share columns of a row add up to its total column - use that to read unclear digits.
- A number alone on a line belongs to the item text on that line or beside it. Never invent a 'Total' row.
{hints}
For (B) reply with only JSON: {{"kind": "ledger", "title": str, "columns": [str], "rows": [{{"section": str|null,
"item": str, "item_en": str, "amounts": {{"<column heading as written>": number|null}}}}]}}"""

# Column headings that only ever belong to a printed bill - a reply that
# called the page a ledger but used these is a bill all the same.
_BILL_COLUMNS = {"cgst", "sgst", "igst", "gst", "hsn", "hsnsac", "sac", "qty", "rate", "mrp", "net",
                 "taxable", "taxablevalue", "amount", "amt", "disc", "discount", "uom"}


def _hints_text(columns: dict[str, str], words: dict[str, str]) -> str:
    lines = []
    if columns:
        lines.append("In this notebook: " + "; ".join(f"column {k} = {v}" for k, v in columns.items()) + ".")
    if words:
        lines.append("Words you misread before (read -> actually written): "
                     + "; ".join(f"{a} -> {b}" for a, b in list(words.items())[:40]) + ".")
    return "\n".join("- " + l for l in lines)


def _image_b64(raw: bytes) -> str:
    """A phone photo shrunk to what the model reads well (and the API takes)."""
    from PIL import Image, ImageOps
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
    img.thumbnail((2400, 2400))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode()


def _ask_vision(prompt: str, image_b64: str) -> dict:
    """Send the page to Gemini (2.5 Flash by default) and parse its JSON reply. Raises
    RuntimeError when no key is set or the request fails."""
    from database import get_settings
    key = get_settings().gemini_api_key
    if not key:
        raise RuntimeError("The notebook reader isn't set up yet - add a Gemini API key (GEMINI_API_KEY).")
    body = json.dumps({
        "model": VISION_MODEL, "temperature": 0, "max_tokens": 4000,
        "response_format": {"type": "json_object"},
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}}]}],
    }).encode()
    req = urllib.request.Request(GEMINI_URL, data=body, method="POST", headers={
        "Authorization": f"Bearer {key}", "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            content = json.loads(resp.read().decode())["choices"][0]["message"]["content"]
    except urllib.error.HTTPError as e:
        if e.code == 429:
            raise RuntimeError("The notebook reader has hit its free Gemini limit for now - "
                               "try again in a minute (or tomorrow, if it's the daily limit).") from None
        if e.code in (401, 403):
            raise RuntimeError("The notebook reader's Gemini key was refused - "
                               "check GEMINI_API_KEY on the server.") from None
        detail = e.read().decode(errors="replace")[:200]
        raise RuntimeError(f"Gemini rejected the page ({e.code}): {detail}") from None
    except (urllib.error.URLError, KeyError, ValueError, TimeoutError) as e:
        raise RuntimeError(f"Couldn't reach Gemini: {e}") from None
    m = re.search(r"\{.*\}", content, re.S)       # tolerate ```json fences
    return json.loads(m.group(0) if m else content)


def _num(v) -> float | None:
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.replace(",", "").strip().lower()
        mult = 1000 if s.endswith(("th", "k")) else 1
        s = re.sub(r"[^\d.]", "", s)
        try:
            return float(s) * mult if s else None
        except ValueError:
            return None
    return None


def _is_total(col: str) -> bool:
    c = col.strip().strip(".").lower()
    return c in ("t", "total", "tot", "कुल", "टोटल") or c.startswith("total")


def fix_row(total: float | None, shares: dict[str, float | None]) -> tuple[float | None, dict[str, float], list[str]]:
    """(total, shares, notes) with the arithmetic repairs described above."""
    s = {k: (v or 0.0) for k, v in shares.items()}
    notes: list[str] = []
    if total is None:
        total = sum(s.values()) or None
        if total:
            notes.append("total worked out from the shares")
        return total, s, notes
    if abs(sum(s.values()) - total) <= 1:
        return total, s, notes
    small = [k for k, v in s.items() if 0 < v < 1000]
    for n in range(1, len(small) + 1):
        for combo in itertools.combinations(small, n):
            trial = {k: (v * 1000 if k in combo else v) for k, v in s.items()}
            if abs(sum(trial.values()) - total) <= 1:
                notes.append("read " + ", ".join(f"{k} {s[k]:g} as {s[k] * 1000:,.0f}" for k in combo)
                             + " (written in thousands)")
                return total, trial, notes
    notes.append(f"shares add up to {sum(s.values()):,.0f}, not {total:,.0f} - check this row")
    return total, s, notes


def _money(v) -> float | None:
    n = _num(v)
    return round(n, 2) if n else None


def _bill(page: dict) -> dict:
    """A printed bill as one receipt - the shape the receipt scan gives
    (Expense.receipt_json), for the ordinary add-expense form to split."""
    items = []
    for it in page.get("items") or []:
        if isinstance(it, dict) and str(it.get("label") or "").strip() and _money(it.get("amount")):
            items.append({"label": str(it["label"]).strip()[:120], "amount": _money(it["amount"])})
    total = _money(page.get("total")) or (round(sum(i["amount"] for i in items), 2) if items else None)
    date = page.get("date") if isinstance(page.get("date"), str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", page["date"]) else None
    return {"kind": "bill", "merchant": str(page.get("merchant") or "").strip()[:200] or None, "date": date,
            "items": items, "subtotal": _money(page.get("subtotal")), "tax": _money(page.get("tax")), "total": total}


def read_page(raw: bytes, column_hints: dict[str, str], word_hints: dict[str, str]) -> dict:
    """A handwritten ledger: {"kind": "ledger", "title", "columns",
    "total_column", "rows": [{"section", "item", "item_en", "total",
    "shares": {column: amount}, "notes", "ok"}]}. A printed bill: _bill()."""
    page = _ask_vision(_PROMPT.format(hints=_hints_text(column_hints, word_hints)), _image_b64(raw))
    cols = {re.sub(r"[^a-z]", "", str(c).lower()) for c in (page.get("columns") or [])}
    if page.get("kind") == "bill" or len(cols & _BILL_COLUMNS) >= 2:
        if page.get("kind") != "bill":     # called a ledger, but its columns are a bill's
            page = _ask_vision(_PROMPT.format(hints="") + "\nThis photo is (A), a printed bill.", _image_b64(raw))
        return _bill(page)
    raw_rows = [r for r in (page.get("rows") or []) if isinstance(r, dict)]
    # A "column" with no number anywhere under it is a heading the model
    # mistook for one (the page title, the item column).
    columns = [str(c) for c in (page.get("columns") or [])
               if any(_num((r.get("amounts") or {}).get(c)) for r in raw_rows if isinstance(r.get("amounts"), dict))]
    total_col = next((c for c in columns if _is_total(c)), None)
    share_cols = [c for c in columns if c != total_col]
    rows = []
    for r in raw_rows:
        if not str(r.get("item") or "").strip():
            continue
        amounts = r.get("amounts") if isinstance(r.get("amounts"), dict) else {}
        if not any(_num(v) for v in amounts.values()):
            continue                           # a heading line, not an expense
        # Past corrections reach the model only as prompt hints, never as a
        # blind replacement: "Ring" once misread for a saree mustn't turn
        # every real ring on a later page into a saree.
        item = str(r["item"]).strip()
        total, shares, notes = fix_row(_num(amounts.get(total_col)) if total_col else None,
                                       {c: _num(amounts.get(c)) for c in share_cols})
        total = round(total, 2) if total else total
        shares = {c: round(v, 2) for c, v in shares.items()}
        rows.append({"section": r.get("section"), "item": item, "item_en": str(r.get("item_en") or item).strip(),
                     "total": total, "shares": shares, "notes": notes,
                     "ok": total is not None and abs(sum(shares.values()) - total) <= 1})
    return {"kind": "ledger", "title": page.get("title"), "columns": columns, "total_column": total_col,
            "share_columns": share_cols, "rows": rows}

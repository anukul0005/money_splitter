"""Turn raw OCR text into a structured receipt guess, and score how much
that guess should be trusted.

Deliberately dumb line-based heuristics, not a model: receipts are printed
in wildly different layouts, but a total is reliably the largest money-like
number on a line that says "total", and a line item is reliably "some
label ... a price at the end". Rules that mostly work and are easy to read
and adjust beat a black box that's occasionally uncannily good and
occasionally silently wrong on money.
"""
from __future__ import annotations

import re
from datetime import date as _date

_MONEY = re.compile(r"(?:₹|rs\.?|inr)?\s*([\d,]+\.\d{2}|[\d,]+)\s*$", re.I)
_TOTAL_WORDS = re.compile(r"\b(grand\s*total|total|amount\s*due|net\s*amount|balance\s*due)\b", re.I)
_TAX_WORDS = re.compile(r"\b(gst|tax|cgst|sgst|vat|service\s*charge)\b", re.I)
_SUBTOTAL_WORDS = re.compile(r"\bsub\s*total\b", re.I)
_DATE_PATTERNS = [
    (re.compile(r"\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b"), "dmy"),
    (re.compile(r"\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b"), "ymd"),
]


def _to_float(s: str) -> float | None:
    try:
        return float(s.replace(",", ""))
    except (ValueError, AttributeError):
        return None


def _line_amount(line: str) -> float | None:
    m = _MONEY.search(line.strip())
    return _to_float(m.group(1)) if m else None


def _parse_date(text: str) -> str | None:
    """A receipt's own printed date, read as DD/MM/YYYY first - the
    convention almost every Indian till receipt actually prints in -
    falling back to YYYY-MM-DD. Returns None rather than guessing when
    neither pattern is found, so the caller's own default (today) applies
    instead of a wrong date silently winning."""
    for pattern, order in _DATE_PATTERNS:
        m = pattern.search(text)
        if not m:
            continue
        a, b, c = m.groups()
        try:
            if order == "dmy":
                d, mo, y = int(a), int(b), int(c)
            else:
                y, mo, d = int(a), int(b), int(c)
            return _date(y, mo, d).isoformat()
        except ValueError:
            continue
    return None


def parse_receipt(raw_text: str) -> dict:
    """Best-effort structured guess plus a 0-100 confidence score, from
    four independent 25-point checks: a merchant name, at least one line
    item, a total, and the items (plus tax) actually summing close to that
    total. routers/receipts.py stops trying further OCR providers once
    this clears CONFIDENCE_THRESHOLD - a receipt that fails the math check
    is exactly the case where a second provider's read is worth the extra
    quota.
    """
    lines = [l.strip() for l in raw_text.splitlines() if l.strip()]

    merchant = lines[0] if lines else None

    total = subtotal = tax = None
    items: list[dict] = []

    for line in lines:
        # A bare date line ("12/09/2026") also matches the money pattern
        # (2026 reads as an amount) - skipped outright rather than treated
        # as either a total or a line item.
        if any(p.search(line) for p, _ in _DATE_PATTERNS):
            continue
        amt = _line_amount(line)
        if amt is None:
            continue
        is_total_line = bool(_TOTAL_WORDS.search(line))
        is_subtotal_line = bool(_SUBTOTAL_WORDS.search(line))
        is_tax_line = bool(_TAX_WORDS.search(line))

        if is_subtotal_line and subtotal is None:
            subtotal = amt
        elif is_total_line and total is None:
            total = amt
        elif is_tax_line:
            tax = (tax or 0) + amt
        else:
            # A plain "description ... price" line elsewhere on the
            # receipt - a line item, unless it's the merchant header itself.
            label = _MONEY.sub("", line).strip(" .-:")
            if label and label != merchant:
                items.append({"label": label, "amount": amt})

    receipt_date = _parse_date(raw_text)

    score = 0
    if merchant:
        score += 25
    if items:
        score += 25
    if total is not None:
        score += 25
    if total is not None and items:
        # ₹2 or 5%, whichever is larger - generous on purpose, since OCR
        # reliably drops a digit or a decimal point long before it drops a
        # whole rupee, and this check exists to catch a genuinely wrong
        # read, not to penalise normal rounding.
        items_sum = sum(i["amount"] for i in items) + (tax or 0)
        if abs(items_sum - total) <= max(2.0, total * 0.05):
            score += 25
    elif total is not None:
        # A total with nothing to check it against isn't wrong, just
        # unverified - worth something, not the full 25.
        score += 10

    return {
        "merchant": merchant,
        "date": receipt_date,
        "items": items,
        "subtotal": subtotal,
        "tax": tax,
        "total": total,
        "confidence": score,
    }

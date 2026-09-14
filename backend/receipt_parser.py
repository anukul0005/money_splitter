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

# Currency marker allowed on either side of the number - "₹408.00" and
# "408.00Rs" both appear on real receipts (a thermal printer's own POS
# software picks whichever convention it was built with).
_MONEY = re.compile(r"(?:₹|rs\.?|inr)?\s*([\d,]+\.\d{2}|[\d,]+)\s*(?:₹|rs\.?|inr)?\s*$", re.I)
_TOTAL_WORDS = re.compile(r"\b(grand\s*total|total|amount\s*due|net\s*amount|balance\s*due)\b", re.I)
_TAX_WORDS = re.compile(r"\b(gst|tax|cgst|sgst|vat|service\s*charge)\b", re.I)
_SUBTOTAL_WORDS = re.compile(r"\bsub\s*total\b", re.I)
# Neither a tax nor a real line item - a rounding adjustment line would
# otherwise get counted as one, throwing off the items-vs-total math check
# by exactly the rounding amount it's supposed to explain.
_ROUNDING_WORDS = re.compile(r"\b(before\s*rounding|rounding|round\s*off)\b", re.I)
# A line that's purely receipt bookkeeping, never a merchant's own name -
# skipped when picking the merchant even though _line_amount would ignore
# these too (most have no trailing price).
_METADATA_LINE = re.compile(
    r"^(store\s*no|order\s*no|table\s*no|bill\s*no|invoice\s*no|receipt\s*no|"
    r"gstin|fssai|qty|item)\b|^\d{1,2}:\d{2}(:\d{2})?\s*$", re.I,
)
# A bare code/number ("#160101", "16-01-01") isn't a merchant name either -
# a real one has at least one letter in it. Checked separately from
# _METADATA_LINE because this has no keyword to key off, just shape.
_CODE_LINE = re.compile(r"^#?\s*[\d\s\-]+$")
_DATE_PATTERNS = [
    (re.compile(r"\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b"), "dmy4"),
    (re.compile(r"\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b"), "ymd4"),
    (re.compile(r"\b(\d{1,2})[/-](\d{1,2})[/-](\d{2})\b"), "dmy2"),
]
_DATE_KEYWORD = re.compile(r"\bdate\b|\bdt\b|\bbilled\s*on\b", re.I)
# Lines these appear on are never the receipt's own date, even when they
# happen to contain a date-shaped run of digits - a GSTIN, phone number,
# or invoice/bill/table number is exactly the kind of thing that
# coincidentally matches "\d{1,2}[/-]\d{1,2}[/-]\d{4}".
_NOT_DATE_CONTEXT = re.compile(
    r"\b(gstin|gst\s*no|pan\s*no|phone|mobile|contact|invoice\s*no|"
    r"bill\s*no|order\s*no|table\s*no|fssai|cin\b)", re.I,
)


def _to_float(s: str) -> float | None:
    try:
        return float(s.replace(",", ""))
    except (ValueError, AttributeError):
        return None


def _line_amount(line: str) -> float | None:
    m = _MONEY.search(line.strip())
    return _to_float(m.group(1)) if m else None


def _date_from_match(order: str, a: str, b: str, c: str) -> tuple[int, int, int]:
    if order == "dmy4":
        d, mo, y = int(a), int(b), int(c)
    elif order == "ymd4":
        y, mo, d = int(a), int(b), int(c)
    else:   # dmy2 - a 2-digit year, the "70" cutoff is the usual windowing convention
        d, mo, yy = int(a), int(b), int(c)
        y = 2000 + yy if yy < 70 else 1900 + yy
    return d, mo, y


def _parse_date(lines: list[str]) -> str | None:
    """A receipt's own printed date - read line by line, not as one search
    over the whole receipt, because a single global search happily matches
    the first date-shaped digit run it finds, and a GSTIN, phone number or
    invoice/bill/table number frequently is one. Skips any line that looks
    like it holds one of those instead (_NOT_DATE_CONTEXT), prefers a line
    that actually says "date" over an incidental match elsewhere, and
    rejects a year outside a plausible receipt range so a stray match can't
    win just because nothing better was found. Returns None - not a guess -
    when nothing plausible turns up, so the caller's own default (today)
    applies instead of a wrong date silently winning.
    """
    this_year = _date.today().year
    candidates: list[tuple[bool, str]] = []

    for line in lines:
        if _NOT_DATE_CONTEXT.search(line):
            continue
        for pattern, order in _DATE_PATTERNS:
            m = pattern.search(line)
            if not m:
                continue
            d, mo, y = _date_from_match(order, *m.groups())
            if not (2015 <= y <= this_year + 1):
                continue
            try:
                iso = _date(y, mo, d).isoformat()
            except ValueError:
                continue
            candidates.append((bool(_DATE_KEYWORD.search(line)), iso))
            break   # one date per line is enough; move on

    if not candidates:
        return None
    candidates.sort(key=lambda c: not c[0])   # keyword-flagged lines first
    return candidates[0][1]


def _regex_extract(raw_text: str) -> dict:
    """The original, dependency-free extraction: dumb line-by-line
    heuristics, not a model. Used as-is when llm_receipt_parser isn't
    configured or fails, and still the thing _validate_and_score's math
    check treats identically to an LLM's output - neither source is
    trusted just because of where it came from.
    """
    lines = [l.strip() for l in raw_text.splitlines() if l.strip()]

    # First line that isn't the date/time stamp, a store/order/table/bill
    # number, or a table header ("Item", "Qty") many POS printouts lead
    # with instead of - or in addition to - an actual merchant name. Falls
    # back to the literal first line if every line looks like metadata,
    # since a bare guess still beats leaving the field empty.
    merchant = next(
        (l for l in lines if not _METADATA_LINE.search(l)
         and not _CODE_LINE.match(l)
         and not any(p.search(l) for p, _ in _DATE_PATTERNS)),
        lines[0] if lines else None,
    )

    total = subtotal = tax = None
    items: list[dict] = []

    for line in lines:
        # A bare date line ("12/09/2026") also matches the money pattern
        # (2026 reads as an amount) - skipped outright rather than treated
        # as either a total or a line item.
        if any(p.search(line) for p, _ in _DATE_PATTERNS):
            continue
        if _ROUNDING_WORDS.search(line):
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

    return {
        "merchant": merchant,
        "date": _parse_date(lines),
        "items": items,
        "subtotal": subtotal,
        "tax": tax,
        "total": total,
    }


def _validate_and_score(fields: dict) -> dict:
    """The Python validator, applied identically no matter which source
    (the LLM, or _regex_extract) produced `fields` - a fluent, confident
    LLM response is not automatically a correct one, so it earns its
    confidence score the exact same way a regex-derived read does.

    Four independent 25-point checks: a merchant name, at least one line
    item, a total, and the items (plus tax) actually summing close to
    that total. routers/receipts.py stops trying further OCR providers
    once this clears CONFIDENCE_THRESHOLD - a receipt that fails the math
    check is exactly the case where a second provider's read is worth the
    extra quota.
    """
    merchant = fields.get("merchant")
    items = list(fields.get("items") or [])
    subtotal = fields.get("subtotal")
    tax = fields.get("tax")
    total = fields.get("total")

    # No total at all - the word was misread, missing, spelled a way no
    # rule (or the LLM) recognised, or split across two lines. Rather than
    # leave the amount at nothing, the largest money amount found is
    # pulled out and used as a guess - true of virtually every receipt
    # shape that the biggest number on it is the total. Marked
    # `total_inferred` so confidence reflects that this is a guess, not a
    # labelled fact.
    total_inferred = False
    if total is None and items:
        largest = max(items, key=lambda i: i["amount"])
        items = [i for i in items if i is not largest]
        total = largest["amount"]
        total_inferred = True

    score = 0
    if merchant:
        score += 25
    if items:
        score += 25
    if total is not None:
        score += 10 if total_inferred else 25
    if total is not None and items and not total_inferred:
        # ₹2 or 5%, whichever is larger - generous on purpose, since OCR
        # reliably drops a digit or a decimal point long before it drops a
        # whole rupee, and this check exists to catch a genuinely wrong
        # read, not to penalise normal rounding.
        items_sum = sum(i["amount"] for i in items) + (tax or 0)
        if abs(items_sum - total) <= max(2.0, total * 0.05):
            score += 25
    elif total is not None and not total_inferred:
        # A total with nothing to check it against isn't wrong, just
        # unverified - worth something, not the full 25.
        score += 10

    return {
        "merchant": merchant,
        "date": fields.get("date"),
        "items": items,
        "subtotal": subtotal,
        "tax": tax,
        "total": total,
        # None from _regex_extract, which has no way to judge what a
        # receipt is actually for - only the LLM path sets this (see
        # llm_receipt_parser.py), constrained to AddExpense.jsx's own
        # CATEGORIES list rather than freeform text.
        "category": fields.get("category"),
        "confidence": score,
    }


def parse_receipt(raw_text: str) -> dict:
    """LLM extraction first (see llm_receipt_parser.py, GPT-OSS-120B via
    Groq) when GROQ_API_KEY is configured, falling back to the regex
    extractor above on any failure - not configured, a network error, or
    a malformed response. Either source's fields then go through the same
    _validate_and_score, and the raw OCR text always comes back alongside
    the structured guess so a wrong field is explainable by reading what
    the OCR provider actually returned, not guessed at from outside.
    """
    method = "regex"
    fields = None
    try:
        import llm_receipt_parser
        if llm_receipt_parser.available():
            fields = llm_receipt_parser.extract(raw_text)
            method = "llm"
    except Exception as e:
        print(f"[receipts] LLM extraction failed, falling back to regex: {e}")
        fields = None

    if fields is None:
        fields = _regex_extract(raw_text)
        method = "regex"

    result = _validate_and_score(fields)
    result["raw_text"] = raw_text
    result["extraction_method"] = method
    return result

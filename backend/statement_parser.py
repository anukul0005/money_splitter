"""A credit card statement's text, read by code - no AI.

Two parts, for any bank's layout (each prints the same things its own way):

  parse_summary(text)      the figures a statement leads with: total and
                           minimum due, due and statement dates, the billing
                           period, credit limit, previous balance, payments
                           and purchases. Found by their labels - the value
                           after the label, or, where a row of labels sits
                           over a row of values, the value in the label's
                           place.
  parse_transactions(text) every line that starts with a date and carries an
                           amount: date, description, amount, debit or
                           credit (a Cr/Dr mark, a sign, or what the line
                           says), and its kind.

Whether a reading is right is checked afterwards against the statement's
own totals (card_details.assemble / reconcile), and the statement's text is
kept with the bill so a layout this doesn't read yet can be fixed from it.
Only categorising the spends still uses AI (card_details._categorise).
"""
from __future__ import annotations

import re
from datetime import date

MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}
MONTHS["sept"] = 9

_MON = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*"
# A date as statements print one: 05/10/2026, 05-10-26, 05.10.2026, 2026-10-05,
# 05 Oct 2026, 05-Oct-26, 05Oct26, 05 Oct (the year then comes from the statement)
DATE = re.compile(
    r"(?<![\d/])(?:"
    r"(?P<y1>\d{4})-(?P<m1>\d{1,2})-(?P<d1>\d{1,2})"
    r"|(?P<d2>\d{1,2})[/.-](?P<m2>\d{1,2})[/.-](?P<y2>\d{4}|\d{2})"
    r"|(?P<m4>" + _MON + r")\s+(?P<d4>\d{1,2}),?\s+(?P<y4>\d{4})"
    r"|(?P<d3>\d{1,2})[\s/.-]*(?P<m3>" + _MON + r")[\s/.,'-]*(?P<y3>\d{4}|\d{2})?"
    r")(?![\d/])", re.I)
# A money amount with paise: 1,23,456.78 / 123456.78 / 1,234.5 is not one
AMOUNT = re.compile(r"(?<![\w.])-?(?:₹|rs\.?|inr)?\s*(\d{1,3}(?:,\d{2,3})+|\d+)\.(\d{2})(?![\d])(?!\s*%)", re.I)


def _to_date(m: re.Match, year_hint: int | None = None) -> str | None:
    g = m.groupdict()
    try:
        if g["y1"]:
            y, mo, d = int(g["y1"]), int(g["m1"]), int(g["d1"])
        elif g["d2"]:
            d, mo, y = int(g["d2"]), int(g["m2"]), int(g["y2"])
        elif g["m4"]:
            d, mo, y = int(g["d4"]), MONTHS.get(g["m4"][:4].lower(), MONTHS.get(g["m4"][:3].lower())), int(g["y4"])
        else:
            d, mo = int(g["d3"]), MONTHS.get(g["m3"][:4].lower(), MONTHS.get(g["m3"][:3].lower()))
            y = int(g["y3"]) if g["y3"] else year_hint
            if not mo or not y:
                return None
        if y < 100:
            y += 2000
        return date(y, mo, d).isoformat()
    except (TypeError, ValueError):
        return None


def _num(s: str) -> float:
    return float(s.replace(",", ""))


def _amounts(text: str) -> list[tuple[float, int, int]]:
    """(value, start, end) of every amount in the text."""
    return [(_num(f"{m.group(1)}.{m.group(2)}"), m.start(), m.end()) for m in AMOUNT.finditer(text)]


# ── the summary ──────────────────────────────────────────────────────────────
_LABELS = {
    "total_due": r"total\s*(?:payment\s*|amount\s*)?due|total\s*(?:amount\s*)?payable|total\s*outstanding|new\s*balance|closing\s*balance|amount\s*due",
    "minimum_due": r"min(?:imum)?\.?\s*(?:payment\s*|amount\s*)?(?:due|payable)",
    "due_date": r"(?:payment\s*)?due\s*date|pay\s*by(?:\s*date)?",
    "statement_date": r"statement\s*(?:generation\s*)?date|bill(?:ing)?\s*date",
    "credit_limit": r"(?:total\s*)?credit\s*limit",
    "available_limit": r"available\s*(?:credit\s*)?limit",
    "previous_balance": r"previous\s*(?:statement\s*)?(?:balance|dues)|opening\s*balance|last\s*statement\s*balance",
    "payments_credits": r"payments?\s*(?:/|&|and)?\s*(?:other\s*)?credits?|(?:total\s*)?payments?\s*received|credits?\s*(?:/|&)\s*payments?",
    "purchases_debits": r"purchases?\s*(?:/|&|and)?\s*(?:other\s*)?(?:debits?|charges)|(?:total\s*)?debits?|(?:total\s*)?purchases?",
    "fees_charges": r"fees?\s*(?:/|&|and)?\s*(?:other\s*)?charges|finance\s*charges",
}
_DATE_KEYS = {"due_date", "statement_date"}
_LABEL_RE = {k: re.compile(v, re.I) for k, v in _LABELS.items()}


def _first_after(text: str, key: str, start: int, want_date: bool, year_hint: int | None):
    window = text[start:start + 160]
    if want_date:
        m = DATE.search(window)
        return _to_date(m, year_hint) if m else None
    a = _amounts(window)
    return a[0][0] if a else None


def parse_summary(text: str) -> dict:
    out: dict = {k: None for k in list(_LABELS) + ["interest", "taxes", "period_from", "period_to", "reward_points"]}
    # A transaction line ("PAYMENT RECEIVED 12,000.00") is never where a summary figure is
    lines = [ln for ln in text.splitlines() if not _starts_with_date(ln)]
    text = "\n".join(lines)
    # A row of labels over a row of values: values by position
    for i, line in enumerate(lines[:-1]):
        if _amounts(line):
            continue                       # a row of labels has no amounts in it
        spans = sorted(((m.start(), m.end(), k) for k, rx in _LABEL_RE.items() for m in [rx.search(line)] if m),
                       key=lambda x: (x[0], -(x[1] - x[0])))
        found, end = [], -1
        for st, en, k in spans:            # overlapping labels ("Minimum Amount Due" holds "Amount Due"): the first, longest
            if st >= end:
                found.append((st, k))
                end = en
        if len(found) < 2:
            continue
        nxt = " ".join(lines[i + 1:i + 3])
        tokens = sorted([(m.start(), "date", m) for m in DATE.finditer(nxt)] +
                        [(s, "amount", v) for v, s, _ in _amounts(nxt)], key=lambda t: t[0])
        if len(tokens) < len(found):
            continue
        for (pos, key), (_, kind, val) in zip(found, tokens):
            if out[key] is not None:
                continue
            if key in _DATE_KEYS and kind == "date":
                out[key] = _to_date(val)
            elif key not in _DATE_KEYS and kind == "amount":
                out[key] = val
    # Otherwise the value right after its label
    for key, rx in _LABEL_RE.items():
        if out[key] is not None:
            continue
        for m in rx.finditer(text):
            v = _first_after(text, key, m.end(), key in _DATE_KEYS, None)
            if v is not None:
                out[key] = v
                break
    # The billing period: "01 Sep 2026 to 30 Sep 2026", "Statement Period: 01/09/2026 - 30/09/2026"
    pm = re.search(r"(?:statement|billing)\s*period[^\n]{0,20}?", text, re.I)
    seg = text[pm.end():pm.end() + 80] if pm else ""
    ds = [_to_date(m) for m in DATE.finditer(seg)]
    ds = [d for d in ds if d]
    if len(ds) >= 2:
        out["period_from"], out["period_to"] = ds[0], ds[1]
    rp = re.search(r"reward\s*points?[^\n\d]{0,40}([\d,]+)", text, re.I)
    if rp:
        try:
            out["reward_points"] = float(rp.group(1).replace(",", ""))
        except ValueError:
            pass
    return out


def card_last4(text: str) -> str | None:
    m = (re.search(r"(?:x{2,}|\*{2,}|•{2,})[\sx*•-]*(\d{4})\b", text, re.I)
         or re.search(r"ending\s*(?:with|in)?\s*(\d{4})\b", text, re.I))
    return m.group(1) if m else None


_SERIAL = re.compile(r"^\d{1,3}[.)]?\s+")


def _date_at_start(line: str):
    """The date a transaction line starts with - after a serial number ("1 07/09/2026 ...")."""
    m = DATE.match(line)
    if m:
        return m
    s = _SERIAL.match(line)
    return DATE.match(line, s.end()) if s else None


def _starts_with_date(line: str) -> bool:
    """A transaction line: a date first, an amount, and words between - not a
    row of summary values ("21 Oct 2026  09 Nov 2026  12,861.00  6,776.00")."""
    line = line.strip()
    if not (_date_at_start(line) and _amounts(line)):
        return False
    rest = AMOUNT.sub(" ", DATE.sub(" ", line))
    return bool(re.search(r"[A-Za-z]{3,}", re.sub(r"(?:dr|cr|rs|inr)", " ", rest, flags=re.I)))


# ── the transactions ─────────────────────────────────────────────────────────
_NOT_A_TXN = re.compile(r"opening\s*balance|closing\s*balance|previous\s*balance|total\s*(amount\s*)?due|minimum\s*(amount\s*)?due"
                        r"|statement\s*date|due\s*date|credit\s*limit|available\s*limit|^\s*total\b|sub\s*total", re.I)
_CREDIT_WORDS = re.compile(r"payment\s*(received|thank)|thank\s*you|received|refund|reversal|reversed|cash\s*back|cashback"
                           r"|waiver|waived|bbps|autopay|auto\s*debit\s*payment|neft\s*cr|imps\s*cr|credit\s*adj", re.I)
_KINDS = [
    ("payment", r"payment|thank\s*you|bbps|autopay|neft|imps"),
    ("refund", r"refund|reversal|reversed|waiver|waived"),
    ("cashback", r"cash\s*back|cashback"),
    ("interest", r"interest|finance\s*charge"),
    ("tax", r"\bgst\b|igst|cgst|sgst|\btax\b"),
    ("emi", r"\bemi\b|instal?ment|flexipay|merchant\s*emi"),
    ("fee", r"\bfee\b|fees|charges?\b|surcharge|late\s*payment|over\s*limit|annual"),
]
_FX = re.compile(r"\b(usd|eur|gbp|aed|sgd|jpy|aud|cad|chf|thb|hkd)\s*([\d,]+\.\d{2})", re.I)


def _kind(desc: str, credit: bool) -> str:
    for k, rx in _KINDS:
        if re.search(rx, desc, re.I):
            if credit and k in ("fee", "interest", "tax", "emi"):
                return "refund" if k != "emi" else "emi"
            if not credit and k in ("payment", "refund", "cashback"):
                continue
            return k
    return "other" if credit else "purchase"


def parse_transactions(text: str, year_hint: int | None = None) -> list[dict]:
    """Each line that starts with a date and has an amount. A line straight
    after one, with no date and no amount, is the rest of its description."""
    txns: list[dict] = []
    last = None
    pending = None                       # a dated line whose amount is on the next line
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            last = pending = None
            continue
        if pending is not None:
            if _amounts(line) and not _date_at_start(line):
                line = f"{pending} {line}"
            pending = None
        m = _date_at_start(line)
        amounts = _amounts(line)
        if m and not amounts and not _NOT_A_TXN.search(line):
            pending = line
            continue
        if not m or not amounts or _NOT_A_TXN.search(line):
            # a description that ran onto a second line
            if last is not None and not amounts and not DATE.search(line) and len(line) < 60 \
                    and re.search(r"[A-Za-z]{3}", line) and not re.search(r"page\s*\d|statement|continued", line, re.I):
                last["description"] = f"{last['description']} {line}"[:120]
            last = None if (m or amounts) else last
            continue
        when = _to_date(m, year_hint)
        rest_start = m.end()
        m2 = DATE.match(line[rest_start:].lstrip())          # a posting date beside the transaction date
        if m2:
            rest_start = len(line) - len(line[rest_start:].lstrip()) + m2.end()
        value, a_start, a_end = amounts[-1]
        tail = line[a_end:].strip().lower()
        head = line[:a_start].rstrip()
        desc = line[rest_start:a_start]
        fx = _FX.search(desc)
        if fx:
            desc = desc[:fx.start()] + desc[fx.end():]
        # drop the other amounts and long reference numbers from the description
        desc = AMOUNT.sub(" ", desc)
        desc = re.sub(r"\b\d{9,}\b", " ", desc)
        desc = re.sub(r"\s\d{1,5}\s*$", " ", desc)          # reward points printed before the amount
        desc = " ".join(desc.split()).strip(" -|:")
        if not desc:
            continue
        if tail.startswith(("cr", "c ")) or tail == "c" or head.endswith(("+", "Cr", "CR")) or line[a_start] == "-":
            credit = True
        elif tail.startswith(("dr", "d ")) or tail == "d":
            credit = False
        else:
            credit = bool(_CREDIT_WORDS.search(desc))
        t = {"date": when, "time": None, "description": desc[:120], "amount": abs(value),
             "type": "credit" if credit else "debit", "kind": _kind(desc, credit),
             "foreign_amount": _num(fx.group(2)) if fx else None,
             "currency": fx.group(1).upper() if fx else None}
        txns.append(t)
        last = t
    return txns


def extract(text: str) -> dict:
    """What the bill finder needs (card_bills.find_bill), from a statement or
    its email: the same fields statement_extractor gave, read by code."""
    s = parse_summary(text)
    bank = None
    for name in ("HDFC", "ICICI", "SBI", "Axis", "Kotak", "HSBC", "IDFC", "Yes Bank", "IndusInd", "RBL",
                 "American Express", "Standard Chartered", "AU ", "Jupiter", "OneCard", "BOB", "Federal"):
        if re.search(re.escape(name.strip()), text, re.I):
            bank = name.strip()
            break
    return {"bank": bank, "card_last4": card_last4(text), "statement_date": s["statement_date"],
            "due_date": s["due_date"], "total_due": s["total_due"], "minimum_due": s["minimum_due"]}

"""Reading a payment-app statement (PhonePe CSV, Google Pay PDF, ...) into
plain transaction rows.

Parsing only - deciding what to do with each row (create it, merge it into
an expense already entered by hand, skip it) is routers/expenses.py's
import endpoint, which needs the database.

Adding a statement type: write a parser taking the raw file bytes and
returning StatementTxn rows - raising ValueError when the file isn't its
format - and add it to FORMATS. parse_statement tries each in turn.
"""
from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from datetime import datetime


@dataclass
class StatementTxn:
    date: str          # ISO YYYY-MM-DD
    time: str | None   # HH:MM
    merchant: str
    txn_id: str
    kind: str          # "Debit" | "Credit"
    amount: float
    # The masked account/card the money moved from or to, e.g. "XXXX585552" -
    # what lets a payment to one of your own accounts be told from spending.
    instrument: str = ""
    source: str = "PhonePe"   # which app's statement this row came from


def own_accounts(txns: list[StatementTxn]) -> set[str]:
    """Trailing digits of every account and card this statement's owner
    pays from or receives into."""
    out = set()
    for t in txns:
        digits = t.instrument.lstrip("0123456789").lstrip("X*")
        if digits.isdigit() and len(digits) >= 4:
            out.add(digits)
    return out


def is_self_transfer(t: StatementTxn, own: set[str]) -> bool:
    """Money moved between the owner's own pockets, not spent: a wallet
    top-up, or a payment to a bare masked account number ("XXXX585552")
    that is one of their own instruments. A masked number that ISN'T one
    of theirs ("******0491") is someone else, so stays spending."""
    if t.merchant.lower().startswith(("wallet top-up", "self transfer")):
        return True
    m = t.merchant.strip()
    digits = m.lstrip("X*")
    return bool(digits) and digits.isdigit() and m[:1] in "X*" and digits in own


def time_bucket(hhmm: str | None) -> str | None:
    """The four-way label stored beside a transaction time, for analysis."""
    if not hhmm:
        return None
    hour = int(hhmm[:2])
    if hour < 6:
        return "00:00-06:00"
    if hour < 12:
        return "06:00-12:00"
    if hour < 18:
        return "12:00-18:00"
    return "18:00-24:00"


def _merchant(details: str) -> str:
    d = (details or "").strip()
    for prefix in ("Paid to ", "Received from "):
        if d.startswith(prefix):
            d = d[len(prefix):]
            break
    return d.strip() or "PhonePe payment"


def parse_phonepe_csv(raw: bytes) -> list[StatementTxn]:
    """Every transaction row of a PhonePe statement.

    The file leads with a couple of free-text lines ("Transaction
    Statement for ...", "Duration,...") before the real header, and its
    Time column carries a stray leading tab - so the header is located by
    content rather than assumed to be line one, and every cell is
    stripped. Raises ValueError when no header is found at all, i.e. this
    isn't a PhonePe statement.
    """
    text = raw.decode("utf-8-sig", errors="replace")
    rows = list(csv.reader(io.StringIO(text)))

    header_idx = next(
        (i for i, r in enumerate(rows)
         if len(r) >= 8 and r[0].strip().lower() == "date" and r[1].strip().lower() == "time"),
        None,
    )
    if header_idx is None:
        raise ValueError("This doesn't look like a PhonePe transaction statement.")

    txns: list[StatementTxn] = []
    for r in rows[header_idx + 1:]:
        if len(r) < 8 or not r[0].strip():
            continue
        date = r[0].strip()
        if len(date) != 10 or date[4] != "-":
            continue
        try:
            amount = float(r[7].replace(",", "").strip())
        except ValueError:
            continue
        t = r[1].strip()
        hhmm = t[:5] if len(t) >= 5 and t[2] == ":" else None
        txns.append(StatementTxn(
            date=date, time=hhmm, merchant=_merchant(r[2]),
            txn_id=r[3].strip(), kind=r[5].strip().title(), amount=round(amount, 2),
            instrument=r[6].strip(),
        ))
    return txns


def pdf_lines(raw: bytes) -> list[str]:
    """Every text line of a PDF, top to bottom, page after page.

    Built from the characters directly rather than pdfplumber's
    extract_text: Google Pay's PDFs give every glyph a width equal to its
    font size, so neighbouring words overlap and extract_text interleaves
    their letters ("PaitdoSwiggy"). Characters do come out in reading
    order, though, so a word is a run of them each starting where the last
    ended - a jump back (overlap) or a real gap starts the next word.
    Raises ValueError for a file that won't open (not a PDF, or locked).
    """
    import pdfplumber   # only needed here; the CSV path shouldn't pay for it

    try:
        pdf = pdfplumber.open(io.BytesIO(raw))
    except Exception as e:
        raise ValueError("Couldn't open that PDF - if it's password-protected, "
                         "save an unlocked copy and upload that.") from e
    out: list[str] = []
    with pdf:
        for page in pdf.pages:
            rows: dict[int, list[list]] = {}   # line's top -> [[x0, word], ...]
            prev = None
            for c in page.chars:
                top, ch = round(c["top"]), c["text"]
                if ch.isspace():
                    prev = None
                    continue
                if (prev is None or round(prev["top"]) != top
                        or c["x0"] < prev["x1"] - 0.5
                        or c["x0"] > prev["x1"] + 0.3 * c["size"]):
                    rows.setdefault(top, []).append([c["x0"], ch])
                else:
                    rows[top][-1][1] += ch
                prev = c
            out += [" ".join(w for _, w in sorted(words)) for _, words in sorted(rows.items())]
    return out


_GPAY_HEAD = re.compile(
    r"^(\d{2} [A-Z][a-z]{2}, \d{4}) (Paid to|Received from|Self transfer to) (.+?) ₹([\d,]+(?:\.\d+)?)$")
_GPAY_TIME = re.compile(r"^(\d{1,2}:\d{2} [AP]M)(?:.*?ID:\s*(\S+))?")
_GPAY_ACCOUNT = re.compile(r"^Paid (?:by|to) (.+)$")


def parse_gpay_pdf(raw: bytes) -> list[StatementTxn]:
    """Every transaction of a Google Pay statement PDF.

    Each one is three lines:
        01 Apr, 2026   Paid to Swiggy                        ₹150
        06:40 PM       UPI Transaction ID: 120917335595
                       Paid by Canara Bank 5644
    "Received from X" is a credit; "Self transfer to <bank> 4544" is money
    moved between the owner's own accounts, kept as a debit for
    is_self_transfer to skip. Raises ValueError when this isn't one.
    """
    if not raw.startswith(b"%PDF"):
        raise ValueError("Not a PDF.")
    lines = pdf_lines(raw)
    if not any("Google Pay" in ln for ln in lines):
        raise ValueError("This PDF isn't a Google Pay statement.")

    txns: list[StatementTxn] = []
    cur: StatementTxn | None = None
    for ln in lines:
        head = _GPAY_HEAD.match(ln)
        if head:
            day, how, who, amount = head.groups()
            merchant = f"Self transfer to {who}" if how == "Self transfer to" else who
            cur = StatementTxn(
                date=datetime.strptime(day, "%d %b, %Y").date().isoformat(), time=None,
                merchant=merchant, txn_id="", amount=round(float(amount.replace(",", "")), 2),
                kind="Credit" if how == "Received from" else "Debit", source="Google Pay",
            )
            txns.append(cur)
            continue
        if cur is None:
            continue
        tm = _GPAY_TIME.match(ln)
        if tm and cur.time is None:
            cur.time = datetime.strptime(tm.group(1), "%I:%M %p").strftime("%H:%M")
            cur.txn_id = tm.group(2) or ""
            continue
        acct = _GPAY_ACCOUNT.match(ln)
        if acct and not cur.instrument:
            # "Canara Bank 5644" -> "XXXX5644", the masked form own_accounts reads.
            digits = re.findall(r"\d{4,}", acct.group(1))
            cur.instrument = f"XXXX{digits[-1]}" if digits else acct.group(1)
            cur = None   # this transaction is complete; footers and headers follow
    if not txns:
        raise ValueError("No transactions found in this Google Pay statement.")
    return txns


# Every statement type the import understands, tried in order.
FORMATS = [
    ("Google Pay", parse_gpay_pdf),
    ("PhonePe", parse_phonepe_csv),
]


def parse_statement(raw: bytes) -> tuple[str, list[StatementTxn]]:
    """(app name, transactions) for a statement file of any known type."""
    is_pdf = raw.startswith(b"%PDF")
    for name, parse in FORMATS:
        try:
            return name, parse(raw)
        except ValueError as e:
            # A PDF that wouldn't open says so, rather than "unsupported".
            if is_pdf and isinstance(e.__cause__, Exception):
                raise
            continue
    names = ", ".join(n for n, _ in FORMATS)
    raise ValueError(f"This file isn't a statement type the app can read yet (supported: {names}).")

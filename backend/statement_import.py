"""Reading a PhonePe transaction statement CSV into plain transaction rows.

Parsing only - deciding what to do with each row (create it, merge it into
an expense already entered by hand, skip it) is routers/expenses.py's
import endpoint, which needs the database.
"""
from __future__ import annotations

import csv
import io
from dataclasses import dataclass


@dataclass
class StatementTxn:
    date: str          # ISO YYYY-MM-DD
    time: str | None   # HH:MM
    merchant: str
    txn_id: str
    kind: str          # "Debit" | "Credit"
    amount: float


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
        ))
    return txns

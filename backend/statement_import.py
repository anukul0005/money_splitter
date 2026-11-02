"""Reading a payment-app statement (PhonePe CSV/PDF, Google Pay PDF, Paytm PDF, or a
CSV / Excel table - Paytm's .xlsx, locked or not) into plain transaction rows.

Parsing only - deciding what to do with each row (create it, merge it into
an expense already entered by hand, skip it) is routers/expenses.py's
import endpoint, which needs the database.

Adding a statement type: write a parser returning StatementTxn rows and
raising ValueError when the file isn't its format, and add it to
PDF_FORMATS (it gets the PDF's text lines - see pdf_lines) or CSV_FORMATS
(it gets the raw bytes). parse_statement tries each of the matching kind.
"""
from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Callable


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


class StatementLocked(ValueError):
    """The PDF is password-protected and no password, or the wrong one,
    was given - the caller should ask for it and try again."""

    def __init__(self, wrong: bool):
        self.wrong = wrong
        super().__init__("That password didn't open the PDF - check it and try again." if wrong
                         else "This PDF is password-protected. Enter its password to import it.")


def pdf_lines(raw: bytes, password: str | None = None,
              progress: Callable[[int, int], None] | None = None) -> list[str]:
    """Every text line of a PDF, top to bottom, page after page.

    Built from the characters directly rather than pdfplumber's
    extract_text: Google Pay's PDFs give every glyph a width equal to its
    font size, so neighbouring words overlap and extract_text interleaves
    their letters ("PaitdoSwiggy"). Characters do come out in reading
    order, though, so a word is a run of them each starting where the last
    ended - a jump back (overlap) or a real gap starts the next word.
    `password` opens a locked statement (banks and PhonePe email them that
    way); it's used for this read only, never stored. `progress(done,
    total)` is called after each page. Raises StatementLocked when the PDF
    needs a password it wasn't given, ValueError when it won't open at all.
    """
    import pdfplumber   # only needed here; the CSV path shouldn't pay for it
    from pdfminer.pdfdocument import PDFPasswordIncorrect

    try:
        pdf = pdfplumber.open(io.BytesIO(raw), password=password or "")
    except PDFPasswordIncorrect:
        raise StatementLocked(wrong=bool(password)) from None
    except Exception as e:
        raise ValueError("Couldn't open that PDF - it may be damaged.") from e
    out: list[str] = []
    with pdf:
        total = len(pdf.pages)
        for n, page in enumerate(pdf.pages, 1):
            words: list[list] = []   # [baseline, x0, text]
            prev = None
            for c in page.chars:
                ch = c["text"]
                if ch.isspace():
                    prev = None
                    continue
                # A gap of more than ~a sixth of the font size is a space
                # the PDF didn't spell out as a character.
                if (prev is None or abs(prev["bottom"] - c["bottom"]) > 1
                        or c["x0"] < prev["x1"] - 0.5
                        or c["x0"] > prev["x1"] + 0.15 * c["size"]):
                    words.append([c["bottom"], c["x0"], ch])
                else:
                    words[-1][2] += ch
                prev = c
            out += _rows(words)
            page.close()   # a 600-page statement must not hold every page in memory
            if progress:
                progress(n, total)
    return out


def _rows(words: list[list]) -> list[str]:
    """Words into lines, top to bottom: a line is every word whose baseline
    is within 3pt of the line's first - text in two font sizes on one row
    (a bold name beside a small grey label) sits a point or two apart."""
    lines: list[list] = []   # [baseline, [(x0, text), ...]]
    for base, x0, text in sorted(words):
        if lines and base - lines[-1][0] <= 3:
            lines[-1][1].append((x0, text))
        else:
            lines.append([base, [(x0, text)]])
    return [" ".join(t for _, t in sorted(ws)) for _, ws in lines]


_GPAY_HEAD = re.compile(
    r"^(\d{2} [A-Z][a-z]{2}, \d{4}) (Paid to|Received from|Self transfer to) (.+?) ₹([\d,]+(?:\.\d+)?)$")
_GPAY_TIME = re.compile(r"^(\d{1,2}:\d{2} [AP]M)(?:.*?ID:\s*(\S+))?")
_GPAY_ACCOUNT = re.compile(r"^Paid (?:by|to) (.+)$")


def parse_gpay_pdf(lines: list[str]) -> list[StatementTxn]:
    """Every transaction of a Google Pay statement PDF, from its pdf_lines.

    Each one is three lines:
        01 Apr, 2026   Paid to Swiggy                        ₹150
        06:40 PM       UPI Transaction ID: 120917335595
                       Paid by Canara Bank 5644
    "Received from X" is a credit; "Self transfer to <bank> 4544" is money
    moved between the owner's own accounts, kept as a debit for
    is_self_transfer to skip. Raises ValueError when this isn't one.
    """
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


_PP_HEAD = re.compile(
    r"^([A-Z][a-z]{2} \d{1,2}, \d{4}) (.+?) (Debit|Credit) INR ?([\d,]+(?:\.\d+)?)$")
_PP_TIME = re.compile(r"^(\d{1,2}:\d{2} ?[AP]M)\b")
_PP_TXN_ID = re.compile(r"Transaction ID ?: ?(\S+)")
_PP_ACCOUNT = re.compile(r"^(?:Debited from|Credited to) (\S+)")


def parse_phonepe_pdf(lines: list[str]) -> list[StatementTxn]:
    """Every transaction of a PhonePe statement PDF, from its pdf_lines.

    Each one is a block:
        Feb 14, 2018   Paid to KFC                              Debit  INR 165.00
        07:36 PM       Transaction ID : C1802141935589772477972
                       UTR No : 804538670227
                       Debited from XX0908 INR 164.70 | Wallet INR 0.30
    The Transaction ID is the same one PhonePe's CSV carries, so a payment
    imported from either is recognised by the other. Raises ValueError
    when this isn't one.
    """
    if not any(ln.startswith("Transaction Statement for") for ln in lines) \
            or not any("UTR No" in ln for ln in lines):
        raise ValueError("This PDF isn't a PhonePe statement.")

    txns: list[StatementTxn] = []
    cur: StatementTxn | None = None
    for ln in lines:
        head = _PP_HEAD.match(ln)
        if head:
            day, details, kind, amount = head.groups()
            cur = StatementTxn(
                date=datetime.strptime(day, "%b %d, %Y").date().isoformat(), time=None,
                merchant=_merchant(details), txn_id="", kind=kind,
                amount=round(float(amount.replace(",", "")), 2), source="PhonePe",
            )
            txns.append(cur)
            continue
        if cur is None:
            continue
        tm = _PP_TIME.match(ln)
        if tm and cur.time is None:
            cur.time = datetime.strptime(tm.group(1).replace(" ", ""), "%I:%M%p").strftime("%H:%M")
        tid = _PP_TXN_ID.search(ln)
        if tid and not cur.txn_id:
            cur.txn_id = tid.group(1)
        acct = _PP_ACCOUNT.match(ln)
        if acct and not cur.instrument:
            cur.instrument = acct.group(1)   # "XX5552", or "Wallet"
            cur = None   # this transaction is complete
    if not txns:
        raise ValueError("No transactions found in this PhonePe statement.")
    return txns


_PAYTM_PERIOD = re.compile(r"(\d{2}) ([A-Z]{3})'(\d{2}) - (\d{2}) ([A-Z]{3})'(\d{2})")
_PAYTM_HEAD = re.compile(r"^(\d{2}) ([A-Z][a-z]{2}) (.+?) ([+-]) Rs\.\s?([\d,]+(?:\.\d+)?)$")
_PAYTM_TIME = re.compile(r"^(\d{1,2}:\d{2} [AP]M)\b")
_PAYTM_REF = re.compile(r"UPI Ref No:\s*(\d+)")
_PAYTM_PREFIXES = ("Paid to ", "Money sent to ", "Money received from ", "Received from ")


def _paytm_name(details: str) -> str:
    """The payee out of a Paytm row's mixed-up first line: its columns are
    printed side by side, so the name runs into "Tag: ..." / "Note: ..."
    and the account. "Recharge for Delhi Metro Card Number" -> "Delhi
    Metro recharge"."""
    name = re.split(r" (?:Tag|Note):", details, maxsplit=1)[0].strip()
    for p in _PAYTM_PREFIXES:
        if name.startswith(p):
            name = name[len(p):]
            break
    m = re.match(r"^Recharge for (.+?)(?: Card Number)?$", name)
    if m:
        name = f"{m.group(1)} recharge"
    return name.strip() or "Paytm payment"


def parse_paytm_pdf(lines: list[str]) -> list[StatementTxn]:
    """Every transaction of a Paytm UPI statement PDF, from its pdf_lines.

    Each one is a block of four or more lines, the columns run together:
        28 Sep Paid to DOTPE Tag: Union Bank - Rs.82.96
        3:15 PM
        UPI ID: paytm-52165157@ptybl on # Food Of India - 94
        UPI Ref No: 299914731403
    Rows carry no year: it comes from the statement's period ("19 OCT'25 -
    18 OCT'26"), which is at most a year long. "-" is money paid, "+"
    received. A payment to a ccbillpayment UPI id is a credit card bill,
    named so the import skips it as a repayment. Raises ValueError when
    this isn't one.
    """
    if not any("Paytm Statement for" in ln for ln in lines) \
            or not any("UPI Ref No" in ln for ln in lines):
        raise ValueError("This PDF isn't a Paytm statement.")
    period = next((m for m in map(_PAYTM_PERIOD.search, lines[:12]) if m), None)
    if period is None:
        raise ValueError("Couldn't find this Paytm statement's period.")
    end = datetime.strptime(f"{period.group(4)} {period.group(5).title()} {period.group(6)}", "%d %b %y").date()

    txns: list[StatementTxn] = []
    card_bills: set[int] = set()
    cur: StatementTxn | None = None
    for ln in lines:
        head = _PAYTM_HEAD.match(ln)
        if head:
            day, mon, details, sign, amount = head.groups()
            d = datetime.strptime(f"{day} {mon} {end.year}", "%d %b %Y").date()
            if d > end:
                d = d.replace(year=end.year - 1)
            cur = StatementTxn(
                date=d.isoformat(), time=None, merchant=_paytm_name(details), txn_id="",
                kind="Credit" if sign == "+" else "Debit",
                amount=round(float(amount.replace(",", "")), 2), source="Paytm",
            )
            txns.append(cur)
            continue
        if cur is None:
            continue
        tm = _PAYTM_TIME.match(ln)
        if tm and cur.time is None:
            cur.time = datetime.strptime(tm.group(1), "%I:%M %p").strftime("%H:%M")
        ref = _PAYTM_REF.search(ln)
        if ref and not cur.txn_id:
            cur.txn_id = ref.group(1)
        if "ccbillpayment" in ln.lower().replace(" ", ""):
            card_bills.add(id(cur))
    for t in txns:
        if id(t) in card_bills:
            t.merchant = f"Credit card bill via {t.merchant}"
    if not txns:
        raise ValueError("No transactions found in this Paytm statement.")
    return txns


# ── Tables: a CSV or Excel statement laid out as columns ────────────────────
# Paytm's Excel statement, and CSVs other than PhonePe's own layout: the
# header row is found by its names (a date column and an amount, or debit /
# credit, column) and each column is read by what it's called.

_COLS = {
    "date": re.compile(r"^(txn |transaction |value )?date", re.I),
    "time": re.compile(r"^(txn |transaction )?time", re.I),
    "details": re.compile(r"transaction details|^details|description|narration|particulars|^activity|source/destination"
                          r"|paid to|merchant|^name", re.I),
    "ref": re.compile(r"upi ref|utr|transaction id|txn id|reference|ref\.? ?no", re.I),
    "amount": re.compile(r"^amount", re.I),
    "debit": re.compile(r"debit|withdrawal|paid out", re.I),
    "credit": re.compile(r"credit|deposit|received", re.I),
    "type": re.compile(r"^type$|dr ?/ ?cr|^cr ?/ ?dr|transaction type", re.I),
    "status": re.compile(r"^status", re.I),
    "account": re.compile(r"your account|^account|instrument", re.I),
}
_DATE_FORMATS = ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d/%m/%y", "%d-%m-%y", "%d %b %Y", "%d %b %y", "%b %d, %Y",
                 "%d %B %Y", "%d-%b-%Y", "%d-%b-%y", "%d.%m.%Y")
_TIME = re.compile(r"(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?")


def _cell_date(v: str) -> tuple[str, str | None] | None:
    """(ISO date, HH:MM or None) from a date cell, which may carry the time too."""
    s = str(v or "").strip()
    if not s:
        return None
    t = _TIME.search(s[8:]) if len(s) > 8 else None
    hhmm = None
    if t:
        h, m, ap = int(t.group(1)), int(t.group(2)), (t.group(3) or "").lower()
        h = h % 12 + (12 if ap == "pm" else 0) if ap else h
        hhmm = f"{h:02d}:{m:02d}"
        s = s[:8 + t.start()].strip(" ,T")
    for f in _DATE_FORMATS:
        try:
            return datetime.strptime(s, f).date().isoformat(), hhmm
        except ValueError:
            continue
    return None


def _cell_time(v: str) -> str | None:
    t = _TIME.search(str(v or ""))
    if not t:
        return None
    h, m, ap = int(t.group(1)), int(t.group(2)), (t.group(3) or "").lower()
    if ap:
        h = h % 12 + (12 if ap == "pm" else 0)
    return f"{h:02d}:{m:02d}" if h < 24 else None


def _num(v) -> float | None:
    s = re.sub(r"[₹,\s]|Rs\.?|INR", "", str(v or ""), flags=re.I)
    if s in ("", "-", "+"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_table(rows: list[list[str]], source: str) -> list[StatementTxn]:
    """Every transaction of a statement laid out as a table. Raises
    ValueError when no header row with a date and an amount is found."""
    head, cols = None, {}
    for i, r in enumerate(rows[:40]):
        names = [str(c or "").strip() for c in r]
        found = {}
        for k, rx in _COLS.items():
            j = next((j for j, n in enumerate(names) if n and rx.search(n) and j not in found.values()), None)
            if j is not None:
                found[k] = j
        if "date" in found and ("amount" in found or "debit" in found):
            head, cols = i, found
            break
    if head is None:
        raise ValueError("No statement table found.")
    get = lambda r, k: (str(r[cols[k]]).strip() if k in cols and cols[k] < len(r) and r[cols[k]] is not None else "")
    txns = []
    for r in rows[head + 1:]:
        d = _cell_date(get(r, "date"))
        if not d:
            continue
        if re.search(r"fail|pending|declin|revers", get(r, "status"), re.I):
            continue
        details = get(r, "details")
        kind, amount = None, None
        if "debit" in cols or "credit" in cols:
            dr, cr = _num(get(r, "debit")), _num(get(r, "credit"))
            if dr:
                kind, amount = "Debit", abs(dr)
            elif cr:
                kind, amount = "Credit", abs(cr)
        if amount is None:
            raw_amt = get(r, "amount")
            a = _num(raw_amt)
            if not a:
                continue
            ty = get(r, "type").lower()
            if ty.startswith(("dr", "debit", "paid", "sent")) or raw_amt.lstrip().startswith("-"):
                kind = "Debit"
            elif ty.startswith(("cr", "credit", "receiv")) or raw_amt.lstrip().startswith("+"):
                kind = "Credit"
            else:
                kind = "Credit" if re.match(r"(received|money received|refund|cashback)", details, re.I) else "Debit"
            amount = abs(a)
        merchant = re.sub(r"^(paid to|money sent to|sent to|received from|money received from|payment to)\s+", "",
                          details, flags=re.I).strip() or f"{source} payment"
        txns.append(StatementTxn(date=d[0], time=_cell_time(get(r, "time")) or d[1], merchant=merchant[:200],
                                 txn_id=get(r, "ref").lstrip("'"), kind=kind, amount=round(amount, 2),
                                 instrument=get(r, "account"), source=source))
    if not txns:
        raise ValueError("No transactions found in this statement.")
    return txns


def _guess_source(text: str) -> str:
    low = text.lower()
    for key, name in (("paytm", "Paytm"), ("phonepe", "PhonePe"), ("google pay", "Google Pay"), ("gpay", "Google Pay")):
        if key in low:
            return name
    return "Statement"


def parse_csv_table(raw: bytes) -> list[StatementTxn]:
    text = raw.decode("utf-8-sig", errors="replace")
    return parse_table(list(csv.reader(io.StringIO(text))), _guess_source(text[:4000]))


_OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"      # a password-protected .xlsx (or an old .xls)


def _unlock_office(raw: bytes, password: str | None) -> bytes:
    """A locked Excel file, opened with its password. Raises StatementLocked
    without one or with the wrong one, ValueError for an old unlocked .xls."""
    try:
        import msoffcrypto
    except ImportError:
        raise ValueError("Password-protected Excel files can't be opened on this server yet.")
    f = msoffcrypto.OfficeFile(io.BytesIO(raw))
    try:
        if not f.is_encrypted():
            raise ValueError("Old .xls files aren't supported - save it as .xlsx or CSV.")
    except ValueError:
        raise
    except Exception:
        raise ValueError("This Excel file couldn't be read.")
    if not password:
        raise StatementLocked(wrong=False)
    out = io.BytesIO()
    try:
        f.load_key(password=password)
        f.decrypt(out)
    except Exception:
        raise StatementLocked(wrong=True)
    return out.getvalue()


def xlsx_rows(raw: bytes) -> list[list[list[str]]]:
    """Each sheet of an .xlsx as rows of text cells (dates as YYYY-MM-DD HH:MM)."""
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    sheets = []
    for ws in wb.worksheets:
        rows = []
        for r in ws.iter_rows(values_only=True):
            rows.append(["" if c is None else c.strftime("%Y-%m-%d %H:%M") if isinstance(c, datetime)
                         else c.isoformat() if hasattr(c, "isoformat") else str(c) for c in r])
        sheets.append(rows)
    return sheets


# Every statement type the import understands, tried in order.
PDF_FORMATS: list[tuple[str, Callable[[list[str]], list[StatementTxn]]]] = [
    ("Google Pay", parse_gpay_pdf),
    ("PhonePe", parse_phonepe_pdf),
    ("Paytm", parse_paytm_pdf),
]
CSV_FORMATS: list[tuple[str, Callable[[bytes], list[StatementTxn]]]] = [
    ("PhonePe", parse_phonepe_csv),
    ("", parse_csv_table),            # named from the file - see _guess_source
]


def parse_statement(raw: bytes, password: str | None = None,
                    progress: Callable[[int, int], None] | None = None,
                    bank_llm: bool | Callable[[list[str]], bool] = True,
                    ) -> tuple[str, list[StatementTxn]]:
    """(app name, transactions) for a statement file of any known type.
    Raises StatementLocked for a locked PDF without its password (see
    pdf_lines), ValueError for anything it can't read. `bank_llm` says
    whether a PDF of no known layout goes to the (slow) AI bank-statement
    reader - or, as a function of its text lines, whether this one does."""
    if raw.startswith(_OLE):
        raw = _unlock_office(raw, password)
    if raw.startswith(b"PK\x03\x04"):                 # an Excel (.xlsx) statement
        try:
            sheets = xlsx_rows(raw)
        except Exception:
            raise ValueError("This Excel file couldn't be read.")
        for rows in sheets:
            try:
                txns = parse_table(rows, _guess_source(" ".join(" ".join(r) for r in rows[:15])))
                return txns[0].source, txns
            except ValueError:
                continue
        raise ValueError("No statement table found in this Excel file.")
    if raw.startswith(b"%PDF"):
        lines = pdf_lines(raw, password, progress)
        attempts = [(name, lambda f=f: f(lines)) for name, f in PDF_FORMATS]
    else:
        attempts = [(name, lambda f=f: f(raw)) for name, f in CSV_FORMATS]
    for name, run in attempts:
        try:
            txns = run()
            return name or txns[0].source, txns
        except ValueError:
            continue
    if raw.startswith(b"%PDF") and (bank_llm(lines) if callable(bank_llm) else bank_llm):
        # Not a payment app's: any bank's account statement, read by the LLM
        # (bank_statement_llm) - the reading then shows as the bar's progress.
        import bank_statement_llm
        txns = bank_statement_llm.parse_bank_pdf(lines, progress)
        return txns[0].source, txns
    names = ", ".join([f"{n} PDF" for n, _ in PDF_FORMATS] + [f"{n} CSV" for n, _ in CSV_FORMATS])
    raise ValueError(f"This file isn't a statement type the app can read yet (supported: {names}, bank statement PDFs).")

"""
Seed Supabase with historical data from Expenditure.xlsx.
Usage:
    cd backend
    python seed.py
"""

import os
import re
import datetime
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

import openpyxl
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from models import Group, Member, Expense

XLSX_PATH = Path(__file__).parent.parent / "Expenditure.xlsx"

engine = create_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)
Session = sessionmaker(bind=engine)

# ── Group / sheet config (Sheet2 and Bike excluded per user request) ──────────
SHEET_META = {
    "Sheet1": {
        "name": "Friends Outings (Mar 25)",
        "emoji": "",
        "description": "Ajay, Anukul & Anubhav – Mar to Jun 2025",
        "members": ["Ajay", "Anukul", "Anubhav"],
    },
    "Sheet4": {
        "name": "Anubhav & Me (Mar 25)",
        "emoji": "",
        "description": "Anubhav & Anukul – Mar to Jun 2025",
        "members": ["Anubhav", "Anukul"],
    },
    "Sheet5": {
        "name": "Mumbai Trip (Oct 25)",
        "emoji": "",
        "description": "Anukul, Apoorv & Akshat – 2025",
        "members": ["Anukul", "Apoorv", "Akshat"],
    },
    "Sheet6": {
        "name": "Mumbai with Apoorv (Jan 25)",
        "emoji": "",
        "description": "Apoorv & Anukul – Jan–Feb 2025",
        "members": ["Apoorv", "Anukul"],
    },
    "Sheet8": {
        "name": "Mumbai + Diwali Trip (Oct 25)",
        "emoji": "",
        "description": "Anubhav & Anukul – Oct–Nov 2025",
        "members": ["Anubhav", "Anukul"],
    },
}


# ── Parsers ───────────────────────────────────────────────────────────────────

def _parse_amount(value) -> float | None:
    """Parse a cell value that may be a number, a plain string, or an Excel
    formula string like '=830', '=205+35+180', '=(10150/5)*3'."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if not s:
        return None
    # Strip leading '='
    expr = s[1:] if s.startswith("=") else s
    # Skip cell-reference formulas (contain letters: D2, F3, etc.)
    if re.search(r"[A-Za-z]", expr):
        return None
    try:
        result = eval(expr, {"__builtins__": {}}, {})  # safe: no builtins
        return float(result)
    except Exception:
        return None


def _parse_date(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, (datetime.datetime, datetime.date)):
        return (value if isinstance(value, datetime.date) else value.date()).strftime("%Y-%m-%d")
    raw = str(value).strip()
    for fmt in ("%d-%m-%y", "%d-%m-%Y", "%d/%m/%Y", "%d/%m/%y"):
        try:
            return datetime.datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None  # unparseable — store as NULL


def _load_expenses(ws, members: list[str]) -> list[dict]:
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return []

    header = [str(c).strip().lower() if c else "" for c in rows[0]]

    def col(name: str) -> int | None:
        for i, h in enumerate(header):
            if name in h:
                return i
        return None

    ci_date   = col("date")
    ci_type   = col("type")
    ci_title  = col("title")
    ci_amount = col("amount")
    ci_name   = col("name")
    ci_div    = col("divider")

    skip_names = {"none", "paid", "p.p", "indivdual", "individual", "total"}

    expenses = []
    for row in rows[1:]:
        if all(v is None for v in row):
            continue

        amount = _parse_amount(row[ci_amount] if ci_amount is not None else None)
        if amount is None or amount <= 0:
            continue

        raw_name = row[ci_name] if ci_name is not None else None
        paid_by  = str(raw_name).strip() if raw_name else ""
        if not paid_by or paid_by.lower() in skip_names:
            continue

        div_raw  = row[ci_div] if ci_div is not None else None
        div_val  = _parse_amount(div_raw)
        divider  = max(1, int(div_val)) if div_val and div_val >= 1 else len(members)
        individual = round(amount / divider, 2)

        expenses.append({
            "date":              _parse_date(row[ci_date] if ci_date is not None else None),
            "category":          str(row[ci_type]).strip() if ci_type is not None and row[ci_type] else None,
            "title":             str(row[ci_title]).strip() if ci_title is not None and row[ci_title] else None,
            "amount":            round(amount, 2),
            "paid_by":           paid_by,
            "divider":           divider,
            "individual_amount": individual,
        })

    return expenses


# ── Main ──────────────────────────────────────────────────────────────────────

def seed():
    wb = openpyxl.load_workbook(XLSX_PATH, data_only=False)
    db = Session()

    total = 0
    try:
        for sheet_name, meta in SHEET_META.items():
            if sheet_name not in wb.sheetnames:
                print(f"  skip {sheet_name} (sheet not found in workbook)")
                continue

            # Idempotent – skip if group already exists
            if db.query(Group).filter_by(name=meta["name"]).first():
                print(f"  skip '{meta['name']}' (already in DB)")
                continue

            print(f"\nSeeding {sheet_name} -> '{meta['name']}'")

            grp = Group(
                name=meta["name"],
                description=meta["description"],
                emoji=meta["emoji"],
                is_historical=True,
            )
            db.add(grp)
            db.flush()

            for name in meta["members"]:
                db.add(Member(group_id=grp.id, name=name))

            expenses = _load_expenses(wb[sheet_name], meta["members"])
            for e in expenses:
                db.add(Expense(group_id=grp.id, **e))

            total += len(expenses)
            print(f"  {len(meta['members'])} members, {len(expenses)} expenses")

        db.commit()
        print(f"\nDone. {total} expenses imported across {len(SHEET_META)} groups.")

    except Exception as exc:
        db.rollback()
        print(f"Error: {exc}")
        raise
    finally:
        db.close()


if __name__ == "__main__":
    seed()

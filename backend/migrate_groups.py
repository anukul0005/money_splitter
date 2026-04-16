"""
Migration script:
  1. Rename existing groups to include (Mon YY) format
  2. Add Shimla Trip (Apr 25) from the CSV

Usage:
    cd backend
    python migrate_groups.py
"""

import os, csv, datetime
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from models import Group, Member, Expense

CSV_PATH = Path(__file__).parent.parent / "Trip Fare- 18,19,20 - Sheet1.csv"

engine = create_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)
Session = sessionmaker(bind=engine)

# ── 1. Rename existing groups ─────────────────────────────────────────────────
RENAMES = {
    "Friends Outings":        "Friends Outings (Mar 25)",
    "Anubhav & Me":           "Anubhav & Me (Mar 25)",
    "Mumbai Trip":            "Mumbai Trip (Apr 25)",
    "Mumbai with Apoorv":     "Mumbai with Apoorv (Jan 25)",
    "Mumbai + Diwali Trip":   "Mumbai + Diwali Trip (Oct 25)",
}

# ── 2. Shimla Trip config ─────────────────────────────────────────────────────
SHIMLA_NAME    = "Shimla Trip (Apr 25)"
SHIMLA_MEMBERS = ["Ajay", "Anukul", "Anubhav", "Renu", "Shubhi"]


def parse_date(s: str):
    s = s.strip()
    for fmt in ("%d-%m-%y", "%d-%m-%Y", "%d/%m/%Y", "%d/%m/%y"):
        try:
            return datetime.datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def load_shimla_expenses():
    expenses = []
    with open(CSV_PATH, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            date_raw = row.get("Date", "").strip()
            date = parse_date(date_raw)
            if not date:
                continue  # skip summary rows

            try:
                amount = float(row.get("Amount", "").strip().replace(",", "") or 0)
            except ValueError:
                continue
            if amount <= 0:
                continue

            paid_by = row.get("Name", "").strip()
            if not paid_by or paid_by.lower() in {"none", "paid", "total"}:
                continue

            try:
                divider = int(float(row.get("Divider", "").strip() or 0))
            except ValueError:
                divider = 0
            if divider < 1:
                divider = len(SHIMLA_MEMBERS)

            individual = round(amount / divider, 2)
            category = row.get("type", "").strip() or None
            title    = row.get("Title", "").strip() or None

            expenses.append({
                "date":              date,
                "category":          category,
                "title":             title,
                "amount":            round(amount, 2),
                "paid_by":           paid_by,
                "divider":           divider,
                "individual_amount": individual,
            })
    return expenses


def main():
    db = Session()
    try:
        # ── Step 1: rename existing groups ──────────────────────────────────
        renamed = 0
        for old_name, new_name in RENAMES.items():
            grp = db.query(Group).filter_by(name=old_name).first()
            if grp:
                grp.name = new_name
                print(f"  Renamed: '{old_name}' -> '{new_name}'")
                renamed += 1
            else:
                # might already be renamed or not yet seeded
                exists_new = db.query(Group).filter_by(name=new_name).first()
                if exists_new:
                    print(f"  Already renamed: '{new_name}'")
                else:
                    print(f"  Not found (skipped): '{old_name}'")

        # ── Step 2: add Shimla Trip ──────────────────────────────────────────
        existing = db.query(Group).filter_by(name=SHIMLA_NAME).first()
        if existing:
            print(f"\n  Shimla Trip already exists — skipping insert")
        else:
            print(f"\n  Adding '{SHIMLA_NAME}'...")
            grp = Group(
                name=SHIMLA_NAME,
                description="Ajay, Anukul, Anubhav, Renu & Shubhi – Apr 2025",
                emoji="",
                is_historical=True,
            )
            db.add(grp)
            db.flush()

            for name in SHIMLA_MEMBERS:
                db.add(Member(group_id=grp.id, name=name))

            expenses = load_shimla_expenses()
            for e in expenses:
                db.add(Expense(group_id=grp.id, **e))

            print(f"  {len(SHIMLA_MEMBERS)} members, {len(expenses)} expenses added")

        db.commit()
        print(f"\nDone. {renamed} group(s) renamed.")

    except Exception as exc:
        db.rollback()
        print(f"Error: {exc}")
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()

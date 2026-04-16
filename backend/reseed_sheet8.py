"""
Delete and re-seed 'Mumbai + Diwali Trip (Oct 25)' from Sheet8,
now properly encoding gentleman's agreement splits as split_json.

Usage:
    cd backend
    python reseed_sheet8.py
"""
import os, sys
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from models import Group, Member, Expense

sys.path.insert(0, str(Path(__file__).parent))
from seed import _load_expenses, XLSX_PATH

engine = create_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)
Session = sessionmaker(bind=engine)

GROUP_NAME = "Mumbai + Diwali Trip (Oct 25)"
MEMBERS    = ["Anubhav", "Anukul"]
SHEET      = "Sheet8"

def main():
    import openpyxl
    wb = openpyxl.load_workbook(XLSX_PATH, data_only=False)
    if SHEET not in wb.sheetnames:
        print(f"Sheet '{SHEET}' not found in workbook")
        return

    db = Session()
    try:
        # Delete existing group (cascades to members + expenses)
        existing = db.query(Group).filter_by(name=GROUP_NAME).first()
        if existing:
            db.delete(existing)
            db.flush()
            print(f"Deleted existing '{GROUP_NAME}'")

        # Re-create
        grp = Group(
            name=GROUP_NAME,
            description="Anubhav & Anukul – Oct–Nov 2025",
            emoji="",
            is_historical=True,
        )
        db.add(grp)
        db.flush()

        for name in MEMBERS:
            db.add(Member(group_id=grp.id, name=name))

        expenses = _load_expenses(wb[SHEET], MEMBERS)
        gentleman_count = sum(1 for e in expenses if e.get("split_json"))
        for e in expenses:
            db.add(Expense(group_id=grp.id, **e))

        db.commit()
        print(f"Re-seeded '{GROUP_NAME}':")
        print(f"  {len(MEMBERS)} members, {len(expenses)} expenses")
        print(f"  {gentleman_count} expense(s) with gentleman's split (split_json)")

    except Exception as exc:
        db.rollback()
        print(f"Error: {exc}")
        raise
    finally:
        db.close()

if __name__ == "__main__":
    main()

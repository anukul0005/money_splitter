"""Export one person's spending as an ML-ready CSV.

    python export_ml_dataset.py <user name> <statement.csv> [--until YYYY-MM-DD] [--out path]

Columns: date, time, amount, txn_id, paid_to, category, subcategory.

A row per statement debit that the app counts as spending - i.e. its
transaction id is on an expense the user paid (created in a monthly group,
merged into a hand-entered one, or linked to a shared-group expense). So
everything import_statement leaves out is left out here too, for the same
reasons: investments, credit repayments, self-transfers, excluded payees,
settle-ups and loans. Cash expenses typed in by hand have no transaction id
and so no row. Amount, time and payee come from the statement (what was
actually paid), not from the app entry, which may be rounded or renamed;
the app entry's title is only used to help categorize a payment to a person.

Read-only: it never writes to the database.
"""
from __future__ import annotations

import argparse
import csv
import json
import os

from database import get_session_factory
from models import Expense
from routers.expenses import _norm
from spend_categories import categorize
from statement_import import parse_phonepe_csv

COLUMNS = ["date", "time", "amount", "txn_id", "paid_to", "category", "subcategory"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("user")
    ap.add_argument("statement")
    ap.add_argument("--until", default="9999-12-31")
    ap.add_argument("--out", default=os.path.join("..", "ml_data", "spending_dataset.csv"))
    args = ap.parse_args()

    db = get_session_factory()()
    try:
        db.connection().exec_driver_sql("SET TRANSACTION READ ONLY")
        me = args.user.lower()
        title_by_ref: dict[str, str] = {}
        for e in db.query(Expense).filter(Expense.txn_ref.isnot(None)).all():
            if (e.paid_by or "").lower() != me:
                continue
            for r in e.txn_ref.split(","):
                title_by_ref[r] = e.title or e.category or ""
    finally:
        db.rollback()
        db.close()

    # Per-payee labels (Claude's classifications and questionnaire answers),
    # kept next to the dataset since they name real people. They win over
    # the keyword rules.
    labels: dict[str, list[str]] = {}
    labels_path = os.path.join(os.path.dirname(os.path.abspath(args.out)), "payee_labels.json")
    if os.path.exists(labels_path):
        with open(labels_path, encoding="utf-8") as f:
            labels = {k: v for k, v in json.load(f).items() if not k.startswith("_")}

    with open(args.statement, "rb") as f:
        txns = parse_phonepe_csv(f.read())
    rows, seen = [], set()
    for t in sorted(txns, key=lambda x: (x.date, x.time or "")):
        if t.kind != "Debit" or t.txn_id not in title_by_ref or t.txn_id in seen or t.date > args.until:
            continue
        seen.add(t.txn_id)
        label = labels.get(_norm(t.merchant))
        cat, sub = (label[0], label[1]) if label else categorize(t.merchant, t.amount, title_by_ref[t.txn_id])
        rows.append([t.date, t.time or "", f"{t.amount:.2f}", t.txn_id, t.merchant, cat, sub])

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(COLUMNS)
        w.writerows(rows)
    print(f"{len(rows)} rows -> {os.path.abspath(args.out)}")


if __name__ == "__main__":
    main()

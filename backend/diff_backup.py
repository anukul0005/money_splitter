"""Field-level diff between a backup snapshot and the live database.

    cd backend
    ../venv/Scripts/python.exe diff_backup.py backups/backup-YYYYmmdd-HHMMSS.json

Reports rows added, rows deleted, and every changed field, so you can see
exactly what has happened since the snapshot was taken. Read-only.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, date
from pathlib import Path

from database import get_session_factory
from models import User, Group, Member, Expense, Payment, Activity, ActivitySeen

TABLES = [
    ("users", User, "id"),
    ("groups", Group, "id"),
    ("members", Member, "id"),
    ("expenses", Expense, "id"),
    ("payments", Payment, "id"),
    ("activities", Activity, "id"),
    ("activity_seen", ActivitySeen, "user_name"),
]

# Noisy or irrelevant to compare
SKIP_FIELDS = {"created_at"}


def norm(v):
    if isinstance(v, dict) and "__dt__" in v:
        return v["__dt__"]
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, float):
        return round(v, 2)
    return v


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    path = Path(sys.argv[1])
    payload = json.loads(path.read_text(encoding="utf8"))
    db = get_session_factory()()

    print(f"Snapshot : {path.name}   taken {payload.get('created_at', '?')}")
    print(f"Compared : live database\n")

    total_add = total_del = total_chg = 0

    for name, model, pk in TABLES:
        saved = {str(norm(r[pk])): r for r in payload["tables"].get(name, [])}
        live = {str(norm(getattr(o, pk))): o for o in db.query(model).all()}
        cols = [c.name for c in model.__table__.columns if c.name not in SKIP_FIELDS]

        added = sorted(set(live) - set(saved), key=lambda x: (len(x), x))
        removed = sorted(set(saved) - set(live), key=lambda x: (len(x), x))
        changed = []
        for k in sorted(set(saved) & set(live), key=lambda x: (len(x), x)):
            diffs = []
            for c in cols:
                a, b = norm(saved[k].get(c)), norm(getattr(live[k], c))
                if a != b:
                    diffs.append((c, a, b))
            if diffs:
                changed.append((k, diffs))

        if not (added or removed or changed):
            print(f"{name:15s} unchanged ({len(live)} rows)")
            continue

        print(f"{name:15s} +{len(added)} added  -{len(removed)} removed  ~{len(changed)} changed")
        total_add += len(added)
        total_del += len(removed)
        total_chg += len(changed)

        for k in added:
            o = live[k]
            desc = getattr(o, "name", None) or getattr(o, "title", None) or ""
            print(f"    ADDED   {pk}={k:5s} {str(desc)[:44]}")
        for k in removed:
            r = saved[k]
            desc = r.get("name") or r.get("title") or ""
            print(f"    REMOVED {pk}={k:5s} {str(desc)[:44]}")
        for k, diffs in changed:
            o = live[k]
            desc = getattr(o, "name", None) or getattr(o, "title", None) or ""
            print(f"    CHANGED {pk}={k:5s} {str(desc)[:40]}")
            for c, a, b in diffs:
                print(f"        {c:18s} {str(a)[:34]:36s} -> {str(b)[:34]}")
        print()

    print(f"TOTAL: {total_add} added, {total_del} removed, {total_chg} changed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Restore the database from a backup_db.py snapshot.

    cd backend
    ../venv/Scripts/python.exe restore_db.py backups/backup-YYYYmmdd-HHMMSS.json --dry-run
    ../venv/Scripts/python.exe restore_db.py backups/backup-YYYYmmdd-HHMMSS.json --yes

DESTRUCTIVE: --yes wipes every table listed in the snapshot and rewrites it
from the file. Defaults to a dry run that only reports what would change, and
refuses to run without --yes so it can never fire by accident.

Targets whatever DATABASE_URL is in backend/.env — currently the live Neon
database, so read the dry-run output before passing --yes.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

from database import get_session_factory, get_settings
from models import User, Group, Member, Expense, Payment, Activity, ActivitySeen

# Parents first when writing, children first when deleting.
TABLES = [
    ("users", User),
    ("groups", Group),
    ("members", Member),
    ("expenses", Expense),
    ("payments", Payment),
    ("activities", Activity),
    ("activity_seen", ActivitySeen),
]


def _decode(value):
    if isinstance(value, dict) and "__dt__" in value:
        return datetime.fromisoformat(value["__dt__"])
    return value


def _resync_sequences(db) -> None:
    """Postgres keeps its own id counters; after an explicit-id restore they
    must be pushed past the highest restored id or the next insert collides."""
    from sqlalchemy import text
    for name, model in TABLES:
        cols = [c.name for c in model.__table__.columns]
        if "id" not in cols:
            continue
        try:
            db.execute(text(
                f"SELECT setval(pg_get_serial_sequence('{name}', 'id'), "
                f"COALESCE((SELECT MAX(id) FROM {name}), 1), true)"
            ))
        except Exception as e:
            print(f"  ! could not resync sequence for {name}: {e}")
    db.commit()


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        return 1

    path = Path(args[0])
    if not path.exists():
        print(f"No such snapshot: {path}")
        return 1

    payload = json.loads(path.read_text(encoding="utf8"))
    tables = payload["tables"]
    db = get_session_factory()()
    url = get_settings().database_url
    target = url.split("://")[0] + "://…" + (url.split("@")[-1] if "@" in url else "local")

    print(f"Snapshot : {path.name}  (taken {payload.get('created_at', '?')})")
    print(f"Target   : {target}\n")
    print(f"  {'table':15s} {'live':>6s} {'snapshot':>9s}")
    for name, model in TABLES:
        print(f"  {name:15s} {db.query(model).count():6d} {len(tables.get(name, [])):9d}")

    if "--yes" not in sys.argv:
        print("\nDry run — nothing changed. Re-run with --yes to actually restore.")
        return 0

    print("\nRestoring…")
    # Children first so foreign keys never dangle mid-wipe
    for name, model in reversed(TABLES):
        db.query(model).delete(synchronize_session=False)
    db.commit()

    for name, model in TABLES:
        rows = tables.get(name, [])
        for row in rows:
            db.add(model(**{k: _decode(v) for k, v in row.items()}))
        db.commit()
        print(f"  {name:15s} {len(rows):5d} rows restored")

    _resync_sequences(db)
    print("\nDone. Sequences resynced.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

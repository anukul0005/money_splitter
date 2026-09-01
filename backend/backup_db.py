"""Full snapshot of every table to a local JSON file.

    cd backend
    ../venv/Scripts/python.exe backup_db.py            # write a new snapshot
    ../venv/Scripts/python.exe backup_db.py --verify F # re-check a snapshot

Reads whatever DATABASE_URL is in backend/.env, which currently points at the
live Neon database. Snapshots land in backend/backups/ and are gitignored —
they contain password and recovery hashes, so they must never be committed.

Restore with restore_db.py.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, date
from pathlib import Path

from database import get_session_factory, get_settings
from models import User, Group, Member, Expense, Payment, Activity, ActivitySeen

# Order matters for restore: parents before children.
TABLES = [
    ("users", User),
    ("groups", Group),
    ("members", Member),
    ("expenses", Expense),
    ("payments", Payment),
    ("activities", Activity),
    ("activity_seen", ActivitySeen),
]

BACKUP_DIR = Path(__file__).parent / "backups"


def _encode(value):
    if isinstance(value, (datetime, date)):
        return {"__dt__": value.isoformat()}
    return value


def _row_to_dict(obj, model) -> dict:
    return {c.name: _encode(getattr(obj, c.name)) for c in model.__table__.columns}


def snapshot(db) -> dict:
    data = {}
    for name, model in TABLES:
        rows = db.query(model).all()
        data[name] = [_row_to_dict(r, model) for r in rows]
    return data


def main() -> int:
    db = get_session_factory()()
    url = get_settings().database_url
    target = url.split("://")[0] + "://…" + (url.split("@")[-1] if "@" in url else "local")

    if "--verify" in sys.argv:
        path = Path(sys.argv[sys.argv.index("--verify") + 1])
        saved = json.loads(path.read_text(encoding="utf8"))
        live = snapshot(db)
        print(f"Verifying {path.name} against {target}\n")
        ok = True
        for name, _ in TABLES:
            a, b = len(saved["tables"][name]), len(live[name])
            flag = "OK " if a == b else "DIFF"
            if a != b:
                ok = False
            print(f"  {flag} {name:15s} snapshot={a:5d}  live={b:5d}")
        print("\nSnapshot matches the live database." if ok else "\nCounts differ (expected if data changed since).")
        return 0 if ok else 1

    BACKUP_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = BACKUP_DIR / f"backup-{stamp}.json"

    data = snapshot(db)
    payload = {
        "created_at": datetime.now().isoformat(),
        "database": target,
        "counts": {k: len(v) for k, v in data.items()},
        "tables": data,
    }
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf8")

    print(f"Backed up {target}")
    print(f"  -> {path}")
    print(f"  {path.stat().st_size / 1024:.1f} KB\n")
    for name, _ in TABLES:
        print(f"  {name:15s} {len(data[name]):5d} rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

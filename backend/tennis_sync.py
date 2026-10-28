"""Keeps the app's tennis results (tennis_kb tables in Postgres) current:
started by the daily cron (routers/cron.daily_jobs), in a thread - it is
a few dozen ESPN requests. From two days before the last day it covered
to today, so a missed day is caught up and late results are picked up.
Nothing happens until the tables have been loaded once (load_tennis.py).
"""
from __future__ import annotations

import threading
from datetime import date, datetime, timedelta

_running = threading.Lock()


def run(today: date) -> dict:
    if not _running.acquire(blocking=False):
        return {"skipped": "already running"}
    import tennis_kb as kb
    from database import get_engine
    conn = None
    try:
        conn = kb.connect_pg(get_engine())
        last = kb.meta_get(conn, "last_fetched")
        if not last:
            return {"skipped": "tennis tables not loaded yet"}
        start = date.fromisoformat(last) - timedelta(days=2)
        out = kb.fetch_range(conn, start, today, log=lambda m: print(f"[tennis] {m}"))
        kb.meta_set(conn, "last_update", datetime.now().isoformat(timespec="seconds"))
        conn.commit()
        print(f"[tennis] {start} to {today}: {out}")
        return out
    except Exception as err:          # never let tennis break the daily jobs
        print(f"[tennis] update failed: {err}")
        return {"error": str(err)[:200]}
    finally:
        if conn is not None:
            conn.close()
        _running.release()
        warm_stats()


def warm_stats() -> None:
    """Works out the Sets statistics now, so the page doesn't wait on the
    one pass over every match (tennis_stats caches it until the data changes)."""
    try:
        import tennis_stats
        from database import get_db
        gen = get_db()
        try:
            tennis_stats.data(next(gen))
        finally:
            gen.close()
    except Exception as err:
        print(f"[tennis] set stats warm-up failed: {err}")


def start(today: date) -> None:
    threading.Thread(target=run, args=(today,), daemon=True, name="tennis-sync").start()

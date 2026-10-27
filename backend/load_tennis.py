"""One-time: copy the local tennis knowledge base (Tennis_scraper/
tennis_kb.sqlite) into the app's Postgres, for Betting analytics. After
this the daily cron keeps the app's copy current by itself (tennis_sync).

    python load_tennis.py ../Tennis_scraper/tennis_kb.sqlite

Uses DATABASE_URL from backend/.env. Replaces whatever tennis data the app
had - the other tables are not touched.
"""
from __future__ import annotations

import sqlite3
import sys
import time

import tennis_kb as kb
from database import get_engine

TABLES = ("tennis_players", "tennis_matches", "tennis_match_stats", "tennis_meta")


def main(path: str) -> None:
    from psycopg2.extras import execute_values
    src = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    pg = kb.connect_pg(get_engine())
    cur = pg.raw.cursor()
    cur.execute("TRUNCATE " + ", ".join(TABLES))
    for table in TABLES:
        cols = [r[1] for r in src.execute(f"PRAGMA table_info({table})")]
        t0, n = time.time(), 0
        sel = src.execute(f"SELECT {', '.join(cols)} FROM {table}")
        while True:
            batch = sel.fetchmany(5000)
            if not batch:
                break
            execute_values(cur, f"INSERT INTO {table} ({', '.join(cols)}) VALUES %s", batch, page_size=5000)
            n += len(batch)
        pg.commit()
        print(f"{table}: {n:,} rows in {time.time() - t0:.0f}s")
    cur.execute("ANALYZE " + ", ".join(TABLES))
    pg.commit()
    print(kb.summary(pg))
    pg.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])

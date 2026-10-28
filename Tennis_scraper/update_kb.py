"""Script 2 - the update: the latest ATP and WTA tour-level singles
results into tennis_kb.sqlite. Run every hour by cron.

    python update_kb.py

It starts two days before the last day it covered - results that finished
after the previous run, or were corrected, are picked up - and runs to
today, so a missed run (laptop off) is caught up on the next one. Matches
already stored with the same score are skipped, so an hour with nothing
new costs four small ESPN requests. Running it twice adds nothing twice:
each match has one key (tennis_kb.upsert). Appends a line to update.log.

cron (Linux / macOS - every hour, on the hour):
    0 * * * * cd /path/to/Tennis_scraper && /usr/bin/python3 update_kb.py >> update.log 2>&1
Windows (Task Scheduler - the same):
    schtasks /Create /SC HOURLY /MO 1 /ST 00:00 /TN "Tennis KB update" /TR "\"<python.exe>\" \"<folder>\\update_kb.py\"" /F
"""
from __future__ import annotations

import os
import sys
from datetime import date, datetime, timedelta

import os as _os, sys as _sys
# The tennis module lives in the app's backend - one copy for the app and these scripts.
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "backend"))
import tennis_kb as kb  # noqa: E402

OVERLAP_DAYS = 2


def main() -> int:
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    log = open("update.log", "a", encoding="utf-8")

    def say(msg: str) -> None:
        line = f"{datetime.now():%Y-%m-%d %H:%M} {msg}"
        print(line)
        log.write(line + "\n")
        log.flush()

    if not os.path.exists(kb.DB_FILE):
        say(f"No {kb.DB_FILE} - run build_kb.py first")
        return 1
    conn = kb.connect(kb.DB_FILE)
    last = kb.meta_get(conn, "last_fetched")
    start = (date.fromisoformat(last) - timedelta(days=OVERLAP_DAYS)) if last else date.today() - timedelta(days=OVERLAP_DAYS)
    end = date.today()
    try:
        result = kb.fetch_range(conn, start, end, log=say, light=True)   # unchanged matches skipped, players looked up by name
    except Exception as err:          # one bad day mustn't leave the log silent
        say(f"update failed: {err}")
        return 1
    finally:
        conn.commit()
    kb.meta_set(conn, "last_update", datetime.now().isoformat(timespec="seconds"))
    conn.commit()
    say(f"{start} to {end}: {result['added']} new, {result['refreshed']} refreshed. {kb.summary(conn)}")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

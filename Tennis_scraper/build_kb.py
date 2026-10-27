"""Script 1 - generate the tennis knowledge base, up to today.

    python build_kb.py --source <folder with tennis.db + atp_players.csv + wta_players.csv>
    python build_kb.py                 (knowledge base already built: just catch up to today)

With --source it builds tennis_kb.sqlite from scratch:
  1. players - every ATP and WTA player from atp_players.csv / wta_players.csv
     (id, name, hand, date of birth, country, height);
  2. matches - every ATP and WTA tour-level singles match up to 16 Nov 2025
     from the old tennis.db (Jeff Sackmann's data 2000-2024 with serve stats,
     the app's 2025 scrape) - Challenger, qualifying and ITF left out;
  3. then every match from 17 Nov 2025 to today (tennis_kb.fetch_range:
     ESPN, with the app's TheSportsDB method as fallback), each player
     matched to their player id.
Without --source the knowledge base is the source: it is caught up from
the day after the last one fetched. Run update_kb.py daily after this.
"""
from __future__ import annotations

import argparse
import csv
import os
import sqlite3
import sys
from datetime import date, datetime, timedelta

import os as _os, sys as _sys
# The tennis module lives in the app's backend - one copy for the app and these scripts.
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "backend"))
import tennis_kb as kb  # noqa: E402

BASE_UNTIL = 20251116        # the consolidated base ends with the 2025 ATP Finals final


def _int(v):
    try:
        return int(float(v)) if v not in (None, "", "nan") else None
    except (TypeError, ValueError):
        return None


def _float(v):
    try:
        return float(v) if v not in (None, "", "nan") else None
    except (TypeError, ValueError):
        return None


def load_players(conn, src: str) -> int:
    n = 0
    for tour, fname in (("ATP", "atp_players.csv"), ("WTA", "wta_players.csv")):
        with open(os.path.join(src, fname), encoding="utf-8", errors="replace") as f:
            rows = []
            for r in csv.DictReader(f):
                pid = _int(r.get("player_id"))
                if pid is None:
                    continue
                first, last = (r.get("name_first") or "").strip(), (r.get("name_last") or "").strip()
                hand = (r.get("hand") or "").strip() or None
                rows.append((tour, pid, f"{first} {last}".strip(), first, last, None if hand == "U" else hand,
                             _int(r.get("dob")), (r.get("ioc") or "").strip() or None, _int(r.get("height")),
                             (r.get("wikidata_id") or "").strip() or None, "sackmann"))
            conn.executemany("INSERT OR REPLACE INTO tennis_players(tour, player_id, name, first_name, last_name, hand, dob, "
                             "ioc, height, wikidata_id, source) VALUES(?,?,?,?,?,?,?,?,?,?,?)", rows)
            n += len(rows)
    return n


def load_matches(conn, src: str) -> tuple[int, int]:
    old = sqlite3.connect(f"file:{os.path.join(src, 'tennis.db')}?mode=ro", uri=True)
    old.row_factory = sqlite3.Row
    seen: dict[str, int] = {}
    matches, stats = [], []
    for r in old.execute("SELECT * FROM matches WHERE tour IN ('ATP', 'WTA') AND tourney_date <= ? "
                         "ORDER BY tourney_date, tourney_id, match_num", (BASE_UNTIL,)):
        r = dict(r)
        year = str(r["tourney_date"])[:4]
        sackmann = year < "2025"
        if sackmann:
            mid = f"{r['tour']}:{r['tourney_id']}-{r['match_num']}"
        else:                                      # the app's 2025 scrape: tourney_id is the event id
            mid = f"tsdb:{r['tourney_id']}"
        seen[mid] = seen.get(mid, 0) + 1
        if seen[mid] > 1:                          # three Sackmann rows share a key
            mid = f"{mid}#{seen[mid]}"
        d = str(r["tourney_date"])
        row = {"match_id": mid, "source": "sackmann" if sackmann else "thesportsdb", "tour": r["tour"],
               "tourney_id": r["tourney_id"], "tourney_name": r["tourney_name"], "surface": r["surface"] or None,
               "draw_size": _int(r["draw_size"]), "tourney_level": r["tourney_level"],
               "tourney_date": _int(r["tourney_date"]),
               "match_date": None if sackmann else f"{d[:4]}-{d[4:6]}-{d[6:8]}",
               "match_num": _int(r["match_num"]), "round": r["round"], "best_of": _int(r["best_of"]),
               "score": r["score"], "minutes": _int(r["minutes"])}
        row["play_date"] = kb.play_date(row)
        for side in ("winner", "loser"):
            row.update({f"{side}_id": _int(r[f"{side}_id"]), f"{side}_name": r[f"{side}_name"],
                        f"{side}_ioc": r[f"{side}_ioc"], f"{side}_age": _float(r[f"{side}_age"]),
                        f"{side}_rank": _int(r[f"{side}_rank"]), f"{side}_rank_points": _int(r[f"{side}_rank_points"]),
                        f"{side}_seed": str(_int(r[f"{side}_seed"]) or r[f"{side}_seed"] or "") or None,
                        f"{side}_entry": r[f"{side}_entry"] or None})
        matches.append([row.get(c) for c in kb.MATCH_COLS])
        sv = [_int(r[c]) for c in kb.STAT_COLS]
        if any(v is not None for v in sv):
            stats.append([mid] + sv)
    old.close()
    conn.executemany(f"INSERT INTO tennis_matches({', '.join(kb.MATCH_COLS)}) VALUES({', '.join('?' * len(kb.MATCH_COLS))})", matches)
    conn.executemany(f"INSERT INTO tennis_match_stats(match_id, {', '.join(kb.STAT_COLS)}) "
                     f"VALUES({', '.join('?' * (len(kb.STAT_COLS) + 1))})", stats)
    return len(matches), len(stats)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", help="folder with tennis.db, atp_players.csv, wta_players.csv - builds from scratch")
    ap.add_argument("--db", default=kb.DB_FILE)
    ap.add_argument("--until", default=date.today().isoformat(), help="last day to fetch (default today)")
    a = ap.parse_args()
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    if a.source:
        if os.path.exists(a.db):
            sys.exit(f"{a.db} already exists - move it away to rebuild from scratch")
        conn = kb.connect(a.db)
        print(f"Players: {load_players(conn, a.source):,}")
        m, s = load_matches(conn, a.source)
        print(f"Matches up to {BASE_UNTIL}: {m:,} ({s:,} with serve stats)")
        kb.meta_set(conn, "built_at", datetime.now().isoformat(timespec="seconds"))
        kb.meta_set(conn, "base_until", BASE_UNTIL)
        kb.meta_set(conn, "last_fetched", "2025-11-16")
        conn.commit()
    else:
        if not os.path.exists(a.db):
            sys.exit(f"No {a.db} yet - run with --source <folder> first")
        conn = kb.connect(a.db)

    start = date.fromisoformat(kb.meta_get(conn, "last_fetched")) + timedelta(days=1)
    end = date.fromisoformat(a.until)
    if start <= end:
        print(f"Fetching {start} to {end}...")
        print(kb.fetch_range(conn, start, end))
    print("Optimising...")
    conn.execute("ANALYZE")
    conn.commit()
    conn.execute("VACUUM")
    print(kb.summary(conn))
    conn.close()


if __name__ == "__main__":
    main()

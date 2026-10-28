# Tennis knowledge base

Every **ATP and WTA tour-level singles match** (no Challenger, qualifying,
ITF or WTA 125) from **2000 to today**, in one SQLite file: `tennis_kb.sqlite`.

| Table | What's in it |
|---|---|
| `tennis_matches` | one row per match: tour, tournament, surface, level, `play_date` (day played; for 2000-2024 the tournament's first day), round, both players (id, name, country, age, rank, seed), score, minutes, source |
| `tennis_match_stats` | aces, double faults, serve points, break points... where known (2000-2024) |
| `tennis_players` | 136k ATP/WTA players: id, name, hand, date of birth, country, height, ESPN id |
| `tennis_meta` | `last_fetched` - the last day covered |

Sources: Jeff Sackmann's ATP/WTA data (2000-2024, with serve stats), the
original scraper's TheSportsDB 2025 data (to 16 Nov 2025), then ESPN's
daily scoreboard (TheSportsDB as fallback). Every player in new matches is
matched to their player id.

## Scripts
The tennis logic lives in `../backend/tennis_kb.py` - the same module the
app's **Betting analytics** page uses - so these scripts need the folder to
stay next to `backend/`. Standard library Python only.

1. **`build_kb.py`** - data generation up to today. The knowledge base now
   *is* the source (the original CSVs are gone), so run without arguments:
   it fetches from the day after `last_fetched` to today.
   `--source` rebuilt it from the original files and no longer applies.
2. **`update_kb.py`** - the hourly update: from two days before the last day
   covered to today (late results are picked up, a missed run is caught up),
   safe to run twice. Matches already stored with the same score are
   skipped and players are looked up name by name, so a quiet hour costs
   four small ESPN requests. Logs to `update.log`.

## Hourly schedule
Registered on this laptop as Windows Task **"Tennis KB update"**, every
hour on the hour (Task Scheduler is Windows' cron). If the laptop is off,
the next run catches up.

    schtasks /Query /TN "Tennis KB update"          # check it
    schtasks /Run   /TN "Tennis KB update"          # run it now
    schtasks /Delete /TN "Tennis KB update" /F      # remove it

On Linux/macOS the equivalent cron line:

    0 * * * * cd /path/to/Tennis_scraper && python3 update_kb.py

The app keeps its own copy current separately (`backend/tennis_sync.py`):
the daily cron runs the full update, and a light one (yesterday and today)
runs hourly - from a pinger calling `/cron/tennis?key=<CRON_SECRET>`, and
whenever Betting analytics is opened with results over an hour old.

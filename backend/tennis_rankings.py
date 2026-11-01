"""The current ATP / WTA singles rankings - ESPN's top 150 (the same source as
the live scores), held HOLD seconds. Each player is matched to the
knowledge base by ESPN id (tennis_players.espn_id), so a ranked name opens
that player's page; and the live rows and the match page show each
player's ranking now.
"""
from __future__ import annotations

import threading
import time

from sqlalchemy import bindparam, text

import tennis_kb as kb

URL = "https://site.api.espn.com/apis/site/v2/sports/tennis/{tour}/rankings"
HOLD = 6 * 3600
_held: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()


def _read(tour: str) -> dict:
    data = kb.get_json(URL.format(tour=tour.lower()))
    table = (data.get("rankings") or [{}])[0]
    rows = []
    for r in table.get("ranks") or []:
        a = r.get("athlete") or {}
        rows.append({"rank": r.get("current"), "previous": r.get("previous"), "points": round(r.get("points") or 0),
                     "name": a.get("displayName") or "?", "ioc": a.get("citizenshipCountry"),
                     "espn_id": str(a.get("id") or "")})
    return {"tour": tour, "updated": table.get("update"), "rows": rows}


def get(tour: str) -> dict:
    tour = tour.upper()
    with _lock:
        hit = _held.get(tour)
    if hit and time.time() - hit[0] < HOLD:
        return hit[1]
    try:
        value = _read(tour)
    except Exception as e:
        print(f"[tennis-rankings] {tour}: {e}")
        if hit:
            return hit[1]           # ESPN down: the last list beats none
        return {"tour": tour, "updated": None, "rows": []}
    with _lock:
        _held[tour] = (time.time(), value)
    return value


def by_espn(tour: str) -> dict[str, int]:
    return {r["espn_id"]: r["rank"] for r in get(tour)["rows"] if r["espn_id"]}


def with_players(db, tour: str) -> dict:
    """The list with each player's knowledge-base id (None when not on file)."""
    data = get(tour)
    ids = [r["espn_id"] for r in data["rows"] if r["espn_id"]]
    known = {}
    if ids:
        q = text("SELECT player_id, espn_id FROM tennis_players WHERE tour = :t AND espn_id IN :e").bindparams(
            bindparam("e", expanding=True))
        for pid, eid in db.execute(q, {"t": data["tour"], "e": ids}).all():
            known[str(eid)] = pid
    return {**data, "rows": [{**r, "player_id": known.get(r["espn_id"])} for r in data["rows"]]}


def by_player(db, tour: str) -> dict[int, int]:
    return {r["player_id"]: r["rank"] for r in with_players(db, tour)["rows"] if r["player_id"]}

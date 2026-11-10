"""The pressure pattern: serving at 4-5 to stay in the set - broken there,
the set is lost 4-6 - and the other big service games at the end of a set
(5-6 to reach the tie-break, 5-4 and 6-5 serving for it), against how often
the same players hold an ordinary service game.

Worked out once from the Match Charting Project's point-by-point logs,
like tennis_early_break (same folder of charting-*.csv files):

    python tennis_pressure.py <folder with the charting-*.csv files>

The Patterns tab shows the tour table (JSON_FILE); a player's page shows
their own record in these games next to the tour's (PLAYERS_FILE).
"""
from __future__ import annotations

import csv
import json
import os
import sys
from collections import defaultdict

import tennis_kb as kb

FROM_YEAR = 2017
JSON_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tennis_pressure.json")
PLAYERS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tennis_pressure_players.json")
MIN_SETS = 10      # a player with fewer charted sets is left out

# The service games counted, by the score before them as server-returner
SPOTS = {"s45": (4, 5), "s56": (5, 6), "s54": (5, 4), "s65": (6, 5)}


def _sets_of(points: list) -> list:
    """Complete sets of one match: {set, final (p1, p2), games [(g1, g2, server, winner)]}."""
    by = defaultdict(list)
    for p in points:
        by[p[0]].append(p)
    out = []
    for s, ps in sorted(by.items()):
        games = {}
        for _, g1, g2, svr, w in ps:
            games[(g1, g2)] = [svr, w]
        seq = sorted(games, key=lambda k: k[0] + k[1])
        if [a + b for a, b in seq] != list(range(len(seq))):
            continue                                  # a game missing from the chart
        a, b = seq[-1]
        fa, fb = (a + 1, b) if games[seq[-1]][1] == 1 else (a, b + 1)
        hi, lo = max(fa, fb), min(fa, fb)
        if not (hi >= 6 and (hi - lo >= 2 or (hi == 7 and lo == 6))):
            continue                                  # unfinished, or a chart that stops short
        out.append({"set": s + 1, "final": (fa, fb),
                    "games": [(g1, g2, *games[(g1, g2)]) for g1, g2 in seq if (g1, g2) != (6, 6)]})
    return out


def _read(folder: str) -> dict:
    csv.field_size_limit(10 ** 8)
    sets = {"ATP": [], "WTA": []}
    meta = {}                                         # match id -> (names, best of)
    for t in "mw":
        for r in csv.DictReader(open(os.path.join(folder, f"charting-{t}-matches.csv"), encoding="utf8", errors="replace")):
            meta[r["match_id"]] = ((kb.norm(r["Player 1"]), kb.norm(r["Player 2"])), 5 if r.get("Best of") == "5" else 3)
    for t, tour in (("m", "ATP"), ("w", "WTA")):
        for dec in ("2010s", "2020s"):
            cur, pts = None, []

            def flush():
                if cur and cur[:4].isdigit() and int(cur[:4]) >= FROM_YEAR:
                    names, bo = meta.get(cur, (None, 3))
                    sets[tour].extend({**x, "mid": cur, "names": names, "bo": bo} for x in _sets_of(pts))
            for r in csv.DictReader(open(os.path.join(folder, f"charting-{t}-points-{dec}.csv"), encoding="utf8", errors="replace")):
                if r["match_id"] != cur:
                    flush()
                    cur, pts = r["match_id"], []
                try:
                    pts.append((int(r["Set1"]) + int(r["Set2"]), int(r["Gm1"]), int(r["Gm2"]),
                                int(r["Svr"]), int(r["PtWinner"])))
                except ValueError:
                    pass
            flush()
    sets["ALL"] = sets["ATP"] + sets["WTA"]
    return sets


def _spots(s: dict):
    """Each counted game of a set: (key, server 1/2, held, server won the set)."""
    for g1, g2, svr, w in s["games"]:
        mine = (g1, g2) if svr == 1 else (g2, g1)
        won_set = (s["final"][0] > s["final"][1]) == (svr == 1)
        for key, at in SPOTS.items():
            if mine == at:
                yield key, svr, svr == w, won_set
        yield "hold", svr, svr == w, won_set


def _which(s: dict) -> str:
    """Set 1, a middle set, or the deciding set."""
    if s["set"] == 1:
        return "set1"
    return "decider" if s["set"] == (5 if s["bo"] == 5 else 3) else "middle"


def build(folder: str):
    sets = _read(folder)
    out = {"from_year": FROM_YEAR, "tours": {}}
    for tour, S in sets.items():
        c = defaultdict(lambda: [0, 0])               # key -> [games, held]
        after = defaultdict(int)                      # held at 4-5 -> how the set ended
        for s in S:
            for key, svr, held, won_set in _spots(s):
                c[key][0] += 1
                c[key][1] += held
                if key == "s45":
                    c[f"s45_{_which(s)}"][0] += 1
                    c[f"s45_{_which(s)}"][1] += held
                    if held:
                        hi = max(s["final"])
                        after["won 7-5" if won_set and hi == 7 and min(s["final"]) == 5 else
                              "won 7-6" if won_set else "lost 7-6" if hi == 7 and min(s["final"]) == 6 else "lost 5-7"] += 1
        out["tours"][tour] = {"sets": len(S), **{k: {"n": v[0], "held": v[1]} for k, v in c.items()},
                              "after_hold": sorted(after.items(), key=lambda x: -x[1])}
    return out, _players(sets)


def _players(sets: dict) -> dict:
    """{tour: {player: {key: [games, held], "r45": [games, broke], ...}}} with "_avg"."""
    out = {}
    for tour in ("ATP", "WTA"):
        by = defaultdict(lambda: defaultdict(lambda: [0, 0]))
        n_sets, matches = defaultdict(int), defaultdict(set)
        for s in sets[tour]:
            if not s.get("names"):
                continue
            for side in (1, 2):
                n_sets[s["names"][side - 1]] += 1
                matches[s["names"][side - 1]].add(s["mid"])
            for key, svr, held, _ in _spots(s):
                server, returner = s["names"][svr - 1], s["names"][2 - svr]
                for who in (server, "_avg"):
                    by[who][key][0] += 1
                    by[who][key][1] += held
                if key in ("s45", "s56"):             # returning at that score: did they break and take the set
                    for who in (returner, "_avg"):
                        by[who]["r" + key[1:]][0] += 1
                        by[who]["r" + key[1:]][1] += not held
        out[tour] = {n: {**{k: v for k, v in d.items()}, "sets": n_sets.get(n, 0), "matches": len(matches.get(n, ()))}
                     for n, d in by.items() if n == "_avg" or n_sets[n] >= MIN_SETS}
    return out


_held = None
_players_held = None


def player(tour: str, name: str) -> dict | None:
    """One player's pressure games and the tour's average, or None when too few are charted."""
    global _players_held
    if _players_held is None:
        try:
            with open(PLAYERS_FILE, encoding="utf8") as f:
                _players_held = json.load(f)
        except OSError:
            _players_held = {}
    t = _players_held.get(tour.upper()) or {}
    me = t.get(kb.norm(name))
    return {"from_year": FROM_YEAR, "player": me, "avg": t.get("_avg")} if me else None


def get() -> dict:
    global _held
    if _held is None:
        try:
            with open(JSON_FILE, encoding="utf8") as f:
                _held = json.load(f)
        except OSError:
            _held = {"tours": {}}
    return _held


if __name__ == "__main__":
    data, players = build(sys.argv[1])
    with open(JSON_FILE, "w", encoding="utf8") as f:
        json.dump(data, f, separators=(",", ":"))
    with open(PLAYERS_FILE, "w", encoding="utf8") as f:
        json.dump(players, f, separators=(",", ":"))
    print({t: len(v) - 1 for t, v in players.items()}, "players")
    for t, d in data["tours"].items():
        print(t, d["sets"], {k: (d[k]["n"], round(100 * (1 - d[k]["held"] / max(1, d[k]["n"])), 1))
                             for k in ("hold", "s45", "s56", "s54", "s65", "s45_set1", "s45_middle", "s45_decider") if k in d},
              d["after_hold"])

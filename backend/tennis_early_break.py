"""The early-break pattern: a break of serve in the first 4 games of a set,
and how often that set is then closed in 8 games or fewer (6-0, 6-1, 6-2 -
"under 8.5 games").

Final scores (the knowledge base) don't say when a break came, so this is
worked out from the Match Charting Project's point-by-point logs
(github.com/JeffSackmann/tennis_MatchChartingProject, matches from FROM_YEAR
on) - every game in order, who served and who won it. The logs are history,
so the figures are worked out once, here, and kept in JSON_FILE:

    python tennis_early_break.py <folder with the charting-*.csv files>

The Patterns tab shows the table; the Live tab marks a set being played
with its chance of ending under 8.5 from the score it's at (`by_score`).
"""
from __future__ import annotations

import csv
import json
import os
import sys
from collections import defaultdict

FROM_YEAR = 2017
JSON_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tennis_early_break.json")
UNDER = 8          # games in the set, at most


def _sets_of(points: list) -> list:
    """Complete sets of one match: [{final, early breaks, score after 4, prefixes}]."""
    by = defaultdict(list)
    for p in points:
        by[p[0]].append(p)
    out = []
    for s, ps in sorted(by.items()):
        games = {}                                    # (g1, g2) before the game -> [server, winner of its last point]
        for _, g1, g2, svr, w in ps:
            games[(g1, g2)] = [svr, w]
        seq = sorted(games, key=lambda k: k[0] + k[1])
        if [a + b for a, b in seq] != list(range(len(seq))):
            continue                                  # a game missing from the chart
        a, b = seq[-1]
        fa, fb = (a + 1, b) if games[seq[-1]][1] == 1 else (a, b + 1)
        hi, lo = max(fa, fb), min(fa, fb)
        if not (hi >= 6 and (hi - lo >= 2 or (hi == 7 and lo == 6))):
            continue                                  # unfinished (a retirement) or a chart that stops short
        early = [(i + 1, games[k][1]) for i, k in enumerate(seq[:4]) if games[k][0] != games[k][1]]
        out.append({"set": s + 1, "final": (fa, fb), "early": early,
                    "after4": seq[4] if len(seq) > 4 else (fa, fb), "seq": seq + [(fa, fb)]})
    return out


def build(folder: str) -> dict:
    csv.field_size_limit(10 ** 8)
    sets = {"ATP": [], "WTA": []}
    for t, tour in (("m", "ATP"), ("w", "WTA")):
        for dec in ("2010s", "2020s"):
            cur, pts = None, []
            path = os.path.join(folder, f"charting-{t}-points-{dec}.csv")
            for r in csv.DictReader(open(path, encoding="utf8", errors="replace")):
                if r["match_id"] != cur:
                    if cur and int(cur[:4]) >= FROM_YEAR:
                        sets[tour].extend(_sets_of(pts))
                    cur, pts = r["match_id"], []
                try:
                    pts.append((int(r["Set1"]) + int(r["Set2"]), int(r["Gm1"]), int(r["Gm2"]),
                                int(r["Svr"]), int(r["PtWinner"])))
                except ValueError:
                    pass
            if cur and int(cur[:4]) >= FROM_YEAR:
                sets[tour].extend(_sets_of(pts))
    sets["ALL"] = sets["ATP"] + sets["WTA"]

    def cell(rows):
        return {"n": len(rows), "under": sum(1 for s in rows if sum(s["final"]) <= UNDER)}

    def net(s):
        return sum(1 if w == 1 else -1 for _, w in s["early"])

    out = {"from_year": FROM_YEAR, "under": UNDER + 0.5, "tours": {}}
    for tour, S in sets.items():
        E = [s for s in S if s["early"]]
        held = [s for s in E if net(s)]
        won = [s for s in held if (s["final"][0] > s["final"][1]) == (net(s) > 0)]
        after = lambda x, y: [s for s in E if tuple(sorted(s["after4"], reverse=True)) == (x, y)]
        finals = defaultdict(int)
        for s in E:
            finals[f"{max(s['final'])}-{min(s['final'])}"] += 1
        # every score a set passed through (leader-trailer, not level) -> how often it then ended under
        by_score = defaultdict(lambda: [0, 0])
        for s in S:
            u = sum(s["final"]) <= UNDER
            for a, b in {(max(k), min(k)) for k in s["seq"][1:-1] if k[0] != k[1]}:
                by_score[f"{a}-{b}"][0] += 1
                by_score[f"{a}-{b}"][1] += u
        out["tours"][tour] = {
            "rows": [
                {"key": "all", "label": "Every set", **cell(S)},
                {"key": "none", "label": "No break in games 1-4", **cell([s for s in S if not s["early"]])},
                {"key": "early", "label": "Any break in games 1-4", **cell(E)},
                {"key": "22", "label": "Broken back - 2-2 after 4", **cell(after(2, 2))},
                {"key": "31", "label": "One break up - 3-1 after 4", **cell(after(3, 1))},
                {"key": "40", "label": "Double break - 4-0 after 4", **cell(after(4, 0))},
                {"key": "g12", "label": "First break in game 1 or 2", **cell([s for s in E if s["early"][0][0] <= 2])},
                {"key": "g34", "label": "First break in game 3 or 4", **cell([s for s in E if s["early"][0][0] >= 3])},
            ],
            "breaker_wins": {"n": len(held), "won": len(won)},
            "finals": sorted(([k, v] for k, v in finals.items() if v), key=lambda x: -x[1])[:7],
            "early_n": len(E),
            "by_score": {k: {"n": v[0], "under": v[1]} for k, v in sorted(by_score.items())},
        }
    return out


_held = None


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
    data = build(sys.argv[1])
    with open(JSON_FILE, "w", encoding="utf8") as f:
        json.dump(data, f, separators=(",", ":"))
    for t, d in data["tours"].items():
        print(t, [(r["key"], r["n"], round(100 * r["under"] / max(1, r["n"]), 1)) for r in d["rows"]])

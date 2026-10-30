"""Live text commentary for WTA tour-level matches (250, 500, 1000, Grand
Slams), written here from the WTA's own point-by-point log
(api.wtatennis.com .../matches/<id>/point-by-point: every point's server,
winner, game score and time) plus the match stats.

The whole log comes back on each ask, so the commentary always runs from the
first point - nothing is kept between asks. No one publishes tennis
commentary as text, and nothing open carries the ATP's points: WTA only.
Aces and double faults aren't marked point by point - they show as totals.
"""
from __future__ import annotations

import threading
import time

import tennis_kb as kb
import tennis_live as live

CACHE_SECONDS = 4                              # the app asks every 5 seconds
ORDER = {"0": 0, "15": 1, "30": 2, "40": 3, "A": 4}

_lock = threading.Lock()
_cache: dict[tuple, tuple[float, dict]] = {}


def _get(url: str):
    with _lock:
        hit = _cache.get(url)
    if hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]
    data = kb.get_json(url)
    with _lock:
        _cache[url] = (time.time(), data)
        for k in [k for k, v in _cache.items() if time.time() - v[0] > 600]:
            del _cache[k]
    return data


def _games_line(a, b, x, y) -> str:
    if x == y:
        return f"{x}–{y}"
    return f"{a if x > y else b} leads {max(x, y)}–{min(x, y)}"


def lines_of(pbp: dict) -> list:
    """The commentary, oldest line first: [{at, kind, text}]."""
    names = {c.get("team"): c.get("lastName") or c.get("team") for c in pbp.get("contestants", [])}
    a, b = names.get("A", "A"), names.get("B", "B")
    nm = {"A": a, "B": b}
    games: dict[int, list] = {}
    sets = {"A": 0, "B": 0}
    prev: dict[tuple, tuple] = {}                 # (set, game) -> the game score so far
    out = []
    add = lambda at, kind, text: out.append({"at": at, "kind": kind, "text": text})
    for p in pbp.get("points", []):
        at, s, srv, win = p.get("timestamp"), p.get("setNumber"), p.get("server"), p.get("pointWinner")
        if win not in ("A", "B"):
            continue
        g = games.setdefault(s, [0, 0])
        if p.get("pointNumber") == 1:
            add(at, "info", f"Match starts · {nm.get(srv, srv)} to serve")
        sc = (p.get("scoreAfterPoint") or {}).get("gameScore") or {}
        qa, qb = str(sc.get("teamAScore") or "0"), str(sc.get("teamBScore") or "0")
        tb = g == [6, 6]
        # who won the point, from how the score moved (the feed's pointWinner slips at deuce)
        key = (s, p.get("gameNumber"))
        pa, pb = prev.get(key, ("0", "0"))
        prev[key] = (qa, qb)
        if "G" in (qa, qb):
            win = "A" if qa == "G" else "B"
        elif qa == qb == "40" and "A" in (pa, pb):
            win = "B" if pa == "A" else "A"
        elif tb and qa.isdigit() and qb.isdigit() and pa.isdigit() and pb.isdigit():
            win = "A" if int(qa) > int(pa) else "B" if int(qb) > int(pb) else win
        elif not tb:
            win = "A" if ORDER.get(qa, 0) > ORDER.get(pa, 0) else "B" if ORDER.get(qb, 0) > ORDER.get(pb, 0) else win
        if "G" in (qa, qb):                                       # the game's last point
            g[0 if win == "A" else 1] += 1
            x, y = g
            broke = not tb and srv in ("A", "B") and srv != win
            if tb:
                add(at, "game", f"{nm[win]} wins the tie-break")
            elif broke:
                add(at, "break", f"Break! {nm[win]} breaks · {_games_line(a, b, x, y)}")
            else:
                add(at, "game", f"{nm[win]} holds · {_games_line(a, b, x, y)}")
            if (max(x, y) >= 6 and abs(x - y) >= 2) or tb:
                sets[win] += 1
                add(at, "set", f"Set {nm[win]}, {max(x, y)}–{min(x, y)} · sets {a} {sets['A']}–{sets['B']} {b}")
            continue
        if tb:
            add(at, "point", f"Point {nm[win]} · tie-break {a} {qa}–{qb} {b}")
            continue
        if qa == qb == "40":
            score = "Deuce"
        elif "A" in (qa, qb):
            score = f"Advantage {a if qa == 'A' else b}"
        else:
            score = (f"{qb}–{qa}" if srv == "B" else f"{qa}–{qb}") + (f" ({nm[srv]} serving)" if srv in nm else "")
        add(at, "point", f"Point {nm[win]} · {score}")
        if srv in ("A", "B"):
            s_pt, r_pt = (qa, qb) if srv == "A" else (qb, qa)
            if r_pt == "A" or (r_pt == "40" and ORDER.get(s_pt, 0) < 3):
                n = 1 if r_pt == "A" else 3 - ORDER.get(s_pt, 0)
                recv = b if srv == "A" else a
                add(at, "bp", f"{['', '', 'Two ', 'Three '][n]}{'break points' if n > 1 else 'Break point'} for {recv}")
    status = (pbp.get("matchStatus") or "").lower()
    if out and status and status != "playing":
        w = "A" if sets["A"] > sets["B"] else "B"
        score = " ".join(f"{games[k][0]}-{games[k][1]}" for k in sorted(games))
        add(out[-1]["at"], "end", f"Match over · {nm[w]} wins {score}" if sets["A"] != sets["B"] else f"Match over · {score}")
    return out


def _stats(rows) -> dict:
    t = next((r for r in rows or [] if r.get("setnum") == 0), None)
    if not t:
        return {}
    pct = lambda w, n: round(100 * w / n) if n else None
    return {"aces": {"a": t.get("acesa") or 0, "b": t.get("acesb") or 0},
            "dfs": {"a": t.get("dblflta") or 0, "b": t.get("dblfltb") or 0},
            "first_won": {"a": pct(t.get("ptswon1stserva") or 0, t.get("ptsplayed1stserva") or 0),
                          "b": pct(t.get("ptswon1stservb") or 0, t.get("ptsplayed1stservb") or 0)},
            "bp": {"a": [t.get("breakptsconva") or 0, t.get("breakptsplayeda") or 0],
                   "b": [t.get("breakptsconvb") or 0, t.get("breakptsplayedb") or 0]}}


def feed(espn: str) -> dict:
    """The commentary of a live WTA match, found by its ESPN id (the Live tab's), newest line first."""
    with live._lock:
        hit = live._cache.get("WTA")
    m = next((x for x in (hit[1] if hit else []) if x["espn"] == espn), None)
    if not m:
        return {"lines": [], "found": False}
    names = [kb.norm(p["name"]) for p in m["players"]]
    for w in live._wta_points():
        if not (w["a"] and w["b"]) or "125" in (w.get("level") or ""):
            continue
        for flip in (False, True):
            x, y = (w["b"], w["a"]) if flip else (w["a"], w["b"])
            if names[0].endswith(x) and names[1].endswith(y):
                ev, year, mid = w["wta"]
                base = f"{live.WTA_API}/tournaments/{ev}/{year}/matches/{mid}"
                try:
                    pbp = _get(f"{base}/point-by-point")
                except Exception as err:
                    print(f"[tennis-feed] {mid}: {err}")
                    return {"lines": [], "found": False}
                try:
                    st = _stats(_get(f"{base}/stats"))
                except Exception:
                    st = {}
                side = (lambda d: [d.get("b"), d.get("a")]) if flip else (lambda d: [d.get("a"), d.get("b")])
                return {"found": True, "live": (pbp.get("matchStatus") or "").lower() == "playing",
                        "lines": list(reversed(lines_of(pbp))), "stats": {k: side(v) for k, v in st.items()}}
    return {"lines": [], "found": False}

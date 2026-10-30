"""Live text commentary for WTA tour-level matches (250, 500, 1000, Grand
Slams) - built here, point by point, from the WTA's own live scoring
(api.wtatennis.com: the score, the server, and the match stats).

No one publishes tennis commentary as text in a form the app can read, and
nothing open carries the ATP's points, so this is WTA only. A background
thread asks the WTA every 5 seconds while its tournaments are live and turns
each change into a line: the point and the score, deuce and advantage, break
points, aces and double faults, a hold or a break, the set, the result. The
lines are kept in memory (the last day; a server restart starts them again).
"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timezone

import tennis_kb as kb
import tennis_live as live

EVERY = 5                                      # seconds between asks while a match is live
KEEP = 600                                     # lines kept per match
ORDER = {"0": 0, "15": 1, "30": 2, "40": 3, "A": 4}

_lock = threading.Lock()
_feeds: dict[str, dict] = {}                   # "event/year/match" -> {a, b, snap, stats, lines, live, seen}
_started = False


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _tour_level(level: str) -> bool:
    lv = (level or "").lower()
    return "125" not in lv and "itf" not in lv


def _snap(m: dict) -> dict:
    games = lambda side: [int(m[f"ScoreSet{i}{side}"]) for i in range(1, 6) if str(m.get(f"ScoreSet{i}{side}") or "").isdigit()]
    return {"ga": games("A"), "gb": games("B"), "pa": live._pt(m.get("PointA")), "pb": live._pt(m.get("PointB")),
            "serve": m.get("Serve") if m.get("Serve") in ("A", "B") else None}


def _games_line(f, ga, gb) -> str:
    if not ga:
        return ""
    x, y = ga[-1], gb[-1]
    if x == y:
        return f"{x}–{y}"
    return f"{f['a'] if x > y else f['b']} leads {max(x, y)}–{min(x, y)}"


def _point_lines(f, old, new) -> list:
    """Lines for a change inside one game."""
    a, b = f["a"], f["b"]
    pa, pb, qa, qb = old["pa"], old["pb"], new["pa"], new["pb"]
    if (pa, pb) == (qa, qb) or qa is None or qb is None:
        return []
    tb = bool(new["ga"]) and new["ga"][-1] == 6 and new["gb"][-1] == 6
    out = []
    if tb:
        ia, ib = int(qa) if qa.isdigit() else 0, int(qb) if qb.isdigit() else 0
        oa, ob = (int(pa) if (pa or "").isdigit() else 0), (int(pb) if (pb or "").isdigit() else 0)
        who = a if ia > oa else b if ib > ob else None
        out.append(("point", f"{'Point ' + who + ' · ' if who else ''}tie-break {a} {ia}–{ib} {b}"))
        return out
    va, vb, ua, ub = ORDER.get(qa, 0), ORDER.get(qb, 0), ORDER.get(pa or "0", 0), ORDER.get(pb or "0", 0)
    if qa == qb == "40" and "A" in (pa, pb):
        who = b if pa == "A" else a
    else:
        who = a if va > ua else b if vb > ub else None
    if qa == qb == "40":
        score = "Deuce"
    elif "A" in (qa, qb):
        score = f"Advantage {a if qa == 'A' else b}"
    else:
        srv = new["serve"] or old["serve"]                     # the server's points said first
        score = f"{qb}–{qa}" if srv == "B" else f"{qa}–{qb}"
        score += f" ({a if srv != 'B' else b} serving)" if srv else ""
    out.append(("point", f"Point {who} · {score}" if who else score))
    srv = new["serve"]
    if srv:
        s_pt, r_pt = (qa, qb) if srv == "A" else (qb, qa)
        recv = b if srv == "A" else a
        if r_pt == "A" or (r_pt == "40" and ORDER.get(s_pt, 0) < 3):
            n = 1 if r_pt == "A" else 3 - ORDER.get(s_pt, 0)
            out.append(("bp", f"{['', '', 'Two ', 'Three '][n]}{'break points' if n > 1 else 'Break point'} for {recv}"))
    return out


def _game_lines(f, old, new) -> list:
    a, b = f["a"], f["b"]
    oa, ob, na, nb = old["ga"], old["gb"], new["ga"], new["gb"]
    out = []
    if len(na) > len(oa) and oa:                               # a set ended (and a new one began)
        i = len(oa) - 1
        x, y = na[i], nb[i]
        w, l = (a, b) if x > y else (b, a)
        sa = sum(1 for k in range(i + 1) if na[k] > nb[k])
        sb = (i + 1) - sa
        broke = bool(old["serve"]) and (old["serve"] == "A") != (w == a)
        out.append(("break" if broke else "game", f"{'Break! ' + w + ' breaks' if broke else w + ' holds'} to win the set"))
        out.append(("set", f"Set {w}, {max(x, y)}–{min(x, y)} · sets {a} {sa}–{sb} {b}"))
        return out
    if not oa or len(na) != len(oa):
        return out
    da, db = na[-1] - oa[-1], nb[-1] - ob[-1]
    if da + db != 1:
        out.append(("game", f"Games {a} {na[-1]}–{nb[-1]} {b}"))
        return out
    w = a if da else b
    if old["serve"]:
        broke = (old["serve"] == "A") != (w == a)
        out.append(("break" if broke else "game",
                    f"{'Break! ' + w + ' breaks' if broke else w + ' holds'} · {_games_line(f, na, nb)}"))
    else:
        out.append(("game", f"Game {w} · {_games_line(f, na, nb)}"))
    return out


def _stat_lines(f, old, new) -> list:
    out = []
    for key, kind, word in (("aces", "ace", "Ace"), ("dfs", "df", "Double fault")):
        for side, name in (("a", f["a"]), ("b", f["b"])):
            n = (new.get(key) or {}).get(side, 0) - (old.get(key) or {}).get(side, 0)
            if 0 < n < 4:
                out += [(kind, f"{word} · {name}")] * n
    return out


def _stats(ev, year, mid) -> dict | None:
    try:
        rows = kb.get_json(f"{live.WTA_API}/tournaments/{ev}/{year}/matches/{mid}/stats")
    except Exception:
        return None
    t = next((r for r in rows or [] if r.get("setnum") == 0), None)
    if not t:
        return None
    pct = lambda w, n: round(100 * w / n) if n else None
    return {"aces": {"a": t.get("acesa") or 0, "b": t.get("acesb") or 0},
            "dfs": {"a": t.get("dblflta") or 0, "b": t.get("dblfltb") or 0},
            "first_won": {"a": pct(t.get("ptswon1stserva") or 0, t.get("ptsplayed1stserva") or 0),
                          "b": pct(t.get("ptswon1stservb") or 0, t.get("ptsplayed1stservb") or 0)},
            "bp": {"a": [t.get("breakptsconva") or 0, t.get("breakptsplayeda") or 0],
                   "b": [t.get("breakptsconvb") or 0, t.get("breakptsplayedb") or 0]}}


def _add(f, lines):
    t = _now()
    for kind, txt in lines:
        f["lines"].append({"at": t, "kind": kind, "text": txt})
    del f["lines"][:-KEEP]


def _tick() -> bool:
    """One round over every live WTA tour-level tournament. True if any match is live."""
    events = [e for e in live._wta_live_events() if _tour_level(e[2])]
    any_live = False
    for ev, year, _ in events:
        try:
            ms = kb.get_json(f"{live.WTA_API}/tournaments/{ev}/{year}/matches?states=L").get("matches", [])
        except Exception as err:
            print(f"[tennis-feed] {ev}: {err}")
            continue
        here = set()
        for m in ms:
            if m.get("DrawMatchType") != "S" or m.get("MatchState") != "P":
                continue
            any_live = True
            key = f"{ev}/{year}/{m['MatchID']}"
            here.add(key)
            new = _snap(m)
            stats = _stats(ev, year, m["MatchID"])
            with _lock:
                f = _feeds.get(key)
                if not f:
                    f = _feeds[key] = {"a": m.get("PlayerNameLastA") or "A", "b": m.get("PlayerNameLastB") or "B",
                                       "full_a": f"{m.get('PlayerNameFirstA', '')} {m.get('PlayerNameLastA', '')}".strip(),
                                       "full_b": f"{m.get('PlayerNameFirstB', '')} {m.get('PlayerNameLastB', '')}".strip(),
                                       "snap": new, "stats": stats or {}, "lines": [], "live": True}
                    sets = " ".join(f"{x}-{y}" for x, y in zip(new["ga"], new["gb"]))
                    _add(f, [("info", f"Following live · {f['a']} v {f['b']}" + (f" · {sets}" if sets else ""))])
                else:
                    old = f["snap"]
                    lines = _stat_lines(f, f["stats"], stats) if stats and f["stats"] else []
                    if (old["ga"], old["gb"]) != (new["ga"], new["gb"]):
                        lines += _game_lines(f, old, new)
                    else:
                        lines += _point_lines(f, old, new)
                    _add(f, lines)
                    f["snap"] = new
                    if stats:
                        f["stats"] = stats
                f["seen"] = time.time()
        # matches that were live and aren't now: finished - the result line from the full list
        with _lock:
            gone = [k for k, f in _feeds.items() if f["live"] and k.startswith(f"{ev}/{year}/") and k not in here]
        if gone:
            try:
                full = {m["MatchID"]: m for m in kb.get_json(f"{live.WTA_API}/tournaments/{ev}/{year}/matches").get("matches", [])}
            except Exception:
                full = {}
            with _lock:
                for k in gone:
                    m = full.get(k.rsplit("/", 1)[1]) or {}
                    if m.get("MatchState") == "F":
                        _feeds[k]["live"] = False
                        _add(_feeds[k], [("end", f"Match over · {m.get('ResultString') or m.get('ScoreString') or ''}".strip())])
    with _lock:                                    # a day after, a match's lines go
        for k in [k for k, f in _feeds.items() if time.time() - f.get("seen", 0) > 86400]:
            del _feeds[k]
    return any_live


def _loop():
    while True:
        try:
            busy = _tick()
        except Exception as err:
            print(f"[tennis-feed] {err}")
            busy = False
        time.sleep(EVERY if busy else 60)


def start() -> None:
    """The background reader - started by the first live request, once."""
    global _started
    with _lock:
        if _started:
            return
        _started = True
    threading.Thread(target=_loop, name="tennis-feed", daemon=True).start()


def feed(espn: str) -> dict:
    """The commentary of a live WTA match, found by its ESPN id (the Live tab's)."""
    start()
    with live._lock:
        hit = live._cache.get("WTA")
    m = next((x for x in (hit[1] if hit else []) if x["espn"] == espn), None)
    if not m:
        return {"lines": [], "found": False}
    names = [kb.norm(p["name"]) for p in m["players"]]
    with _lock:
        for f in _feeds.values():
            a, b = kb.norm(f["a"]), kb.norm(f["b"])
            for flip in (False, True):
                x, y = (b, a) if flip else (a, b)
                if names[0].endswith(x) and names[1].endswith(y):
                    st = f["stats"] or {}
                    side = (lambda d: [d.get("b"), d.get("a")]) if flip else (lambda d: [d.get("a"), d.get("b")])
                    return {"found": True, "live": f["live"], "lines": list(reversed(f["lines"])),
                            "stats": {k: side(v) for k, v in st.items()}}
    return {"lines": [], "found": False}

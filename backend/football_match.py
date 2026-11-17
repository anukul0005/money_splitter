"""One football match on a page of its own (the match centre): ESPN's match
summary - line-ups, events, stats, each side's last five, the table, news -
found from our competition, day and the two names, plus what we have
ourselves: our odds, the bookmakers' prices, head-to-head from our results
and how much each side has rotated (today's starters against the players
who started its last five).

ESPN's public site API, no key (as football.py). Everything is held a while:
a live match half a minute, one to come ten minutes, a finished one hours.
"""
from __future__ import annotations

import difflib
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

import football as fb

ESPN = fb.ESPN_SOCCER
SLUG = {"PL": "eng.1", "PD": "esp.1", "SA": "ita.1", "BL1": "ger.1", "FL1": "fra.1", "CL": "uefa.champions",
        "ISL": "ind.1", "WC": "fifa.world", "EC": "uefa.euro"}
KEY_EVENTS = {"goal", "own-goal", "penalty---scored", "penalty---missed", "yellow-card", "red-card", "substitution"}
STATS = [("possessionPct", "Possession %"), ("totalShots", "Shots"), ("shotsOnTarget", "On target"),
         ("wonCorners", "Corners"), ("saves", "Saves"), ("passPct", "Pass accuracy"), ("foulsCommitted", "Fouls"),
         ("offsides", "Offsides"), ("yellowCards", "Yellow cards"), ("redCards", "Red cards")]


def _ymd(d: date) -> str:
    return d.strftime("%Y%m%d")


def _close(a: str, b: str) -> float:
    a, b = fb.squash(a), fb.squash(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if a in b or b in a:
        return 0.9
    return difflib.SequenceMatcher(None, a, b).ratio()


def _likeness(names: list[str], team: dict) -> float:
    cands = [team.get(k) for k in ("displayName", "shortDisplayName", "name", "location", "abbreviation") if team.get(k)]
    return max((_close(n, c) for n in names if n for c in cands), default=0.0)


def find_event(comp: str, day: date, home: list[str], away: list[str]) -> str | None:
    """ESPN's event id for this match: its competition's scoreboard (every
    competition's for national teams) on the day and the days either side
    (ESPN's day isn't always UTC's), the best fit for both names."""
    # our stored names ("Paris SG", "Man City") also by the spellings that map to them ("psg", "mancity")
    home = home + [k for k, v in fb._ALIAS.items() if v in home]
    away = away + [k for k, v in fb._ALIAS.items() if v in away]
    best, best_score = None, 0.0
    for d in (day, day - timedelta(days=1), day + timedelta(days=1)):
        try:
            if comp in SLUG:
                board = fb._hold(f"mc:{comp}{_ymd(d)}", 600, lambda d=d: fb._get(f"{ESPN}/{SLUG[comp]}/scoreboard?dates={_ymd(d)}"))
            else:
                board = fb._espn_all(d)
        except Exception:
            continue
        for e in board.get("events") or []:
            h, a, _ = fb._sides(e)
            if not h or not a:
                continue
            sh, sa = _likeness(home, h.get("team") or {}), _likeness(away, a.get("team") or {})
            if min(sh, sa) < 0.6:
                continue
            score = sh + sa - (0.05 if d != day else 0)
            if score > best_score:
                best, best_score = e["id"], score
        if best_score >= 1.9:
            break
    return best


def _summary(event: str, ttl: float) -> dict:
    return fb._hold(f"mcs:{event}", ttl, lambda: fb._get(f"{ESPN}/all/summary?event={event}"))


def _decimal(ml) -> float | None:
    """An American moneyline as a decimal price."""
    try:
        x = float(ml)
    except (TypeError, ValueError):
        return None
    if x == 0:
        return None
    return round(1 + (x / 100 if x > 0 else 100 / -x), 2)


def _player(p: dict) -> dict:
    a = p.get("athlete") or {}
    return {"id": a.get("id"), "name": a.get("displayName"), "short": a.get("shortName") or a.get("displayName"),
            "jersey": p.get("jersey"), "pos": (p.get("position") or {}).get("abbreviation"),
            "place": int(p["formationPlace"]) if str(p.get("formationPlace") or "").isdigit() else 0,
            "off": bool(p.get("subbedOut")), "on": bool(p.get("subbedIn"))}


def _lineup(r: dict) -> dict:
    roster = r.get("roster") or []
    starters = sorted((_player(p) for p in roster if p.get("starter")), key=lambda x: x["place"] or 99)
    subs = [_player(p) for p in roster if not p.get("starter")]
    return {"formation": r.get("formation"), "starters": starters, "subs": subs}


def _starters(event: str) -> dict[str, list[dict]]:
    """{ESPN team id: its starting XI} in one past match."""
    try:
        s = _summary(event, 7 * 86400)
    except Exception:
        return {}
    out = {}
    for r in s.get("rosters") or []:
        tid = str((r.get("team") or {}).get("id"))
        xi = [_player(p) for p in (r.get("roster") or []) if p.get("starter")]
        if xi:
            out[tid] = xi
    return out


def _rotation(team_id: str, past: list[dict], today: list[dict] | None) -> dict | None:
    """The side's regulars - those who started at least three of its last five -
    and, once today's line-up is out, which of them don't start."""
    ids = [e["id"] for e in past][:5]
    if not ids:
        return None
    with ThreadPoolExecutor(5) as ex:
        xis = [x.get(team_id) for x in ex.map(_starters, ids)]
    xis = [x for x in xis if x]
    if len(xis) < 3:
        return None
    count, who = {}, {}
    for xi in xis:
        for p in xi:
            count[p["id"]] = count.get(p["id"], 0) + 1
            who[p["id"]] = p
    regulars = sorted((pid for pid, n in count.items() if n >= 3), key=lambda pid: -count[pid])
    out = {"games": len(xis), "regulars": [{**who[pid], "starts": count[pid]} for pid in regulars]}
    if today:
        now = {p["id"] for p in today}
        out["missing"] = [who[pid]["name"] for pid in regulars if pid not in now]
        out["new"] = [p["name"] for p in today if count.get(p["id"], 0) == 0]
        out["kept"] = len(regulars) - len(out["missing"])
    return out


def _stats(s: dict) -> tuple[list[dict], list[str]]:
    teams = (s.get("boxscore") or {}).get("teams") or []
    if len(teams) != 2:
        return [], []
    side = {}
    for t in teams:
        st = {x.get("name"): x.get("displayValue") for x in t.get("statistics") or []}
        side[str((t.get("team") or {}).get("id"))] = st
    return [{"key": k, "label": lbl, "values": [v.get(k) for v in side.values()]} for k, lbl in STATS
            if all(v.get(k) not in (None, "") for v in side.values())], list(side)


def _events(s: dict, home_id: str) -> list[dict]:
    out = []
    for e in s.get("keyEvents") or []:
        kind = (e.get("type") or {}).get("type") or ""
        if kind not in KEY_EVENTS and not e.get("scoringPlay"):
            continue
        names = [((p.get("athlete") or {}).get("displayName")) for p in e.get("participants") or []]
        out.append({"minute": (e.get("clock") or {}).get("displayValue"), "kind": kind if kind in KEY_EVENTS else "goal",
                    "label": (e.get("type") or {}).get("text"), "home": str((e.get("team") or {}).get("id")) == home_id,
                    "players": [n for n in names if n]})
    return out


def _form(s: dict) -> dict[str, list[dict]]:
    out = {}
    for blk in s.get("lastFiveGames") or []:
        tid = str((blk.get("team") or {}).get("id"))
        out[tid] = [{"id": e.get("id"), "day": (e.get("gameDate") or "")[:10], "res": e.get("gameResult"), "score": e.get("score"),
                     "at": "away" if e.get("atVs") == "@" else "home", "opp": (e.get("opponent") or {}).get("displayName"),
                     "comp": e.get("leagueAbbreviation") or e.get("leagueName")}
                    for e in blk.get("events") or []]
        out[tid].sort(key=lambda x: x["day"], reverse=True)          # ESPN gives them oldest first
    return out


def _table(s: dict) -> list[dict]:
    groups = (s.get("standings") or {}).get("groups") or []
    rows = []
    for g in groups[:1]:
        for i, ent in enumerate(((g.get("standings") or {}).get("entries")) or []):
            st = {x.get("name") or x.get("type"): x.get("value") for x in ent.get("stats") or []}
            rows.append({"pos": int(st.get("rank") or i + 1), "team": ent.get("team"), "id": str(ent.get("id")),
                         "p": int(st.get("gamesPlayed") or 0), "w": int(st.get("wins") or 0), "d": int(st.get("ties") or 0),
                         "l": int(st.get("losses") or 0), "gd": int(st.get("pointDifferential") or 0), "pts": int(st.get("points") or 0)})
    return rows


def _news(s: dict, slug: str | None, team_ids: list[str]) -> list[dict]:
    """Each side's latest headlines (ESPN team news), else the competition's."""
    seen, out = set(), []

    def add(a, tid):
        if a.get("headline") and a["headline"] not in seen:
            seen.add(a["headline"])
            out.append({"headline": a["headline"], "description": a.get("description"), "published": a.get("published"),
                        "link": ((a.get("links") or {}).get("web") or {}).get("href"), "team": tid})
    if slug:
        for tid in team_ids:
            try:
                n = fb._hold(f"mcn:{slug}:{tid}", 1800, lambda tid=tid: fb._get(f"{ESPN}/{slug}/news?team={tid}"))
                for a in (n.get("articles") or [])[:6]:
                    add(a, tid)
            except Exception:
                pass
    for a in ((s.get("news") or {}).get("articles") or [])[:6]:
        add(a, None)
    return out[:16]


def _prices(s: dict) -> dict | None:
    """The first sportsbook ESPN shows (DraftKings): home / draw / away, decimal."""
    for o in s.get("odds") or s.get("pickcenter") or []:
        h = _decimal((o.get("homeTeamOdds") or {}).get("moneyLine"))
        a = _decimal((o.get("awayTeamOdds") or {}).get("moneyLine"))
        dr = _decimal((o.get("drawOdds") or {}).get("moneyLine"))
        if h and a and dr:
            return {"home": h, "draw": dr, "away": a, "book": (o.get("provider") or {}).get("name") or "ESPN",
                    "ou": o.get("overUnder"), "over": _decimal(o.get("overOdds")), "under": _decimal(o.get("underOdds"))}
    return None


def centre(event: str, comp: str) -> dict:
    """ESPN's side of the match centre, for event `event` of our competition `comp`."""
    first = _summary(event, 30)
    hdr = ((first.get("header") or {}).get("competitions") or [{}])[0]
    st = (hdr.get("status") or {}).get("type") or {}
    state = "finished" if st.get("completed") else "live" if st.get("state") == "in" else "upcoming"
    if state != "live":                   # hold it longer once we know it isn't moving
        fb._held[f"mcs:{event}"] = (fb._held[f"mcs:{event}"][0] + (21600 if state == "finished" else 270), first)
    s = first
    cs = hdr.get("competitors") or []
    home = next((c for c in cs if c.get("homeAway") == "home"), cs[0] if cs else {})
    away = next((c for c in cs if c.get("homeAway") == "away"), cs[-1] if cs else {})
    hid, aid = str((home.get("team") or {}).get("id")), str((away.get("team") or {}).get("id"))

    def team(c):
        t = c.get("team") or {}
        ls = [x.get("displayValue") for x in c.get("linescores") or []]
        rec = next((r.get("summary") for r in c.get("record") or [] if r.get("type") == "total"), None)
        return {"id": str(t.get("id")), "name": t.get("displayName"), "short": t.get("shortDisplayName") or t.get("displayName"),
                "abbr": t.get("abbreviation"), "crest": (t.get("logos") or [{}])[0].get("href") or t.get("logo"),
                "goals": int(c["score"]) if state != "upcoming" and str(c.get("score", "")).isdigit() else None,
                "half": ls[0] if ls else None, "record": rec}
    lineups = {}
    for r in s.get("rosters") or []:
        if r.get("roster"):
            lineups[str((r.get("team") or {}).get("id"))] = _lineup(r)
    form = _form(s)
    stats, order = _stats(s)
    if order and order[0] != hid:
        stats = [{**x, "values": x["values"][::-1]} for x in stats]
    rot = {}
    for tid in (hid, aid):
        past = [e for e in form.get(tid, []) if e["id"] != event]
        try:
            rot[tid] = _rotation(tid, past, (lineups.get(tid) or {}).get("starters"))
        except Exception:
            rot[tid] = None
    venue = (s.get("gameInfo") or {}).get("venue") or {}
    league = (s.get("header") or {}).get("league") or {}
    return {
        "event": event, "comp": comp, "comp_name": league.get("name"), "start": hdr.get("date"), "state": state,
        "status": st.get("shortDetail") or st.get("detail") or st.get("description"), "neutral": bool(hdr.get("neutralSite")),
        "venue": venue.get("fullName"), "city": (venue.get("address") or {}).get("city"),
        "attendance": (s.get("gameInfo") or {}).get("attendance"),
        "home": team(home), "away": team(away),
        "lineups": {"home": lineups.get(hid), "away": lineups.get(aid)},
        "rotation": {"home": rot.get(hid), "away": rot.get(aid)},
        "events": _events(s, hid), "stats": stats,
        "form": {"home": form.get(hid, []), "away": form.get(aid, [])},
        "table": _table(s), "espn_odds": _prices(s),
        "news": _news(s, SLUG.get(comp), [hid, aid]),
        "series": ((s.get("seasonseries") or [{}])[0] or {}).get("summary"),
    }

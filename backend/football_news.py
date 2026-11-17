"""Team news and its sentiment, for the betting model and the match centre.

Every six hours, each club in the five leagues: its latest ESPN news (no
key; about a month of articles a request), stored once each
(FootballNews), every headline + summary scored with a football word list
- no paid model needed. A match then reads each side's last 14 days:

    article score  s = tanh(sum of matched word weights / 3)        in [-1, 1]
    team sentiment   = sum_i s_i * 0.5^(age_i / 4 days) / sum_i 0.5^(age_i / 4 days)

with counts of the big signals - injuries, manager under pressure,
suspensions, dressing-room trouble - kept apart, since they matter more
than the overall tone. Saved daily from now on, so after a season it can
be tested as a model feature; until then it's a warning on the match.
(A Tavily key can widen the sources later: same table, same scoring.)
"""
from __future__ import annotations

import math
import re
import time
from datetime import datetime, timedelta, timezone

import football as fb

SLUGS = {"E0": "eng.1", "SP1": "esp.1", "I1": "ita.1", "D1": "ger.1", "F1": "fra.1"}
WINDOW_DAYS, HALF_LIFE = 14, 4.0

# (pattern, weight, flag) - matched on lower-case headline + summary
WORDS = [
    (r"\binjur(y|ies|ed)\b", -1.0, "injury"), (r"\bruled out\b", -1.5, "injury"), (r"\bsidelined\b", -1.2, "injury"),
    (r"\b(hamstring|acl|ligament|fracture|surgery|knock)\b", -0.8, "injury"), (r"\bdoubt(ful)?\b", -0.6, "injury"),
    (r"\bout for\b", -1.0, "injury"), (r"\bsetback\b", -0.8, "injury"),
    (r"\bsack(ed|ing)?\b", -2.0, "manager"), (r"\b(fired|axed|dismissed)\b", -1.8, "manager"),
    (r"\bunder (pressure|fire)\b", -1.5, "manager"), (r"\b(future in doubt|on the brink|ultimatum)\b", -1.5, "manager"),
    (r"\b(interim|caretaker)\b", -0.8, "manager"),
    (r"\b(suspend(ed)?|suspension|banned|ban)\b", -1.0, "suspension"), (r"\bred card\b", -0.6, "suspension"),
    (r"\b(rift|row|bust-up|fallout|unrest|turmoil|crisis|chaos|mutiny|feud)\b", -1.3, "dressing room"),
    (r"\b(defeat|beaten|loses|lost|slump|winless|struggl\w*|humiliat\w*|collapse|thrashed|crushed|stunned)\b", -0.7, None),
    (r"\b(poor|woeful|dismal|worst)\b", -0.6, None),
    (r"\b(returns?|back in training|fit again|recovered|available|boost)\b", 0.9, None),
    (r"\b(win|wins|won|victory|beat|beats|thrash(es)?|rout)\b", 0.6, None),
    (r"\b(unbeaten|streak|run of|straight win|top of|title (race|charge|challengers?)|dominant|perfect)\b", 0.9, None),
    (r"\b(new (deal|contract)|extension|signs|agrees)\b", 0.5, None),
]
_COMPILED = [(re.compile(p), w, f) for p, w, f in WORDS]
status = {"last": None, "stored": 0, "teams": 0}


def score(text: str) -> tuple[float, list[str]]:
    """(-1..1, flags) for one article's text."""
    t = (text or "").lower()
    total, flags = 0.0, []
    for rx, w, f in _COMPILED:
        if rx.search(t):
            total += w
            if f and f not in flags:
                flags.append(f)
    return math.tanh(total / 3), flags


def _teams(code: str) -> list[dict]:
    d = fb._hold(f"nt:{code}", 7 * 86400, lambda: fb._get(f"{fb.ESPN_SOCCER}/{SLUGS[code]}/teams"))
    return [t["team"] for t in ((d.get("sports") or [{}])[0].get("leagues") or [{}])[0].get("teams") or []]


def sync(db) -> int:
    """Every club's latest news into the store; returns new articles."""
    from sqlalchemy.dialects.postgresql import insert
    from models import FootballNews
    import football_lineups as fl
    season = fb._season_code(fb.current_season_start())
    n = 0
    for code, slug in SLUGS.items():
        try:
            teams = _teams(code)
        except Exception as e:
            print(f"[football-news] {code} teams: {e}", flush=True)
            continue
        for t in teams:
            ours = fl.our_name(db, code, season, t)
            try:
                d = fb._get(f"{fb.ESPN_SOCCER}/{slug}/news?team={t['id']}&limit=50")
            except Exception:
                continue
            rows = []
            for a in d.get("articles") or []:
                if not a.get("id") or not a.get("headline") or not a.get("published"):
                    continue
                s, flags = score(f"{a['headline']}. {a.get('description') or ''}")
                rows.append({"comp": code, "team": ours, "espn_team": str(t["id"]), "article": str(a["id"]),
                             "headline": a["headline"][:300], "description": (a.get("description") or "")[:1000],
                             "link": (((a.get("links") or {}).get("web") or {}).get("href") or "")[:400],
                             "published": datetime.fromisoformat(a["published"].replace("Z", "+00:00")),
                             "score": round(s, 4), "flags": ",".join(flags)})
            if rows:
                r = db.execute(insert(FootballNews).values(rows).on_conflict_do_nothing(constraint="ux_football_news"))
                n += r.rowcount or 0
                db.commit()
            status["teams"] += 1
            time.sleep(0.5)
    status["last"] = time.strftime("%Y-%m-%d %H:%M")
    status["stored"] += n
    return n


def team_sentiment(db, comp: str, team: str, asof: datetime | None = None) -> dict | None:
    """The side's last 14 days of news before `asof`: recency-weighted score, counts and flags."""
    from sqlalchemy import text
    asof = asof or datetime.now(timezone.utc)
    rows = db.execute(text(
        "SELECT headline, link, published, score, flags FROM football_news WHERE comp = :c AND team = :t "
        "AND published < :a AND published >= :f ORDER BY published DESC"),
        {"c": comp, "t": team, "a": asof, "f": asof - timedelta(days=WINDOW_DAYS)}).fetchall()
    if not rows:
        return None
    num = den = 0.0
    flags: dict[str, int] = {}
    for _, _, pub, s, fl_ in rows:
        age = (asof - pub).total_seconds() / 86400
        wt = 0.5 ** (age / HALF_LIFE)
        num += s * wt
        den += wt
        for f in filter(None, (fl_ or "").split(",")):
            flags[f] = flags.get(f, 0) + 1
    val = num / den if den else 0.0
    worst = sorted((r for r in rows if r[3] < -0.2), key=lambda r: r[3])[:3]
    return {"score": round(val, 3), "tone": "negative" if val < -0.15 else "positive" if val > 0.15 else "neutral",
            "articles": len(rows), "flags": flags,
            "worst": [{"headline": h, "link": l, "published": p.isoformat(), "score": s} for h, l, p, s, _ in worst]}


def loop() -> None:
    from database import get_session_factory
    time.sleep(300)
    while True:
        try:
            db = get_session_factory()()
            try:
                k = sync(db)
                print(f"[football-news] {k} new article(s) across the five leagues", flush=True)
            finally:
                db.close()
        except Exception as e:
            print(f"[football-news] {type(e).__name__}: {e}", flush=True)
        time.sleep(6 * 3600)

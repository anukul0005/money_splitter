"""Tennis news - the headlines the big tennis desks publish, newest first.

Read from the publishers' own RSS feeds (the Guardian, BBC Sport, Sky
Sports, ESPN, Tennis365), every POLL_EVERY while the app is up and
whenever the News page asks after that long. Each story links back to its
publisher; only the headline, a line of summary and the thumbnail the feed
itself carries are kept.

The same story told by three desks is one story: a headline sharing most of
its words with one already on file in the last two days is filed under it
(`story`) and shown as "also on ...", not as a new item.

New stories are pushed (not emailed - that'd be a mail per headline) to the
sports users, the headline cut to 20 words: a few one by one, the rest as a
"+N more". The very first read files what's there without a push, so the
first deploy doesn't fire a day's backlog.
"""
from __future__ import annotations

import html
import re
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

FEEDS = [
    ("The Guardian", "https://www.theguardian.com/sport/tennis/rss"),
    ("BBC Sport", "https://feeds.bbci.co.uk/sport/tennis/rss.xml"),
    ("Sky Sports", "https://www.skysports.com/rss/12110"),
    ("ESPN", "https://www.espn.com/espn/rss/tennis/news"),
    ("Tennis365", "https://www.tennis365.com/feed"),
]
POLL_EVERY = 600            # seconds
PUSH_EACH = 3               # stories pushed one by one per read; the rest as "+N more"
FRESH = timedelta(hours=3)  # only stories this new are pushed
HEADLINE_WORDS = 20
_MEDIA = "{http://search.yahoo.com/mrss/}"
_STOP = {"after", "with", "from", "that", "this", "have", "will", "into", "over", "about", "their", "says",
         "said", "what", "when", "they", "been", "were", "more", "than", "tennis", "open"}

_lock = threading.Lock()
_last = 0.0


def headline(title: str, words: int = HEADLINE_WORDS) -> str:
    w = (title or "").split()
    return " ".join(w[:words]) + ("…" if len(w) > words else "")


def _text(s: str | None) -> str:
    s = re.sub(r"<[^>]+>", " ", html.unescape(s or ""))
    return " ".join(s.split())


def _words(title: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]+", (title or "").lower()) if len(w) > 3 and w not in _STOP}


def _same_story(a: set[str], b: set[str]) -> bool:
    """Most of the shorter headline's words are in the other: "Zverev thrashes
    GB's Fery to reach Vienna semis" / "Zverev repeats Wimbledon victory over
    Fery to reach Vienna semi-finals"."""
    common = len(a & b)
    return common >= 3 and common / max(min(len(a), len(b)), 1) >= 0.6


def _when(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        d = parsedate_to_datetime(s)
    except (TypeError, ValueError):
        try:
            d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def parse(source: str, xml: bytes) -> list[dict]:
    """A feed's items: {source, title, link, published, summary, image}."""
    out = []
    root = ET.fromstring(xml)
    for it in root.iter("item"):
        title, link = _text(it.findtext("title")), (it.findtext("link") or "").strip()
        if not (title and link):
            continue
        image = None
        for tag in (f"{_MEDIA}content", f"{_MEDIA}thumbnail", "enclosure"):
            for el in it.iter(tag):
                url = el.get("url")
                if url and (tag != "enclosure" or (el.get("type") or "image").startswith("image")):
                    w = int(el.get("width") or 0)
                    if image is None or w > image[1]:
                        image = (url, w)
        out.append({"source": source, "title": title[:300], "link": link[:500],
                    "published": _when(it.findtext("pubDate")),
                    "summary": _text(it.findtext("description"))[:400] or None,
                    "image": image[0][:500] if image else None})
    return out


def _fetch() -> list[dict]:
    items = []
    for source, url in FEEDS:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "SplitEasy news reader"})
            with urllib.request.urlopen(req, timeout=15) as r:
                items += parse(source, r.read())
        except Exception as e:      # one desk down never stops the others
            print(f"[tennis-news] {source}: {e}")
    return items


def refresh() -> int:
    """Read every feed, file what's new, push the fresh stories. Returns how
    many items were new."""
    global _last
    if not _lock.acquire(blocking=False):
        return 0
    try:
        _last = time.time()
        items = _fetch()
        if not items:
            return 0
        from database import get_session_factory
        from models import TennisNews
        db = get_session_factory()()
        try:
            first = db.query(TennisNews.id).first() is None
            known = {l for (l,) in db.query(TennisNews.link)}
            now = datetime.now(timezone.utc)
            recent = [(r.id, _words(r.title)) for r in db.query(TennisNews)
                      .filter(TennisNews.story.is_(None), TennisNews.published >= now - timedelta(days=2)).all()]
            new = []
            for it in sorted(items, key=lambda x: x["published"] or now):
                if it["link"] in known:
                    continue
                known.add(it["link"])
                w = _words(it["title"])
                story = next((rid for rid, rw in recent if _same_story(w, rw)), None)
                row = TennisNews(**it, story=story, notified=first or story is not None)
                if row.published is None or row.published > now:
                    row.published = now
                db.add(row)
                db.flush()
                if story is None:
                    recent.append((row.id, w))
                    new.append(row)
            db.commit()
            fresh = [r for r in new if not r.notified and r.published >= now - FRESH]
            if fresh:
                _push(db, sorted(fresh, key=lambda r: r.published, reverse=True))
                for r in new:
                    r.notified = True
                db.commit()
            return len(new)
        finally:
            db.close()
    finally:
        _lock.release()


def _push(db, rows) -> None:
    from push import send_push_to_user
    from routers.tennis import ANALYTICS_USERS
    for name in ANALYTICS_USERS:
        for r in rows[:PUSH_EACH]:
            send_push_to_user(db, name, f"🎾 {r.source}", headline(r.title), url="/tennis/news")
        if len(rows) > PUSH_EACH:
            more = len(rows) - PUSH_EACH
            send_push_to_user(db, name, "🎾 Tennis news",
                              headline(f"+{more} more: " + " · ".join(r.title for r in rows[PUSH_EACH:])),
                              url="/tennis/news")


def maybe_refresh() -> None:
    """Re-read in the background when the last read is POLL_EVERY old."""
    if time.time() - _last > POLL_EVERY:
        threading.Thread(target=refresh, daemon=True, name="tennis-news").start()


def loop() -> None:
    """While the app is up: read the feeds every POLL_EVERY."""
    while True:
        try:
            refresh()
        except Exception as e:
            print(f"[tennis-news] refresh failed: {e}")
        time.sleep(POLL_EVERY)


def latest(db, limit: int = 80, source: str | None = None) -> list[dict]:
    from models import TennisNews
    q = db.query(TennisNews).filter(TennisNews.story.is_(None))
    if source:
        q = q.filter(TennisNews.source == source)
    rows = q.order_by(TennisNews.published.desc()).limit(limit).all()
    also: dict[int, list] = {}
    if rows:
        for d in db.query(TennisNews).filter(TennisNews.story.in_([r.id for r in rows])).all():
            also.setdefault(d.story, []).append({"source": d.source, "link": d.link})
    return [{"id": r.id, "title": r.title, "headline": headline(r.title), "link": r.link, "source": r.source,
             "published": r.published.isoformat() if r.published else None, "summary": r.summary,
             "image": r.image, "also": also.get(r.id, [])} for r in rows]

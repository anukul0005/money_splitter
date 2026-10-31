"""Sports news - tennis and football headlines, newest first.

Read from the publishers' own RSS feeds (tennis: the Guardian, BBC Sport,
Sky Sports, ESPN, Tennis365; football: the Guardian, ESPN), every
POLL_EVERY while the app is up and
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
    ("tennis", "The Guardian", "https://www.theguardian.com/sport/tennis/rss"),
    ("tennis", "BBC Sport", "https://feeds.bbci.co.uk/sport/tennis/rss.xml"),
    ("tennis", "Sky Sports", "https://www.skysports.com/rss/12110"),
    ("tennis", "ESPN", "https://www.espn.com/espn/rss/tennis/news"),
    ("tennis", "Tennis365", "https://www.tennis365.com/feed"),
    ("football", "The Guardian", "https://www.theguardian.com/football/rss"),
    ("football", "ESPN", "https://www.espn.com/espn/rss/soccer/news"),
]
SPORTS = {"tennis": "🎾", "football": "⚽"}
MAX_AGE = timedelta(days=7)   # a feed's old items (the Guardian's football one goes back years) stay out
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


def parse(source: str, xml: bytes, sport: str = "tennis") -> list[dict]:
    """A feed's items: {sport, source, title, link, published, summary, image}."""
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
        out.append({"sport": sport, "source": source, "title": title[:300], "link": link[:500],
                    "published": _when(it.findtext("pubDate")),
                    "summary": _text(it.findtext("description"))[:400] or None,
                    "image": image[0][:500] if image else None})
    return out


def _fetch() -> list[dict]:
    items = []
    for sport, source, url in FEEDS:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "SplitEasy news reader"})
            with urllib.request.urlopen(req, timeout=15) as r:
                items += parse(source, r.read(), sport)
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
            recent = [(r.id, r.sport, _words(r.title)) for r in db.query(TennisNews)
                      .filter(TennisNews.story.is_(None), TennisNews.published >= now - timedelta(days=2)).all()]
            new = []
            for it in sorted(items, key=lambda x: x["published"] or now):
                if it["link"] in known or (it["published"] and it["published"] < now - MAX_AGE):
                    continue
                known.add(it["link"])
                w = _words(it["title"])
                story = next((rid for rid, rs, rw in recent if rs == it["sport"] and _same_story(w, rw)), None)
                row = TennisNews(**it, story=story, notified=first or story is not None)
                if row.published is None or row.published > now:
                    row.published = now
                db.add(row)
                db.flush()
                if story is None:
                    recent.append((row.id, row.sport, w))
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
    from models import User
    for sport, icon in SPORTS.items():
        these = [r for r in rows if r.sport == sport]
        for name in ANALYTICS_USERS:
            u = db.query(User).filter(User.name.ilike(name)).first()
            if u is not None and not getattr(u, f"news_{sport}", True):
                continue        # turned off in Account
            for r in these[:PUSH_EACH]:
                send_push_to_user(db, name, f"{icon} {r.source}", headline(r.title), url=f"/tennis/news/{r.id}")
            if len(these) > PUSH_EACH:
                more = len(these) - PUSH_EACH
                send_push_to_user(db, name, f"{icon} {sport.title()} news",
                                  headline(f"+{more} more: " + " · ".join(r.title for r in these[PUSH_EACH:])),
                                  url=f"/tennis/news?sport={sport}")


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


# ── The article itself, read in the app (a reader view) ──────────────────────
from html.parser import HTMLParser

_SKIP = {"script", "style", "nav", "footer", "aside", "header", "form", "figure", "figcaption",
         "noscript", "button", "svg", "select", "template", "iframe"}
_BLOCKS = {"p": "p", "h2": "h", "h3": "h", "blockquote": "q", "li": "li"}
_BOX = re.compile(r"(article|story|content|body|post|entry|rich-?text)", re.I)
_JUNK = re.compile(r"(sign up|subscribe|newsletter|follow us|cookie|advertis|download the|read more:|"
                   r"get sky sports|watch .* live on|click here|all rights reserved|^image:|^photo:|"
                   r"terms and conditions|privacy policy|share this|related:|^read next|^also read|^more:|"
                   r"^want more from|preferred source)", re.I)
# A box of links to other stories set in the article ("More ATP Tour News",
# "Related", "Read more"): its heading and the headlines under it go
_LINK_BOX = re.compile(r"^(more\b|related\b|read more|also read|latest\b|recommended|you may|you might|"
                       r"trending|top stories|most read|popular)", re.I)


def _headline_like(text: str) -> bool:
    """A link to another story, not a sentence: short, no closing full stop."""
    return len(text) < 170 and not re.search(r"[.!?\"”’']\s*$", text)
_INVISIBLE = re.compile("[​-‏⁠﻿­]")
_VOID = {"br", "img", "hr", "meta", "link", "input", "source", "wbr", "area", "col", "embed", "track", "param"}


class _Reader(HTMLParser):
    """Every paragraph-ish block of a page with the box it sits in - the
    nearest <article>/<main>, or a div whose class says it's the story."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, str | None]] = []   # (tag, box id if this element is a box)
        self.skip = 0
        self.block: tuple[str, list[str], str] | None = None
        self.out: list[tuple[str, str, str]] = []        # (box, kind, text)
        self.n = 0

    def _box(self) -> str:
        for tag, box in reversed(self.stack):
            if box:
                return box
        return "page"

    def handle_starttag(self, tag, attrs):
        if tag in _VOID:
            if tag == "br" and self.block:
                self.block[1].append(" ")
            return
        a = dict(attrs)
        box = None
        if tag in ("article", "main") or (tag in ("div", "section") and _BOX.search(
                f"{a.get('class') or ''} {a.get('id') or ''} {a.get('data-component') or ''}")):
            self.n += 1
            box = f"{tag}{self.n}"
        self.stack.append((tag, box))
        if tag in _SKIP:
            self.skip += 1
        elif tag in _BLOCKS and not self.skip and self.block is None:
            self.block = (tag, [], self._box())

    def handle_endtag(self, tag):
        if tag in _VOID:
            return
        if self.block and tag == self.block[0]:
            text = " ".join(_INVISIBLE.sub("", "".join(self.block[1])).split())
            if text:
                self.out.append((self.block[2], _BLOCKS[tag], text))
            self.block = None
        # close back to the matching open tag (pages don't always nest cleanly)
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                for t, _b in self.stack[i:]:
                    if t in _SKIP:
                        self.skip -= 1
                del self.stack[i:]
                break

    def handle_data(self, data):
        if self.block and not self.skip:
            self.block[1].append(data)


def extract(page: str) -> list[dict]:
    """The story's text from an article page: the box with the most
    paragraph text, its paragraphs and sub-headings in order, boilerplate out."""
    r = _Reader()
    try:
        r.feed(page)
    except Exception:
        pass
    by_box: dict[str, int] = {}
    for box, kind, text in r.out:
        if kind == "p" and len(text) >= 40:
            by_box[box] = by_box.get(box, 0) + len(text)
    if not by_box:
        return []
    # an <article> wrapping the story's box counts the story's paragraphs too -
    # the box with the most text is the story
    best = max(by_box, key=by_box.get)
    out, seen = [], set()
    in_links = False
    for box, kind, text in r.out:
        if box != best or text in seen or _JUNK.search(text):
            continue
        if kind == "h" and _LINK_BOX.search(text):
            in_links = True           # "More ATP Tour News" - out, with its links
            continue
        if in_links:
            if _headline_like(text):
                continue
            in_links = False          # the story carries on below the box
        if kind == "li" or (kind == "p" and len(text) < 25 and not text.startswith(("\"", "“", "'"))):
            continue
        seen.add(text)
        out.append({"type": "h" if kind == "h" else ("quote" if kind == "q" else "p"), "text": text})
    while out and out[-1]["type"] == "h":
        out.pop()
    return out


_bodies: dict[int, list[dict]] = {}


def article(db, news_id: int) -> dict | None:
    """One story to read in the app: its headline, picture, source and text
    (read from the publisher's page once, then kept while the app is up)."""
    from models import TennisNews
    r = db.get(TennisNews, news_id)
    if not r:
        return None
    body = _bodies.get(r.id)
    if body is None:
        try:
            req = urllib.request.Request(r.link, headers={"User-Agent": "Mozilla/5.0 (compatible; SplitEasy reader)"})
            with urllib.request.urlopen(req, timeout=20) as resp:
                charset = resp.headers.get_content_charset() or "utf-8"
                body = extract(resp.read().decode(charset, "replace"))
        except Exception as e:
            print(f"[tennis-news] article {r.id}: {e}")
            body = []
        if body:
            if len(_bodies) > 300:
                _bodies.pop(next(iter(_bodies)))
            _bodies[r.id] = body
    also = [{"source": d.source, "link": d.link} for d in db.query(TennisNews).filter(TennisNews.story == r.id)]
    return {"id": r.id, "sport": r.sport, "title": r.title, "source": r.source, "link": r.link, "image": r.image,
            "published": r.published.isoformat() if r.published else None, "summary": r.summary,
            "body": body, "also": also}


def latest(db, limit: int = 80, source: str | None = None, sport: str | None = None) -> list[dict]:
    from models import TennisNews
    q = db.query(TennisNews).filter(TennisNews.story.is_(None))
    if source:
        q = q.filter(TennisNews.source == source)
    if sport:
        q = q.filter(TennisNews.sport == sport)
    rows = q.order_by(TennisNews.published.desc()).limit(limit).all()
    also: dict[int, list] = {}
    if rows:
        for d in db.query(TennisNews).filter(TennisNews.story.in_([r.id for r in rows])).all():
            also.setdefault(d.story, []).append({"source": d.source, "link": d.link})
    return [{"id": r.id, "sport": r.sport, "title": r.title, "headline": headline(r.title), "link": r.link, "source": r.source,
             "published": r.published.isoformat() if r.published else None, "summary": r.summary,
             "image": r.image, "also": also.get(r.id, [])} for r in rows]

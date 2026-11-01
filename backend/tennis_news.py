"""Sports news - tennis, football and badminton headlines, newest first.

Read from the publishers' own RSS feeds (tennis: the Guardian, BBC Sport,
Sky Sports, ESPN, Tennis365; football: the Guardian, ESPN; badminton:
Sportstar, Indian Express, BBC Sport, Hindustan Times, the Guardian), every
POLL_EVERY while the app is up and
whenever the News page asks after that long. Each story links back to its
publisher; only the headline, a line of summary and the thumbnail the feed
itself carries are kept.

The same story told by three desks is one story: a headline sharing most of
its words with one already on file in the last two days is filed under it
(`story`) and shown as "also on ...", not as a new item.

New stories are pushed (not emailed - that'd be a mail per headline) to the
app users (OPEN_SPORTS), each for the sports switched on in Account - the headline cut to 20 words: a few one by one, the rest as a
"+N more". The very first read files what's there without a push, so the
first deploy doesn't fire a day's backlog. A story naming the same people or
event as one already notified in the last REPEAT_WINDOW (`_repeats`: "PV
Sindhu wins Hylo Open" / "Sindhu beats Kjaersfelt to clinch ... Hylo Open
final") is filed but not pushed again - bar the first with the result in it
after a preview or a live blog.
"""
from __future__ import annotations

import difflib
import html
import re
import threading
import time
import unicodedata
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
    ("badminton", "Sportstar", "https://sportstar.thehindu.com/badminton/feeder/default.rss"),
    ("badminton", "Indian Express", "https://indianexpress.com/section/sports/badminton/feed/"),
    ("badminton", "BBC Sport", "https://feeds.bbci.co.uk/sport/badminton/rss.xml"),
    ("badminton", "Hindustan Times", "https://www.hindustantimes.com/feeds/rss/sports/badminton/rssfeed.xml"),
    ("badminton", "The Guardian", "https://www.theguardian.com/sport/badminton/rss"),
]
SPORTS = {"tennis": "🎾", "football": "⚽", "badminton": "🏸"}
# Sports whose news - the page and the pushes - is for every app user, not
# just the sports-section people (routers.tennis.ANALYTICS_USERS): all of them;
# each person picks theirs with the switches in Account
OPEN_SPORTS = set(SPORTS)


def sports_for(user) -> list[str]:
    """The sports whose news this person gets."""
    from routers.tennis import ANALYTICS_USERS
    if (getattr(user, "name", "") or "").lower() in ANALYTICS_USERS:
        return list(SPORTS)
    return [s for s in SPORTS if s in OPEN_SPORTS]
MAX_AGE = timedelta(days=7)   # a feed's old items (the Guardian's football one goes back years) stay out
POLL_EVERY = 600            # seconds
PUSH_EACH = 3               # stories pushed one by one per read; the rest as "+N more"
FRESH = timedelta(hours=3)  # only stories this new are pushed
HEADLINE_WORDS = 20
REPEAT_WINDOW = timedelta(hours=12)   # a story about the same names as one notified this recently isn't pushed
_MEDIA = "{http://search.yahoo.com/mrss/}"
_STOP = {"after", "with", "from", "that", "this", "have", "will", "into", "over", "about", "their", "says",
         "said", "what", "when", "they", "been", "were", "more", "than", "tennis", "open", "badminton"}

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


# Capitalised words in headlines that aren't names: they don't make two stories the same
_GENERIC = set("""
open live updates update list final finals title titles tour world championships championship masters cup
grand slam super series watch exclusive report video highlights photos preview result results score scores
day round quarterfinal quarterfinals semifinal semifinals semi semis how why what who when where the and
for after his her she they says vs wins beats win beat star stars new top first second third players player
men women mens womens singles doubles mixed match matches season year live blog analysis opinion explained
bwf atp wta itf india indian british american spanish french german italian chinese japanese korean danish
indonesian malaysian thai australian canadian russian serbian swiss polish czech kazakh filipino
monday tuesday wednesday thursday friday saturday sunday january february march april may june july august
september october november december
""".split())


def _norm_word(w: str) -> str:
    w = unicodedata.normalize("NFKD", w.replace("ø", "o").replace("Ø", "O").replace("æ", "ae").replace("ß", "ss"))
    return "".join(c for c in w if not unicodedata.combining(c)).lower().replace("'s", "").replace("’s", "")


def _names(title: str) -> list[set[str]]:
    """The names a headline is about: runs of capitalised words ("PV Sindhu",
    "Line Højmark Kjaersfelt", "Hylo Open"), each as its words, generic ones out."""
    out = []
    for chunk in re.split(r"[,:;|()\[\]\"“”‘]|\s[-–—]\s|\s'|'\s", title or ""):
        run: list[str] = []
        for w in re.findall(r"[^\W\d_][\w'’-]*", chunk) + [""]:
            if w[:1].isupper():
                run.append(w)
                continue
            words = {n for n in (_norm_word(x) for x in run) if len(n) >= 3 and n not in _GENERIC}
            if words:
                out.append(words)
            run = []
    return out


def _alike(a: str, b: str) -> bool:
    """The same word, or one misspelt ("Kjaersfelt" / "Kjadersfelt")."""
    return a == b or (min(len(a), len(b)) >= 5 and difflib.SequenceMatcher(None, a, b).ratio() >= 0.85)


def _repeats(a: list[set[str]], b: list[set[str]]) -> bool:
    """Two headlines about the same thing: two or more of the names in one are in the other."""
    hit = sum(1 for x in a if any(_alike(u, v) for y in b for u in x for v in y))
    return hit >= 2


_RESULT = re.compile(r"\b(wins?|won|beats?|beaten|clinch\w*|crowned|champion|lifts?|stuns?|knocks? out|"
                     r"defeats?|downs?|edges?|thrash\w*|routs?|triumphs?|retains?|claims?|takes? the title)\b", re.I)
_NOT_RESULT = re.compile(r"\b(live|vs?\.?|preview|prediction|eyes?|to face|faces|aims?|targets?|hopes?|can|will)\b", re.I)


def _result(title: str) -> bool:
    """A headline with the outcome in it ("Sindhu wins Hylo Open"), not a preview or a live blog."""
    return bool(_RESULT.search(title or "")) and not _NOT_RESULT.search(title or "")


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
            # a sport read for the first time (one just added) is filed quietly too
            had = {sp for (sp,) in db.query(TennisNews.sport).distinct()}
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
                row = TennisNews(**it, story=story, notified=first or story is not None or it["sport"] not in had)
                if row.published is None or row.published > now:
                    row.published = now
                db.add(row)
                db.flush()
                if story is None:
                    recent.append((row.id, row.sport, w))
                    new.append(row)
            db.commit()
            fresh = _not_repeats(db, [r for r in new if not r.notified and r.published >= now - FRESH], now)
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


def _not_repeats(db, rows, now) -> list:
    """The stories to push: none about the same names as one notified in the
    last REPEAT_WINDOW, or as one earlier in this read."""
    from models import TennisNews
    if not rows:
        return rows
    ids = {r.id for r in rows}
    seen: dict[str, list] = {}               # sport -> [(names, was a result)]
    for old in db.query(TennisNews).filter(TennisNews.notified.is_(True),
                                          TennisNews.published >= now - REPEAT_WINDOW).all():
        if old.id not in ids:
            seen.setdefault(old.sport, []).append((_names(old.title), _result(old.title)))
    keep = []
    for r in sorted(rows, key=lambda r: r.published):
        n, res = _names(r.title), _result(r.title)
        same = [was for o, was in seen.get(r.sport, []) if _repeats(n, o)]
        # the same names again: skipped - unless it's the outcome after a preview or a live blog
        if same and not (res and not any(same)):
            continue
        seen.setdefault(r.sport, []).append((n, res))
        keep.append(r)
    return keep


def _push(db, rows) -> None:
    from push import send_push_to_user
    from routers.tennis import ANALYTICS_USERS
    from models import User
    everyone = None
    for sport, icon in SPORTS.items():
        these = [r for r in rows if r.sport == sport]
        if not these:
            continue
        if sport in OPEN_SPORTS:
            if everyone is None:
                everyone = db.query(User).all()
            people = everyone
        else:
            people = [u for u in (db.query(User).filter(User.name.ilike(n)).first() for n in ANALYTICS_USERS) if u]
        for u in people:
            if not getattr(u, f"news_{sport}", True):
                continue        # turned off in Account
            name = u.name
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
                   r"^want more from|preferred source|^published on\b|^updated on\b)", re.I)
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
        self.out: list[tuple[tuple, str, str]] = []      # (boxes it sits in, outermost first; kind; text)
        self.n = 0

    def _box(self) -> tuple:
        return ("page",) + tuple(box for _t, box in self.stack if box)

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
    """The story's text from an article page: its paragraphs and sub-headings
    in order, boilerplate out. The story is the innermost box holding most
    of the page's paragraph text - so a story the site splits over several
    blocks (BBC, Indian Express) comes out whole, not just its longest block."""
    r = _Reader()
    try:
        r.feed(page)
    except Exception:
        pass
    by_box: dict[str, int] = {}
    depth: dict[str, int] = {}
    for boxes, kind, text in r.out:
        if kind == "p" and len(text) >= 40:
            for i, b in enumerate(boxes):
                by_box[b] = by_box.get(b, 0) + len(text)
                depth[b] = i
    if not by_box:
        return []
    top = max(by_box.values())
    best = max((b for b, n in by_box.items() if n >= 0.8 * top), key=lambda b: depth[b])
    out, seen = [], set()
    in_links = False
    for boxes, kind, text in r.out:
        if best not in boxes or text in seen or _JUNK.search(text):
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


def latest(db, limit: int = 80, source: str | None = None, sports: list[str] | None = None) -> list[dict]:
    from models import TennisNews
    q = db.query(TennisNews).filter(TennisNews.story.is_(None))
    if source:
        q = q.filter(TennisNews.source == source)
    if sports:
        q = q.filter(TennisNews.sport.in_(sports))
    rows = q.order_by(TennisNews.published.desc()).limit(limit).all()
    also: dict[int, list] = {}
    if rows:
        for d in db.query(TennisNews).filter(TennisNews.story.in_([r.id for r in rows])).all():
            also.setdefault(d.story, []).append({"source": d.source, "link": d.link})
    return [{"id": r.id, "sport": r.sport, "title": r.title, "headline": headline(r.title), "link": r.link, "source": r.source,
             "published": r.published.isoformat() if r.published else None, "summary": r.summary,
             "image": r.image, "also": also.get(r.id, [])} for r in rows]

"""AI trip planner for a discussion: "Plan a 4-day Jodhpur and Jaisalmer
trip for 5 friends from Delhi, 20-24 December, under Rs 12,000 each".

A bounded agent, all on free tiers:
  1. understand  - the AI turns the request into a trip spec (who, where,
                   when, budget); people default to the discussion's members
  2. research    - the tools, each a real source:
                     Nominatim (OpenStreetMap)  places -> coordinates
                     OSRM                        road distance and time
                     Open-Meteo                  forecast, or last year's
                                                 weather on those dates
                     Wikivoyage                  sights, food, stays, getting
                                                 there - often with prices
                     Tavily (if TAVILY_API_KEY)  live web search: fares,
                                                 hotel rates, entry fees;
                                                 the AI picks the searches
  3. draft       - the AI writes the day-wise plan; every price says where it
                   came from: "found" (a source given, by id) or "estimate"
                   (with how it was worked out) - a claimed source that isn't
                   one is downgraded to an estimate
  4. budget      - plain Python adds it up (per person, group, by category);
                   over budget, the AI gets one round to bring it in
A revision ("make day 2 cheaper") reuses its plan's research when the
places haven't changed. Runs in a thread; every step is written to the
plan's `steps_json` as it happens, for the Plan tab to show.
"""
from __future__ import annotations

import json
import math
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

UA = "Settle trip planner (https://www.settle0.in.net)"
IST = timezone(timedelta(hours=5, minutes=30))
CATEGORIES = ("transport", "stay", "food", "activity", "local", "other")
MAX_SEARCHES = 6
STALE_AFTER = timedelta(minutes=10)            # a "running" plan older than this was cut off


# ── plumbing ───────────────────────────────────────────────────────────────

def _get_json(url: str, timeout: int = 20) -> dict | list:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _post_json(url: str, body: dict, headers: dict, timeout: int = 60) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={
        "Content-Type": "application/json", "Accept": "application/json", "User-Agent": UA, **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _gemini_one(model: str, system: str, user: str, max_tokens: int) -> dict:
    from attachment_reader import GEMINI_URL
    from database import get_settings
    body = {"model": model, "temperature": 0.3, "max_tokens": max_tokens,
            "response_format": {"type": "json_object"}, "reasoning_effort": "low",
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    for attempt in range(2):
        try:
            d = _post_json(GEMINI_URL, body, {"Authorization": f"Bearer {get_settings().gemini_api_key}"}, timeout=120)
        except urllib.error.HTTPError as e:
            if e.code == 400 and attempt == 0:                # a model that won't take reasoning_effort
                body.pop("reasoning_effort", None)
                continue
            raise
        text = d["choices"][0]["message"]["content"]
        m = re.search(r"\{.*\}", text, re.S)
        out = json.loads(m.group(0) if m else text)
        if not isinstance(out, dict):
            raise ValueError("not an object")
        return out
    raise RuntimeError("no answer")


def _gemini(system: str, user: str, max_tokens: int) -> dict:
    """The first two models asked at once - whichever answers first wins (one
    of them is often slow) - then the rest in turn."""
    from attachment_reader import GEMINI_MODELS
    from concurrent.futures import FIRST_COMPLETED, wait
    from database import get_settings
    if not get_settings().gemini_api_key:
        raise RuntimeError("no Gemini key")
    last: Exception | None = None
    pool = ThreadPoolExecutor(max_workers=2)
    pending = {pool.submit(_gemini_one, m, system, user, max_tokens) for m in GEMINI_MODELS[:2]}
    try:
        while pending:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            for f in done:
                try:
                    return f.result()
                except Exception as e:
                    last = e
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    for model in GEMINI_MODELS[2:]:
        try:
            return _gemini_one(model, system, user, max_tokens)
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (401, 403):
                break
        except Exception as e:
            last = e
    raise last or RuntimeError("Gemini didn't answer")


def _llm(system: str, user: str, max_tokens: int = 12000, quick: bool = False) -> dict:
    """One JSON answer. `quick` (a short job - reading the request, picking
    searches): Groq first, it answers in seconds; else Gemini first, for the
    long plan-writing prompt. Each falls back to the other."""
    import ai_text
    tries = [lambda: ai_text.chat_json(system, user[:24000], temperature=0.3),
             lambda: _gemini(system, user, max_tokens)]
    if not quick:
        tries.reverse()
    last: Exception | None = None
    for t in tries:
        try:
            return t()
        except Exception as e:
            last = e
    raise RuntimeError(f"The AI couldn't be reached ({type(last).__name__})") from last


# ── the tools ──────────────────────────────────────────────────────────────

_geo_lock = threading.Lock()
_geo_cache: dict[str, dict | None] = {}
_geo_last = [0.0]


def geocode(place: str) -> dict | None:
    """Nominatim, at most one request a second (its usage policy), cached."""
    k = place.strip().lower()
    if k in _geo_cache:
        return _geo_cache[k]
    with _geo_lock:
        wait = 1.1 - (time.time() - _geo_last[0])
        if wait > 0:
            time.sleep(wait)
        try:
            # As named - the trip can be anywhere ("Edinburgh", "Jaisalmer" both resolve)
            q = urllib.parse.urlencode({"q": place, "format": "json", "limit": 1})
            rows = _get_json(f"https://nominatim.openstreetmap.org/search?{q}")
            hit = {"name": place, "lat": float(rows[0]["lat"]), "lon": float(rows[0]["lon"]),
                   "label": rows[0]["display_name"]} if rows else None
        except Exception as e:
            print(f"[trip] geocode {place!r}: {e!r}")
            hit = None
        _geo_last[0] = time.time()
    _geo_cache[k] = hit
    return hit


def road_legs(points: list[dict]) -> list[dict]:
    """OSRM's public router: each leg's road km and hours."""
    legs = []
    for a, b in zip(points, points[1:]):
        try:
            r = _get_json(f"https://router.project-osrm.org/route/v1/driving/"
                          f"{a['lon']},{a['lat']};{b['lon']},{b['lat']}?overview=false")["routes"][0]
            legs.append({"from": a["name"], "to": b["name"], "km": round(r["distance"] / 1000),
                         "hours": round(r["duration"] / 3600, 1)})
        except Exception as e:
            print(f"[trip] route {a['name']}->{b['name']}: {e!r}")
    return legs


def weather(place: dict, start: date, end: date) -> dict | None:
    """Open-Meteo: the forecast when the dates are within its 16 days,
    otherwise the same dates last year (what to expect, not a forecast)."""
    today = datetime.now(IST).date()
    daily = "temperature_2m_max,temperature_2m_min"
    if start <= today + timedelta(days=15) and end >= today:
        url = (f"https://api.open-meteo.com/v1/forecast?latitude={place['lat']}&longitude={place['lon']}"
               f"&daily={daily},precipitation_probability_max&timezone=auto"
               f"&start_date={max(start, today)}&end_date={min(end, today + timedelta(days=15))}")
        kind = "forecast"
    else:
        try:
            s, e = start.replace(year=start.year - 1), end.replace(year=end.year - 1)
        except ValueError:                                  # 29 Feb
            s, e = start - timedelta(days=365), end - timedelta(days=365)
        url = (f"https://archive-api.open-meteo.com/v1/archive?latitude={place['lat']}&longitude={place['lon']}"
               f"&daily={daily},precipitation_sum&timezone=auto&start_date={s}&end_date={e}")
        kind = "last_year"
    try:
        d = _get_json(url)["daily"]
    except Exception as e:
        print(f"[trip] weather {place['name']}: {e!r}")
        return None
    days = []
    for i, t in enumerate(d.get("time", [])):
        row = {"date": t, "max": d["temperature_2m_max"][i], "min": d["temperature_2m_min"][i]}
        if "precipitation_probability_max" in d:
            row["rain_chance"] = d["precipitation_probability_max"][i]
        if "precipitation_sum" in d:
            row["rain_mm"] = d["precipitation_sum"][i]
        days.append(row)
    return {"place": place["name"], "kind": kind, "days": days}


_WIKI_STRIP = [(re.compile(r"\{\{[^{}]*\}\}"), ""), (re.compile(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]"), r"\1"),
               (re.compile(r"\[https?://\S+ ([^\]]*)\]"), r"\1"), (re.compile(r"<[^>]+>"), ""),
               (re.compile(r"'{2,}"), ""), (re.compile(r"\n{2,}"), "\n")]


def _plain(wikitext: str) -> str:
    s = wikitext
    for _ in range(3):                                   # nested templates
        for rx, rep in _WIKI_STRIP[:1]:
            s = rx.sub(rep, s)
    for rx, rep in _WIKI_STRIP[1:]:
        s = rx.sub(rep, s)
    return s.strip()


def wikivoyage(place: str) -> dict | None:
    """Wikivoyage's page on a place: how to get in, and its listings (see,
    do, eat, sleep) with their prices where the page gives them."""
    try:
        q = urllib.parse.urlencode({"action": "parse", "page": place, "prop": "wikitext", "format": "json",
                                    "formatversion": 2, "redirects": 1})
        d = _get_json(f"https://en.wikivoyage.org/w/api.php?{q}")
        text, title = d["parse"]["wikitext"], d["parse"]["title"]
    except Exception:
        return None
    sections = {m.group(1).strip().lower(): m.start() for m in re.finditer(r"^==\s*([^=]+?)\s*==\s*$", text, re.M)}

    def section(name: str) -> str:
        if name not in sections:
            return ""
        start = sections[name]
        after = [p for p in sections.values() if p > start]
        return text[start:min(after) if after else len(text)]

    listings = []
    for kind, body in re.findall(r"\{\{\s*(see|do|eat|drink|sleep)\s*\|(.*?)\}\}", text, re.S | re.I):
        f = {m.group(1).strip().lower(): m.group(2).strip()
             for m in re.finditer(r"\|\s*([a-z]+)\s*=\s*([^|]*)", "|" + body)}
        if f.get("name"):
            listings.append({"kind": kind.lower(), "name": _plain(f["name"])[:80],
                             "price": _plain(f.get("price", ""))[:120], "about": _plain(f.get("content", ""))[:160]})
    return {"title": title, "url": f"https://en.wikivoyage.org/wiki/{urllib.parse.quote(title.replace(' ', '_'))}",
            "get_in": _plain(section("get in"))[:1800], "get_around": _plain(section("get around"))[:600],
            "listings": listings[:45]}


def web_search(query: str) -> list[dict]:
    """Tavily - nothing when no key is set. Pages from the past year first
    (stale fares and rates are the commonest wrong answer); if that finds
    nothing, any age."""
    from database import get_settings
    key = get_settings().tavily_api_key
    if not key:
        return []
    d = {}
    for extra in ({"time_range": "year"}, {}):
        try:
            d = _post_json("https://api.tavily.com/search",
                           {"query": query, "max_results": 5, "search_depth": "basic", **extra},
                           {"Authorization": f"Bearer {key}"}, timeout=30)
            if d.get("results"):
                break
        except Exception as e:
            print(f"[trip] search {query!r} {extra}: {e!r}")
    checked = datetime.now(IST).date().isoformat()
    return [{"title": r.get("title", "")[:150], "url": r.get("url", ""), "text": (r.get("content") or "")[:700],
             "checked": checked} for r in d.get("results", []) if r.get("url")]


_fx_cache: dict[tuple[str, str], float] = {}


def inr_rate(code: str) -> float | None:
    """Rupees for one unit of `code`, today: Frankfurter (ECB rates), else
    open.er-api.com - both free, no key. Cached for the day."""
    code = code.upper()
    if code == "INR":
        return 1.0
    key = (code, datetime.now(IST).date().isoformat())
    if key in _fx_cache:
        return _fx_cache[key]
    rate = None
    for url, pick in ((f"https://api.frankfurter.dev/v1/latest?base={code}&symbols=INR", lambda d: d["rates"]["INR"]),
                      (f"https://open.er-api.com/v6/latest/{code}", lambda d: d["rates"]["INR"])):
        try:
            rate = float(pick(_get_json(url)))
            break
        except Exception as e:
            print(f"[trip] rate {code}: {url.split('/')[2]} {e!r}")
    if rate:
        _fx_cache[key] = rate
    return rate


def to_rupees(plan: dict) -> dict:
    """Every item's cost into rupees at today's rate - the AI writes prices in
    the currency they're in and never converts. Records the rates used."""
    rates: dict[str, float] = {}
    for d in plan["days"]:
        for it in d["items"]:
            cur = it.get("currency") or "INR"
            if cur == "INR" or not it["cost"]:
                it["currency"] = "INR"
                continue
            if cur not in rates:
                rates[cur] = inr_rate(cur)
            if rates[cur]:
                it["cost_local"] = it["cost_local"] if it.get("cost_local") is not None else it["cost"]
                it["cost"] = round(it["cost_local"] * rates[cur])
            else:                                   # no rate: keep the figure, but say it isn't in rupees
                it["basis"] = f"{it['basis']} (in {cur} - no exchange rate today)".strip()
    plan["fx"] = {c: round(r, 2) for c, r in rates.items() if r}
    plan["fx_date"] = datetime.now(IST).date().isoformat() if plan["fx"] else None
    return plan


def _trip_month(spec: dict) -> str:
    """"December 2026" - the trip's month (its start), else this month."""
    d = _date(spec.get("start_date")) or datetime.now(IST).date()
    return d.strftime("%B %Y")


def fix_query_dates(q: str, when: str) -> str:
    """A search about another year or month gets the trip's instead - the AI
    picking searches doesn't always know what year it is."""
    month, year = when.split()
    q = re.sub(r"\b(19|20)\d{2}\b", year, q)
    q = re.sub(r"\b(January|February|March|April|May|June|July|August|September|October|November|December)\b",
               month, q, flags=re.I)
    if year not in q:
        q = f"{q} {when}"
    return q


# ── the prompts ────────────────────────────────────────────────────────────

_SPEC = """You turn a group trip request (the group lives in India; the trip can be anywhere in the world) into a trip
spec for a planner. Today is {today}. Budgets are in rupees.
Respond with ONLY a JSON object:
{{"origin": "city the group starts from ('' if not said)",
  "destinations": ["places to visit, in visiting order"],
  "start_date": "YYYY-MM-DD or null", "end_date": "YYYY-MM-DD or null", "days": 0,
  "travellers": 0, "rooms": null,
  "budget_per_person": null, "budget_total": null,
  "transport_pref": "", "stay_pref": "", "interests": [], "food": "", "notes": ""}}
Rules: a date without a year is the next one after today. "4-day trip between 20-24 December" means 4 days from
the 20th (days wins over the range). travellers: the number the request gives ("5 friends" = 5), else the
group size given below. Amounts in rupees as numbers ("12k" = 12000, "1.2 lakh" = 120000); a per-person budget goes
in budget_per_person, a whole-trip one in budget_total. rooms only when the request says. Never invent places
the request doesn't name, except when it asks for suggestions."""

_SEARCHES = """You pick web searches for a trip planner (the group lives in India; the trip can be anywhere): at most {n},
short Google-style queries for
what most changes the cost and the plan - fares between the origin and each place and between places (train, bus,
flight - match the transport preference), hotel or guest-house prices per night in each place (match the stay
preference and budget), entry fees of the main sights, and the paid activities the interests name (e.g. desert
safari or camp prices). Today is {today}. The trip is in {when}: put "{when}" in each query that's about a price -
never any other month or year. Respond with ONLY JSON:
{{"searches": [{{"q": "...", "for": "transport|stay|activity|food|local"}}]}}"""

_PLAN = """You are Settle's trip planner. Write a realistic day-by-day plan for this group trip (the group lives in
India; the trip can be anywhere) from the facts and numbered sources given.
Rules:
- Every item that costs money has `cost` (a number) in `currency` (ISO code: "INR", "GBP", "EUR", "USD", "THB"...)
  - the currency the price is actually in: a source's price exactly as the source states it, an estimate in the
  local currency of where it's paid. NEVER convert between currencies yourself - the app converts at today's rate.
  Flights or trains booked from India are usually in INR.
- Every costed item has `per`: "person" (each person pays it - a train
  ticket, an entry fee, a meal), "group" (one cost shared by all - a hired cab, a guide) or "room" (per room per
  night - stays only, one stay item per night, using the room count given).
- `source` is "found" ONLY when the price is taken from a given source: list them in `source_ids` (e.g. ["S3"])
  and use the figure that source states (a range: its middle). Otherwise "estimate", with `basis` saying how it
  was estimated ("typical 3AC fare Delhi-Jodhpur"). Never cite a source that wasn't given, never invent one.
- Web prices are what the page showed on the day it was checked (given with each source), often for other
  dates ("cheapest in the next 14 days", last season's rates). When a found price isn't for the trip's own dates,
  `basis` says so ("lowest fare on the page, for early Nov - December fares may differ"). Fares and hotel rates
  usually rise around Christmas, New Year, Diwali and long weekends - say so where it applies.
- Cover everything the trip costs: getting there and back, between places, local transport, stays, food (one
  item a day per person is fine), entry fees and activities. Free things cost 0.
- Include each place's main sights and the experience it is known for (the reason people go there), unless the
  request rules it out.
- When a per-person budget is given, plan to fit it (sleeper or 3AC trains, buses, guest houses, shared cabs)
  - but never leave a cost out to fit.
- Use the road times given to keep days realistic, and the weather (hot afternoons, rain) when choosing what
  goes when. Day 1 is the start date.
Respond with ONLY JSON:
{"title": "...", "summary": "2-3 sentences", "days": [{"day": 1, "date": "YYYY-MM-DD", "city": "...",
  "title": "...", "items": [{"time": "07:30", "title": "...", "detail": "...",
  "category": "transport|stay|food|activity|local|other", "cost": 0, "currency": "INR", "per": "person|group|room",
  "source": "found|estimate", "source_ids": [], "basis": "..."}]}],
 "tips": ["..."], "assumptions": ["..."]}"""


# ── the steps ──────────────────────────────────────────────────────────────

def _num(v) -> float | None:
    try:
        n = float(v)
        return n if math.isfinite(n) and n >= 0 else None
    except (TypeError, ValueError):
        return None


def _date(v) -> date | None:
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def normalise_spec(raw: dict, members: int) -> dict:
    spec = {k: raw.get(k) for k in ("origin", "destinations", "start_date", "end_date", "days", "travellers",
                                     "rooms", "budget_per_person", "budget_total", "transport_pref", "stay_pref",
                                     "interests", "food", "notes")}
    spec["origin"] = str(spec["origin"] or "").strip()[:80]
    spec["destinations"] = [str(x).strip()[:80] for x in (spec["destinations"] or []) if str(x).strip()][:6]
    spec["interests"] = [str(x)[:60] for x in (spec["interests"] or [])][:10]
    spec["travellers"] = max(1, min(60, int(_num(spec["travellers"]) or members or 1)))
    spec["rooms"] = int(_num(spec["rooms"])) if _num(spec["rooms"]) else math.ceil(spec["travellers"] / 2)
    start, end = _date(spec["start_date"]), _date(spec["end_date"])
    days = int(_num(spec["days"]) or 0)
    if start and not days and end and end >= start:
        days = (end - start).days + 1
    days = max(1, min(21, days or 3))
    if start:
        end = start + timedelta(days=days - 1)
    spec.update(start_date=start.isoformat() if start else None, end_date=end.isoformat() if end else None, days=days)
    bpp, btot = _num(spec["budget_per_person"]), _num(spec["budget_total"])
    if not bpp and btot:
        bpp = btot / spec["travellers"]
    spec["budget_per_person"] = round(bpp) if bpp else None
    spec["budget_total"] = round(bpp * spec["travellers"]) if bpp else None
    for k in ("transport_pref", "stay_pref", "food", "notes"):
        spec[k] = str(spec[k] or "")[:200]
    return spec


# A currency written as a word or a sign instead of its code
_CURRENCY_WORDS = {"RUPEE": "INR", "RS": "INR", "₹": "INR", "POUND": "GBP", "£": "GBP", "STERLING": "GBP",
                   "EURO": "EUR", "€": "EUR", "DOLLAR": "USD", "$": "USD", "US$": "USD", "BAHT": "THB", "YEN": "JPY",
                   "¥": "JPY", "DIRHAM": "AED", "RINGGIT": "MYR", "DONG": "VND", "FRANC": "CHF"}


def clean_plan(raw: dict, sources: dict[str, dict], spec: dict) -> dict:
    days = []
    raw_days = raw.get("days") if isinstance(raw.get("days"), list) else []
    for d in [x for x in raw_days if isinstance(x, dict)]:
        items = []
        for it in [x for x in (d.get("items") or []) if isinstance(x, dict)]:
            cost = _num(it.get("cost")) or 0
            per = it.get("per") if it.get("per") in ("person", "group", "room") else "person"
            cat = it.get("category") if it.get("category") in CATEGORIES else "other"
            ids = [s for s in (it.get("source_ids") or []) if isinstance(s, str) and s in sources]
            found = it.get("source") == "found" and bool(ids) and cost > 0
            cur = str(it.get("currency") or "INR").strip().upper()
            cur = _CURRENCY_WORDS.get(cur.rstrip("S"), cur)
            cur = cur if re.fullmatch(r"[A-Z]{3}", cur) else "INR"
            items.append({"time": str(it.get("time") or "")[:10], "title": str(it.get("title") or "")[:140],
                          "detail": str(it.get("detail") or "")[:400], "category": cat,
                          "cost": round(cost) if cur == "INR" else round(cost, 2), "currency": cur,
                          "per": per, "source": "found" if found else "estimate",
                          "source_ids": ids if found else [], "basis": str(it.get("basis") or "")[:200]})
        days.append({"day": len(days) + 1, "date": str(d.get("date") or "")[:10], "city": str(d.get("city") or "")[:80],
                     "title": str(d.get("title") or "")[:140], "items": items})
    return {"title": str(raw.get("title") or "Trip plan")[:140], "summary": str(raw.get("summary") or "")[:600],
            "days": days, "tips": [str(x)[:240] for x in (raw.get("tips") or [])][:8],
            "assumptions": [str(x)[:240] for x in (raw.get("assumptions") or [])][:8]}


def work_out_budget(plan: dict, spec: dict) -> dict:
    """The money, in code: what each item costs one person, then the sums."""
    n, rooms = spec["travellers"], spec["rooms"]
    by_cat = {c: 0.0 for c in CATEGORIES}
    found = total = 0.0
    for d in plan["days"]:
        for it in d["items"]:
            pp = it["cost"] if it["per"] == "person" else it["cost"] / n if it["per"] == "group" \
                else it["cost"] * rooms / n
            it["per_person"] = round(pp)
            by_cat[it["category"]] += pp
            total += pp
            if it["source"] == "found":
                found += pp
    budget = spec.get("budget_per_person")
    return {"per_person": round(total), "group_total": round(total * n), "travellers": n, "rooms": rooms,
            "by_category": {k: round(v) for k, v in by_cat.items() if v},
            "budget_per_person": budget, "over_by": round(total - budget) if budget and total > budget else 0,
            "found_share": round(100 * found / total) if total else 0}


# ── the run ────────────────────────────────────────────────────────────────

def start(plan_id: int) -> None:
    threading.Thread(target=_run, args=(plan_id,), daemon=True, name=f"trip-plan-{plan_id}").start()


def _run(plan_id: int) -> None:
    from database import get_session_factory
    from models import Discussion, DiscussionMessage, Group, TripPlan
    db = get_session_factory()()
    plan = db.get(TripPlan, plan_id)
    steps: list[dict] = []

    def step(text: str) -> None:
        steps.append({"at": datetime.now(timezone.utc).isoformat(), "text": text})
        plan.steps_json = json.dumps(steps)
        db.commit()

    try:
        d = db.get(Discussion, plan.discussion_id)
        group = db.get(Group, d.group_id)
        members = [m.name for m in group.members]
        parent = db.get(TripPlan, plan.parent_id) if plan.parent_id else None
        today = datetime.now(IST).date()

        step("Understanding the request")
        context = (f"Discussion: {d.title}\nDetails: {d.description or '-'}\n"
                   f"Group size: {len(members)} ({', '.join(members)})")
        if parent and parent.spec_json:
            ask = f"{context}\n\nThe trip so far (a spec):\n{parent.spec_json}\n\nChange asked for:\n{plan.prompt}\n" \
                  "Return the whole updated spec - change only what's asked."
        else:
            ask = f"{context}\n\nRequest:\n{plan.prompt}"
        spec = normalise_spec(_llm(_SPEC.format(today=today.isoformat()), ask, 1500, quick=True), len(members))
        if not spec["destinations"]:
            raise ValueError("Say which places the trip is to - e.g. \"Jodhpur and Jaisalmer\".")
        plan.spec_json = json.dumps(spec)
        db.commit()

        old = json.loads(parent.research_json) if parent and parent.research_json else None
        same_places = old and old.get("places_key") == [spec["origin"].lower()] + [x.lower() for x in spec["destinations"]]
        if same_places:
            step("Using the research from the earlier plan")
            research = old
        else:
            research = _research(spec, step)
        plan.research_json = json.dumps(research)
        db.commit()

        facts = _facts(spec, research)
        if parent and parent.plan_json:
            facts += f"\n\nThe current plan (revise it - change what's asked, keep the rest):\n" \
                     f"{for_ai(json.loads(parent.plan_json))}\n\nChange asked for: {plan.prompt}"
        result, money = write_plan(spec, research, facts, step)
        plan.plan_json, plan.budget_json = json.dumps(result), json.dumps(money)
        plan.status, plan.finished_at = "done", datetime.now(timezone.utc)
        within = "" if not spec["budget_per_person"] else (
            f" (over the ₹{spec['budget_per_person']:,} budget by ₹{money['over_by']:,})" if money["over_by"]
            else f" (within ₹{spec['budget_per_person']:,})")
        db.add(DiscussionMessage(discussion_id=d.id, author=plan.created_by, text=(
            f"🧭 Trip plan: {result['title']}\n{spec['days']} days · {spec['travellers']} people · "
            f"₹{money['per_person']:,} per person{within}\nSee it in the Plan tab.")[:5000]))
        d.updated_at = datetime.now(timezone.utc)
        step("Done")
    except Exception as e:
        print(f"[trip] plan {plan_id} failed: {e!r}")
        db.rollback()
        plan = db.get(TripPlan, plan_id)
        plan.status, plan.finished_at = "failed", datetime.now(timezone.utc)
        plan.error = (str(e) if isinstance(e, ValueError) else "Something went wrong while planning - try again.")[:500]
        db.commit()
    finally:
        db.close()


def for_ai(plan: dict) -> str:
    """A plan handed back to the AI: each price in the currency it was written
    in (the rupee figures are the app's conversion), so the AI never mixes them."""
    days = [{**d, "items": [{k: v for k, v in {**it, "cost": it.get("cost_local", it["cost"])}.items()
                             if k not in ("cost_local", "per_person")} for it in d["items"]]} for d in plan["days"]]
    return json.dumps({k: v for k, v in {**plan, "days": days}.items() if k not in ("fx", "fx_date")})[:12000]


def gaps(plan: dict, spec: dict) -> list[str]:
    """What a plan leaves out that the trip needs: days, the way home."""
    missing = []
    if len(plan["days"]) < spec["days"]:
        missing.append(f"Your plan stops at day {len(plan['days'])}, but the trip is {spec['days']} days - "
                       f"plan every day up to {spec['end_date'] or 'the last day'}.")
    home = spec["origin"].lower()
    if home and plan["days"]:
        last = [it for it in plan["days"][-1]["items"] if it["category"] == "transport"]
        if not any(home in f"{it['title']} {it['detail']}".lower() for it in last):
            missing.append(f"The last day must end with the journey back to {spec['origin']} (the flight, train or "
                           f"bus home, named and with its cost) - getting to the airport or station isn't enough.")
    nights = spec["days"] - 1
    items = [it for d in plan["days"] for it in d["items"]]
    stays = sum(1 for it in items if it["category"] == "stay")
    overnight = sum(1 for it in items if it["category"] == "transport"
                    and re.search(r"overnight|night (?:train|bus|flight)|sleeper", f"{it['title']} {it['detail']}", re.I))
    if nights > 0 and stays + overnight < nights:
        missing.append(f"The trip has {nights} night{'s' if nights > 1 else ''} but only {stays} stay item"
                       f"{'s' if stays != 1 else ''}: add one stay (per room per night) for every night not spent on an "
                       f"overnight train, bus or flight - a desert camp counts as a stay.")
    return missing


def write_plan(spec: dict, research: dict, facts: str, step) -> tuple[dict, dict]:
    """The plan and its money: written, then completed if it left days or the
    way home out, then brought within the budget if it's over - each fix one
    more round with the AI, kept only when it's better."""
    sources = {s["id"]: s for s in research["sources"]}
    write = lambda prompt: to_rupees(clean_plan(_llm(_PLAN, prompt), sources, spec))
    step("Writing the day-by-day plan")
    result = write(facts)

    missing = gaps(result, spec)
    if missing and result["days"]:
        step("Filling in what the plan left out")
        fuller = write(facts + f"\n\n{' '.join(missing)} Return the WHOLE plan, every day:\n{for_ai(result)}")
        if len(fuller["days"]) >= len(result["days"]) and len(gaps(fuller, spec)) < len(missing):
            result = fuller
    if not result["days"]:
        raise ValueError("The AI didn't come back with a plan - try again.")

    money = work_out_budget(result, spec)
    if money["over_by"] > 0.05 * (spec["budget_per_person"] or 0):
        step(f"₹{money['per_person']:,} a person is ₹{money['over_by']:,} over the budget - finding cheaper options")
        retry = facts + (f"\n\nYour plan below costs Rs {money['per_person']} per person, Rs {money['over_by']} over "
                         f"the Rs {spec['budget_per_person']} budget. Rework it to fit (cheaper transport, stays, "
                         f"activities) without leaving any cost, day or the way home out:\n{for_ai(result)}")
        cheaper = write(retry)
        cheaper_money = work_out_budget(cheaper, spec)
        if len(cheaper["days"]) >= len(result["days"]) and cheaper_money["per_person"] < money["per_person"] \
                and len(gaps(cheaper, spec)) <= len(gaps(result, spec)):
            result, money = cheaper, cheaper_money
    return result, money


def _research(spec: dict, step) -> dict:
    places = ([spec["origin"]] if spec["origin"] else []) + spec["destinations"]
    step("Finding the places on the map")
    pts = [p for p in (geocode(x) for x in places) if p]
    research = {"places_key": [spec["origin"].lower()] + [x.lower() for x in spec["destinations"]],
                "places": pts, "legs": [], "weather": [], "sources": []}
    if len(pts) > 1:
        step("Working out road distances")
        route = pts + ([pts[0]] if spec["origin"] and pts[0]["name"] == spec["origin"] else [])
        research["legs"] = road_legs(route)

    start, end = _date(spec["start_date"]), _date(spec["end_date"])
    dest_pts = [p for p in pts if p["name"] in spec["destinations"]]
    if start and end and dest_pts:
        step("Checking the weather")
        research["weather"] = [w for w in (weather(p, start, end) for p in dest_pts) if w]

    step("Reading Wikivoyage: " + ", ".join(spec["destinations"]))
    with ThreadPoolExecutor(max_workers=4) as pool:
        pages = list(pool.map(wikivoyage, spec["destinations"]))
    n = 0
    for page in pages:
        if not page:
            continue
        n += 1
        lines = [f"Getting there: {page['get_in']}"] if page["get_in"] else []
        if page["get_around"]:
            lines.append(f"Getting around: {page['get_around']}")
        lines += [f"[{l['kind']}] {l['name']}" + (f" - price: {l['price']}" if l["price"] else "")
                  + (f" - {l['about']}" if l["about"] else "") for l in page["listings"]]
        research["sources"].append({"id": f"S{n}", "kind": "wikivoyage", "title": f"Wikivoyage: {page['title']}",
                                    "url": page["url"], "text": "\n".join(lines)[:4500]})

    from database import get_settings
    if get_settings().tavily_api_key:
        step("Choosing what to search for")
        when = _trip_month(spec)
        try:
            qs = _llm(_SEARCHES.format(n=MAX_SEARCHES, today=datetime.now(IST).date().isoformat(), when=when),
                      json.dumps(spec), 1000, quick=True).get("searches") or []
        except Exception:
            qs = []
        queries = [fix_query_dates(str(q.get("q") if isinstance(q, dict) else q)[:150], when)
                   for q in qs if q][:MAX_SEARCHES]
        for q in queries:
            step(f"Searching: {q}")
        with ThreadPoolExecutor(max_workers=3) as pool:
            for q, hits in zip(queries, pool.map(web_search, queries)):
                for h in hits[:3]:
                    n += 1
                    research["sources"].append({"id": f"S{n}", "kind": "web", "title": h["title"], "url": h["url"],
                                                "text": h["text"], "query": q, "checked": h["checked"]})
    else:
        step("Live web search isn't set up - prices not on Wikivoyage will be estimates")
    return research


def _facts(spec: dict, research: dict) -> str:
    out = [f"Trip spec: {json.dumps(spec)}",
           f"Travellers: {spec['travellers']} - rooms: {spec['rooms']} (stays are priced per room per night)"]
    if research["legs"]:
        out.append("Road distances (OSRM): " + "; ".join(
            f"{l['from']} -> {l['to']}: {l['km']} km, about {l['hours']} h by road" for l in research["legs"]))
    for w in research["weather"]:
        label = "forecast" if w["kind"] == "forecast" else "same dates last year (a guide, not a forecast)"
        out.append(f"Weather in {w['place']}, {label}: " + "; ".join(
            f"{x['date']}: {x['min']}-{x['max']} C" + (f", rain {x['rain_chance']}%" if x.get("rain_chance") is not None
                                                       else f", rain {x['rain_mm']} mm" if x.get("rain_mm") else "")
            for x in w["days"]))
    out.append("Sources (cite by id):")
    budget = 26000
    for s in research["sources"]:
        checked = f" - page checked {s['checked']}" if s.get("checked") else ""
        block = f"[{s['id']}] {s['title']} ({s['url']}){checked}\n{s['text']}"
        if budget - len(block) < 0:
            break
        budget -= len(block)
        out.append(block)
    if not research["sources"]:
        out.append("(none - every price is an estimate)")
    return "\n\n".join(out)


def mark_stale(db, plan) -> None:
    """A plan cut off by a restart never finishes - say so instead of spinning."""
    if plan.status == "running" and plan.created_at:
        created = plan.created_at if plan.created_at.tzinfo else plan.created_at.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) - created > STALE_AFTER:
            plan.status, plan.error = "failed", "This plan was interrupted - run it again."
            db.commit()

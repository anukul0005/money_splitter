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
            d = _post_json(GEMINI_URL, body, {"Authorization": f"Bearer {get_settings().gemini_api_key}"}, timeout=80)
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


# Models out of their free daily quota, till Google's reset (midnight Pacific)
_out_for_day: dict[str, date] = {}


def _pacific_day() -> date:
    return datetime.now(timezone(timedelta(hours=-8))).date()


def _gemini(system: str, user: str, max_tokens: int) -> dict:
    """The models one at a time (asking two at once doubled what each plan
    takes from the free daily quota); a slow or busy one hands over to the next.
    A model out of its daily quota is skipped till the reset; when the rest were
    only busy (a per-minute limit, 503, slow), all are asked once more after a pause."""
    from attachment_reader import GEMINI_MODELS
    from database import get_settings
    if not get_settings().gemini_api_key:
        raise RuntimeError("no Gemini key")
    last: Exception | None = None
    for round_ in range(2):
        busy = False
        for model in GEMINI_MODELS:
            if _out_for_day.get(model) == _pacific_day():
                continue
            try:
                return _gemini_one(model, system, user, max_tokens)
            except urllib.error.HTTPError as e:
                last = e
                if e.code in (401, 403):
                    raise
                body = ""
                try:
                    body = e.read().decode(errors="ignore")
                except Exception:
                    pass
                if e.code == 429 and "PerDay" in body:
                    _out_for_day[model] = _pacific_day()
                else:
                    busy = True
                print(f"[trip] gemini {model}: {e.code}")
            except Exception as e:
                last, busy = e, True
                print(f"[trip] gemini {model}: {type(e).__name__}")
        if not busy or round_:
            break
        time.sleep(20)
    raise last or RuntimeError("Gemini didn't answer - every model is out of today's free quota")


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


_flight_cache: dict[tuple, dict | None] = {}


def google_flights(frm: str, to: str, out_date: str, back_date: str | None) -> dict | None:
    """SerpApi's Google Flights: one adult's fares in rupees for those dates -
    a round trip when `back_date`, else one way. Cached in this process (a
    revision asks the same again); None without a key or on failure."""
    from database import get_settings
    key = get_settings().serpapi_key
    if not key or not frm or not to or frm == to:
        return None
    ck = (frm, to, out_date, back_date)
    if ck in _flight_cache:
        return _flight_cache[ck]
    params = {"engine": "google_flights", "departure_id": frm, "arrival_id": to, "outbound_date": out_date,
              "type": 1 if back_date else 2, "adults": 1, "currency": "INR", "gl": "in", "hl": "en", "api_key": key}
    if back_date:
        params["return_date"] = back_date
    try:
        d = _get_json(f"https://serpapi.com/search.json?{urllib.parse.urlencode(params)}", timeout=60)
    except Exception as e:
        print(f"[trip] flights {frm}->{to}: {type(e).__name__}")
        _flight_cache[ck] = None
        return None
    options = []
    for f in (d.get("best_flights") or []) + (d.get("other_flights") or []):
        legs = f.get("flights") or []
        if not f.get("price") or not legs:
            continue
        options.append({"price": f["price"], "airlines": " + ".join(dict.fromkeys(l.get("airline", "?") for l in legs)),
                        "stops": len(legs) - 1, "hours": round((f.get("total_duration") or 0) / 60, 1),
                        "depart": (legs[0].get("departure_airport") or {}).get("time", "")[-5:]})
    if not options:
        _flight_cache[ck] = None
        return None
    cheapest = min(o["price"] for o in options)
    options = [o for o in options if o["price"] <= 3 * cheapest]      # not a 2-stop Etihad for a 1-hour hop
    pi = d.get("price_insights") or {}
    out = {"site": "Google Flights", "from": frm, "to": to, "date": out_date, "back": back_date, "options": options[:8],
           "lowest": pi.get("lowest_price") or min(o["price"] for o in options),
           "level": pi.get("price_level"), "typical": pi.get("typical_price_range"),
           "url": (d.get("search_metadata") or {}).get("google_flights_url") or "https://www.google.com/travel/flights",
           "checked": datetime.now(IST).date().isoformat()}
    _flight_cache[ck] = out
    return out


def skyscanner_flights(frm: str, to: str, out_date: str, back_date: str | None) -> dict | None:
    """API.SH's Skyscanner (1 credit): one adult's fares in rupees on the
    Indian market for those dates - a round trip when `back_date`, else one
    way - in the same shape as google_flights (no price verdict). Cached."""
    ck = ("sky", frm, to, out_date, back_date)
    if ck in _flight_cache:
        return _flight_cache[ck]
    params = {"origin": frm, "destination": to, "date": out_date, "adults": 1, "market": "IN", "currency": "INR",
              "locale": "en-GB", "sort": "best", "limit": 25} | ({"return_date": back_date} if back_date else {})
    # Skyscanner gathers fares from many sites - 30-60 s
    d = _apish("skyscanner/v1/flights", params, timeout=90) if frm and to and frm != to else None
    options = []
    for it in (d or {}).get("itineraries") or []:
        legs = it.get("legs") or []
        if not it.get("price") or not legs or it.get("self_transfer"):
            continue
        names = [a.get("name", "?") for l in legs for a in (l.get("airlines") or [])]
        options.append({"price": round(it["price"]), "airlines": " + ".join(dict.fromkeys(names)) or "?",
                        "stops": max(l.get("stops") or 0 for l in legs),
                        "hours": round((legs[0].get("duration_minutes") or 0) / 60, 1),
                        "depart": (legs[0].get("departure") or "")[11:16]})
    if not options:
        _flight_cache[ck] = None
        return None
    options.sort(key=lambda o: o["price"])
    cheapest = options[0]["price"]
    options = [o for o in options if o["price"] <= 3 * cheapest]
    ymd = lambda s: s[2:4] + s[5:7] + s[8:10]
    out = {"site": "Skyscanner", "from": frm, "to": to, "date": out_date, "back": back_date, "options": options[:8],
           "lowest": cheapest, "level": None, "typical": None,
           "url": f"https://www.skyscanner.co.in/transport/flights/{frm.lower()}/{to.lower()}/{ymd(out_date)}/"
                  + (f"{ymd(back_date)}/" if back_date else "") + "?adultsv2=1&cabinclass=economy",
           "checked": datetime.now(IST).date().isoformat()}
    _flight_cache[ck] = out
    return out


def find_flights(frm: str, to: str, out_date: str, back_date: str | None) -> dict | None:
    """Skyscanner first (API.SH credits); Google Flights (SerpApi's 250 a month) when it finds nothing."""
    return skyscanner_flights(frm, to, out_date, back_date) or google_flights(frm, to, out_date, back_date)


_train_cache: dict[tuple, dict | None] = {}


def _apish(path: str, params: dict, timeout: int = 40) -> dict | None:
    """One API.SH call (Indian Railways, Booking.com, Skyscanner), None without a key or on failure."""
    from database import get_settings
    key = get_settings().api_sh_key
    if not key:
        return None
    req = urllib.request.Request(f"https://api.api.sh/{path}?{urllib.parse.urlencode(params)}",
                                 headers={"x-api-key": key, "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f"[trip] api.sh {path}: {type(e).__name__}")
        return None


def _rail(path: str, params: dict) -> dict | None:
    return _apish(f"indian-rail/v1/{path}", params)


def _station(code: str | None, place: str) -> str | None:
    """The station code: the AI's guess, else API.SH's search for the place."""
    if code:
        return code
    found = (_rail("stations", {"q": place}) or {}).get("stations") or []
    return found[0]["code"] if found else None


def indian_trains(frm: str, to: str, on: str | None, frm_place: str = "", to_place: str = "") -> dict | None:
    """API.SH Indian Railways: the trains between two stations (running that
    day when `on`), with timings and indicative adult fares per class in INR.
    A code that finds nothing is looked up by the place's name once. Cached
    in this process; None without a key or on failure."""
    ck = (frm, to, on)
    if ck in _train_cache:
        return _train_cache[ck]
    params = {"from": frm, "to": to} | ({"date": on} if on else {})
    d = _rail("trains", params) if frm and to and frm != to else None
    if not (d or {}).get("trains") and (frm_place or to_place):
        a = _station(None, frm_place) if frm_place else frm
        b = _station(None, to_place) if to_place else to
        if a and b and (a, b) != (frm, to) and a != b:
            d = _rail("trains", {"from": a, "to": b} | ({"date": on} if on else {}))
    trains = [t for t in (d or {}).get("trains") or [] if t.get("fares") and t.get("runs_on_date", True)]
    if not trains:
        _train_cache[ck] = None
        return None
    trains.sort(key=lambda t: t.get("duration_min") or 9999)
    names = (d["from"].get("name") or d["from"]["code"], d["to"].get("name") or d["to"]["code"])
    out = {"from": d["from"], "to": d["to"], "date": on, "checked": datetime.now(IST).date().isoformat(),
           "url": "https://www.google.com/search?q=" + urllib.parse.quote("trains from %s to %s" % names),
           "trains": [{"number": t["number"], "name": t.get("full_name") or t.get("name"), "type": t.get("category"),
                       "depart": t.get("departure"), "arrive": t.get("arrival"),
                       "next_day": t.get("arrival_day_offset") or 0, "hours": round((t.get("duration_min") or 0) / 60, 1),
                       "runs": t.get("run_days"),
                       "fares": {c: f.get("adult") for c, f in t["fares"].items() if f.get("adult")}}
                      for t in trains[:8]]}
    _train_cache[ck] = out
    return out


_stay_cache: dict[tuple, dict | None] = {}


def booking_stays(place: str, checkin: str) -> dict | None:
    """API.SH's Booking.com: places to stay in `place` for the night of
    `checkin` - one room for two, the night's price with taxes in INR - popular
    ones with a fair number of reviews, cheapest first. Cached in this process."""
    nights = 1
    ck = (place.lower(), checkin)
    if ck in _stay_cache:
        return _stay_cache[ck]
    out_date = (date.fromisoformat(checkin) + timedelta(days=nights)).isoformat()
    d = _apish("booking/v1/search", {"q": place, "checkin": checkin, "checkout": out_date, "adults": 2, "rooms": 1,
                     "currency": "INR", "sort": "popularity"})
    hotels = []
    for h in (d or {}).get("hotels") or []:
        price = h.get("price_per_night") or h.get("price_amount")
        if not price or h.get("sold_out") or (h.get("currency") or "INR") != "INR" or (h.get("review_count") or 0) < 5:
            continue
        hotels.append({"name": h.get("name"), "price": round(price + (h.get("taxes_and_fees") or 0)),
                       "stars": h.get("stars"), "score": h.get("review_score"), "reviews": h.get("review_count"),
                       "area": h.get("district") or h.get("address"), "distance": h.get("distance"),
                       "room": ", ".join((h.get("unit") or {}).get("names") or [])[:60],
                       "breakfast": bool(h.get("meal_plan")), "url": h.get("url")})
    if not hotels:
        _stay_cache[ck] = None
        return None
    hotels.sort(key=lambda h: h["price"])
    out = {"place": place, "checkin": checkin, "hotels": hotels[:12],
           "url": f"https://www.booking.com/searchresults.html?{urllib.parse.urlencode({'ss': place, 'checkin': checkin, 'checkout': out_date, 'group_adults': 2, 'no_rooms': 1, 'selected_currency': 'INR'})}",
           "checked": datetime.now(IST).date().isoformat()}
    _stay_cache[ck] = out
    return out


def _km(a: dict, b: dict) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (a["lat"], a["lon"], b["lat"], b["lon"]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


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
  "transport_pref": "", "stay_pref": "", "interests": [], "food": "", "notes": "",
  "travel_by": "train|flight|cheapest|any - train or flight when the request asks for one; cheapest when it asks for
  cheaper, budget or low-cost options; else any",
  "airports": {{"origin": "IATA code of the origin's main airport", "destinations": ["IATA code nearest each
  destination, same order; null where there's none within ~150 km"]}},
  "stations": {{"origin": "Indian Railways code of the origin's main station (NDLS New Delhi, JP Jaipur, JU Jodhpur,
  BCT Mumbai Central - a railway code, never the airport's)", "destinations":
  ["Indian Railways code of each destination's main station, same order; null outside India or with no railway"]}}}}
Rules: a date without a year is the next one after today. "4-day trip between 20-24 December" means 4 days from
the 20th (days wins over the range). When only a month, a span of months or a season is given ("March-April 2027",
"next winter"), pick real dates inside it - the best time to go when the request asks, else a sensible start -
and say which and why in notes; start_date is null only when nothing at all is said about when. "5n 6d" = 6 days. travellers: the number the request gives ("5 friends" = 5), else the
group size given below - but count the people the words imply first: "my wife and I", "a honeymoon", "a couple" = 2;
"me and 3 friends" = 4. origin: where the trip starts; when not said, a city in India the request or the details
suggest, else "Delhi" - and say in notes that it was assumed (the plan always includes getting there and back).
Amounts in rupees as numbers ("12k" = 12000, "1.2 lakh" = 120000); a per-person budget goes
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
  item a day per person is fine), entry fees and activities. Free things cost 0 - but meals are never free: every
  lunch and dinner has a realistic price; only a breakfast that comes with the stay costs 0 (say "included").
  Dinner is at 20:00 or later, never earlier.
- Choosing how to travel: when a journey has both train and flight sources, weigh them - a train is usually far
  cheaper, and a night train saves a night's stay; a flight saves a long day. Take the train when it's well under
  the fare and takes up to ~12 h (or runs overnight), unless the request asks to fly or time is short; take the
  flight when the train is very long. Either way put the other option in `detail` ("Or by train: 14088 Runicha
  Exp, 3A Rs 1,205, 19:00-10:35").
- Include each place's main sights and the experience it is known for (the reason people go there), unless the
  request rules it out.
- Tickets (flights, trains, buses, entry fees) are per person: `cost` is ONE person's fare, `per` "person". A return
  journey is one person's round-trip fare, or two one-way items. Never a guessed figure "for the group".
- Flight sources (Skyscanner, Google Flights) are real fares for ONE adult on the trip's dates, in INR: when flying, pick one of
  those options (say which airline in the title) - `per` "person", `currency` "INR", source "found" with its id.
  A round-trip fare goes half on the flight out and half on the flight back, each saying so in `basis`
  ("half of the Rs 165,800 British Airways round trip").
- Indian Railways sources are real timetables with each class's fare for ONE adult in INR: when going by train,
  pick a train from them - number and name in the title, the class and times in `detail`, the departure as `time`,
  `cost` that class's fare, `per` "person", source "found" with its id. A night train (arriving the next day)
  covers that night - no stay needed. Choose the class by the budget and preference (SL cheapest, 3A the usual
  comfortable choice). Booked close to the date, Tatkal costs more - say so in a tip when the trip is soon.
- Booking.com sources are real prices of one room for two for one night of the trip, taxes included, in INR:
  pick a place from them for each night there (its name in the title) - `cost` its price, `per` "room",
  `currency` "INR", source "found" with its id - choosing by the stay preference and budget, and well rated.
  Other nights in the same place keep the same stay and price.
- When a source gives a fare or rate, use it - don't replace it with a lower guess. An estimate is a realistic
  market price for those dates, never shaded down to fit the budget.
- When a per-person budget is given, fit it by choosing cheaper things (sleeper or 3AC trains, buses, guest
  houses, shared cabs, fewer paid activities) - never by lowering prices or leaving a cost out. If it can't fit,
  leave it over budget and say so in the summary.
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
    # How to travel: what the AI read, checked against the words themselves
    by = str(raw.get("travel_by") or "").strip().lower()
    words = f"{spec['transport_pref']} {spec['notes']}"
    if by not in ("train", "flight", "cheapest"):
        by = ("train" if re.search(r"\btrains?\b|\brail", words, re.I) else
              "flight" if re.search(r"\bfl(?:y|ight)", words, re.I) else
              "cheapest" if re.search(r"cheap|budget|low[- ]cost|economical|affordable", words, re.I) else "any")
    spec["travel_by"] = by
    air = raw.get("airports") if isinstance(raw.get("airports"), dict) else {}
    code = lambda c: str(c).strip().upper() if c and re.fullmatch(r"[A-Za-z]{3}", str(c).strip()) else None
    dests = [code(c) for c in (air.get("destinations") or [])][:len(spec["destinations"])]
    spec["airports"] = {"origin": code(air.get("origin")),
                        "destinations": dests + [None] * (len(spec["destinations"]) - len(dests))}
    rail = raw.get("stations") if isinstance(raw.get("stations"), dict) else {}
    stn = lambda c: str(c).strip().upper() if c and re.fullmatch(r"[A-Za-z]{1,5}", str(c).strip()) else None
    dests = [stn(c) for c in (rail.get("destinations") or [])][:len(spec["destinations"])]
    spec["stations"] = {"origin": stn(rail.get("origin")),
                        "destinations": dests + [None] * (len(spec["destinations"]) - len(dests))}
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
        compact = _facts(spec, research, compact=True)
        if parent and parent.plan_json:
            compact = facts                             # a revision carries the whole plan: Gemini's job
        result, money = write_plan(spec, research, facts, step, compact)
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


_OVERNIGHT = re.compile(r"overnight|night (?:train|bus|flight)|sleeper|arrives [\d:]+ next day", re.I)


def fill_stays(plan: dict, spec: dict) -> dict:
    """Another night in the same place is the same stay at the same price: a
    night with no stay (and no overnight journey) gets a copy of the stay from
    the night before, when the group is still in that city. The AI often
    prices one stay a city, not one a night."""
    days = plan["days"]
    sleeps_in = lambda d: re.split(r"→|->|\bto\b", str(d.get("city") or ""))[-1].strip().lower()   # "Delhi → Jodhpur"
    for i in range(min(len(days), spec["days"] - 1)):           # the night after day i
        items = days[i]["items"]
        if any(it["category"] == "stay" or (it["category"] == "transport" and
               _OVERNIGHT.search(f"{it['title']} {it['detail']}")) for it in items):
            continue
        before = next(((d, it) for d in reversed(days[:i]) for it in reversed(d["items"])
                       if it["category"] == "stay"), None)
        if before and sleeps_in(days[i]) and sleeps_in(before[0]) == sleeps_in(days[i]):
            stay = before[1]
            name = re.sub(r"^(?:Another night: |Check[-‑ ]in:? )+", "", stay["title"])
            items.append({**stay, "time": "22:00", "title": f"Another night: {name}",
                          "detail": "Same stay as the night before"})
    return plan


def _letters(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]+", s.lower()) if w not in ("exp", "express", "sf", "sup", "the", "train")}


def name_trains(plan: dict, sources: dict[str, dict]) -> dict:
    """A train the plan takes, written exactly as the railway lists it: matched
    to the cited timetable by its number, else its name, else its departure
    time, else its fare - then titled "14088 Runicha Express" with the class and
    times added to the detail when the AI left them out."""
    for d in plan["days"]:
        for it in d["items"]:
            if it["category"] != "transport":
                continue
            cited = [sources[i] for i in it.get("source_ids") or [] if sources.get(i, {}).get("kind") == "trains"]
            pool = [(s, t) for s in cited for t in s.get("trains") or []]
            if not pool:
                continue
            text = f"{it['title']} {it.get('detail', '')}"
            num = re.search(r"\b(\d{5})\b", text)
            words = _letters(it["title"])
            fare = round(it.get("cost_local", it["cost"]) or 0)
            named = lambda t: (tn := _letters(t["name"] or "")) and len(tn & words) >= max(1, len(tn) - 1)
            match = (next((p for p in pool if num and p[1]["number"] == num.group(1)), None)
                     or next((p for p in pool if named(p[1])), None)
                     or next((p for p in pool if it.get("time") and p[1]["depart"] == it["time"]), None)
                     or next((p for p in pool if fare and fare in p[1]["fares"].values()), None))
            if not match:
                continue
            src, t = match
            # "RUNICHA EXP" -> "Runicha Express"; short codes ("SBIB", "JU") stay as they are
            name = " ".join(w.capitalize() if w.isupper() and len(w) > 4 else w for w in str(t["name"]).split())
            name = re.sub(r"\bExp\b", "Express", name).replace("EXP", "Express")
            it["title"] = f"Train {t['number']} {name} ({src['route'][0]} → {src['route'][1]})"
            it["time"] = t["depart"] or it.get("time")
            cls = next((c for c, v in t["fares"].items() if v == fare), None)
            if not re.search(r"\b(?:SL|1A|2A|3A|3E|CC|EC|2S|GN)\b", it.get("detail") or ""):
                when = f"departs {t['depart']}, arrives {t['arrive']}" + (" next day" if t["next_day"] else "") + f", {t['hours']} h"
                it["detail"] = (f"{cls} · {when}" if cls else when) + (f". {it['detail']}" if it.get("detail") else "")
    return plan


def _train_item(src: dict, travel_by: str) -> dict | None:
    """The train to take from a timetable source: sleeper on a "cheapest" trip,
    else 3A (else the cheapest reserved class); the cheapest such train on a
    "cheapest" trip, else the quickest."""
    want = ["SL", "3A", "2S", "CC"] if travel_by == "cheapest" else ["3A", "CC", "2A", "SL", "2S"]
    best = None
    for cls in want:
        rows = [t for t in src.get("trains") or [] if t["fares"].get(cls)]
        if rows:
            t = min(rows, key=lambda t: t["fares"][cls]) if travel_by == "cheapest" else rows[0]
            best = (t, cls)
            break
    if not best:
        return None
    t, cls = best
    return {"time": t["depart"] or "", "title": f"Train {t['number']} {t['name']} ({src['route'][0]} → {src['route'][1]})",
            "detail": f"{cls} · departs {t['depart']}, arrives {t['arrive']}" + (" next day" if t["next_day"] else "")
                      + f", {t['hours']} h", "category": "transport", "cost": t["fares"][cls], "currency": "INR",
            "per": "person", "source": "found", "source_ids": [src["id"]],
            "basis": f"{cls} fare from the railway timetable"}


def fix_journeys(plan: dict, spec: dict, sources: dict[str, dict]) -> dict:
    """The journeys out and home, made right in code:
    - a flight's title names where it goes ("Flight DEL-GOI" on the last day
      becomes "... (Goa → Delhi)"), so the way home is recognised;
    - on a train or "cheapest" trip, a flight out or home is swapped for the
      train on that day when the railway has one;
    - a last day with no way home gets the train home when there is one."""
    home, dests = spec["origin"], spec["destinations"]
    if not home or not plan["days"] or not dests:
        return plan
    by = spec.get("travel_by") or "any"
    trains_on = lambda when: next((s for s in sources.values() if s.get("kind") == "trains" and s.get("trains")
                                   and s.get("date") == when), None)
    ends = [(plan["days"][0], spec["start_date"], f"{home} → {dests[0]}")]
    if len(plan["days"]) > 1:
        ends.append((plan["days"][-1], spec["end_date"], f"{dests[-1]} → {home}"))
    no_flights = not any(s.get("kind") == "flights" for s in sources.values())   # short trip, or trains asked for
    is_flight = lambda it: any(sources.get(s, {}).get("kind") == "flights" for s in it.get("source_ids") or []) or (
        no_flights and re.search(r"\bfl(?:y|ight)|airline|IndiGo|Air India|SpiceJet|Akasa", f"{it['title']} {it['detail']}", re.I))
    flights_on = lambda when: next((s for s in sources.values() if s.get("kind") == "flights" and s.get("options")
                                    and when in (s.get("date"), s.get("back"))), None)
    for day, when, route in ends:
        src = flights_on(when) if by not in ("train", "cheapest") and when else None
        for i, it in enumerate(day["items"]):
            # over 550 km (flights were checked) and trains weren't asked for: fly, not a 37-hour train
            if src and it["category"] == "transport" and not is_flight(it) and re.search(
                    r"\btrain|rail|express|rajdhani|shatabdi|duronto|vande|sleeper", f"{it['title']} {it['detail']}", re.I):
                day["items"][i] = _flight_item(src, when, route, it)
                break
        for i, it in enumerate(day["items"]):
            if it["category"] != "transport" or not is_flight(it):
                continue
            src = trains_on(when) if (by in ("train", "cheapest") or no_flights) and when else None
            train = _train_item(src, by) if src else None
            if train:
                train["detail"] += f". Or fly: {it['title']}, Rs {it['cost']:,}"
                day["items"][i] = train
            elif home.lower() not in it["title"].lower():
                it["title"] = f"{it['title']} ({route})"
    last = plan["days"][-1]
    if len(plan["days"]) > 1 and not any(it["category"] == "transport" and home.lower() in
                                         f"{it['title']} {it['detail']}".lower() for it in last["items"]):
        fly = flights_on(spec["end_date"]) if by not in ("train", "cheapest") else None
        src = trains_on(spec["end_date"]) if by != "flight" and not fly else None
        train = _train_item(src, by) if src else None
        if fly:
            last["items"].append(_flight_item(fly, spec["end_date"], f"{dests[-1]} → {home}"))
        elif train:
            last["items"].append(train)
    return plan


def _flight_item(src: dict, when: str, route: str, instead: dict | None = None) -> dict:
    """The flight to take from a flight source, for the day `when`: its
    cheapest option; the way home of a round trip is in the fare paid going out."""
    frm, to = src["airports"]
    if src.get("back") and when == src["back"]:
        return {"time": "", "title": f"Flight {to}-{frm} ({route})", "detail": "The way home of the round trip - "
                "in the fare paid on day 1", "category": "transport", "cost": 0, "currency": "INR", "per": "person",
                "source": "found", "source_ids": [src["id"]], "basis": "included in the round-trip fare"}
    o = min(src["options"], key=lambda o: o["price"])
    detail = f"{o['airlines']}, {o['stops']} stop(s), {o['hours']} h, departs {o['depart']}" + (
        "; round trip - the flight home is included" if src.get("back") else "")
    if instead:
        detail += f". Or by train: {instead['title']}, Rs {instead['cost']:,}"
    return {"time": o["depart"] or "", "title": f"Flight {frm}-{to} ({route})", "detail": detail,
            "category": "transport", "cost": o["price"], "currency": "INR", "per": "person", "source": "found",
            "source_ids": [src["id"]], "basis": "lowest fare for one adult" + (", round trip" if src.get("back") else "")}


_INCLUDED = re.compile(r"includ|complimentary|free breakfast|with (?:the )?(?:stay|room|camp)", re.I)


DINNER_FROM = "20:00"


def late_dinners(plan: dict) -> dict:
    """A dinner timed before 20:00 moves to 20:00, and the day is put back in
    time order (an item with no time stays after the one before it)."""
    for d in plan["days"]:
        moved = False
        for it in d["items"]:
            t = it.get("time") or ""
            if it["category"] == "food" and re.search(r"dinner|supper", it["title"], re.I) \
                    and re.fullmatch(r"\d{1,2}:\d{2}", t) and t.zfill(5) < DINNER_FROM:
                it["time"], moved = DINNER_FROM, True
        if not moved:
            continue
        keys, last = [], ""
        for it in d["items"]:
            t = it.get("time") or ""
            last = t.zfill(5) if re.fullmatch(r"\d{1,2}:\d{2}", t) else last
            keys.append(last)
        d["items"] = [it for _, _, it in sorted(zip(keys, range(len(keys)), d["items"]), key=lambda x: (x[0], x[1]))]
    return plan


def price_meals(plan: dict) -> dict:
    """A lunch or dinner the AI left at 0 gets the typical price of the plan's
    other meals (an estimate saying so) - only a meal included with the stay is free."""
    items = [it for d in plan["days"] for it in d["items"] if it["category"] == "food"]
    paid = sorted(it["cost"] for it in items if it["cost"] > 0 and it["per"] == "person")
    if not paid:
        return plan
    typical = paid[len(paid) // 2]
    for it in items:
        if it["cost"] <= 0 and not _INCLUDED.search(f"{it['title']} {it.get('detail', '')} {it.get('basis', '')}"):
            it.update(cost=typical, per="person", currency="INR", source="estimate", source_ids=[],
                      basis="a meal costs about what the plan's other meals do (the AI had it free)")
            it.pop("cost_local", None)
    return plan


def gaps(plan: dict, spec: dict) -> list[str]:
    """What a plan leaves out that the trip needs: days, the way home."""
    missing = []
    if len(plan["days"]) < spec["days"]:
        missing.append(f"Your plan stops at day {len(plan['days'])}, but the trip is {spec['days']} days - "
                       f"plan every day up to {spec['end_date'] or 'the last day'}.")
    home = spec["origin"].lower()
    if home and plan["days"]:
        last = [it for it in plan["days"][-1]["items"] if it["category"] == "transport"]
        back = [it for it in last if home in f"{it['title']} {it['detail']}".lower()]
        if not back:
            missing.append(f"The last day must end with the journey back to {spec['origin']} (the flight, train or "
                           f"bus home, named and with its cost) - getting to the airport or station isn't enough.")
        elif not any(it["cost"] > 0 for it in back):
            missing.append(f"The journey back to {spec['origin']} has no cost - give its real fare per person.")
        first = [it for it in plan["days"][0]["items"] if it["category"] == "transport"
                 and home in f"{it['title']} {it['detail']}".lower()]
        if first and not any(it["cost"] > 0 for it in first):
            missing.append(f"The journey from {spec['origin']} has no cost - give its real fare per person.")
    nights = spec["days"] - 1
    items = [it for d in plan["days"] for it in d["items"]]
    stays = sum(1 for it in items if it["category"] == "stay")
    overnight = sum(1 for it in items if it["category"] == "transport"
                    and _OVERNIGHT.search(f"{it['title']} {it['detail']}"))
    if nights > 0 and stays + overnight < nights:
        missing.append(f"The trip has {nights} night{'s' if nights > 1 else ''} but only {stays} stay item"
                       f"{'s' if stays != 1 else ''}: add one stay (per room per night) for every night not spent on an "
                       f"overnight train, bus or flight - a desert camp counts as a stay.")
    return missing


# Groq's free plan takes 8,000 tokens a minute per key - what goes in and
# what comes out together - so it writes from the compact facts, and only
# when the answer has room; else (a revision, a long trip) Gemini writes.
GROQ_TOKENS = 7600


def _groq_plan(user: str) -> dict:
    import ai_text
    tokens_in = (len(_PLAN) + len(user)) / 3.2
    room = int(GROQ_TOKENS - tokens_in)
    if room < 2500:
        raise ValueError("too long for Groq")
    # The second key: the first has just read the request and picked the searches this minute
    return ai_text.chat_json(_PLAN, user, 0.3, prefer=1, timeout=90,
                             extra={"max_completion_tokens": room, "reasoning_effort": "low"})


# OpenRouter's free models that take a long prompt (a plan change carries the whole plan)
OPENROUTER_FREE = ["nvidia/nemotron-3-ultra-550b-a55b:free", "nvidia/nemotron-3.5-super-vl:free"]


def _openrouter(system: str, user: str, max_tokens: int = 12000) -> dict:
    from database import get_settings
    key = get_settings().openrouter_api_key
    if not key:
        raise RuntimeError("no OpenRouter key")
    last: Exception | None = None
    for model in OPENROUTER_FREE:
        body = {"model": model, "temperature": 0.3, "max_tokens": max_tokens, "response_format": {"type": "json_object"},
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
        try:
            d = _post_json("https://openrouter.ai/api/v1/chat/completions", body, {
                "Authorization": f"Bearer {key}", "HTTP-Referer": "https://www.settle0.in.net", "X-Title": "Settle"},
                timeout=100)                             # free models can be slow; Gemini is next
            text = d["choices"][0]["message"]["content"] or ""
            m = re.search(r"\{.*\}", text, re.S)
            out = json.loads(m.group(0) if m else text)
            if isinstance(out, dict):
                return out
            last = ValueError("not an object")
        except Exception as e:
            last = e
            print(f"[trip] openrouter {model}: {getattr(e, 'code', type(e).__name__)}")
    raise last or RuntimeError("OpenRouter didn't answer")


def _write_ai(compact: str, full: str) -> dict:
    """Groq (GPT-OSS 120B) on the compact facts first; then the full facts to
    OpenRouter's free Nemotron, then Gemini."""
    last: Exception | None = None
    for name, ask in (("groq", lambda: _groq_plan(compact)), ("openrouter", lambda: _openrouter(_PLAN, full)),
                      ("gemini", lambda: _gemini(_PLAN, full, 12000))):
        try:
            out = ask()
            print(f"[trip] plan written by {name}")
            return out
        except Exception as e:
            last = e
            print(f"[trip] {name} didn't write the plan: {e!r}"[:300])
    raise RuntimeError(f"The AI couldn't be reached ({type(last).__name__})") from last


def write_plan(spec: dict, research: dict, facts: str, step, compact: str | None = None) -> tuple[dict, dict]:
    """The plan and its money: written, then completed if it left days or the
    way home out, then brought within the budget if it's over - each fix one
    more round with the AI, kept only when it's better. `compact`: the facts
    cut down for Groq (each round adds the same text to both)."""
    sources = {s["id"]: s for s in research["sources"]}
    compact = compact or facts

    def write(more: str = "") -> dict:
        plan = to_rupees(clean_plan(_write_ai(compact + more, facts + more), sources, spec))
        return late_dinners(price_meals(fill_stays(name_trains(fix_journeys(plan, spec, sources), sources), spec)))
    step("Writing the day-by-day plan")
    result = write()

    for _ in range(2):                                  # up to two rounds to fill what's missing
        missing = gaps(result, spec)
        if not missing or not result["days"]:
            break
        step("Filling in what the plan left out")
        try:
            fuller = write(f"\n\n{' '.join(missing)} Return the WHOLE plan, every day:\n{for_ai(result)}")
        except Exception as e:                          # the AI's quota or a timeout: keep the plan written
            print(f"[trip] fill round failed: {e!r}")
            step("Couldn't reach the AI again - keeping the plan as written")
            break
        if len(fuller["days"]) >= len(result["days"]) and len(gaps(fuller, spec)) < len(missing):
            result = fuller
    if not result["days"]:
        raise ValueError("The AI didn't come back with a plan - try again.")
    left = gaps(result, spec)
    if left:                                            # say what it still lacks, rather than hide it
        result["assumptions"] = (result.get("assumptions") or []) + [f"Not complete: {x}" for x in left]

    money = work_out_budget(result, spec)
    if money["over_by"] > 0.05 * (spec["budget_per_person"] or 0):
        step(f"₹{money['per_person']:,} a person is ₹{money['over_by']:,} over the budget - finding cheaper options")
        retry = (f"\n\nYour plan below costs Rs {money['per_person']} per person, Rs {money['over_by']} over "
                         f"the Rs {spec['budget_per_person']} budget. Rework it to fit by choosing cheaper transport, "
                         f"stays and activities - never by lowering a price below what the sources show, or leaving "
                         f"any cost, day or the way home out. If it can't fit, keep real prices and say so:\n"
                         f"{for_ai(result)}")
        try:
            cheaper = write(retry)
        except Exception as e:
            print(f"[trip] cheaper round failed: {e!r}")
            step("Couldn't reach the AI again - keeping the plan as written")
            return result, money
        cheaper_money = work_out_budget(cheaper, spec)
        # Cheaper by real choices, not by guessing lower or dropping things: complete (no gaps at all), and
        # leaning on sources as much as the first plan did
        if len(cheaper["days"]) >= len(result["days"]) and cheaper_money["per_person"] < money["per_person"] \
                and not gaps(cheaper, spec) and cheaper_money["found_share"] >= money["found_share"] - 5:
            result, money = cheaper, cheaper_money
    return result, money


def _flights(spec: dict, pts: list[dict], step) -> list[dict]:
    """Flight fares for the long legs (Skyscanner, else Google Flights): only
    when the first place is over 550 km away as the crow flies (Delhi-Jodhpur
    is ~490: trains) and trains weren't asked for; the dates and airports must
    be known.
    One destination: a round trip. Several: out to the first, back from the last."""
    from database import get_settings
    air = spec.get("airports") or {}
    start, end = spec.get("start_date"), spec.get("end_date")
    home, dests = air.get("origin"), air.get("destinations") or []
    s = get_settings()
    if not (s.api_sh_key or s.serpapi_key) or not (start and end and home and dests and dests[0]):
        return []
    by_name = {p["name"]: p for p in pts}
    a, b = by_name.get(spec["origin"]), by_name.get(spec["destinations"][0])
    far = a and b and _km(a, b) > 550
    if not far or spec.get("travel_by") == "train":
        return []
    last = next((c for c in reversed(dests) if c), None)
    if last == dests[0]:
        legs = [(home, dests[0], start, end)]
    else:
        legs = [(home, dests[0], start, None)] + ([(last, home, end, None)] if last else [])
    step("Checking flight fares: " + " · ".join(f"{f} → {t}" + (" and back" if r else "") for f, t, _, r in legs))
    with ThreadPoolExecutor(max_workers=2) as pool:
        found = list(pool.map(lambda leg: find_flights(*leg), legs))
    return [f for f in found if f]


def _trains(spec: dict, pts: list[dict], step, flown: bool = False) -> list[dict]:
    """Indian Railways for each leg within India over ~60 km: home to the first
    place on the start date, between places (any day - the plan picks the day),
    and back home from the last on the end date. A leg over 550 km is flown
    when flights were found (`flown`), so its trains aren't checked - unless
    the request asks for trains or a cheaper, budget trip."""
    from database import get_settings
    if not get_settings().api_sh_key or not spec["destinations"]:
        return []
    by_air = flown and spec.get("travel_by") not in ("train", "cheapest")
    by_name = {p["name"]: p for p in pts}
    rail = spec.get("stations") or {}
    names = ([spec["origin"]] if spec["origin"] else []) + spec["destinations"]
    codes = ([rail.get("origin")] if spec["origin"] else []) + list(rail.get("destinations") or [])
    code = dict(zip(names, codes + [None] * len(names)))
    stops = list(zip(names, names[1:])) + ([(names[-1], spec["origin"])] if spec["origin"] and len(names) > 1 else [])
    legs = []
    for i, (a, b) in enumerate(stops):
        pa, pb = by_name.get(a), by_name.get(b)
        if not (pa and pb and pa["label"].endswith("India") and pb["label"].endswith("India") and _km(pa, pb) > 60):
            continue
        if by_air and _km(pa, pb) > 550:
            continue
        on = spec["start_date"] if i == 0 and spec["origin"] else spec["end_date"] if i == len(stops) - 1 and spec["origin"] else None
        legs.append((_station(code.get(a), a), _station(code.get(b), b), on, a, b))
    legs = [l for l in legs if l[0] and l[1]][:5]
    if not legs:
        return []
    step("Checking Indian Railways: " + " · ".join(f"{a} → {b}" for *_, a, b in legs))
    with ThreadPoolExecutor(max_workers=3) as pool:
        found = list(pool.map(lambda l: indian_trains(*l), legs))
    return [f for f in found if f]


def _stays(spec: dict, step) -> list[dict]:
    """Booking.com for each place the group sleeps: the trip's nights shared
    out across the places in order, priced for the first night in each."""
    from database import get_settings
    start, nights = _date(spec["start_date"]), spec["days"] - 1
    dests = spec["destinations"][:5]
    if not get_settings().api_sh_key or not start or nights < 1 or not dests:
        return []
    each, extra = divmod(nights, len(dests))
    asks, day = [], start
    for i, place in enumerate(dests):
        n = each + (1 if i < extra else 0)
        if n:
            asks.append((place, day.isoformat()))
        day += timedelta(days=n)
    step("Checking Booking.com: " + " · ".join(f"{p} from {d[8:]}/{d[5:7]}" for p, d in asks))
    with ThreadPoolExecutor(max_workers=3) as pool:
        found = list(pool.map(lambda a: booking_stays(*a), asks))
    return [f for f in found if f]


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

    n = 0
    research["flights"] = []
    for f in _flights(spec, pts, step):
        n += 1
        what = "round trip" if f["back"] else "one way"
        site = f.get("site") or "Google Flights"
        lines = [f"{site} fares for ONE adult, in INR, {what}, {f['from']} -> {f['to']} on {f['date']}"
                 + (f", back {f['back']}" if f["back"] else "") + f": lowest Rs {f['lowest']}"
                 + (f" (Google rates it '{f['level']}'; usual range Rs {f['typical'][0]}-{f['typical'][1]})"
                    if f.get("level") and f.get("typical") else "")]
        lines += [f"- Rs {o['price']}: {o['airlines']}, {o['stops']} stop(s), {o['hours']} h, departs {o['depart']}"
                  for o in f["options"]]
        research["sources"].append({"id": f"S{n}", "kind": "flights", "checked": f["checked"], "url": f["url"],
                                    "title": f"{site}: {f['from']} → {f['to']}" + (" and back" if f["back"] else ""),
                                    "text": "\n".join(lines), "options": f["options"], "airports": [f["from"], f["to"]],
                                    "date": f["date"], "back": f["back"]})
        research["flights"].append({"site": site} | {k: f[k] for k in ("from", "to", "date", "back", "lowest",
                                                                         "level", "typical")})

    research["trains"] = []
    for t in _trains(spec, pts, step, flown=bool(research["flights"])):
        n += 1
        frm, to = f"{t['from']['name']} ({t['from']['code']})", f"{t['to']['name']} ({t['to']['code']})"
        lines = [f"Indian Railways timetable, {frm} -> {to}" + (f", trains running on {t['date']}" if t["date"] else "")
                 + ": indicative fares for ONE adult in INR by class (SL sleeper, 3A/2A/1A AC sleeper, CC/EC chair car,"
                 " 2S second sitting, GN unreserved); Tatkal costs more"]
        lines += [f"- {x['number']} {x['name']} ({x['type']}): departs {x['depart']}, arrives {x['arrive']}"
                  + (f" (+{x['next_day']} day)" if x["next_day"] else "") + f", {x['hours']} h"
                  + ("" if t["date"] else f", runs {'/'.join(x['runs'] or [])}") + "; fares "
                  + ", ".join(f"{c} Rs {v}" for c, v in x["fares"].items()) for x in t["trains"]]
        research["sources"].append({"id": f"S{n}", "kind": "trains", "checked": t["checked"], "url": t["url"],
                                    "title": f"Indian Railways: {t['from']['name']} → {t['to']['name']}",
                                    "text": "\n".join(lines), "trains": t["trains"],
                                    "route": [t["from"]["name"], t["to"]["name"]], "date": t["date"]})
        reserved = [v for x in t["trains"] for c, v in x["fares"].items() if c != "GN"]      # not unreserved
        cheapest = min(reserved) if reserved else None
        research["trains"].append({"from": t["from"]["name"], "to": t["to"]["name"], "date": t["date"],
                                   "count": len(t["trains"]), "fastest": t["trains"][0]["name"],
                                   "fastest_hours": t["trains"][0]["hours"], "lowest": cheapest})

    research["stays"] = []
    for s in _stays(spec, step):
        n += 1
        lines = [f"Booking.com, {s['place']}, the night of {s['checkin']}: price of ONE room for two for that night"
                 " in INR, taxes included, cheapest first"]
        lines += [f"- Rs {h['price']}: {h['name']}" + (f", {h['stars']} star" if h["stars"] else "")
                  + (f", rated {h['score']}/10 by {h['reviews']}" if h["score"] else "")
                  + (f", {h['area']}" if h["area"] else "") + (f" ({h['distance']})" if h["distance"] else "")
                  + (f", {h['room']}" if h["room"] else "") + (", breakfast included" if h["breakfast"] else "")
                  for h in s["hotels"]]
        research["sources"].append({"id": f"S{n}", "kind": "stays", "checked": s["checked"], "url": s["url"],
                                    "title": f"Booking.com: {s['place']}", "text": "\n".join(lines)})
        prices = [h["price"] for h in s["hotels"]]
        research["stays"].append({"place": s["place"], "checkin": s["checkin"], "count": len(prices),
                                  "lowest": min(prices), "highest": max(prices)})

    step("Reading Wikivoyage: " + ", ".join(spec["destinations"]))
    with ThreadPoolExecutor(max_workers=4) as pool:
        pages = list(pool.map(wikivoyage, spec["destinations"]))
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


# Compact facts (for Groq): what each kind of source keeps - list lines, or characters of text
_COMPACT_LINES = {"flights": 5, "trains": 5, "stays": 6}
_COMPACT_CHARS = {"wikivoyage": 700, "web": 380}


_TRAVEL_BY = {
    "train": "The request asks for trains: go by train wherever the railway sources have one; a bus or cab only "
             "where there's no train, and a flight only if there's no train or bus at all.",
    "cheapest": "The request asks for cheaper, budget options: go by train (sleeper or 3A) wherever the railway "
                "sources have one - a night train saves a stay - else bus; no flights unless nothing else goes there.",
    "flight": "The request asks to fly: take the flights from the flight sources for the long journeys.",
}


def _facts(spec: dict, research: dict, compact: bool = False) -> str:
    """The research handed to the AI. `compact`: about a third of the size -
    the spec without its empty fields, a weather line a place, fewer options in
    each list and short page extracts, no URLs."""
    if compact:
        brief = {k: v for k, v in spec.items() if v not in (None, "", [], {})}
        out = [f"Trip spec: {json.dumps(brief, separators=(',', ':'))}",
               f"Travellers: {spec['travellers']} - rooms: {spec['rooms']} (stays priced per room per night)"]
    else:
        out = [f"Trip spec: {json.dumps(spec)}",
               f"Travellers: {spec['travellers']} - rooms: {spec['rooms']} (stays are priced per room per night)"]
    if spec.get("origin") and not research.get("flights"):
        out.append("How to travel: no flights on this trip (the places are under 550 km apart, or trains were asked "
                   "for) - go by train wherever the railway sources have one, else bus or cab.")
    elif spec.get("travel_by") in ("train", "cheapest"):
        out.append("How to travel: " + _TRAVEL_BY[spec["travel_by"]])
    elif spec.get("origin"):
        out.append("How to travel: the journeys over 550 km go by air - take a flight from the flight sources (no "
                   "long train rides); go by train, bus or cab only between places closer than that.")
    if research["legs"]:
        out.append("Road distances (OSRM): " + "; ".join(
            f"{l['from']} -> {l['to']}: {l['km']} km, about {l['hours']} h by road" for l in research["legs"]))
    for w in research["weather"]:
        label = "forecast" if w["kind"] == "forecast" else "same dates last year (a guide, not a forecast)"
        if compact and w["days"]:
            rain = max((x.get("rain_chance") or 0) for x in w["days"])
            out.append(f"Weather in {w['place']} ({label}): {min(x['min'] for x in w['days'])}-"
                       f"{max(x['max'] for x in w['days'])} C" + (f", rain up to {rain}%" if rain > 20 else ""))
            continue
        out.append(f"Weather in {w['place']}, {label}: " + "; ".join(
            f"{x['date']}: {x['min']}-{x['max']} C" + (f", rain {x['rain_chance']}%" if x.get("rain_chance") is not None
                                                       else f", rain {x['rain_mm']} mm" if x.get("rain_mm") else "")
            for x in w["days"]))
    out.append("Sources (cite by id):")
    budget = 9000 if compact else 26000
    for s in research["sources"]:
        checked = f" - page checked {s['checked']}" if s.get("checked") else ""
        text = s["text"]
        if compact:
            if s["kind"] in _COMPACT_LINES:
                lines = text.split("\n")
                text = "\n".join(lines[:1 + _COMPACT_LINES[s["kind"]]])
            else:
                text = text[:_COMPACT_CHARS.get(s["kind"], 380)]
            block = f"[{s['id']}] {s['title']}{checked}\n{text}"
        else:
            block = f"[{s['id']}] {s['title']} ({s['url']}){checked}\n{text}"
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

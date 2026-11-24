"""Google Places API (New) - find any restaurant by name.

Two calls, kept apart because Google bills them differently:

- search(q): Text Search with only the basic fields (id, name, address,
  location, type) - the "Pro" tier, a few thousand free calls a month.
- details(place_id): rating, price level, opening hours, phone, website,
  Maps link - the "Enterprise" tier, about a thousand free a month, so it's
  fetched only when someone opens a place.

The field mask header is what decides the tier; asking for a field the mask
doesn't name costs nothing and returns nothing. Results are meant to be
cached by the caller (place_id is stable).
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from database import get_settings

BASE = "https://places.googleapis.com/v1"
SEARCH_FIELDS = ",".join(f"places.{f}" for f in (
    "id", "displayName", "formattedAddress", "location", "primaryType", "primaryTypeDisplayName"))
DETAIL_FIELDS = ",".join((
    "id", "displayName", "formattedAddress", "location", "primaryTypeDisplayName",
    "rating", "userRatingCount", "priceLevel", "currentOpeningHours",
    "nationalPhoneNumber", "websiteUri", "googleMapsUri"))
TIMEOUT = 10


class PlacesError(Exception):
    pass


def available() -> bool:
    return bool(get_settings().google_places_api_key)


def _call(method: str, path: str, fields: str, body: dict | None = None) -> dict:
    key = get_settings().google_places_api_key
    if not key:
        raise PlacesError("Google Places isn't set up (GOOGLE_PLACES_API_KEY)")
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": fields})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("error", {}).get("message", "")
        except Exception:
            msg = ""
        raise PlacesError(f"Google Places {e.code}: {msg or e.reason}") from None
    except (urllib.error.URLError, TimeoutError) as e:
        raise PlacesError(f"Google Places unreachable: {e}") from None


def _brief(p: dict) -> dict:
    loc = p.get("location") or {}
    return {
        "place_id": p.get("id"),
        "name": (p.get("displayName") or {}).get("text"),
        "address": p.get("formattedAddress"),
        "lat": loc.get("latitude"), "lon": loc.get("longitude"),
        "type": (p.get("primaryTypeDisplayName") or {}).get("text") or p.get("primaryType"),
    }


def search(q: str, near: tuple[float, float] | None = None, limit: int = 8) -> list[dict]:
    """Restaurants (and cafes, bars...) matching `q`, e.g. "Haldiram's
    Sector 18 Noida" - optionally biased towards `near` (lat, lon)."""
    body: dict = {"textQuery": q, "pageSize": max(1, min(limit, 20)),
                  "languageCode": "en", "regionCode": "IN"}
    if near:
        body["locationBias"] = {"circle": {"center": {"latitude": near[0], "longitude": near[1]},
                                           "radius": 20000.0}}
    return [_brief(p) for p in _call("POST", "/places:searchText", SEARCH_FIELDS, body).get("places", [])]


PRICE = {"PRICE_LEVEL_FREE": 0, "PRICE_LEVEL_INEXPENSIVE": 1, "PRICE_LEVEL_MODERATE": 2,
         "PRICE_LEVEL_EXPENSIVE": 3, "PRICE_LEVEL_VERY_EXPENSIVE": 4}


def details(place_id: str) -> dict:
    p = _call("GET", f"/places/{place_id}", DETAIL_FIELDS)
    hours = p.get("currentOpeningHours") or {}
    return {**_brief(p),
            "rating": p.get("rating"), "ratings": p.get("userRatingCount"),
            "price_level": PRICE.get(p.get("priceLevel")),
            "open_now": hours.get("openNow"), "hours": hours.get("weekdayDescriptions") or [],
            "phone": p.get("nationalPhoneNumber"), "website": p.get("websiteUri"),
            "maps_url": p.get("googleMapsUri")}


if __name__ == "__main__":       # quick check on the server: python google_places.py "query"
    import sys
    hits = search(" ".join(sys.argv[1:]) or "Haldiram's Sector 18 Noida", limit=3)
    for h in hits:
        print(h)
    if hits:
        print(details(hits[0]["place_id"]))

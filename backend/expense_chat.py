"""Add Expense's chat box and mic: a typed or spoken line ("rs 400 spent with
utkarsh at xyz store") read into the form's fields.

Groq's GPT-OSS-120B does the reading (ai_text.chat_json - the app's usual
keys and fallbacks): a one-line extraction wants a fast answer in strict
JSON, which Groq gives in about a second. The free Nemotron models on
OpenRouter take several times as long and are rate-limited far sooner.
Speech goes to Groq's Whisper first, on the same keys.
"""
from __future__ import annotations

import json
import re
import uuid
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

import ai_text
from database import get_settings

IST = timezone(timedelta(hours=5, minutes=30))
MODES = ("cash", "upi", "credit_card", "debit_card")
WHISPER_MODEL = "whisper-large-v3-turbo"

_SYSTEM = """You fill in an expense form for a money-splitting app, from what the user typed or said (Indian English or Hinglish; amounts are rupees).

Return ONLY a JSON object:
{
  "people": [names] - everyone the message names as being with the user or sharing it, written as in the list of people the user knows when one matches (by first name or nickname, ignoring case), else as said; [] when nobody is named,
  "amount": number or null - the total spent,
  "title": string or null - the description: who the money went to or what it was for ("XYZ Store", "Dinner at Punjab Grill", "Petrol"). Tidy capitalisation. null when the message doesn't say - never invent one, and never use a person's name or the amount as the description,
  "paid_by": string or null - who paid: "me" for the user ("I paid", "spent", "spent with X" with nobody else named as paying), else that person's name; null if unclear,
  "payment_mode": "cash" | "upi" | "credit_card" | "debit_card" | null (gpay/phonepe/paytm = upi; "card" alone = null),
  "date": "YYYY-MM-DD" or null (today/yesterday/"on monday" worked out from today's date given; null when not said),
  "notes": string or null - other detail worth keeping that isn't the description (items bought etc.), else null,
  "reply": string - one or two short friendly lines back to the user saying what you filled in (don't mention groups - the app picks the group); when there's no description, ask what it was for; when there's no amount, ask for it
}

The form may already hold values from earlier messages (shown as "Form so far"). Keep them unless this message changes them - a follow-up like "it was groceries" only sets the description. Return the whole form each time, not just what changed."""


def _today() -> str:
    return datetime.now(IST).date().isoformat()


def understand(text: str, me: str, groups: list[dict], current: int | None, draft: dict) -> dict:
    """`groups`: [{id, name, members, last}] the user may add to, `last`
    being how recently each was used (higher = more recent). The model reads
    the message; the group is then picked here, by rule - with 150+ groups
    to choose from, the model's own pick was too often an odd one."""
    known = sorted({m for g in groups for m in g["members"] if m.lower() != me.lower()})
    lines = [f"Today: {_today()} ({datetime.now(IST):%A})", f"The user: {me}",
             "People the user knows: " + ", ".join(known)]
    kept = {k: v for k, v in (draft or {}).items() if v not in (None, "", [])}
    if "split_with" in kept:
        kept["people"] = [n for n in kept.pop("split_with") if n.lower() != me.lower()]
    if kept:
        lines.append("Form so far: " + json.dumps(kept, ensure_ascii=False))
    lines.append("\nMessage: " + text.strip()[:600])
    out = ai_text.chat_json(_SYSTEM, "\n".join(lines), temperature=0, timeout=30,
                            extra={"reasoning_effort": "low"})
    return _check(out, me, groups, current)


def _same(a: str, b: str) -> bool:
    """A member name matches a name as said: whole, or by first name."""
    a, b = a.strip().lower(), b.strip().lower()
    return bool(a and b) and (a == b or a.split()[0] == b.split()[0])


def _pick_group(people: list[str], me: str, groups: list[dict], current: int | None) -> int | None:
    by_id = {g["id"]: g for g in groups}

    def holds(g):
        return all(any(_same(m, p) for m in g["members"]) for p in people)
    if current in by_id and (not people or holds(by_id[current])):
        return current
    if not people:
        # Nobody named and no group picked: the user's own tracker, if any
        solo = [g for g in groups if len(g["members"]) == 1]
        return max(solo, key=lambda g: g["last"])["id"] if solo else None
    fits = [g for g in groups if holds(g)]
    if not fits:
        return current if current in by_id else None
    # Just the user and the people named, else the smallest group holding
    # them all; among equals, the one used most recently
    return min(fits, key=lambda g: (len(g["members"]), -g["last"]))["id"]


def _num(v) -> float | None:
    try:
        n = float(str(v).replace(",", "").replace("₹", "").strip())
    except (TypeError, ValueError):
        return None
    return round(n, 2) if n > 0 else None


def _check(out: dict, me: str, groups: list[dict], current: int | None) -> dict:
    said = [str(p) for p in (out.get("people") or []) if str(p).strip()] \
        if isinstance(out.get("people"), list) else []
    said = [p for p in said if not _same(p, me) and p.strip().lower() not in ("me", "i", "myself")]
    gid = _pick_group(said, me, groups, current)
    members = next((g["members"] for g in groups if g["id"] == gid), [])

    def member(name):
        n = str(name or "").strip()
        if not n or not members:
            return None
        exact = [m for m in members if m.lower() == n.lower()]
        firsts = [m for m in members if _same(m, n)]
        return exact[0] if exact else firsts[0] if len(firsts) == 1 else None

    payer = str(out.get("paid_by") or "").strip()
    paid = member(me if payer.lower() in ("", "me", "i", "myself", "user") else payer) or member(me)
    sharing = None
    named = [m for m in (member(p) for p in said) if m]
    if named:
        mine = member(me)
        people = sorted({*named, *([mine] if mine else [])}, key=members.index)
        if len(people) < len(members):
            sharing = people
    date = out.get("date")
    if not (isinstance(date, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", date)):
        date = None
    mode = out.get("payment_mode")
    title = (out.get("title") or "").strip()[:200] or None
    notes = (out.get("notes") or "").strip()[:500] or None
    return {
        "group_id": gid,
        "amount": _num(out.get("amount")),
        "title": title,
        "paid_by": paid,
        "participants": sharing,
        "payment_mode": mode if mode in MODES else None,
        "date": date,
        "notes": notes,
        "reply": (out.get("reply") or "").strip()[:400] or None,
    }


def transcribe(audio: bytes, content_type: str) -> str:
    """Speech to text on Groq's Whisper, trying each Groq key in turn."""
    s = get_settings()
    keys = [k for k in (s.groq_api_key, s.groq_api_key_2) if k]
    if not keys:
        raise RuntimeError("No Groq key configured")
    kind = (content_type or "").split(";")[0].strip() or "audio/webm"
    ext = {"audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "m4a", "audio/mpeg": "mp3",
           "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav"}.get(kind, "webm")
    fields = {"model": WHISPER_MODEL, "temperature": "0", "response_format": "json",
              # Nudges the spelling (₹ amounts, Latin script for Hinglish)
              "prompt": "Rs 400 spent with Utkarsh at XYZ store, paid by UPI."}
    edge = uuid.uuid4().hex
    body = b"".join(
        f"--{edge}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
        for k, v in fields.items()
    ) + (f"--{edge}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"speech.{ext}\"\r\n"
         f"Content-Type: {kind}\r\n\r\n").encode() + audio + f"\r\n--{edge}--\r\n".encode()
    last: Exception | None = None
    for key in keys:
        req = urllib.request.Request(
            "https://api.groq.com/openai/v1/audio/transcriptions", data=body, method="POST",
            headers={"Authorization": f"Bearer {key}",
                     "Content-Type": f"multipart/form-data; boundary={edge}",
                     # Groq's Cloudflare front-end blocks urllib's default user agent.
                     "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
                                   "Chrome/124.0.0.0 Safari/537.36",
                     "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=40) as resp:
                return (json.loads(resp.read().decode()).get("text") or "").strip()
        except (urllib.error.URLError, ValueError, TimeoutError) as e:
            last = e
    raise last or RuntimeError("Transcription failed")

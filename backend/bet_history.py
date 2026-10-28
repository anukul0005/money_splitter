"""My bets: read a bookmaker's betting-history export and keep every bet.

1xbet sends the history on request as an email with a .zip attached,
holding one HTML page: a header ("Bets for: period from 29 jul 2026 to 28
oct 2026", number of bets, total winnings) and one block per bet slip -
slip number, when placed, bet type (single / accumulator), a row per leg
(sport. league / match, pick, odds, status, final result, when settled)
and a footer (stake, total odds, payout or "Loss").

sync_for_user finds those emails in the inbox connected for betting
(BettingGmailConnection - routers/gmail_auth.py, purpose=betting), and
import_zip turns one zip into Bet rows. Exports overlap (each covers the
last few months), so a bet is keyed by its slip number: one already kept is
skipped, unless it was still open then and is settled now.
"""
from __future__ import annotations

import base64
import html as htmlmod
import io
import json
import re
import threading
import zipfile
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from models import Bet, BetImport, BettingGmailConnection

BOOKMAKER = "1xbet"
SEARCH = 'has:attachment filename:zip (from:1xbet OR 1xbet OR "bet history" OR "betting history")'
MAX_MESSAGES = 50

_MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


# ── parsing ──────────────────────────────────────────────────────────────────
def _text(s: str) -> str:
    return re.sub(r"\s+", " ", htmlmod.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def _iso(s: str | None) -> str | None:
    """"28.10.2026 | 15:30" -> "2026-10-28 15:30"."""
    m = re.search(r"(\d{2})\.(\d{2})\.(\d{4})\s*\|\s*(\d{2}:\d{2})", s or "")
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)} {m.group(4)}" if m else None


def _money(s: str | None) -> tuple[float | None, str | None]:
    m = re.search(r"(-?[\d\s]+(?:[.,]\d+)?)\s*([A-Z]{3})", s or "")
    if not m:
        return None, None
    return float(m.group(1).replace(" ", "").replace(",", ".")), m.group(2)


def _period(head: str) -> tuple[str | None, str | None]:
    m = re.search(r"period from (\d{1,2}) (\w{3})\w* (\d{4}) to (\d{1,2}) (\w{3})\w* (\d{4})", head, re.I)
    if not m:
        return None, None
    d = lambda dd, mon, yy: f"{yy}-{_MONTHS.get(mon.lower(), 1):02d}-{int(dd):02d}"
    return d(*m.group(1, 2, 3)), d(*m.group(4, 5, 6))


def _status(payout: float | None, stake: float | None, lost: bool) -> str:
    if lost:
        return "lost"
    if payout is None or stake is None:
        return "open"
    if payout > stake + 0.005:
        return "won"
    if abs(payout - stake) <= 0.005:
        return "returned"
    return "partial" if payout > 0 else "lost"


def settled_all(legs: list[dict]) -> bool:
    return bool(legs) and all(l.get("processed") for l in legs)


def parse_html(page: str) -> dict:
    """{"period": (from, to), "summary": {...}, "bets": [bet dict, ...]}"""
    head = page.split('<div class="cupHisNew', 1)[0]
    summary = {}
    for label, value in re.findall(r"<b>\s*([^<:]+):\s*</b>\s*([^<]+)", head):
        summary[label.strip()] = value.strip()
    bets = []
    for block in page.split('<div class="cupHisNew')[1:]:
        slip = re.search(r"Bet slip\s*№\s*(\d+)", block)
        if not slip:
            continue
        table = block.split('<table class="table_prop">', 1)[-1].split("</table>", 1)[0]
        rows = re.split(r"<tr[^>]*>", table)
        btype = re.search(r"Bet type:\s*([^<]+)", table)
        legs = []
        for i, row in enumerate(rows):
            if 'class="ha"' not in row:
                continue
            name = re.search(r'<b class="[^"]*">(.*?)</b>', row, re.S)
            lines = [_text(x) for x in re.split(r"<br\s*/?>", name.group(1))] if name else []
            head_line = lines[0] if lines else ""
            sport, _, league = head_line.partition(". ")
            cells = [_text(c) for c in re.findall(r'<td class="ce"[^>]*>(.*?)</td>', row, re.S)]
            starts = re.findall(r"<b>\s*(\d{2}\.\d{2}\.\d{4}\s*\|\s*\d{2}:\d{2})\s*</b>", row)
            detail = _text(rows[i + 1]) if i + 1 < len(rows) else ""
            res = re.search(r"Result:\s*(.*?)(?:\s*Time of processing:|$)", detail)
            proc = re.search(r"Time of processing:\s*(\d{2}\.\d{2}\.\d{4}\s*\|\s*\d{2}:\d{2})", detail)
            legs.append({"sport": sport.strip() or None, "league": league.strip() or None,
                         "event": " ".join(lines[1:]).strip() or head_line, "start": _iso(starts[0]) if starts else None,
                         "pick": cells[0] if cells else None,
                         "odds": float(cells[1]) if len(cells) > 1 and re.fullmatch(r"[\d.]+", cells[1]) else None,
                         "status": cells[2] if len(cells) > 2 else None,
                         "result": res.group(1).strip() if res else None,
                         "processed": _iso(proc.group(1)) if proc else None})
        foot = [_text(c) for c in re.findall(r'<td class="ce"[^>]*>(.*?)</td>', rows[-1], re.S)] if rows else []
        stake, cur = _money(foot[0] if foot else None)
        lost = len(foot) > 2 and foot[2].lower().startswith("loss")
        payout, cur2 = (0.0, cur) if lost else _money(foot[2] if len(foot) > 2 else None)
        total_odds = float(foot[1]) if len(foot) > 1 and re.fullmatch(r"[\d.]+", foot[1]) else None
        status = _status(payout, stake, lost)
        cashout = False
        # Sold early: total odds below 1 and no payout written - what came back is stake x those odds.
        if status == "open" and stake and total_odds is not None and total_odds < 1 and settled_all(legs):
            payout, status, cashout = round(stake * total_odds, 2), "cashout", True
        placed = re.search(r"<time>\s*([^<]+)</time>", block)
        sports = {l["sport"] for l in legs if l["sport"]}
        settled = [l["processed"] for l in legs if l["processed"]]
        bets.append({
            "bet_key": slip.group(1), "placed_at": _iso(placed.group(1)) if placed else None,
            "settled_at": max(settled) if settled and len(settled) == len(legs) else None,
            "sport": sports.pop() if len(sports) == 1 else ("Mixed" if sports else None),
            "event": legs[0]["event"] if len(legs) == 1 else f"{len(legs)}-leg accumulator: " + "; ".join(l["event"] for l in legs),
            "market": legs[0]["pick"] if len(legs) == 1 else None,
            "bet_type": btype.group(1).strip() if btype else None, "legs": len(legs) or 1,
            "odds": total_odds, "stake": stake, "payout": payout, "currency": cur or cur2,
            "status": status, "raw": {"legs": legs, **({"payout_estimated": True} if cashout else {})},
        })
    return {"period": _period(head), "summary": summary, "bets": bets}


def pages_in_zip(data: bytes, password: str | None = None) -> list[tuple[str, str]]:
    """[(file name, HTML)] for every .htm(l) inside the zip."""
    z = zipfile.ZipFile(io.BytesIO(data))
    out = []
    for name in z.namelist():
        if name.lower().endswith((".html", ".htm")):
            raw = z.read(name, pwd=password.encode() if password else None)
            for enc in ("utf-8", "cp1251", "latin-1"):
                try:
                    out.append((name, raw.decode(enc)))
                    break
                except UnicodeDecodeError:
                    continue
    return out


# ── storing ──────────────────────────────────────────────────────────────────
def store(db: Session, user_id: int, bets: list[dict], message_id: str) -> int:
    """Adds bets not kept yet; a kept bet that was open is refreshed. Returns how many were new."""
    keys = [b["bet_key"] for b in bets]
    have = {b.bet_key: b for b in db.query(Bet).filter(Bet.user_id == user_id, Bet.bookmaker == BOOKMAKER,
                                                       Bet.bet_key.in_(keys)).all()} if keys else {}
    new = 0
    for b in bets:
        old = have.get(b["bet_key"])
        if old is not None and old.status != "open":
            continue                                   # overlapping export: already kept, already settled
        row = old or Bet(user_id=user_id, bookmaker=BOOKMAKER, bet_key=b["bet_key"])
        for k in ("placed_at", "settled_at", "sport", "event", "market", "bet_type", "legs", "odds", "stake",
                  "payout", "status", "currency"):
            setattr(row, k, b[k])
        row.raw = json.dumps(b["raw"])
        row.gmail_message_id = message_id
        if old is None:
            db.add(row)
            new += 1
    return new


def import_zip(db: Session, user_id: int, data: bytes, message_id: str, subject: str | None = None,
               received_at: datetime | None = None, password: str | None = None) -> BetImport:
    rec = BetImport(user_id=user_id, gmail_message_id=message_id, subject=subject, received_at=received_at)
    try:
        pages = pages_in_zip(data, password)
        rec.files = json.dumps([n for n, _ in pages])
        found = new = 0
        periods, summaries = [], []
        for _, page in pages:
            parsed = parse_html(page)
            found += len(parsed["bets"])
            new += store(db, user_id, parsed["bets"], message_id)
            periods.append(parsed["period"])
            summaries.append(parsed["summary"])
        rec.bets_found, rec.bets_new = found, new
        rec.columns = json.dumps({"periods": periods, "summary": summaries})
        if not found and pages:
            rec.error = "No bets could be read from this file"
            rec.sample = pages[0][1][:20000]
    except RuntimeError as e:                          # zipfile: wrong / missing password
        rec.error = f"Couldn't open the zip: {e}"[:300]
    except zipfile.BadZipFile:
        rec.error = "Not a readable zip file"
    db.add(rec)
    db.commit()
    return rec


# ── Gmail ────────────────────────────────────────────────────────────────────
_progress: dict[int, dict] = {}
_lock = threading.Lock()


def get_progress(user_id: int) -> dict:
    with _lock:
        return dict(_progress.get(user_id, {"status": "idle"}))


def _set(user_id: int, **f) -> None:
    with _lock:
        _progress.setdefault(user_id, {}).update(f)


def _service(conn: BettingGmailConnection):
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    import secret_box
    from database import get_settings
    s = get_settings()
    token = secret_box.decrypt(conn.refresh_token_encrypted)
    if not token:
        raise RuntimeError("The betting Gmail connection is unreadable - connect it again")
    creds = Credentials(None, refresh_token=token, token_uri="https://oauth2.googleapis.com/token",
                        client_id=s.google_client_id, client_secret=s.google_client_secret)
    return build("gmail", "v1", credentials=creds)


def _zips(service, message_id: str, part: dict) -> list[tuple[str, bytes]]:
    out = []
    body = part.get("body", {})
    name = part.get("filename") or ""
    if name.lower().endswith(".zip") or part.get("mimeType") in ("application/zip", "application/x-zip-compressed"):
        data = body.get("data")
        if body.get("attachmentId"):
            data = service.users().messages().attachments().get(userId="me", messageId=message_id,
                                                                id=body["attachmentId"]).execute()["data"]
        if data:
            out.append((name, base64.urlsafe_b64decode(data)))
    for sub in part.get("parts", []) or []:
        out += _zips(service, message_id, sub)
    return out


def sync_for_user(db: Session, user_id: int, password: str | None = None) -> dict:
    conn = db.query(BettingGmailConnection).filter(BettingGmailConnection.user_id == user_id).first()
    if not conn:
        raise RuntimeError("Connect the Gmail inbox your 1xbet history goes to first")
    service = _service(conn)
    ids = [m["id"] for m in service.users().messages().list(userId="me", q=SEARCH, maxResults=MAX_MESSAGES)
           .execute().get("messages", [])]
    done = {r.gmail_message_id for r in db.query(BetImport.gmail_message_id).filter(BetImport.user_id == user_id)}
    todo = [i for i in ids if i not in done]
    _set(user_id, status="running", total=len(todo), done=0, emails=0, bets_new=0, error=None)
    emails = bets_new = 0
    for n, mid in enumerate(reversed(todo), 1):        # oldest first, so a later export refreshes open bets
        msg = service.users().messages().get(userId="me", id=mid).execute()
        headers = {h["name"].lower(): h["value"] for h in msg.get("payload", {}).get("headers", [])}
        received = datetime.fromtimestamp(int(msg.get("internalDate", "0")) / 1000, tz=timezone.utc)
        for fname, data in _zips(service, mid, msg.get("payload", {})):
            rec = import_zip(db, user_id, data, mid, headers.get("subject"), received, password)
            emails += 1
            bets_new += rec.bets_new or 0
        _set(user_id, done=n, emails=emails, bets_new=bets_new)
    conn.last_synced_at = datetime.now(timezone.utc)
    db.commit()
    return {"checked": len(ids), "new_emails": emails, "bets_new": bets_new}


def start_sync(user_id: int, password: str | None = None) -> None:
    if get_progress(user_id).get("status") == "running":
        raise RuntimeError("Already looking")
    from database import get_session_factory
    factory = get_session_factory()
    _set(user_id, status="running", total=0, done=0, emails=0, bets_new=0, error=None)

    def _run():
        db = factory()
        try:
            _set(user_id, status="done", **sync_for_user(db, user_id, password))
        except Exception as e:
            print(f"[bet_history] sync failed for user {user_id}: {e}")
            _set(user_id, status="error", error=str(e)[:300])
        finally:
            db.close()

    threading.Thread(target=_run, daemon=True, name="bet-history").start()

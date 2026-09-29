"""Find credit card statement emails in a connected Gmail inbox, unlock
their password-protected PDF attachment, and extract the billing fields.

One user, one sync call (see routers/credit_cards.py's /scan endpoint) -
this is invoked on request rather than continuously, since a person has to
have actually connected Gmail and set at least one bank's password before
there is anything useful to look for.
"""
from __future__ import annotations

import base64
import io
import threading
from datetime import datetime, timezone

import pdfplumber
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from sqlalchemy.orm import Session
from tqdm import tqdm

import secret_box
import statement_extractor
from database import get_settings
from models import BankPassword, CreditCardStatement, GmailConnection

# In-memory scan progress, keyed by user id, so the frontend can poll
# /credit-cards/scan/progress instead of one request blocking for however
# long a whole inbox scan + LLM extraction takes. Fine to lose on a
# restart/redeploy - it's only ever "how's the scan that's running right
# now going", never data anyone needs kept.
_progress: dict[int, dict] = {}
_progress_lock = threading.Lock()


def get_progress(user_id: int) -> dict:
    with _progress_lock:
        return dict(_progress.get(user_id, {"status": "idle"}))


def _set_progress(user_id: int, **fields) -> None:
    with _progress_lock:
        _progress.setdefault(user_id, {}).update(fields)


def start_sync(user_id: int) -> None:
    """Runs sync_for_user in a background thread against its own DB session
    and returns immediately - see routers/credit_cards.py's /scan endpoint,
    which used to block on the whole scan for one request/response cycle."""
    if get_progress(user_id).get("status") == "running":
        raise RuntimeError("A scan is already running")

    from database import get_session_factory
    session_factory = get_session_factory()
    _set_progress(user_id, status="running", total=0, done=0, found=0,
                  skipped=0, failed=0, error=None)

    def _run():
        db = session_factory()
        try:
            sync_for_user(db, user_id)
            _set_progress(user_id, status="done")
        except Exception as e:
            print(f"[statement_sync] scan failed for user {user_id}: {e}")
            _set_progress(user_id, status="error", error=str(e))
        finally:
            db.close()

    threading.Thread(target=_run, daemon=True).start()

# Broad on purpose: real statement subjects vary a lot bank to bank
# ("Your Credit Card Statement", "e-Statement for card ending 1234",
# "Monthly Statement"...), so this narrows by attachment + a couple of
# near-universal words rather than trying to enumerate every bank's exact
# subject line - the LLM extraction step is the real filter for whether a
# match was actually useful.
SEARCH_QUERY = 'has:attachment filename:pdf (statement OR "credit card") newer_than:9m'

# A hard ceiling, not a page size - was 25 back when a scan had to finish
# inside one HTTP request; now that it runs in a background thread (see
# start_sync) and skips messages already in the DB, this only exists to
# stop one scan from running away on an inbox with hundreds of matches.
MAX_MESSAGES_PER_SYNC = 200


def _gmail_service(connection: GmailConnection):
    settings = get_settings()
    refresh_token = secret_box.decrypt(connection.refresh_token_encrypted)
    if not refresh_token:
        raise RuntimeError("Gmail connection is unreadable - reconnect needed")
    creds = Credentials(
        None,
        refresh_token=refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
    )
    return build("gmail", "v1", credentials=creds)


def _extract_pdf_text(pdf_bytes: bytes, passwords: list[str]) -> str | None:
    """Try opening with no password, then each stored bank password in
    turn - a message's sender doesn't reliably say which bank issued it
    (forwarding, aggregator addresses, etc.), so this just tries every
    password on file rather than guessing which one applies first."""
    for pw in [None, *passwords]:
        try:
            with pdfplumber.open(io.BytesIO(pdf_bytes), password=pw) as pdf:
                return "\n".join((p.extract_text() or "") for p in pdf.pages)
        except Exception:
            continue
    return None


def sync_for_user(db: Session, user_id: int) -> dict:
    connection = db.query(GmailConnection).filter(GmailConnection.user_id == user_id).first()
    if not connection:
        raise RuntimeError("Gmail isn't connected for this account")

    passwords = [
        secret_box.decrypt(bp.password_encrypted)
        for bp in db.query(BankPassword).filter(BankPassword.user_id == user_id).all()
    ]
    passwords = [p for p in passwords if p]

    service = _gmail_service(connection)
    message_ids: list[str] = []
    page_token = None
    while len(message_ids) < MAX_MESSAGES_PER_SYNC:
        resp = service.users().messages().list(
            userId="me", q=SEARCH_QUERY, maxResults=100, pageToken=page_token,
        ).execute()
        message_ids += [m["id"] for m in resp.get("messages", [])]
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    message_ids = message_ids[:MAX_MESSAGES_PER_SYNC]

    already = {
        row.gmail_message_id for row in
        db.query(CreditCardStatement.gmail_message_id)
        .filter(CreditCardStatement.user_id == user_id).all()
    }

    found, skipped, failed = 0, 0, 0
    _set_progress(user_id, status="running", total=len(message_ids), done=0,
                  found=0, skipped=0, failed=0, error=None)
    # mininterval=0 + a plain ASCII bar: Render's log viewer isn't a real
    # terminal, so the default throttled/carriage-return redraw would just
    # sit silent until the loop finished - this instead prints one line per
    # message, which is what actually shows up as progress while it runs.
    bar = tqdm(message_ids, desc=f"[statement_sync] user {user_id}", mininterval=0, ascii=True)
    for i, mid in enumerate(bar, start=1):
        if mid in already:
            skipped += 1
        else:
            try:
                if _process_message(db, service, user_id, mid, passwords):
                    found += 1
                else:
                    failed += 1
            except Exception as e:
                print(f"[statement_sync] message {mid} failed: {e}")
                failed += 1
        bar.set_postfix(found=found, skipped=skipped, failed=failed)
        _set_progress(user_id, done=i, found=found, skipped=skipped, failed=failed)

    connection.last_synced_at = datetime.now(timezone.utc)
    db.commit()
    return {"scanned": len(message_ids), "found": found, "skipped": skipped, "failed": failed}


def _process_message(db: Session, service, user_id: int, message_id: str,
                     passwords: list[str]) -> bool:
    msg = service.users().messages().get(userId="me", id=message_id).execute()
    pdf_bytes = _first_pdf_attachment(service, message_id, msg.get("payload", {}))
    if not pdf_bytes:
        return False

    text = _extract_pdf_text(pdf_bytes, passwords)
    if not text or not text.strip():
        return False  # every password on file failed, or the PDF is unreadable

    if not statement_extractor.available():
        return False

    fields = statement_extractor.extract(text)
    if fields.get("total_due") is None and fields.get("due_date") is None:
        return False  # didn't look like a real statement worth keeping

    import json
    db.add(CreditCardStatement(
        user_id=user_id,
        bank=fields.get("bank") or "Unknown",
        card_last4=fields.get("card_last4"),
        statement_date=fields.get("statement_date"),
        due_date=fields.get("due_date"),
        total_due=fields.get("total_due"),
        minimum_due=fields.get("minimum_due"),
        gmail_message_id=message_id,
        raw_extract=json.dumps(fields),
    ))
    db.commit()
    return True


def _first_pdf_attachment(service, message_id: str, part: dict) -> bytes | None:
    filename = part.get("filename", "")
    body = part.get("body", {})
    if filename.lower().endswith(".pdf") and body.get("attachmentId"):
        att = service.users().messages().attachments().get(
            userId="me", messageId=message_id, id=body["attachmentId"],
        ).execute()
        return base64.urlsafe_b64decode(att["data"])
    for sub in part.get("parts", []) or []:
        found = _first_pdf_attachment(service, message_id, sub)
        if found:
            return found
    return None

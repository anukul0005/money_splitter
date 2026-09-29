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
from datetime import datetime, timezone

import pdfplumber
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from sqlalchemy.orm import Session

import secret_box
import statement_extractor
from database import get_settings
from models import BankPassword, CreditCardStatement, GmailConnection

# Broad on purpose: real statement subjects vary a lot bank to bank
# ("Your Credit Card Statement", "e-Statement for card ending 1234",
# "Monthly Statement"...), so this narrows by attachment + a couple of
# near-universal words rather than trying to enumerate every bank's exact
# subject line - the LLM extraction step is the real filter for whether a
# match was actually useful.
SEARCH_QUERY = 'has:attachment filename:pdf (statement OR "credit card") newer_than:9m'

MAX_MESSAGES_PER_SYNC = 25


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
    resp = service.users().messages().list(
        userId="me", q=SEARCH_QUERY, maxResults=MAX_MESSAGES_PER_SYNC,
    ).execute()
    message_ids = [m["id"] for m in resp.get("messages", [])]

    already = {
        row.gmail_message_id for row in
        db.query(CreditCardStatement.gmail_message_id)
        .filter(CreditCardStatement.user_id == user_id).all()
    }

    found, skipped, failed = 0, 0, 0
    for mid in message_ids:
        if mid in already:
            skipped += 1
            continue
        try:
            if _process_message(db, service, user_id, mid, passwords):
                found += 1
            else:
                failed += 1
        except Exception as e:
            print(f"[statement_sync] message {mid} failed: {e}")
            failed += 1

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

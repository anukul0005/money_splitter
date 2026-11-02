"""Payment-app statements from a connected Gmail inbox, for the monthly
expenses: PhonePe, Paytm and Google Pay statement emails, each attachment
(PDF, CSV or Excel - locked or not) handed to the same import a hand
upload goes through (routers/expenses.py's mail-sync job).

Gmail access is the Credit Cards connection (models.GmailConnection,
read-only); this only finds the emails and fetches their files.
"""
from __future__ import annotations

import base64

# The apps' statement emails: by sender, or the app named in the subject.
SENDERS = ("phonepe.com", "paytm.com", "paytmbank.com", "paytmpayments.com", "google.com")
STATEMENT_FILES = (".pdf", ".csv", ".xlsx", ".xls")
MAX_MESSAGES = 30


def query(days: int) -> str:
    who = " OR ".join([f"from:{s}" for s in SENDERS] + ['subject:phonepe', 'subject:paytm', 'subject:"google pay"'])
    files = " OR ".join(f"filename:{x.lstrip('.')}" for x in STATEMENT_FILES)
    return f"has:attachment ({files}) ({who}) (statement OR passbook OR transactions OR history) newer_than:{days}d"


def find(connection, days: int) -> tuple[object, list[str]]:
    """(Gmail service, ids of the statement emails), newest first."""
    from statement_sync import _gmail_service
    service = _gmail_service(connection)
    resp = service.users().messages().list(userId="me", q=query(days), maxResults=MAX_MESSAGES).execute()
    return service, [m["id"] for m in resp.get("messages", [])]


def _parts(part: dict):
    yield part
    for sub in part.get("parts", []) or []:
        yield from _parts(sub)


def attachments(service, message_id: str) -> tuple[str, list[tuple[str, bytes]]]:
    """(subject, [(file name, bytes)]) of an email's statement files."""
    msg = service.users().messages().get(userId="me", id=message_id).execute()
    payload = msg.get("payload", {})
    subject = next((h["value"] for h in payload.get("headers", []) if h.get("name", "").lower() == "subject"), "")
    out = []
    for p in _parts(payload):
        name = (p.get("filename") or "").strip()
        body = p.get("body", {})
        if not name.lower().endswith(STATEMENT_FILES) or not (body.get("attachmentId") or body.get("data")):
            continue
        data = body.get("data")
        if body.get("attachmentId"):
            data = service.users().messages().attachments().get(
                userId="me", messageId=message_id, id=body["attachmentId"]).execute()["data"]
        out.append((name, base64.urlsafe_b64decode(data)))
    return subject, out

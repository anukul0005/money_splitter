"""Connect / disconnect a Gmail inbox, read-only, for the Credit Cards
statement scanner (see statement_sync.py for what actually gets done with
the access this grants).

/gmail/connect and /gmail/callback are the two halves of the OAuth
handshake. The tricky part is that /gmail/callback is hit by Google's own
redirect, not by an authenticated request from this app's frontend - there
is no Authorization header to read a caller from, only whatever this app
put in the `state` param on the way out. So `state` carries the caller's
user id, signed and time-limited (see secret_box.decrypt's ttl), which is
what lets the callback trust it without a session token.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from google_auth_oauthlib.flow import Flow
from sqlalchemy.orm import Session

import secret_box
from auth import current_user
from database import get_db, get_settings
from models import GmailConnection, User

router = APIRouter(prefix="/gmail", tags=["gmail"])

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
STATE_TTL_SECONDS = 600   # 10 minutes to complete the Google consent screen


def _redirect_uri() -> str:
    return f"{get_settings().api_base_url}/gmail/callback"


def _flow() -> Flow:
    settings = get_settings()
    if not settings.google_client_id or not settings.google_client_secret:
        raise HTTPException(400, "Gmail isn't configured on the server yet")
    return Flow.from_client_config(
        {
            "web": {
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        },
        scopes=SCOPES,
        redirect_uri=_redirect_uri(),
    )


@router.get("/connect", response_model=dict)
def connect(caller: User = Depends(current_user)):
    """The URL to send the browser to. The frontend just does
    `window.location = data.url` - there is nothing to POST here, Google's
    own consent screen is the next step."""
    flow = _flow()
    state = secret_box.encrypt(str(caller.id))
    auth_url, _ = flow.authorization_url(
        access_type="offline",     # required to get a refresh token back
        prompt="consent",          # forces one even on a re-connect
        include_granted_scopes="true",
        state=state,
    )
    return {"url": auth_url}


@router.get("/callback")
def callback(code: str | None = None, state: str | None = None, error: str | None = None,
            db: Session = Depends(get_db)):
    """No auth dependency on purpose - see the module docstring."""
    settings = get_settings()
    frontend = settings.frontend_url.rstrip("/")

    if error:
        return RedirectResponse(f"{frontend}/loans?tab=cards&gmail=error&reason={error}")
    if not code or not state:
        return RedirectResponse(f"{frontend}/loans?tab=cards&gmail=error&reason=missing_code")

    user_id_str = secret_box.decrypt(state, ttl=STATE_TTL_SECONDS)
    if not user_id_str:
        return RedirectResponse(f"{frontend}/loans?tab=cards&gmail=error&reason=expired")

    user = db.query(User).filter(User.id == int(user_id_str)).first()
    if not user:
        return RedirectResponse(f"{frontend}/loans?tab=cards&gmail=error&reason=unknown_user")

    flow = _flow()
    try:
        flow.fetch_token(code=code)
    except Exception as e:
        print(f"[gmail] token exchange failed: {e}")
        return RedirectResponse(f"{frontend}/loans?tab=cards&gmail=error&reason=token_exchange")

    creds = flow.credentials
    if not creds.refresh_token:
        # Happens if the person has connected before and Google decided not
        # to re-issue one - prompt=consent above is meant to prevent this,
        # but a stale existing connection's refresh token still works, so
        # this isn't fatal unless there was no connection before at all.
        existing = db.query(GmailConnection).filter(GmailConnection.user_id == user.id).first()
        if not existing:
            return RedirectResponse(f"{frontend}/loans?tab=cards&gmail=error&reason=no_refresh_token")
    else:
        gmail_address = _fetch_gmail_address(creds)
        row = db.query(GmailConnection).filter(GmailConnection.user_id == user.id).first()
        if row is None:
            row = GmailConnection(user_id=user.id, gmail_address=gmail_address,
                                  refresh_token_encrypted=secret_box.encrypt(creds.refresh_token))
            db.add(row)
        else:
            row.gmail_address = gmail_address
            row.refresh_token_encrypted = secret_box.encrypt(creds.refresh_token)
        db.commit()

    return RedirectResponse(f"{frontend}/loans?tab=cards&gmail=connected")


def _fetch_gmail_address(creds) -> str:
    from googleapiclient.discovery import build

    service = build("gmail", "v1", credentials=creds)
    profile = service.users().getProfile(userId="me").execute()
    return profile.get("emailAddress", "")


@router.get("/status", response_model=dict)
def status(db: Session = Depends(get_db), caller: User = Depends(current_user)):
    row = db.query(GmailConnection).filter(GmailConnection.user_id == caller.id).first()
    if not row:
        return {"connected": False}
    return {
        "connected": True,
        "gmail_address": row.gmail_address,
        "connected_at": row.connected_at,
        "last_synced_at": row.last_synced_at,
    }


@router.delete("/disconnect", status_code=204)
def disconnect(db: Session = Depends(get_db), caller: User = Depends(current_user)):
    row = db.query(GmailConnection).filter(GmailConnection.user_id == caller.id).first()
    if row:
        db.delete(row)
        db.commit()

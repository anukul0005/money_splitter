"""Who is calling, and are they allowed to see this.

Before this existed the API had no notion of a caller at all: every endpoint
served whoever asked, and the filtering that made the app look private lived
in React. A `name` query parameter is not identity — anyone can type another
person's name — so the rule here is that identity comes from a signed token
and never from the request body or query string.

The token is a signed blob, not encryption: its contents are readable by
anyone holding it, but they cannot be changed without the server's secret.
That is all a session needs. It deliberately avoids a JWT dependency —
hmac and secrets are in the standard library and this app is small.
"""

from __future__ import annotations

import base64
import hmac
import json
import os
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from hashlib import sha256

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from database import get_db
from models import Group, User

TOKEN_TTL = timedelta(days=30)

# Sent only when the *session* is bad, never when a password, passkey or
# one-time code is wrong. The client signs the user out on this and nothing
# else — otherwise mistyping an admin passkey logs the admin out, which is
# exactly what happened when any 401 was treated as an expired session.
SESSION_EXPIRED = "Sign in to continue"


@lru_cache(maxsize=1)
def _secret() -> bytes:
    """Server signing key. Must be identical before and after a restart.

    SECRET_KEY from the environment wins. Without it we *derive* a key from
    DATABASE_URL rather than generating a random one, because a random key has
    to be stored somewhere and there is nowhere reliable to put it: a free
    Render instance spins down when idle and comes back with an empty disk, so
    a key written to a file is a new key every time the app wakes — and every
    session dies with it. That is what "logged out for no reason after being
    idle" was.

    Deriving instead means the key is a pure function of config the server
    already has, so it survives restarts, redeploys and cold starts with no
    setup. It is not a substitute for SECRET_KEY: anyone holding DATABASE_URL
    could mint tokens — though they could equally read the whole database
    directly, so it adds no meaningful exposure. Rotating the database
    password changes the derived key and signs everyone out once.
    """
    env = os.getenv("SECRET_KEY", "").strip()
    if env:
        return env.encode()

    from database import get_settings

    return hmac.new(
        b"money-splitter/session-key/v1",
        get_settings().database_url.encode(),
        sha256,
    ).digest()


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def create_token(user: User) -> str:
    payload = {
        "uid": user.id,
        "name": user.name,
        "adm": bool(user.is_admin),
        "exp": (datetime.now(timezone.utc) + TOKEN_TTL).timestamp(),
    }
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    sig = _b64(hmac.new(_secret(), body.encode(), sha256).digest())
    return f"{body}.{sig}"


def read_token(token: str) -> dict | None:
    """Decode a token, or None if it's malformed, forged or expired."""
    try:
        body, sig = token.split(".", 1)
        expected = _b64(hmac.new(_secret(), body.encode(), sha256).digest())
        # compare_digest so a wrong signature can't be found byte by byte
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(_unb64(body))
    except Exception:
        return None
    if float(payload.get("exp", 0)) < datetime.now(timezone.utc).timestamp():
        return None
    return payload


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    """The signed-in caller. Every protected endpoint depends on this."""
    header = request.headers.get("Authorization", "")
    token = header[7:].strip() if header.lower().startswith("bearer ") else ""
    payload = read_token(token) if token else None
    if not payload:
        raise HTTPException(401, SESSION_EXPIRED, headers={"WWW-Authenticate": "Bearer"})

    user = db.query(User).filter(User.id == payload["uid"]).first()
    if not user:
        raise HTTPException(401, SESSION_EXPIRED, headers={"WWW-Authenticate": "Bearer"})
    return user


def require_admin(user: User = Depends(current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(403, "Admins only")
    return user


def is_member(group: Group, user: User) -> bool:
    return any(m.name.lower() == user.name.lower() for m in group.members)


def member_group(group_id: int, user: User, db: Session) -> Group:
    """Fetch a group, but only for someone who is in it.

    Returns 404 rather than 403 for a group the caller isn't in: telling an
    outsider "that exists, you just can't see it" is itself a leak of who is
    grouped with whom.
    """
    group = db.query(Group).filter(Group.id == group_id).first()
    if not group or not is_member(group, user):
        raise HTTPException(404, "Group not found")
    return group


def visible_groups(db: Session, user: User) -> list[Group]:
    """Every group the caller belongs to."""
    return [g for g in db.query(Group).all() if is_member(g, user)]

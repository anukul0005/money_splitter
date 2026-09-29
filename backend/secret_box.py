"""Encryption at rest for things nobody but this server should ever read in
the clear: a bank's PDF-opening password, a Gmail OAuth refresh token.

Keyed the same way auth.py's session-signing key is - SECRET_KEY from the
environment if set, otherwise derived from DATABASE_URL so it survives a
restart with no extra setup. A database leak that gets these rows also gets
DATABASE_URL, so deriving from it adds no meaningful exposure beyond what a
leak already grants; it does mean rotating the database password re-derives
this key too, which would make every already-stored secret unreadable - not
a concern yet, since nothing is stored here before this feature ships.
"""

from __future__ import annotations

import base64
import hmac
import os
from functools import lru_cache
from hashlib import sha256

from cryptography.fernet import Fernet, InvalidToken


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    env = os.getenv("SECRET_KEY", "").strip()
    if env:
        raw = env.encode()
    else:
        from database import get_settings

        raw = hmac.new(
            b"money-splitter/secret-box/v1",
            get_settings().database_url.encode(),
            sha256,
        ).digest()
    # Fernet needs a 32-byte urlsafe-base64 key specifically, not an
    # arbitrary secret, so the derived bytes are hashed down and re-encoded.
    key = base64.urlsafe_b64encode(sha256(raw).digest())
    return Fernet(key)


def encrypt(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str, ttl: int | None = None) -> str | None:
    """None rather than raising - a row encrypted under a since-rotated key
    should read as "gone", not crash whatever asked for it.

    `ttl` (seconds) rejects a token older than that, on top of the normal
    integrity check - used for the Gmail OAuth "state" param, which is a
    short-lived, signed handoff rather than a row this app stores.
    """
    try:
        kwargs = {"ttl": ttl} if ttl is not None else {}
        return _fernet().decrypt(ciphertext.encode(), **kwargs).decode()
    except (InvalidToken, ValueError):
        return None

"""Web Push - the system-level notification that shows even when SplitEasy
isn't open in a tab, distinct from both email and the in-app Activity feed.

One VAPID keypair (see database.Settings) identifies this server to every
browser's push service; a subscription (see models.PushSubscription) -
endpoint plus per-device encryption keys - identifies one signed-in
browser/device. Sending is always best-effort and always alongside the
existing email, never instead of it: every place in emailer.py that sends
a notification email calls send_push_to_user right after, and a push
failure there must never be allowed to look like the whole notification
failed.
"""
from __future__ import annotations

import json

from pywebpush import WebPushException, webpush

from database import get_settings


def available() -> bool:
    s = get_settings()
    return bool(s.vapid_private_key and s.vapid_public_key)


def send_push_to_user(db, name: str, title: str, body: str, url: str = "/") -> None:
    """Push to every device `name` (a User's own account name, matched
    case-insensitively) is currently subscribed on.

    Does nothing - not an error - when push isn't configured, or when this
    person has never enabled it (no User account, or an account with zero
    subscriptions): the same degrade-gracefully rule every other optional
    integration in this app follows. A person who only exists in the
    static people.py registry, never having logged in, can't have a
    subscription either way.
    """
    if not available():
        return

    from models import PushSubscription, User   # deferred: push is imported by emailer, which routers import

    user = db.query(User).filter(User.name.ilike(name)).first()
    if not user:
        return

    subs = db.query(PushSubscription).filter(PushSubscription.user_id == user.id).all()
    if not subs:
        return

    settings = get_settings()
    payload = json.dumps({"title": title, "body": body, "url": url})

    for sub in subs:
        try:
            webpush(
                subscription_info={
                    "endpoint": sub.endpoint,
                    "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
                },
                data=payload,
                vapid_private_key=settings.vapid_private_key,
                vapid_claims={"sub": f"mailto:{settings.vapid_claim_email}"},
            )
        except WebPushException as e:
            # 404/410 - the push service has already dropped this
            # subscription (browser uninstalled, site data cleared,
            # subscription expired) - the subscription is dead, not this
            # send, so it's removed rather than retried forever.
            status = getattr(e.response, "status_code", None)
            if status in (404, 410):
                db.delete(sub)
                db.commit()
            else:
                print(f"[push] send failed for {name}: {e}")
        except Exception as e:
            print(f"[push] send failed for {name}: {e}")

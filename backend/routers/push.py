"""Web Push subscription management - see push.py for the actual sending.

Subscribing/unsubscribing is self-service only: a browser only ever
registers or removes its own subscription, tied to whoever is signed in
when it does so, the same rule /users/me/email already follows for who
gets to say where a person's notifications go.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import current_user
from database import get_db, get_settings
from models import PushSubscription, User

router = APIRouter(prefix="/push", tags=["push"])


class PushKeys(BaseModel):
    p256dh: str
    auth: str


class SubscribePayload(BaseModel):
    endpoint: str
    keys: PushKeys


class UnsubscribePayload(BaseModel):
    endpoint: str


@router.get("/vapid-public-key", response_model=dict)
def vapid_public_key():
    """The one non-secret half of the VAPID keypair - handed to the
    browser as the applicationServerKey a subscription is created with.
    Empty string when push isn't configured; the frontend treats that as
    "don't offer to enable notifications" rather than erroring.
    """
    return {"key": get_settings().vapid_public_key}


@router.post("/subscribe", response_model=dict)
def subscribe(payload: SubscribePayload, db: Session = Depends(get_db),
             caller: User = Depends(current_user)):
    """Register (or re-register) one browser's subscription for the
    signed-in user. An endpoint the browser already had on file - the
    same device subscribing again - updates that row in place rather than
    creating a duplicate, since the Push API guarantees the endpoint
    itself is a stable per-installation address.
    """
    existing = db.query(PushSubscription).filter(
        PushSubscription.endpoint == payload.endpoint
    ).first()
    if existing:
        existing.user_id = caller.id
        existing.p256dh = payload.keys.p256dh
        existing.auth = payload.keys.auth
    else:
        db.add(PushSubscription(
            user_id=caller.id, endpoint=payload.endpoint,
            p256dh=payload.keys.p256dh, auth=payload.keys.auth,
        ))
    db.commit()
    return {"status": "subscribed"}


@router.post("/unsubscribe", response_model=dict)
def unsubscribe(payload: UnsubscribePayload, db: Session = Depends(get_db),
                caller: User = Depends(current_user)):
    """Removes only the caller's own subscription for this endpoint - never
    anyone else's, even if the endpoint string were somehow guessed."""
    db.query(PushSubscription).filter(
        PushSubscription.endpoint == payload.endpoint,
        PushSubscription.user_id == caller.id,
    ).delete()
    db.commit()
    return {"status": "unsubscribed"}

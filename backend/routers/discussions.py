"""Discussions: a group's planning threads - wedding venues, a trip's
hotels - where members talk, direct enquiries at each other, and note the
quotes they get in the same fields, to compare side by side.

  - a message can be directed at members: each gets a task (and an email /
    push), open until they mark it done or add a quote against it
  - people not on the app are invited by email; opening the link once
    signed in puts them in the group
  - the AI tidies a message before it's sent (POST /discussions/polish) and
    suggests the quote fields for a topic (POST /discussions/suggest-params)

Only the group's members see a discussion (member_group - a 404 otherwise).
"""
from __future__ import annotations

import json
import re
import secrets
from datetime import datetime, timezone
from html import escape

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from auth import caller_groups, current_user, member_group
from database import get_db
from models import (Discussion, DiscussionInvite, DiscussionMessage, DiscussionQuote, DiscussionTask,
                    Group, Member, User)

router = APIRouter(prefix="/discussions", tags=["discussions"])

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$", re.I)
MAX_PARAMS = 12


def _now():
    return datetime.now(timezone.utc)


def _loads(s, default):
    try:
        return json.loads(s) if s else default
    except ValueError:
        return default


def _clean_params(raw: list) -> list[dict]:
    """[{key, label, unit}] with unique keys made from the labels."""
    out, seen = [], set()
    for p in raw or []:
        label = (p.get("label") if isinstance(p, dict) else str(p) or "").strip()[:60]
        if not label:
            continue
        key = (p.get("key") if isinstance(p, dict) and p.get("key") else None) or \
            re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_") or "field"
        base, n = key[:40], 2
        while key in seen:
            key, n = f"{base}_{n}", n + 1
        seen.add(key)
        unit = (p.get("unit") or "").strip()[:20] if isinstance(p, dict) else ""
        out.append({"key": key, "label": label, "unit": unit})
        if len(out) >= MAX_PARAMS:
            break
    return out


def _discussion(db: Session, discussion_id: int, caller: User) -> tuple[Discussion, Group]:
    d = db.get(Discussion, discussion_id)
    if not d:
        raise HTTPException(404, "No such discussion")
    group = member_group(d.group_id, caller, db, with_history=False)    # 404 for non-members
    return d, group


def _touch(d: Discussion) -> None:
    d.updated_at = _now()


# ── list / create ──────────────────────────────────────────────────────────

@router.get("", response_model=list)
def list_discussions(db: Session = Depends(get_db), caller: User = Depends(current_user)):
    groups = {g.id: g for g in caller_groups(db, caller, history=False)}
    if not groups:
        return []
    rows = (db.query(Discussion).filter(Discussion.group_id.in_(list(groups)))
            .order_by(Discussion.updated_at.desc()).all())
    ids = [d.id for d in rows]
    if not ids:
        return []
    msgs = dict(db.query(DiscussionMessage.discussion_id, func.count()).filter(
        DiscussionMessage.discussion_id.in_(ids)).group_by(DiscussionMessage.discussion_id).all())
    quotes = dict(db.query(DiscussionQuote.discussion_id, func.count()).filter(
        DiscussionQuote.discussion_id.in_(ids)).group_by(DiscussionQuote.discussion_id).all())
    mine = dict(db.query(DiscussionTask.discussion_id, func.count()).filter(
        DiscussionTask.discussion_id.in_(ids), DiscussionTask.status == "open",
        DiscussionTask.assignee.ilike(caller.name)).group_by(DiscussionTask.discussion_id).all())
    out = []
    for d in rows:
        last = (db.query(DiscussionMessage).filter(DiscussionMessage.discussion_id == d.id)
                .order_by(DiscussionMessage.id.desc()).first())
        g = groups[d.group_id]
        out.append({
            "id": d.id, "title": d.title, "description": d.description, "created_by": d.created_by,
            "updated_at": d.updated_at, "group": {"id": g.id, "name": g.name, "emoji": g.emoji},
            "members": [m.name for m in g.members],
            "messages": msgs.get(d.id, 0), "quotes": quotes.get(d.id, 0), "my_open_tasks": mine.get(d.id, 0),
            "last": {"author": last.author, "text": last.text[:140], "at": last.created_at} if last else None,
        })
    return out


class DiscussionIn(BaseModel):
    group_id: int
    title: str
    description: str | None = None
    params: list = []


@router.post("", response_model=dict, status_code=201)
def create_discussion(payload: DiscussionIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    member_group(payload.group_id, caller, db, with_history=False)
    title = payload.title.strip()[:200]
    if not title:
        raise HTTPException(400, "Give the discussion a title")
    d = Discussion(group_id=payload.group_id, title=title, description=(payload.description or "").strip() or None,
                   params_json=json.dumps(_clean_params(payload.params)), created_by=caller.name)
    db.add(d)
    db.commit()
    return {"id": d.id}


class DiscussionEdit(BaseModel):
    title: str | None = None
    description: str | None = None
    params: list | None = None


@router.patch("/{discussion_id}", response_model=dict)
def edit_discussion(discussion_id: int, payload: DiscussionEdit, db: Session = Depends(get_db),
                    caller: User = Depends(current_user)):
    d, _ = _discussion(db, discussion_id, caller)
    if payload.title is not None and payload.title.strip():
        d.title = payload.title.strip()[:200]
    if payload.description is not None:
        d.description = payload.description.strip() or None
    if payload.params is not None:
        d.params_json = json.dumps(_clean_params(payload.params))
    _touch(d)
    db.commit()
    return {"ok": True}


@router.delete("/{discussion_id}", status_code=204)
def delete_discussion(discussion_id: int, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    d, _ = _discussion(db, discussion_id, caller)
    if d.created_by.lower() != caller.name.lower():
        raise HTTPException(403, "Only whoever started the discussion can delete it")
    db.delete(d)
    db.commit()


# ── one discussion ─────────────────────────────────────────────────────────

def _task_out(t: DiscussionTask) -> dict:
    return {"id": t.id, "message_id": t.message_id, "assignee": t.assignee, "status": t.status,
            "done_at": t.done_at, "created_at": t.created_at}


def _quote_out(q: DiscussionQuote) -> dict:
    return {"id": q.id, "task_id": q.task_id, "entered_by": q.entered_by, "vendor": q.vendor,
            "values": _loads(q.values_json, {}), "note": q.note, "created_at": q.created_at}


@router.get("/{discussion_id}", response_model=dict)
def get_discussion(discussion_id: int, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    d, group = _discussion(db, discussion_id, caller)
    msgs = db.query(DiscussionMessage).filter(DiscussionMessage.discussion_id == d.id) \
        .order_by(DiscussionMessage.id).all()
    tasks = db.query(DiscussionTask).filter(DiscussionTask.discussion_id == d.id).order_by(DiscussionTask.id).all()
    quotes = db.query(DiscussionQuote).filter(DiscussionQuote.discussion_id == d.id) \
        .order_by(DiscussionQuote.id.desc()).all()
    invites = db.query(DiscussionInvite).filter(DiscussionInvite.discussion_id == d.id).all()
    by_msg: dict[int, list] = {}
    for t in tasks:
        by_msg.setdefault(t.message_id, []).append(_task_out(t))
    return {
        "id": d.id, "title": d.title, "description": d.description, "created_by": d.created_by,
        "created_at": d.created_at, "params": _loads(d.params_json, []),
        "group": {"id": group.id, "name": group.name, "emoji": group.emoji},
        "members": [m.name for m in group.members],
        "me": caller.name,
        "messages": [{
            "id": m.id, "author": m.author, "text": m.text, "polished": bool(m.original_text),
            "assignees": _loads(m.assignees_json, []), "invites": _loads(m.invites_json, []),
            "tasks": by_msg.get(m.id, []), "created_at": m.created_at,
        } for m in msgs],
        "quotes": [_quote_out(q) for q in quotes],
        "invites": [{"email": i.email, "invited_by": i.invited_by, "accepted_by": i.accepted_by,
                     "created_at": i.created_at} for i in invites],
        "ai": _ai_available(),
    }


def _ai_available() -> bool:
    try:
        import ai_text
        return ai_text.available()
    except Exception:
        return False


class MessageIn(BaseModel):
    text: str
    original_text: str | None = None      # what was typed, when the AI's version is sent
    assignees: list[str] = []
    invite_emails: list[str] = []


@router.post("/{discussion_id}/messages", response_model=dict, status_code=201)
def post_message(discussion_id: int, payload: MessageIn, bg: BackgroundTasks,
                 db: Session = Depends(get_db), caller: User = Depends(current_user)):
    d, group = _discussion(db, discussion_id, caller)
    text = payload.text.strip()
    if not text:
        raise HTTPException(400, "Write something first")
    names = {m.name.lower(): m.name for m in group.members}
    assignees = []
    for a in payload.assignees:
        name = names.get((a or "").strip().lower())
        if not name:
            raise HTTPException(400, f"{a} isn't in {group.name}")
        if name not in assignees:
            assignees.append(name)
    emails = []
    for e in payload.invite_emails:
        e = (e or "").strip().lower()
        if not e:
            continue
        if not _EMAIL.match(e):
            raise HTTPException(400, f"{e} doesn't look like an email address")
        if e not in emails:
            emails.append(e)
    if len(emails) > 10:
        raise HTTPException(400, "Invite at most 10 people at a time")

    m = DiscussionMessage(discussion_id=d.id, author=caller.name, text=text[:5000],
                          original_text=(payload.original_text or "").strip()[:5000] or None,
                          assignees_json=json.dumps(assignees) if assignees else None,
                          invites_json=json.dumps(emails) if emails else None)
    db.add(m)
    db.flush()
    for a in assignees:
        db.add(DiscussionTask(discussion_id=d.id, message_id=m.id, assignee=a))
    tokens = []
    for e in emails:
        tok = secrets.token_urlsafe(24)
        db.add(DiscussionInvite(discussion_id=d.id, email=e, token=tok, invited_by=caller.name))
        tokens.append((e, tok))
    _touch(d)
    db.commit()
    bg.add_task(_notify_message, d.id, m.id, tokens)
    return {"id": m.id}


@router.delete("/{discussion_id}/messages/{message_id}", status_code=204)
def delete_message(discussion_id: int, message_id: int, db: Session = Depends(get_db),
                   caller: User = Depends(current_user)):
    d, _ = _discussion(db, discussion_id, caller)
    m = db.query(DiscussionMessage).filter(DiscussionMessage.id == message_id,
                                           DiscussionMessage.discussion_id == d.id).first()
    if not m:
        raise HTTPException(404, "No such message")
    if m.author.lower() != caller.name.lower():
        raise HTTPException(403, "Only its author can delete a message")
    db.delete(m)
    db.commit()


def _notify_message(discussion_id: int, message_id: int, invites: list[tuple[str, str]]) -> None:
    """Directed members: email + push. Everyone else in the group: a push.
    Invited emails: an invite with the link that adds them to the group."""
    import emailer
    import push as _push
    from database import get_session_factory, get_settings
    db = get_session_factory()()
    try:
        d = db.get(Discussion, discussion_id)
        m = db.get(DiscussionMessage, message_id)
        if not d or not m:
            return
        group = db.get(Group, d.group_id)
        url = f"/discuss/{d.id}"
        assignees = _loads(m.assignees_json, [])
        preview = m.text if len(m.text) <= 300 else m.text[:297] + "…"
        for name in assignees:
            if name.lower() == m.author.lower():
                continue
            emailer.send_notice(db, name, f"{m.author} asked you: {d.title}",
                                [f"{m.author} directed this to you in \"{d.title}\" ({group.name}):", preview],
                                push_body=f"{m.author}: {preview[:120]}", url=url,
                                button_label="Open the discussion")
        skip = {a.lower() for a in assignees} | {m.author.lower()}
        for mem in group.members:
            if mem.name.lower() not in skip:
                try:
                    _push.send_push_to_user(db, mem.name, f"{m.author} in {d.title}", preview[:120], url=url)
                except Exception as e:
                    print(f"[discussions] push failed: {e}")
        front = get_settings().frontend_url.rstrip("/")
        for email, tok in invites:
            link = f"{front}/discuss/{d.id}?invite={tok}"
            subject = f"{m.author} invited you to plan \"{d.title}\""
            lines = [f"{m.author} would like your help with \"{d.title}\" ({group.name}) on SplitEasy:", preview,
                     "Sign up (or sign in) and open the link - you'll join the group and can reply and add quotes."]
            try:
                emailer._send(email, subject, "\n\n".join(lines) + f"\n\nJoin here: {link}",
                              emailer._layout(subject, [escape(x) for x in lines], button_url=link,
                                              button_label="Join the discussion"))
            except Exception as e:
                print(f"[discussions] invite email to {email} failed: {e}")
    except Exception as e:
        print(f"[discussions] notify failed: {e}")
    finally:
        db.close()


# ── tasks & quotes ─────────────────────────────────────────────────────────

class TaskStatus(BaseModel):
    status: str


@router.post("/{discussion_id}/tasks/{task_id}", response_model=dict)
def set_task(discussion_id: int, task_id: int, payload: TaskStatus, db: Session = Depends(get_db),
             caller: User = Depends(current_user)):
    d, _ = _discussion(db, discussion_id, caller)
    t = db.query(DiscussionTask).filter(DiscussionTask.id == task_id, DiscussionTask.discussion_id == d.id).first()
    if not t:
        raise HTTPException(404, "No such task")
    msg = db.get(DiscussionMessage, t.message_id)
    if caller.name.lower() not in (t.assignee.lower(), (msg.author if msg else "").lower()):
        raise HTTPException(403, "Only the person asked, or who asked, can change this")
    if payload.status not in ("open", "done"):
        raise HTTPException(400, "open or done")
    t.status = payload.status
    t.done_at = _now() if payload.status == "done" else None
    _touch(d)
    db.commit()
    return _task_out(t)


class QuoteIn(BaseModel):
    vendor: str
    values: dict = {}
    note: str | None = None
    task_id: int | None = None


def _clean_values(d: Discussion, values: dict) -> dict:
    keys = {p["key"] for p in _loads(d.params_json, [])}
    return {k: str(v).strip()[:200] for k, v in (values or {}).items() if k in keys and str(v).strip()}


@router.post("/{discussion_id}/quotes", response_model=dict, status_code=201)
def add_quote(discussion_id: int, payload: QuoteIn, db: Session = Depends(get_db),
              caller: User = Depends(current_user)):
    d, _ = _discussion(db, discussion_id, caller)
    vendor = payload.vendor.strip()[:200]
    if not vendor:
        raise HTTPException(400, "Who is the quote from?")
    task = None
    if payload.task_id:
        task = db.query(DiscussionTask).filter(DiscussionTask.id == payload.task_id,
                                               DiscussionTask.discussion_id == d.id).first()
        if not task:
            raise HTTPException(404, "No such enquiry")
    q = DiscussionQuote(discussion_id=d.id, task_id=task.id if task else None, entered_by=caller.name, vendor=vendor,
                        values_json=json.dumps(_clean_values(d, payload.values)),
                        note=(payload.note or "").strip()[:2000] or None)
    db.add(q)
    if task and task.assignee.lower() == caller.name.lower() and task.status == "open":
        task.status, task.done_at = "done", _now()       # a quote answers the enquiry
    _touch(d)
    db.commit()
    return _quote_out(q)


@router.put("/{discussion_id}/quotes/{quote_id}", response_model=dict)
def edit_quote(discussion_id: int, quote_id: int, payload: QuoteIn, db: Session = Depends(get_db),
               caller: User = Depends(current_user)):
    d, _ = _discussion(db, discussion_id, caller)
    q = db.query(DiscussionQuote).filter(DiscussionQuote.id == quote_id, DiscussionQuote.discussion_id == d.id).first()
    if not q:
        raise HTTPException(404, "No such quote")
    if q.entered_by.lower() != caller.name.lower():
        raise HTTPException(403, "Only whoever added a quote can change it")
    if not payload.vendor.strip():
        raise HTTPException(400, "Who is the quote from?")
    q.vendor = payload.vendor.strip()[:200]
    q.values_json = json.dumps(_clean_values(d, payload.values))
    q.note = (payload.note or "").strip()[:2000] or None
    _touch(d)
    db.commit()
    return _quote_out(q)


@router.delete("/{discussion_id}/quotes/{quote_id}", status_code=204)
def delete_quote(discussion_id: int, quote_id: int, db: Session = Depends(get_db),
                 caller: User = Depends(current_user)):
    d, _ = _discussion(db, discussion_id, caller)
    q = db.query(DiscussionQuote).filter(DiscussionQuote.id == quote_id, DiscussionQuote.discussion_id == d.id).first()
    if q and q.entered_by.lower() != caller.name.lower():
        raise HTTPException(403, "Only whoever added a quote can delete it")
    if q:
        db.delete(q)
        db.commit()


# ── invites ────────────────────────────────────────────────────────────────

@router.post("/invites/{token}/accept", response_model=dict)
def accept_invite(token: str, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    inv = db.query(DiscussionInvite).filter(DiscussionInvite.token == token).first()
    if not inv:
        raise HTTPException(404, "That invite link isn't valid")
    if inv.accepted_by and inv.accepted_by.lower() != caller.name.lower():
        raise HTTPException(410, "That invite has already been used")
    d = db.get(Discussion, inv.discussion_id)
    if not d:
        raise HTTPException(404, "That discussion was deleted")
    group = db.get(Group, d.group_id)
    if not any(m.name.lower() == caller.name.lower() for m in group.members):
        db.add(Member(group_id=group.id, name=caller.name))
    inv.accepted_by = caller.name
    _touch(d)
    db.commit()
    return {"discussion_id": d.id, "group": group.name}


# ── AI help ────────────────────────────────────────────────────────────────

class PolishIn(BaseModel):
    text: str
    discussion_id: int | None = None
    assignees: list[str] = []


_POLISH = """You help a group of friends or family in India plan things together (a wedding, a trip, an event)
inside a money-sharing app. Rewrite the user's draft message so it is clear, warm and well organised.

Rules:
- Keep every fact, name, number, date, place and budget exactly as given. Never invent details.
- Keep the same language and tone (English stays English; Hinglish stays Hinglish), polite but not formal.
- If the message asks people to find something out, end with a short bulleted checklist of what to ask
  for - use the discussion's quote fields when they are given.
- Address the people it is directed to by name at the start, if any.
- Plain text only (bullets as "- "), no markdown headings, no emojis unless the draft had them. Keep it short.

Respond with ONLY a JSON object: {"text": "<the rewritten message>"}"""


@router.post("/polish", response_model=dict)
def polish(payload: PolishIn, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    import ai_text
    draft = payload.text.strip()
    if not draft:
        raise HTTPException(400, "Write something first")
    context = [f"Written by: {caller.name}"]
    if payload.discussion_id:
        d, group = _discussion(db, payload.discussion_id, caller)
        context.append(f"Discussion: {d.title}" + (f" - {d.description}" if d.description else ""))
        context.append(f"Group: {group.name}")
        params = _loads(d.params_json, [])
        if params:
            context.append("Quote fields: " + ", ".join(p["label"] + (f" ({p['unit']})" if p.get("unit") else "")
                                                         for p in params))
    if payload.assignees:
        context.append("Directed to: " + ", ".join(payload.assignees))
    try:
        out = ai_text.chat_json(_POLISH, "\n".join(context) + "\n\nDraft:\n" + draft[:4000])
    except Exception as e:
        print(f"[discussions] polish failed: {e!r}")
        raise HTTPException(503, "The AI couldn't be reached just now - send it as written, or try again.")
    text = str(out.get("text") or "").strip()
    if not text:
        raise HTTPException(503, "The AI didn't come back with a version - try again.")
    return {"text": text}


class SuggestIn(BaseModel):
    title: str
    description: str | None = None


_SUGGEST = """You set up a comparison sheet for quotes a group in India collects while planning
(wedding venues, caterers, hotels, photographers, tour packages...). Given the topic, list the 4-8 fields
worth noting for every quote so they can be compared: price fields first, then capacity, location, dates,
what's included, contact. Units where they help ("Rs per plate", "guests", "km", "Rs").

Respond with ONLY a JSON object: {"params": [{"label": "...", "unit": "..."}]}  (unit "" when none)"""


@router.post("/suggest-params", response_model=dict)
def suggest_params(payload: SuggestIn, caller: User = Depends(current_user)):
    import ai_text
    if not payload.title.strip():
        raise HTTPException(400, "Give the discussion a title first")
    try:
        out = ai_text.chat_json(_SUGGEST, f"Topic: {payload.title.strip()}"
                                + (f"\nDetails: {payload.description.strip()}" if payload.description else ""))
    except Exception as e:
        print(f"[discussions] suggest failed: {e!r}")
        raise HTTPException(503, "The AI couldn't be reached just now - add the fields yourself.")
    return {"params": _clean_params(out.get("params") or [])}

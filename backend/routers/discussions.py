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

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from activity import record_activity
from auth import caller_groups, current_user, member_group
from database import get_db
from models import (Activity, Discussion, DiscussionInvite, DiscussionMessage, DiscussionPoll, DiscussionQuote,
                    DiscussionPref, DiscussionQuoteNote, DiscussionTask, DiscussionVote, Group, Member, User)

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


NOTIFY_LEVELS = ("all", "mine", "off")


def _notify_level(db: Session, discussion_id: int, name: str) -> str:
    row = db.query(DiscussionPref).filter(DiscussionPref.discussion_id == discussion_id,
                                          DiscussionPref.user_name.ilike(name)).first()
    return row.notify if row else "all"


def _wants(db: Session, discussion_id: int, name: str, direct: bool) -> bool:
    """Whether a member wants this notification: "all" hears everything,
    "mine" only what's directed at them (an enquiry), "off" nothing."""
    level = _notify_level(db, discussion_id, name)
    return level == "all" or (level == "mine" and direct)


def _feed(db: Session, group: Group, actor: str, verb: str, d: Discussion, detail: str = "") -> None:
    """The group's activity feed (the bell, and the Activity tab's whole-group
    view) hears the discussion's milestones - not every chat line or vote."""
    record_activity(db, group, actor, verb, f"💬 {d.title}" + (f" · {detail}" if detail else ""))


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
    title: str
    description: str | None = None
    params: list = []
    # Who it's with: app users by name, and emails of people not on the app
    # (invited - they join from the email's link). A new group is made for it.
    members: list[str] = []
    invite_emails: list[str] = []
    group_id: int | None = None          # an existing group instead (older clients)


def _clean_emails(raw: list[str]) -> list[str]:
    out = []
    for e in raw or []:
        e = (e or "").strip().lower()
        if not e:
            continue
        if not _EMAIL.match(e):
            raise HTTPException(400, f"{e} doesn't look like an email address")
        if e not in out:
            out.append(e)
    if len(out) > 10:
        raise HTTPException(400, "Invite at most 10 people at a time")
    return out


@router.post("", response_model=dict, status_code=201)
def create_discussion(payload: DiscussionIn, bg: BackgroundTasks, db: Session = Depends(get_db),
                      caller: User = Depends(current_user)):
    title = payload.title.strip()[:200]
    if not title:
        raise HTTPException(400, "Give the discussion a title")
    details = (payload.description or "").strip()
    if not details:
        raise HTTPException(400, "Add the details - date, guests, budget, area - so everyone knows what to ask for")
    emails = _clean_emails(payload.invite_emails)
    added: list[str] = []
    if payload.group_id:
        group = member_group(payload.group_id, caller, db, with_history=False)
    else:
        # The people picked, as they're named on the app - only real accounts
        for n in payload.members:
            u = db.query(User).filter(User.name.ilike((n or "").strip())).first()
            if not u:
                raise HTTPException(400, f"{n} isn't on the app - invite them by email instead")
            if u.name.lower() != caller.name.lower() and u.name not in added:
                added.append(u.name)
        if not added and not emails:
            raise HTTPException(400, "Add at least one person to discuss with")
        group = Group(name=title, emoji="💬", category="other",
                      description=f"Made for the discussion \"{title}\"")
        db.add(group)
        db.flush()
        for n in [caller.name, *added]:
            db.add(Member(group_id=group.id, name=n))
        record_activity(db, group, caller.name, "created a new group",
                        f"{group.name} · for a discussion · {len(added) + 1} members")
    d = Discussion(group_id=group.id, title=title, description=details[:5000],
                   params_json=json.dumps(_clean_params(payload.params)), created_by=caller.name)
    db.add(d)
    db.flush()
    tokens = []
    for e in emails:
        tok = secrets.token_urlsafe(24)
        db.add(DiscussionInvite(discussion_id=d.id, email=e, token=tok, invited_by=caller.name))
        tokens.append((e, tok))
    _feed(db, group, caller.name, "started a discussion", d)
    if emails:
        _feed(db, group, caller.name, f"invited {len(emails)} by email", d, ", ".join(emails))
    db.commit()
    if added:
        bg.add_task(_notify_added, d.id, caller.name, added)
    if tokens:
        bg.add_task(_send_invites, d.id, caller.name, d.description or "", tokens)
    return {"id": d.id, "group_id": group.id}


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
        if not payload.description.strip():
            raise HTTPException(400, "The details can't be empty")
        d.description = payload.description.strip()[:5000]
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


def _quote_out(q: DiscussionQuote, opinions: list | None = None) -> dict:
    return {"id": q.id, "task_id": q.task_id, "entered_by": q.entered_by, "vendor": q.vendor, "price": q.price,
            "values": _loads(q.values_json, {}), "note": q.note, "created_at": q.created_at,
            "opinions": [{"author": o.author, "text": o.text, "polished": o.polished,
                          "at": o.edited_at or o.created_at, "edited": bool(o.edited_at)} for o in (opinions or [])]}


def _opinions(db: Session, quote_ids: list[int]) -> dict[int, list]:
    out: dict[int, list] = {}
    if quote_ids:
        for o in (db.query(DiscussionQuoteNote).filter(DiscussionQuoteNote.quote_id.in_(quote_ids))
                  .order_by(DiscussionQuoteNote.id)):
            out.setdefault(o.quote_id, []).append(o)
    return out


@router.get("/{discussion_id}", response_model=dict)
def get_discussion(discussion_id: int, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    d, group = _discussion(db, discussion_id, caller)
    msgs = db.query(DiscussionMessage).filter(DiscussionMessage.discussion_id == d.id) \
        .order_by(DiscussionMessage.id).all()
    tasks = db.query(DiscussionTask).filter(DiscussionTask.discussion_id == d.id).order_by(DiscussionTask.id).all()
    quotes = db.query(DiscussionQuote).filter(DiscussionQuote.discussion_id == d.id) \
        .order_by(DiscussionQuote.id.desc()).all()
    invites = db.query(DiscussionInvite).filter(DiscussionInvite.discussion_id == d.id).all()
    ops = _opinions(db, [q.id for q in quotes])
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
            "tasks": by_msg.get(m.id, []), "created_at": m.created_at, "edited_at": m.edited_at,
            "attachment": _loads(m.attachment_json, None),
        } for m in msgs],
        "quotes": [_quote_out(q, ops.get(q.id)) for q in quotes],
        "invites": [{"email": i.email, "invited_by": i.invited_by, "accepted_by": i.accepted_by,
                     "created_at": i.created_at} for i in invites],
        "polls": _polls_out(db, d, group, caller),
        "summary": _summary_out(d),
        "notify": _notify_level(db, d.id, caller.name),
        "ai": _ai_available(),
    }


def _mandatory_pending(db: Session, discussion_id: int, name: str) -> list[DiscussionPoll]:
    """Open mandatory polls this member hasn't answered (their own don't count)."""
    polls = db.query(DiscussionPoll).filter(DiscussionPoll.discussion_id == discussion_id,
                                            DiscussionPoll.mandatory.is_(True), DiscussionPoll.closed.is_(False)).all()
    out = []
    for p in polls:
        if p.author.lower() == name.lower():
            continue
        if not db.query(DiscussionVote.id).filter(DiscussionVote.poll_id == p.id,
                                                  DiscussionVote.voter.ilike(name)).first():
            out.append(p)
    return out


def _polls_out(db: Session, d: Discussion, group: Group, caller: User) -> list[dict]:
    polls = db.query(DiscussionPoll).filter(DiscussionPoll.discussion_id == d.id).order_by(DiscussionPoll.id).all()
    if not polls:
        return []
    votes = db.query(DiscussionVote).filter(DiscussionVote.poll_id.in_([p.id for p in polls])).all()
    members = [m.name for m in group.members]
    out = []
    for p in polls:
        options = _loads(p.options_json, [])
        vs = [v for v in votes if v.poll_id == p.id]
        voters = sorted({v.voter for v in vs}, key=str.lower)
        voted = {v.lower() for v in voters}
        out.append({
            "id": p.id, "author": p.author, "question": p.question, "multi": p.multi, "closed": p.closed,
            "mandatory": bool(p.mandatory),
            "created_at": p.created_at,
            "options": [{"text": o, "voters": sorted({v.voter for v in vs if v.option_index == i}, key=str.lower)}
                        for i, o in enumerate(options)],
            "voters": voters,
            "mine": sorted(v.option_index for v in vs if v.voter.lower() == caller.name.lower()),
            # voter -> what they wrote with their vote
            "notes": {v.voter: v.note for v in vs if v.note},
            "waiting": [m for m in members if m.lower() not in voted],
        })
    return out


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
    pending = _mandatory_pending(db, d.id, caller.name)
    if pending:
        raise HTTPException(409, {"code": "poll_required",
                                  "message": f"Answer the poll first: {pending[0].question}"})
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
    if assignees:
        _feed(db, group, caller.name, f"asked {', '.join(assignees)} to enquire", d, text[:120])
    if emails:
        _feed(db, group, caller.name, f"invited {len(emails)} by email", d, ", ".join(emails))
    _touch(d)
    db.commit()
    bg.add_task(_notify_message, d.id, m.id, tokens)
    return {"id": m.id}


@router.post("/{discussion_id}/attachments", response_model=dict, status_code=201)
def attach(discussion_id: int, bg: BackgroundTasks, file: UploadFile = File(...), caption: str = Form(""),
           db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """A photo or PDF (a quotation, menu, brochure), read by the AI into a
    brief summary posted to the chat. Only the summary is kept - the file is
    read in memory and dropped (attachment_reader.read)."""
    import attachment_reader
    d, group = _discussion(db, discussion_id, caller)
    pending = _mandatory_pending(db, d.id, caller.name)
    if pending:
        raise HTTPException(409, {"code": "poll_required", "message": f"Answer the poll first: {pending[0].question}"})
    raw = file.file.read(attachment_reader.MAX_BYTES + 1)
    name = (file.filename or "attachment")[:120]
    try:
        got = attachment_reader.read(raw, name, file.content_type or "", d.title, d.description or "",
                                     _loads(d.params_json, []))
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        del raw
        file.file.close()
    caption = caption.strip()[:2000]
    text = (f"{caption}\n\n" if caption else "") + f"📎 {name}\n{got['summary']}"
    m = DiscussionMessage(discussion_id=d.id, author=caller.name, text=text[:5000],
                          attachment_json=json.dumps({"name": name, **got}))
    db.add(m)
    _feed(db, group, caller.name, "shared a file", d, f"{name}" + (f" · {got['vendor']}" if got["vendor"] else ""))
    _touch(d)
    db.commit()
    bg.add_task(_notify_message, d.id, m.id, [])
    return {"id": m.id, "attachment": {"name": name, **got}}


class MessageEdit(BaseModel):
    text: str


@router.patch("/{discussion_id}/messages/{message_id}", response_model=dict)
def edit_message(discussion_id: int, message_id: int, payload: MessageEdit, db: Session = Depends(get_db),
                 caller: User = Depends(current_user)):
    """Its author rewrites a message (who it was directed at stays as it was);
    the AI summary then counts as out of date."""
    d, _ = _discussion(db, discussion_id, caller)
    m = db.query(DiscussionMessage).filter(DiscussionMessage.id == message_id,
                                           DiscussionMessage.discussion_id == d.id).first()
    if not m:
        raise HTTPException(404, "No such message")
    if m.author.lower() != caller.name.lower():
        raise HTTPException(403, "Only its author can edit a message")
    text = payload.text.strip()
    if not text:
        raise HTTPException(400, "A message can't be empty - delete it instead")
    if text != m.text:
        m.text, m.edited_at = text[:5000], _now()
        _touch(d)
        db.commit()
    return {"ok": True, "edited_at": m.edited_at}


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
            if name.lower() == m.author.lower() or not _wants(db, d.id, name, direct=True):
                continue
            emailer.send_notice(db, name, f"{m.author} asked you: {d.title}",
                                [f"{m.author} directed this to you in \"{d.title}\" ({group.name}):", preview],
                                push_body=f"{m.author}: {preview[:120]}", url=url,
                                button_label="Open the discussion")
        skip = {a.lower() for a in assignees} | {m.author.lower()}
        for mem in group.members:
            if mem.name.lower() not in skip and _wants(db, d.id, mem.name, direct=False):
                try:
                    _push.send_push_to_user(db, mem.name, f"{m.author} in {d.title}", preview[:120], url=url)
                except Exception as e:
                    print(f"[discussions] push failed: {e}")
        _email_invites(d, group, m.author, preview, invites)
    except Exception as e:
        print(f"[discussions] notify failed: {e}")
    finally:
        db.close()


def _notify_added(discussion_id: int, actor: str, names: list[str]) -> None:
    """People put in a discussion's group: an email and push that open the discussion."""
    import emailer
    from database import get_session_factory
    db = get_session_factory()()
    try:
        d = db.get(Discussion, discussion_id)
        if not d:
            return
        for n in names:
            emailer.send_notice(db, n, f"{actor} added you to \"{d.title}\"",
                                [f"{actor} added you to the discussion \"{d.title}\" on SplitEasy."]
                                + ([d.description] if d.description else [])
                                + ["Reply, vote in polls and note the quotes you get there."],
                                push_body=f"{actor} added you to \"{d.title}\"", url=f"/discuss/{d.id}",
                                button_label="Open the discussion")
    except Exception as e:
        print(f"[discussions] added-notice failed: {e}")
    finally:
        db.close()


def _email_invites(d: Discussion, group: Group, author: str, preview: str, invites: list[tuple[str, str]]) -> None:
    import emailer
    from database import get_settings
    front = get_settings().frontend_url.rstrip("/")
    for email, tok in invites:
        link = f"{front}/discuss/{d.id}?invite={tok}"
        subject = f"{author} invited you to plan \"{d.title}\""
        lines = [f"{author} would like your help with \"{d.title}\" on SplitEasy" + (":" if preview else "."),
                 *([preview] if preview else []),
                 "Sign up (or sign in) and open the link - you'll join the group and can reply, vote and add quotes."]
        try:
            emailer._send(email, subject, "\n\n".join(lines) + f"\n\nJoin here: {link}",
                          emailer._layout(subject, [escape(x) for x in lines], button_url=link,
                                          button_label="Join the discussion"))
        except Exception as e:
            print(f"[discussions] invite email to {email} failed: {e}")


def _send_invites(discussion_id: int, author: str, preview: str, invites: list[tuple[str, str]]) -> None:
    """The invites made with a new discussion, emailed after the response."""
    from database import get_session_factory
    db = get_session_factory()()
    try:
        d = db.get(Discussion, discussion_id)
        if d:
            _email_invites(d, db.get(Group, d.group_id), author, preview, invites)
    except Exception as e:
        print(f"[discussions] invites failed: {e}")
    finally:
        db.close()


# ── tasks & quotes ─────────────────────────────────────────────────────────

class TaskStatus(BaseModel):
    status: str


@router.post("/{discussion_id}/tasks/{task_id}", response_model=dict)
def set_task(discussion_id: int, task_id: int, payload: TaskStatus, db: Session = Depends(get_db),
             caller: User = Depends(current_user)):
    d, group = _discussion(db, discussion_id, caller)
    t = db.query(DiscussionTask).filter(DiscussionTask.id == task_id, DiscussionTask.discussion_id == d.id).first()
    if not t:
        raise HTTPException(404, "No such task")
    msg = db.get(DiscussionMessage, t.message_id)
    if caller.name.lower() not in (t.assignee.lower(), (msg.author if msg else "").lower()):
        raise HTTPException(403, "Only the person asked, or who asked, can change this")
    if payload.status not in ("open", "done"):
        raise HTTPException(400, "open or done")
    if payload.status == "done" and t.status != "done":
        _feed(db, group, caller.name, "finished an enquiry", d,
              "" if t.assignee.lower() == caller.name.lower() else f"for {t.assignee}")
    t.status = payload.status
    t.done_at = _now() if payload.status == "done" else None
    _touch(d)
    db.commit()
    return _task_out(t)


class QuoteIn(BaseModel):
    vendor: str
    price: str | None = None
    values: dict = {}
    note: str | None = None
    task_id: int | None = None


def _clean_values(d: Discussion, values: dict) -> dict:
    keys = {p["key"] for p in _loads(d.params_json, [])}
    return {k: str(v).strip()[:200] for k, v in (values or {}).items() if k in keys and str(v).strip()}


@router.post("/{discussion_id}/quotes", response_model=dict, status_code=201)
def add_quote(discussion_id: int, payload: QuoteIn, bg: BackgroundTasks, db: Session = Depends(get_db),
              caller: User = Depends(current_user)):
    d, group = _discussion(db, discussion_id, caller)
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
                        price=(payload.price or "").strip()[:100] or None,
                        values_json=json.dumps(_clean_values(d, payload.values)),
                        note=(payload.note or "").strip()[:2000] or None)
    db.add(q)
    if task and task.assignee.lower() == caller.name.lower() and task.status == "open":
        task.status, task.done_at = "done", _now()       # a quote answers the enquiry
    _feed(db, group, caller.name, "added a quote", d, vendor)
    _touch(d)
    db.commit()
    # The one who asked hears of it even on "only when I'm asked"
    asked_by = db.get(DiscussionMessage, task.message_id).author if task else None
    bg.add_task(_notify_quote, d.id, caller.name, vendor, asked_by)
    return _quote_out(q)


def _notify_quote(discussion_id: int, author: str, vendor: str, asked_by: str | None) -> None:
    import push as _push
    from database import get_session_factory
    db = get_session_factory()()
    try:
        d = db.get(Discussion, discussion_id)
        if not d:
            return
        for m in db.get(Group, d.group_id).members:
            if m.name.lower() == author.lower():
                continue
            direct = bool(asked_by) and m.name.lower() == asked_by.lower()
            if _wants(db, d.id, m.name, direct=direct):
                try:
                    _push.send_push_to_user(db, m.name, f"{author} added a quote: {vendor}"[:120],
                                            f"In \"{d.title}\"", url=f"/discuss/{d.id}?tab=quotes")
                except Exception as e:
                    print(f"[discussions] quote push failed: {e}")
    finally:
        db.close()


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
    q.price = (payload.price or "").strip()[:100] or None
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


class AddPeopleIn(BaseModel):
    members: list[str] = []
    invite_emails: list[str] = []


@router.post("/{discussion_id}/people", response_model=dict)
def add_people(discussion_id: int, payload: AddPeopleIn, bg: BackgroundTasks, db: Session = Depends(get_db),
               caller: User = Depends(current_user)):
    """More people for the discussion's group: app users straight in, others
    invited by email."""
    d, group = _discussion(db, discussion_id, caller)
    have = {m.name.lower() for m in group.members}
    added = []
    for n in payload.members:
        u = db.query(User).filter(User.name.ilike((n or "").strip())).first()
        if not u:
            raise HTTPException(400, f"{n} isn't on the app - invite them by email instead")
        if u.name.lower() not in have and u.name not in added:
            added.append(u.name)
            db.add(Member(group_id=group.id, name=u.name))
    emails = _clean_emails(payload.invite_emails)
    tokens = []
    for e in emails:
        tok = secrets.token_urlsafe(24)
        db.add(DiscussionInvite(discussion_id=d.id, email=e, token=tok, invited_by=caller.name))
        tokens.append((e, tok))
    if not added and not tokens:
        raise HTTPException(400, "Pick someone new to add")
    if added:
        _feed(db, group, caller.name, f"added {', '.join(added)}", d)
    if emails:
        _feed(db, group, caller.name, f"invited {len(emails)} by email", d, ", ".join(emails))
    _touch(d)
    db.commit()
    if added:
        bg.add_task(_notify_added, d.id, caller.name, added)
    if tokens:
        bg.add_task(_send_invites, d.id, caller.name, d.description or "", tokens)
    return {"added": added, "invited": emails}


class NotifyIn(BaseModel):
    notify: str


@router.post("/{discussion_id}/notify", response_model=dict)
def set_notify(discussion_id: int, payload: NotifyIn, db: Session = Depends(get_db),
               caller: User = Depends(current_user)):
    """The caller's own notifications for this discussion: all / mine / off."""
    d, _ = _discussion(db, discussion_id, caller)
    if payload.notify not in NOTIFY_LEVELS:
        raise HTTPException(400, "all, mine or off")
    row = db.query(DiscussionPref).filter(DiscussionPref.discussion_id == d.id,
                                          DiscussionPref.user_name.ilike(caller.name)).first()
    if row:
        row.notify = payload.notify
    else:
        db.add(DiscussionPref(discussion_id=d.id, user_name=caller.name, notify=payload.notify))
    db.commit()
    return {"notify": payload.notify}


# ── polls ──────────────────────────────────────────────────────────────────

class PollIn(BaseModel):
    question: str
    options: list[str]
    multi: bool = False
    mandatory: bool = False


@router.post("/{discussion_id}/polls", response_model=dict, status_code=201)
def create_poll(discussion_id: int, payload: PollIn, bg: BackgroundTasks, db: Session = Depends(get_db),
                caller: User = Depends(current_user)):
    d, group = _discussion(db, discussion_id, caller)
    question = payload.question.strip()[:300]
    options = []
    for o in payload.options:
        o = (o or "").strip()[:120]
        if o and o.lower() not in (x.lower() for x in options):
            options.append(o)
    if not question:
        raise HTTPException(400, "Write the question")
    if not 2 <= len(options) <= 10:
        raise HTTPException(400, "Give 2 to 10 different options")
    p = DiscussionPoll(discussion_id=d.id, author=caller.name, question=question,
                       options_json=json.dumps(options), multi=payload.multi, mandatory=payload.mandatory)
    db.add(p)
    _feed(db, group, caller.name, "started a mandatory poll" if payload.mandatory else "started a poll", d, question)
    _touch(d)
    db.commit()
    bg.add_task(_notify_poll, d.id, p.id)
    return {"id": p.id}


class VoteIn(BaseModel):
    choices: list[int]
    note: str | None = None          # written with the vote, shown to everyone


@router.post("/{discussion_id}/polls/{poll_id}/vote", response_model=dict)
def vote(discussion_id: int, poll_id: int, payload: VoteIn, db: Session = Depends(get_db),
         caller: User = Depends(current_user)):
    """The caller's picks, replacing any earlier ones; an empty list takes the vote back."""
    d, _ = _discussion(db, discussion_id, caller)
    p = db.query(DiscussionPoll).filter(DiscussionPoll.id == poll_id, DiscussionPoll.discussion_id == d.id).first()
    if not p:
        raise HTTPException(404, "No such poll")
    if p.closed:
        raise HTTPException(409, "This poll is closed")
    n = len(_loads(p.options_json, []))
    picks = sorted({c for c in payload.choices if isinstance(c, int) and 0 <= c < n})
    if len(picks) > 1 and not p.multi:
        raise HTTPException(400, "Pick one option")
    db.query(DiscussionVote).filter(DiscussionVote.poll_id == p.id,
                                    DiscussionVote.voter.ilike(caller.name)).delete(synchronize_session=False)
    note = (payload.note or "").strip()[:300] or None
    for c in picks:
        db.add(DiscussionVote(poll_id=p.id, voter=caller.name, option_index=c, note=note))
    _touch(d)
    db.commit()
    return {"ok": True}


class PollState(BaseModel):
    closed: bool


@router.post("/{discussion_id}/polls/{poll_id}/state", response_model=dict)
def set_poll_state(discussion_id: int, poll_id: int, payload: PollState, db: Session = Depends(get_db),
                   caller: User = Depends(current_user)):
    d, group = _discussion(db, discussion_id, caller)
    p = db.query(DiscussionPoll).filter(DiscussionPoll.id == poll_id, DiscussionPoll.discussion_id == d.id).first()
    if not p:
        raise HTTPException(404, "No such poll")
    if p.author.lower() != caller.name.lower():
        raise HTTPException(403, "Only whoever asked can close or reopen the poll")
    if payload.closed and not p.closed:
        _feed(db, group, caller.name, "closed a poll", d, p.question)
    p.closed = payload.closed
    _touch(d)
    db.commit()
    return {"ok": True}


@router.delete("/{discussion_id}/polls/{poll_id}", status_code=204)
def delete_poll(discussion_id: int, poll_id: int, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    d, _ = _discussion(db, discussion_id, caller)
    p = db.query(DiscussionPoll).filter(DiscussionPoll.id == poll_id, DiscussionPoll.discussion_id == d.id).first()
    if p and p.author.lower() != caller.name.lower():
        raise HTTPException(403, "Only whoever asked can delete the poll")
    if p:
        db.delete(p)
        db.commit()


def _notify_poll(discussion_id: int, poll_id: int) -> None:
    """Everyone else in the group: a push asking them to vote."""
    import push as _push
    from database import get_session_factory
    db = get_session_factory()()
    try:
        d, p = db.get(Discussion, discussion_id), db.get(DiscussionPoll, poll_id)
        if not d or not p:
            return
        for m in db.get(Group, d.group_id).members:
            # A mandatory poll is asked of everyone: it reaches "only when I'm asked" too
            if m.name.lower() != p.author.lower() and _wants(db, d.id, m.name, direct=bool(p.mandatory)):
                try:
                    _push.send_push_to_user(db, m.name, f"{p.author} asks: {p.question}"[:120],
                                            (f"Your answer is needed to use the chat in \"{d.title}\"" if p.mandatory
                                             else f"Vote in \"{d.title}\""), url=f"/discuss/{d.id}")
                except Exception as e:
                    print(f"[discussions] poll push failed: {e}")
    finally:
        db.close()


# ── activity: everything that happened ─────────────────────────────────────

@router.get("/{discussion_id}/activity", response_model=dict)
def activity(discussion_id: int, scope: str = "discussion", db: Session = Depends(get_db),
             caller: User = Depends(current_user)):
    """scope=discussion: this discussion's own history, put together from its
    records (every message, enquiry, quote, poll and vote). scope=group: the
    whole group's activity feed - expenses, payments, and its discussions'
    milestones - newest first."""
    d, group = _discussion(db, discussion_id, caller)
    if scope == "group":
        rows = (db.query(Activity).filter(Activity.group_id == group.id)
                .order_by(Activity.created_at.desc(), Activity.id.desc()).limit(300).all())
        return {"scope": "group", "items": [{"at": a.created_at, "actor": a.actor, "kind": "group",
                                             "text": a.verb, "detail": a.summary} for a in rows]}
    items = [{"at": d.created_at, "actor": d.created_by, "kind": "start", "text": "started the discussion",
              "detail": d.title}]
    msgs = db.query(DiscussionMessage).filter(DiscussionMessage.discussion_id == d.id).all()
    for m in msgs:
        who = _loads(m.assignees_json, [])
        items.append({"at": m.created_at, "actor": m.author, "kind": "enquiry" if who else "message",
                      "text": f"asked {', '.join(who)} to enquire" if who else "wrote a message",
                      "detail": m.text[:160]})
        invites = _loads(m.invites_json, [])
        if invites:
            items.append({"at": m.created_at, "actor": m.author, "kind": "invite",
                          "text": f"invited {', '.join(invites)} by email", "detail": ""})
    for t in db.query(DiscussionTask).filter(DiscussionTask.discussion_id == d.id, DiscussionTask.done_at.isnot(None)):
        items.append({"at": t.done_at, "actor": t.assignee, "kind": "done", "text": "finished an enquiry", "detail": ""})
    for q in db.query(DiscussionQuote).filter(DiscussionQuote.discussion_id == d.id):
        items.append({"at": q.created_at, "actor": q.entered_by, "kind": "quote", "text": "added a quote",
                      "detail": q.vendor})
    polls = db.query(DiscussionPoll).filter(DiscussionPoll.discussion_id == d.id).all()
    for p in polls:
        items.append({"at": p.created_at, "actor": p.author, "kind": "poll", "text": "started a poll",
                      "detail": p.question})
    if polls:
        opts = {p.id: (p.question, _loads(p.options_json, [])) for p in polls}
        seen = set()
        for v in db.query(DiscussionVote).filter(DiscussionVote.poll_id.in_(list(opts))).order_by(DiscussionVote.id):
            key = (v.poll_id, v.voter.lower())
            if key in seen:
                continue                     # one line per voter per poll
            seen.add(key)
            items.append({"at": v.created_at, "actor": v.voter, "kind": "vote", "text": "voted",
                          "detail": opts[v.poll_id][0]})
    for i in db.query(DiscussionInvite).filter(DiscussionInvite.discussion_id == d.id,
                                               DiscussionInvite.accepted_by.isnot(None)):
        items.append({"at": i.accepted_at or i.created_at, "actor": i.accepted_by, "kind": "join",
                      "text": f"joined from {i.invited_by}'s invite", "detail": ""})
    items.sort(key=lambda x: str(x["at"] or ""), reverse=True)
    return {"scope": "discussion", "items": items}


# ── AI summary: the details, the talk and the quotes in one read ───────────

def _summary_out(d: Discussion) -> dict | None:
    data = _loads(d.summary_json, None)
    if not data:
        return None
    # Anything since (a message, a quote, a vote) makes it out of date
    return {"data": data, "at": d.summary_at, "stale": d.summary_basis != d.updated_at}


_SUM_TALK = """You summarise a group's planning discussion in an Indian money-sharing app (a wedding, trip or
event), so a member who missed it can catch up in a minute and join in.

From the details, the messages, the enquiries and the polls, write:
- "overview": 2-3 sentences - what is being planned and where it stands now.
- "people": for each member who said or did anything, their views, preferences and what they found out
  (one or two lines each). Use their names exactly as given.
- "decided": what has been agreed (poll winners, choices everyone accepted). Empty if nothing yet.
- "open": questions still undecided or things nobody has found out yet.
- "next": concrete next steps, each naming who should do it when that is clear (pending enquiries first).

Rules: only facts from the text - never invent prices, names or dates. Keep the members' language plain and short.
Respond with ONLY a JSON object:
{"overview": "...", "people": [{"name": "...", "summary": "..."}], "decided": ["..."], "open": ["..."], "next": ["..."]}"""

_SUM_QUOTES = """You compare quotes a group in India collected while planning (venues, caterers, hotels...).
Given the requirements and every quote (vendor, the fields noted, notes, who got it), write:
- "summary": 2-3 sentences comparing them - the price range and how they differ.
- "best_value": which quote looks best for the stated requirements and why (one line), or "" if it can't be told.
- "cheapest": the vendor with the lowest main price, or "".
- "per_quote": for each vendor, one line of pros/cons against the requirements, and what is still missing to compare
  it fairly (e.g. "no capacity given").

Rules: use only the numbers given - never invent or estimate prices. Amounts in Rs as written.
Respond with ONLY a JSON object:
{"summary": "...", "best_value": "...", "cheapest": "...", "per_quote": [{"vendor": "...", "note": "...", "missing": "..."}]}"""


def _summary_context(db: Session, d: Discussion, group: Group, caller: User) -> tuple[str, str | None]:
    """(the talk, the quotes) as text for the two prompts; quotes None when there are none."""
    params = _loads(d.params_json, [])
    head = [f"Topic: {d.title}", f"Details: {d.description or '-'}",
            f"Members: {', '.join(m.name for m in group.members)}"]
    msgs = (db.query(DiscussionMessage).filter(DiscussionMessage.discussion_id == d.id)
            .order_by(DiscussionMessage.id.desc()).limit(120).all())[::-1]
    tasks = db.query(DiscussionTask).filter(DiscussionTask.discussion_id == d.id).all()
    lines = []
    for m in msgs:
        who = _loads(m.assignees_json, [])
        status = [f"{t.assignee}: {t.status}" for t in tasks if t.message_id == m.id]
        lines.append(f"[{str(m.created_at)[:16]}] {m.author}" + (f" (asked {', '.join(who)} to enquire)" if who else "")
                     + f": {m.text[:1500]}" + (f"  [enquiry status - {'; '.join(status)}]" if status else ""))
    for p in _polls_out(db, d, group, caller):
        res = "; ".join(f"{o['text']}: {len(o['voters'])} ("
                        + (", ".join(f"{v}" + (f" - \"{p['notes'][v]}\"" if p["notes"].get(v) else "") for v in o["voters"])
                           or "none") + ")" for o in p["options"])
        lines.append(f"POLL by {p['author']}{' (closed)' if p['closed'] else ''}: {p['question']} -> {res}"
                     + (f"; not voted: {', '.join(p['waiting'])}" if p["waiting"] else ""))
    quotes = db.query(DiscussionQuote).filter(DiscussionQuote.discussion_id == d.id).order_by(DiscussionQuote.id).all()
    if quotes:
        lines.append(f"{len(quotes)} quotes noted so far: " + ", ".join(f"{q.vendor} (by {q.entered_by})" for q in quotes))
    talk = "\n".join(head) + "\n\nMessages and polls, oldest first:\n" + ("\n".join(lines) or "(none yet)")
    if not quotes:
        return talk[:24000], None
    qlines = []
    ops = _opinions(db, [q.id for q in quotes])
    for q in quotes:
        vals = _loads(q.values_json, {})
        fields = "; ".join(f"{p['label']}{' (' + p['unit'] + ')' if p.get('unit') else ''}: {vals[p['key']]}"
                           for p in params if vals.get(p["key"]))
        views = "; ".join(f"{o.author}: {o.text[:300]}" for o in ops.get(q.id, []))
        qlines.append(f"- {q.vendor} (noted by {q.entered_by})" + (f", price {q.price}" if q.price else "")
                      + f": {fields or 'no fields filled'}"
                      + (f". Notes: {q.note[:600]}" if q.note else "")
                      + (f". Members' opinions - {views}" if views else ""))
    quotes_text = "\n".join(head[:2]) + "\n\nQuotes:\n" + "\n".join(qlines)
    return talk[:24000], quotes_text[:16000]


@router.post("/{discussion_id}/summary", response_model=dict)
def summarise(discussion_id: int, db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """The AI's summary, made fresh: the talk on one key and the quotes on the
    other, at the same time (ai_text.chat_json_tandem), then put together."""
    import ai_text
    d, group = _discussion(db, discussion_id, caller)
    talk, quotes = _summary_context(db, d, group, caller)
    jobs = [(_SUM_TALK, talk)] + ([(_SUM_QUOTES, quotes)] if quotes else [])
    results = ai_text.chat_json_tandem(jobs)
    if isinstance(results[0], Exception):
        print(f"[discussions] summary failed: {results[0]!r}")
        raise HTTPException(503, "The AI couldn't be reached just now - try again in a minute.")
    data = {"talk": results[0]}
    if quotes:
        if isinstance(results[1], Exception):
            print(f"[discussions] quote summary failed: {results[1]!r}")
            data["quotes_error"] = True
        else:
            data["quotes"] = results[1]
    d.summary_json = json.dumps(data)
    d.summary_basis = d.updated_at           # not _touch: a summary isn't new activity
    d.summary_at = _now()
    db.commit()
    return _summary_out(d)


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
    if not inv.accepted_by:
        inv.accepted_at = _now()
        _feed(db, group, caller.name, f"joined from {inv.invited_by}'s invite", d)
    inv.accepted_by = caller.name
    _touch(d)
    db.commit()
    return {"discussion_id": d.id, "group": group.name}


# ── AI help ────────────────────────────────────────────────────────────────

class PolishIn(BaseModel):
    text: str
    discussion_id: int | None = None
    assignees: list[str] = []
    quote_id: int | None = None        # an opinion on this quote, not a chat message


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
    system = _POLISH
    if payload.quote_id and payload.discussion_id:
        q = db.query(DiscussionQuote).filter(DiscussionQuote.id == payload.quote_id,
                                             DiscussionQuote.discussion_id == payload.discussion_id).first()
        if q:
            vals = _loads(q.values_json, {})
            context.append(f"The quote: {q.vendor} - " + "; ".join(f"{k}: {v}" for k, v in vals.items())
                           + (f". Notes: {q.note[:500]}" if q.note else ""))
            system = _POLISH_OPINION
    try:
        out = ai_text.chat_json(system, "\n".join(context) + "\n\nDraft:\n" + draft[:4000])
    except Exception as e:
        print(f"[discussions] polish failed: {e!r}")
        raise HTTPException(503, "The AI couldn't be reached just now - send it as written, or try again.")
    text = str(out.get("text") or "").strip()
    if not text:
        raise HTTPException(503, "The AI didn't come back with a version - try again.")
    return {"text": text}


_POLISH_OPINION = """You help a member of a group in India give their opinion on one vendor's quote (a venue,
caterer, hotel...) while the group plans. Rewrite their draft opinion so it is clear and short (1-3 sentences or
a few "- " points): what they like, what worries them, and their verdict if they gave one.

Rules: keep their views, facts, numbers and tone exactly - never add opinions or facts they didn't give.
Same language as the draft (Hinglish stays Hinglish). Plain text, no headings.
Respond with ONLY a JSON object: {"text": "<the rewritten opinion>"}"""


class OpinionIn(BaseModel):
    text: str
    polished: bool = False


@router.put("/{discussion_id}/quotes/{quote_id}/opinion", response_model=dict)
def set_opinion(discussion_id: int, quote_id: int, payload: OpinionIn, bg: BackgroundTasks,
                db: Session = Depends(get_db), caller: User = Depends(current_user)):
    """The caller's own opinion on a quote - added, changed, or (empty) removed."""
    d, group = _discussion(db, discussion_id, caller)
    q = db.query(DiscussionQuote).filter(DiscussionQuote.id == quote_id, DiscussionQuote.discussion_id == d.id).first()
    if not q:
        raise HTTPException(404, "No such quote")
    row = db.query(DiscussionQuoteNote).filter(DiscussionQuoteNote.quote_id == q.id,
                                               DiscussionQuoteNote.author.ilike(caller.name)).first()
    text = payload.text.strip()[:2000]
    if not text:
        if row:
            db.delete(row)
            _touch(d)
            db.commit()
        return {"removed": True}
    new = row is None
    if new:
        row = DiscussionQuoteNote(quote_id=q.id, author=caller.name, text=text, polished=payload.polished)
        db.add(row)
        _feed(db, group, caller.name, "gave an opinion on a quote", d, q.vendor)
    elif row.text != text:
        row.text, row.polished, row.edited_at = text, payload.polished, _now()
    _touch(d)
    db.commit()
    if new:
        bg.add_task(_notify_opinion, d.id, caller.name, q.vendor, q.entered_by, text)
    return {"removed": False}


def _notify_opinion(discussion_id: int, author: str, vendor: str, quote_by: str, text: str) -> None:
    import push as _push
    from database import get_session_factory
    db = get_session_factory()()
    try:
        d = db.get(Discussion, discussion_id)
        if not d:
            return
        for m in db.get(Group, d.group_id).members:
            if m.name.lower() == author.lower():
                continue
            # Whoever noted the quote hears of it even on "only when I'm asked"
            if _wants(db, d.id, m.name, direct=m.name.lower() == quote_by.lower()):
                try:
                    _push.send_push_to_user(db, m.name, f"{author} on {vendor}"[:120], text[:120],
                                            url=f"/discuss/{d.id}?tab=quotes")
                except Exception as e:
                    print(f"[discussions] opinion push failed: {e}")
    finally:
        db.close()


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

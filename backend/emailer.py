import smtplib
from email.mime.text import MIMEText

from database import get_settings
from people import person_info


def _send(to_email: str, subject: str, body: str) -> None:
    settings = get_settings()
    if not settings.smtp_sender or not settings.smtp_app_password:
        print("[email] SMTP not configured (SMTP_SENDER / SMTP_APP_PASSWORD missing), skipping notification")
        return
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = settings.smtp_sender
    msg["To"] = to_email
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=10) as server:
            server.login(settings.smtp_sender, settings.smtp_app_password)
            server.sendmail(settings.smtp_sender, [to_email], msg.as_string())
    except Exception as e:
        print(f"[email] failed to send to {to_email}: {e}")


def send_login_code(email: str, code: str) -> None:
    _send(
        email,
        "Your Money Splitter login code",
        f"Your one-time login code is {code}.\n\n"
        "It expires in 10 minutes and works once. If you didn't ask for "
        "this, ignore this email — nobody can sign in without it.",
    )


def _email_for(db, name: str) -> str | None:
    """Where a notification for this member name actually goes.

    A logged-in account's own address wins, since that is the one thing the
    person themselves controls (see /users/me/email). Someone who is a group
    member but never signed up at all - a name on an expense, not an account
    - falls back to the static registry in people.py, which is the only
    address this app has ever had for them.
    """
    from models import User  # deferred: emailer is imported by routers that

    user = db.query(User).filter(User.name.ilike(name)).first()
    if user and user.email:
        return user.email
    info = person_info(name)
    return info["email"] if info else None


def notify_group_activity(db, group, actor_name: str, verb: str, summary: str,
                          skip_names: list[str] | None = None) -> None:
    """Tell every member of the group about something that just happened -
    including whoever just did it, so an edit reads back as confirmation of
    exactly what changed, not just an announcement to everyone else.

    Every member with a findable email gets one, not just the two names in
    people.py's original AG/AS pair — a Mumbai + Diwali trip with Divyank in
    it used to notify nobody at all, since the old rule required exactly two
    members and both being in the registry.

    `skip_names` exists for a narrower reason: a member added in the same
    update gets notify_added_to_group's own, more specific email instead, and
    would otherwise also get this generic "updated the group" one about a
    group they didn't know existed a moment before.
    """
    settings = get_settings()
    link = f"{settings.frontend_url}/groups/{group.id}"
    skip = {s.lower() for s in (skip_names or [])}

    for m in group.members:
        if m.name.lower() in skip:
            continue
        email = _email_for(db, m.name)
        if not email:
            continue
        # Reads as confirmation to the person who did it ("You just..."),
        # and as an announcement to everyone else ("Anukul just...").
        is_self = m.name.lower() == (actor_name or "").lower()
        who = "You" if is_self else actor_name
        subject = f"{'You' if is_self else actor_name} {verb} in {group.name}"
        body = (
            f"{who} {verb} in \"{group.name}\":\n\n"
            f"{summary}\n\n"
            f"View it here: {link}"
        )
        try:
            _send(email, subject, body)
        except Exception as e:
            print(f"[email] notify_group_activity error: {e}")


def notify_added_to_group(db, group, actor_name: str, added_names: list[str]) -> None:
    """Tell someone specifically that they were just put in a group -
    including the person who did the adding, if they added themselves.

    Separate from notify_group_activity because "you're in a new group" and
    "someone changed a group you were already in" are different news, worth
    two distinct, clearly-worded emails rather than one generic "updated the
    group" that leaves the new member guessing what actually happened.
    """
    settings = get_settings()
    link = f"{settings.frontend_url}/groups/{group.id}"

    for name in added_names:
        email = _email_for(db, name)
        if not email:
            continue
        is_self = name.lower() == (actor_name or "").lower()
        subject = f"You're in {group.name}" if is_self else f"{actor_name} added you to {group.name}"
        body = (
            (f"You added yourself to \"{group.name}\" on Money Splitter.\n\n"
             if is_self else
             f"{actor_name} added you to \"{group.name}\" on Money Splitter.\n\n")
            + f"View it here: {link}"
        )
        try:
            _send(email, subject, body)
        except Exception as e:
            print(f"[email] notify_added_to_group error: {e}")

import socket
import smtplib
from contextlib import contextmanager
from email.mime.text import MIMEText

from database import get_settings
from people import person_info


@contextmanager
def _ipv4_only():
    """Force IPv4 name resolution for whatever runs inside this block.

    Render's containers have no outbound IPv6 route, but smtp.gmail.com
    resolves to both an IPv6 and an IPv4 address - when getaddrinfo hands
    back the IPv6 one first, connecting fails immediately with "Network is
    unreachable" rather than falling through to the IPv4 address, since that
    is a routing-table error, not a timeout or refusal smtplib retries past.

    Patched here rather than at import time so it only affects the SMTP
    connection below - the database connection to Neon and anything else
    the app resolves are left alone, in case any of them is one where the
    IPv6 route genuinely does work.
    """
    real_getaddrinfo = socket.getaddrinfo

    def ipv4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        return real_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)

    socket.getaddrinfo = ipv4_getaddrinfo
    try:
        yield
    finally:
        socket.getaddrinfo = real_getaddrinfo


def credentials() -> tuple[str, str]:
    """The sender address and app password, cleaned up.

    Gmail displays an app password as four space-separated groups
    ("abcd efgh ijkl mnop") and that is what gets pasted into a dashboard
    field. Gmail's SMTP does not accept it that way - the spaces have to
    come out, or every login fails with a 535 that reads exactly like a
    wrong password. Stripped here rather than at the call site so both the
    real send and the diagnostics below see the same value.
    """
    settings = get_settings()
    sender = (settings.smtp_sender or "").strip()
    password = "".join((settings.smtp_app_password or "").split())
    return sender, password


def deliver(to_email: str, subject: str, body: str) -> str:
    """Send one email, raising on failure. Returns the transport that worked.

    Separate from _send because the notification paths want a failure to be
    survivable (a broken mailbox should not fail the request that triggered
    it) while the diagnostics endpoint needs the actual exception to report.
    """
    sender, password = credentials()
    if not sender or not password:
        raise RuntimeError(
            "SMTP is not configured: SMTP_SENDER and/or SMTP_APP_PASSWORD "
            "are empty in this process's environment."
        )

    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = to_email

    # 465 first because implicit TLS is one round trip fewer, then 587 as a
    # fallback: hosts that block outbound SMTP rarely block both ports the
    # same way, and a provider that refuses one often allows the other.
    attempts: list[str] = []
    for port, use_ssl in ((465, True), (587, False)):
        try:
            with _ipv4_only():
                if use_ssl:
                    server = smtplib.SMTP_SSL("smtp.gmail.com", port, timeout=15)
                else:
                    server = smtplib.SMTP("smtp.gmail.com", port, timeout=15)
                with server:
                    if not use_ssl:
                        server.starttls()
                    server.login(sender, password)
                    server.sendmail(sender, [to_email], msg.as_string())
            return f"smtp.gmail.com:{port}"
        except smtplib.SMTPAuthenticationError as e:
            # Retrying the other port cannot fix a rejected password, and
            # doing so just earns a second failed-login mark on the account.
            raise RuntimeError(
                f"Gmail rejected the credentials for {sender}: {e}. Use a "
                "16-character App Password (not the account password), and "
                "make sure SMTP_SENDER is the same Google account that "
                "generated it."
            ) from e
        except Exception as e:
            attempts.append(f"port {port}: {type(e).__name__}: {e}")

    raise RuntimeError("could not reach Gmail SMTP - " + "; ".join(attempts))


def _send(to_email: str, subject: str, body: str) -> None:
    try:
        transport = deliver(to_email, subject, body)
        print(f"[email] sent to {to_email} via {transport}: {subject}")
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

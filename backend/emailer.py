import json
import socket
import smtplib
import urllib.error
import urllib.request
from contextlib import contextmanager
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from html import escape

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


# The app's design tokens, copied from frontend/tailwind.config.js. Repeated
# here rather than imported because email cannot share a stylesheet with the
# app - every rule has to be inlined into the markup - so these are the one
# place to change if the palette moves.
BRAND = "#f97316"        # brand-400, the orange the SplitEasy wordmark uses
BRAND_DEEP = "#ea580c"   # brand-500, buttons
INK = "#0f172a"          # field-950, the dark chrome
BODY_TEXT = "#334155"
MUTED = "#64748b"
BORDER = "#e2e8f0"
CANVAS = "#f8fafc"

# Space Grotesk first, for the handful of desktop clients that have it
# installed locally. Web fonts are not an option: Gmail and Outlook strip
# <link> and @import outright, so a font can only be used if the reader
# already has it. The rest of the stack is what actually renders for almost
# everyone, chosen to sit close to Space Grotesk's geometric feel.
FONT = ("'Space Grotesk', 'Segoe UI', -apple-system, BlinkMacSystemFont, "
        "Helvetica, Arial, sans-serif")
MONO = "'IBM Plex Mono', 'Courier New', Courier, monospace"


def _layout(heading: str, lines: list[str], button_url: str = "",
            button_label: str = "", highlight: str = "") -> str:
    """One SplitEasy-branded HTML email.

    Table-based with every style inlined, which looks archaic next to the
    app's Tailwind but is what email clients actually support - Gmail strips
    <style> blocks, and Outlook's renderer predates flexbox and grid by a
    decade. Any <div> layout here would collapse in exactly the clients most
    of these emails land in.

    Always paired with a plain-text alternative by the callers below, so a
    reader whose client blocks HTML still gets the message.
    """
    body_html = "".join(
        f'<p style="margin:0 0 14px;font-size:15px;line-height:1.6;'
        f'color:{BODY_TEXT};">{line}</p>'
        for line in lines
    )

    highlight_html = ""
    if highlight:
        # The login code, given room to breathe and set in mono so a 0 can be
        # told from an O while retyping it.
        highlight_html = (
            f'<table role="presentation" cellpadding="0" cellspacing="0" '
            f'border="0" style="margin:0 0 20px;"><tr>'
            f'<td style="background:{CANVAS};border:1px solid {BORDER};'
            f'border-radius:6px;padding:16px 28px;font-family:{MONO};'
            f'font-size:30px;font-weight:600;letter-spacing:6px;color:{INK};">'
            f'{highlight}</td></tr></table>'
        )

    button_html = ""
    if button_url and button_label:
        button_html = (
            f'<table role="presentation" cellpadding="0" cellspacing="0" '
            f'border="0" style="margin:6px 0 4px;"><tr>'
            f'<td style="background:{BRAND_DEEP};border-radius:6px;">'
            f'<a href="{button_url}" style="display:inline-block;'
            f'padding:11px 22px;font-family:{FONT};font-size:14px;'
            f'font-weight:600;color:#ffffff;text-decoration:none;'
            f'letter-spacing:-0.01em;">{button_label}</a>'
            f'</td></tr></table>'
        )

    return f"""\
<!doctype html>
<html><body style="margin:0;padding:0;background:{CANVAS};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:{CANVAS};padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="max-width:520px;background:#ffffff;border:1px solid {BORDER};
                border-radius:8px;overflow:hidden;">
    <tr><td style="background:{INK};padding:18px 28px;">
      <span style="font-family:{FONT};font-size:21px;font-weight:700;
                   letter-spacing:-0.01em;color:{BRAND};">SplitEasy</span>
    </td></tr>
    <tr><td style="padding:28px;font-family:{FONT};">
      <h1 style="margin:0 0 16px;font-size:18px;font-weight:600;
                 letter-spacing:-0.01em;color:{INK};">{heading}</h1>
      {highlight_html}
      {body_html}
      {button_html}
    </td></tr>
    <tr><td style="border-top:1px solid {BORDER};padding:16px 28px;
                   font-family:{FONT};font-size:12px;line-height:1.5;
                   color:{MUTED};">
      Sent automatically by SplitEasy because you're in this group.
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>"""


def _send_via_brevo(sender: str, to_email: str, subject: str, body: str,
                    html: str = "") -> None:
    """Hand the message to Brevo over HTTPS, raising on any non-2xx.

    Uses urllib rather than requests so this costs no new dependency - it is
    a single POST, and the stdlib does that perfectly well.
    """
    settings = get_settings()
    # "SplitEasy" as the display name rather than a bare gmail address - it is
    # what the app calls itself, and a named sender is both more recognisable
    # in a crowded inbox and marginally less spam-like.
    message = {
        "sender": {"email": sender, "name": "SplitEasy"},
        "to": [{"email": to_email}],
        "subject": subject,
        "textContent": body,
    }
    if html:
        message["htmlContent"] = html
    payload = json.dumps(message).encode()
    req = urllib.request.Request(
        "https://api.brevo.com/v3/smtp/email",
        data=payload,
        headers={
            "api-key": settings.brevo_api_key,
            "content-type": "application/json",
            "accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:400]
        # Brevo answers a refused sender with a perfectly clear message that
        # is worth surfacing verbatim - it is nearly always "this sender is
        # not verified yet", which no amount of retrying will fix.
        raise RuntimeError(f"Brevo rejected the message ({e.code}): {detail}") from e


def deliver(to_email: str, subject: str, body: str, html: str = "") -> str:
    """Send one email, raising on failure. Returns the transport that worked.

    `body` is the plain-text version and is always required; `html` is
    optional and sent alongside it, never instead of it, so a client that
    blocks HTML still shows something readable.

    Two transports, tried in the order that works where the app actually
    runs. Brevo's HTTPS API goes first because Render silently drops
    outbound SMTP on every port Gmail offers - 465 and 587 both time out,
    which is a firewall discarding packets, not anything configuration here
    can fix. Port 443 obviously works, since the API serves its own traffic
    on it.

    Gmail SMTP stays as the fallback rather than being deleted: it works
    perfectly from a laptop, so local development keeps sending mail with no
    Brevo account and no API key, and the two paths are never special-cased
    by environment. Whichever one succeeds is named in the return value so a
    log line says which door the mail actually went through.

    Separate from _send because the notification paths want a failure to be
    survivable (a broken mailbox should not fail the request that triggered
    it) while the diagnostics endpoint needs the actual exception to report.
    """
    sender, password = credentials()
    settings = get_settings()

    if not sender:
        raise RuntimeError(
            "No sender address: SMTP_SENDER is empty in this process's "
            "environment. It is the From address for both transports."
        )

    attempts: list[str] = []

    if settings.brevo_api_key:
        try:
            _send_via_brevo(sender, to_email, subject, body, html)
            return "brevo-api"
        except Exception as e:
            attempts.append(f"brevo-api: {type(e).__name__}: {e}")
    else:
        attempts.append("brevo-api: BREVO_API_KEY not set")

    if not password:
        attempts.append("smtp: SMTP_APP_PASSWORD not set")
        raise RuntimeError("could not send - " + "; ".join(attempts))

    # multipart/alternative when there is HTML: both versions travel together
    # and the client picks. Order matters - least-preferred part first, so the
    # HTML has to be attached last or clients show the plain text.
    if html:
        msg = MIMEMultipart("alternative")
        msg.attach(MIMEText(body, "plain"))
        msg.attach(MIMEText(html, "html"))
    else:
        msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = formataddr(("SplitEasy", sender))
    msg["To"] = to_email

    # 465 first because implicit TLS is one round trip fewer, then 587 as a
    # fallback: hosts that block outbound SMTP rarely block both ports the
    # same way, and a provider that refuses one often allows the other.
    # `attempts` deliberately carries the Brevo failure forward, so a message
    # that got nowhere reports every door it tried, not just the last one.
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

    raise RuntimeError("every email transport failed - " + "; ".join(attempts))


def _send(to_email: str, subject: str, body: str, html: str = "") -> None:
    try:
        transport = deliver(to_email, subject, body, html)
        print(f"[email] sent to {to_email} via {transport}: {subject}")
    except Exception as e:
        print(f"[email] failed to send to {to_email}: {e}")


def send_login_code(email: str, code: str) -> None:
    _send(
        email,
        "Your SplitEasy login code",
        f"Your one-time login code is {code}.\n\n"
        "It expires in 10 minutes and works once. If you didn't ask for "
        "this, ignore this email — nobody can sign in without it.",
        _layout(
            "Your login code",
            ["It expires in 10 minutes and works once.",
             "If you didn't ask for this, ignore this email — nobody can "
             "sign in without it."],
            highlight=code,
        ),
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
        html = _layout(
            f"{who} {verb} in {escape(group.name)}",
            [escape(summary)],
            button_url=link,
            button_label="Open in SplitEasy",
        )
        try:
            _send(email, subject, body, html)
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
        html = _layout(
            f"You're in {escape(group.name)}",
            [f"You added yourself to \"{escape(group.name)}\" on SplitEasy."
             if is_self else
             f"{escape(actor_name)} added you to \"{escape(group.name)}\" "
             "on SplitEasy."],
            button_url=link,
            button_label="Open the group",
        )
        try:
            _send(email, subject, body, html)
        except Exception as e:
            print(f"[email] notify_added_to_group error: {e}")

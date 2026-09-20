import json
import socket
import smtplib
import urllib.error
import urllib.request
from contextlib import contextmanager
from email.header import Header
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from html import escape

from database import get_settings
from people import person_info
import push as _push


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
            button_label: str = "", highlight: str = "",
            footer: str = "Sent automatically by SplitEasy because you're in this group.") -> str:
    """One SplitEasy-branded HTML email, deliberately restrained.

    Table-based with every style inlined, which looks archaic next to the
    app's Tailwind but is what email clients actually support - Gmail strips
    <style> blocks, and Outlook's renderer predates flexbox and grid by a
    decade. Any <div> layout here would collapse in exactly the clients most
    of these emails land in.

    The restraint is the point. A first version had a dark header bar and a
    filled orange call-to-action, and Gmail moved these straight from the
    Updates tab into Promotions - the classifier reads a message's
    appearance, and those two elements are what marketing email looks like.
    The identity that survives is the wordmark, the type and the accent
    colour on links, which is enough to be recognisably the app without
    reading as an advert for it. Anything reintroducing a filled button or a
    colour-blocked header should expect the Promotions tab back.

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

    link_html = ""
    if button_url and button_label:
        # A plain underlined link, not a filled button. A large coloured
        # call-to-action is close to the defining visual feature of marketing
        # email, and it is what moved these from Gmail's Updates tab to
        # Promotions the moment it was introduced. The link does the same job
        # for a reader and carries none of that signal.
        link_html = (
            f'<p style="margin:0;font-size:15px;line-height:1.6;">'
            f'<a href="{button_url}" style="color:{BRAND_DEEP};'
            f'text-decoration:underline;">{button_label}</a></p>'
        )

    return f"""\
<!doctype html>
<html><body style="margin:0;padding:0;background:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:#ffffff;padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="max-width:520px;background:#ffffff;">
    <tr><td style="padding:0 4px 18px;font-family:{FONT};">
      <span style="font-size:19px;font-weight:700;letter-spacing:-0.01em;
                   color:{BRAND};">SplitEasy</span>
    </td></tr>
    <tr><td style="padding:0 4px;font-family:{FONT};">
      <h1 style="margin:0 0 16px;font-size:17px;font-weight:600;
                 letter-spacing:-0.01em;color:{INK};">{heading}</h1>
      {highlight_html}
      {body_html}
      {link_html}
    </td></tr>
    <tr><td style="padding:22px 4px 0;font-family:{FONT};font-size:12px;
                   line-height:1.5;color:{MUTED};">
      {footer}
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
    # Stripped because a key pasted into a dashboard field very often carries
    # a trailing newline or space, and an HTTP header will happily transmit
    # it - Brevo then answers "Key not found", which reads as a wrong or
    # deleted key rather than a whitespace problem and sends you looking in
    # the wrong place entirely.
    api_key = (settings.brevo_api_key or "").strip()
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
            "api-key": api_key,
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
    #
    # utf-8 explicitly on every text part and the subject - this legacy MIME
    # API (compat32, not the modern EmailMessage policy) does not auto-encode
    # non-ASCII content. A subject or body assigned as a plain str with an
    # emoji in it (a birthday email's "Happy birthday! \U0001f382", say) sat
    # fine until .as_string() tried to flatten the message using the
    # process's own default codec - cp1252 on Windows, ascii on a bare Linux
    # container - and failed outright with a UnicodeEncodeError, never
    # reaching the network at all. Header()/the explicit charset argument
    # both force real RFC 2047 / MIME encoding instead of leaving it to
    # whatever codec happens to be the platform default.
    if html:
        msg = MIMEMultipart("alternative")
        msg.attach(MIMEText(body, "plain", "utf-8"))
        msg.attach(MIMEText(html, "html", "utf-8"))
    else:
        msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = Header(subject, "utf-8")
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
    except Exception as e:
        print(f"[email] failed to send to {to_email}: {e}")
        return
    # Logging the send, not sending it - a console that can't render an
    # emoji subject (cp1252 on Windows) must not make a message that has
    # already gone out look like it failed. This used to sit inside the
    # same try/except as deliver() above, so a print() crash here was
    # caught and reported as "failed to send" for an email that had, in
    # fact, already been delivered.
    try:
        print(f"[email] sent to {to_email} via {transport}: {subject}")
    except UnicodeEncodeError:
        print(f"[email] sent to {to_email} via {transport}")


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


def _join_names(names: list[str]) -> str:
    """"A, B, C and D" - the last name gets "and" instead of a comma, the
    way a person would actually say the list out loud."""
    if len(names) <= 1:
        return names[0] if names else ""
    return ", ".join(names[:-1]) + " and " + names[-1]


def send_birthday_wish(db, to_email: str | None, name: str, top_partners: list[tuple[str, float]],
                       age: int | None = None) -> None:
    """One birthday email, sent once a year by the daily cron endpoint (see
    routers/cron.py) to whoever's `birthday` (MM-DD) matches today.

    `top_partners` is this person's own top spending partners - see
    stats.top_transaction_partners - named here rather than left generic,
    since "you should treat these actual people" is the one thing an
    automated birthday email can say that isn't a form-letter platitude.
    Only the names go in the email, not the ₹ amounts behind the ranking -
    a birthday wish saying exactly how much you've spent on your friends
    reads as an accusation, not a nudge. Empty list (nobody to name yet)
    still sends a plain birthday wish rather than skipping the email
    outright.

    `age` is `None` whenever the account has no `birth_year` on file (it's
    optional - see models.User) - the wish is still sent, just without the
    "you turn X today" line, rather than guessing or skipping the email.
    """
    first = name.split()[0] if name.split() else name
    age_bit = f" You turn {age} today - congrats!" if age is not None else ""
    lines = [
        f"Happy birthday, {escape(first)}!{age_bit} Wishing you a genuinely wonderful year ahead.",
    ]
    plain_lines = [f"Happy birthday, {first}!{age_bit} Wishing you a genuinely wonderful year ahead."]

    if top_partners:
        names_only = [pname for pname, _amount in top_partners]
        friends_html = _join_names([escape(n) for n in names_only])
        friends_plain = _join_names(names_only)
        lines.append(
            f"Don't forget to give a party to your best friends - {friends_html}!"
        )
        plain_lines.append(
            f"Don't forget to give a party to your best friends - {friends_plain}!"
        )

    if to_email:
        _send(
            to_email,
            f"🎂 Happy birthday, {first}!",
            "\n\n".join(plain_lines),
            _layout(
                f"Happy birthday, {first}! 🎂",
                lines,
                footer="Sent automatically by SplitEasy on the birthday you set in Account settings.",
            ),
        )
    _push.send_push_to_user(db, name, f"🎂 Happy birthday, {first}!", plain_lines[-1] if len(plain_lines) > 1 else plain_lines[0])


def send_debt_reminder(db, to_email: str | None, name: str, debts: list[tuple[str, float]]) -> None:
    """One monthly nudge, sent on the 1st by the daily cron endpoint (see
    routers/cron.py) to whoever owes anyone money right now.

    `debts` is this person's own outstanding amounts - see
    stats.compute_friend_balances, filtered by the caller to entries where
    they're the one who owes - named per creditor rather than a single
    lump sum, since "here's exactly who to pay and how much" is something
    a person can act on immediately, a total figure isn't.

    Explicitly tells the reader to ignore this if they've already paid,
    rather than assuming the app's own numbers are current - a payment
    made outside the app (cash handed over, a UPI transfer never logged
    here) doesn't show up until someone records it, so an unpaid-looking
    balance is sometimes just an unrecorded one. Framed as "confirm with
    them" rather than "mark it paid yourself," since only the person who
    was actually paid can know for certain that they received it.
    """
    first = name.split()[0] if name.split() else name
    lines = [f"Here's where things stand as of today, {escape(first)}:"]
    plain_lines = [f"Here's where things stand as of today, {first}:"]

    for creditor, amount in debts:
        lines.append(f"You owe <strong>₹{amount:,.2f}</strong> to {escape(creditor)}.")
        plain_lines.append(f"You owe ₹{amount:,.2f} to {creditor}.")

    closing_html = (
        "If you've already paid any of these, no action needed on our end - "
        "just confirm with them directly that they've got it, since a payment "
        "made outside the app doesn't show up here until someone records it."
    )
    lines.append(closing_html)
    plain_lines.append(
        "If you've already paid any of these, no action needed on our end - "
        "just confirm with them directly that they've got it, since a payment "
        "made outside the app doesn't show up here until someone records it."
    )

    if to_email:
        _send(
            to_email,
            "💰 Your SplitEasy dues this month",
            "\n\n".join(plain_lines),
            _layout(
                "Your dues this month 💰",
                lines,
                footer="Sent automatically by SplitEasy on the 1st of every month.",
            ),
        )

    first_creditor, first_amount = debts[0]
    push_body = f"You owe ₹{first_amount:,.0f} to {first_creditor}"
    push_body += "." if len(debts) == 1 else f" and {len(debts) - 1} other{'s' if len(debts) > 2 else ''}."
    _push.send_push_to_user(db, name, "💰 Your dues this month", push_body, url="/balances/owe")


def _describe_participants(expense, member_names: list[str]) -> str:
    """"with everyone" when an expense has no explicit participants (null
    means every group member, same convention ExpenseBase.participants
    documents), otherwise the actual comma-and-"and" list of who was in on
    it - so the memory reads as a real recollection of that day, not just
    an amount."""
    if not expense.participants:
        return "with everyone in the group"
    names = [n.strip() for n in expense.participants.split(",") if n.strip()]
    return f"with {_join_names(names)}" if names else "with everyone in the group"


def notify_group_memory(db, group, expenses: list) -> None:
    """"On this day last year" - one email per reachable member of `group`,
    recalling every expense in it that landed on today's date exactly a
    year ago (see routers/cron.py, which finds `expenses` by an exact
    string match on Expense.date).

    One email per group rather than one per matching expense: a group that
    had three things happen on the same day a year ago should read as one
    memory of that day, not three separate emails landing at once.
    """
    settings = get_settings()
    link = f"{settings.frontend_url}/groups/{group.id}"

    lines, plain_lines = [], []
    for e in expenses:
        desc = e.title or e.category or "an expense"
        who = _describe_participants(e, [m.name for m in group.members])
        lines.append(f"{escape(desc)} - {escape(e.paid_by)} paid, {escape(who)}.")
        plain_lines.append(f"{desc} - {e.paid_by} paid, {who}.")

    subject = f"📅 A year ago today in {group.name}"
    push_body = plain_lines[0] if len(plain_lines) == 1 else f"{len(plain_lines)} things happened in {group.name} a year ago today."

    for m in group.members:
        email = _email_for(db, m.name)
        if email:
            body = (
                f"Exactly a year ago today, this happened in \"{group.name}\":\n\n"
                + "\n".join(f"- {l}" for l in plain_lines)
                + f"\n\nView the group: {link}"
            )
            html = _layout(
                f"A year ago today, in {escape(group.name)} 📅",
                lines,
                button_url=link,
                button_label="Open the group",
                footer="Sent automatically by SplitEasy because an expense in this group happened on this date last year.",
            )
            try:
                _send(email, subject, body, html)
            except Exception as e:
                print(f"[email] notify_group_memory error: {e}")
        # Independent of email: an account with push enabled but no email
        # on file must still hear about this - send_push_to_user is
        # itself a no-op for anyone with no account or no subscription.
        _push.send_push_to_user(db, m.name, subject, push_body, url=link)


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
        # Reads as confirmation to the person who did it ("You just..."),
        # and as an announcement to everyone else ("Anukul just...").
        is_self = m.name.lower() == (actor_name or "").lower()
        who = "You" if is_self else actor_name
        subject = f"{'You' if is_self else actor_name} {verb} in {group.name}"

        email = _email_for(db, m.name)
        if email:
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
        _push.send_push_to_user(db, m.name, subject, summary, url=link)


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
        is_self = name.lower() == (actor_name or "").lower()
        subject = f"You're in {group.name}" if is_self else f"{actor_name} added you to {group.name}"
        push_body = (
            f"You added yourself to \"{group.name}\"." if is_self
            else f"{actor_name} added you to \"{group.name}\"."
        )

        email = _email_for(db, name)
        if email:
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
        _push.send_push_to_user(db, name, subject, push_body, url=link)


def notify_group_activity_bg(group_id: int, actor_name: str, verb: str, summary: str,
                             skip_names: list[str] | None = None) -> None:
    """notify_group_activity, run from FastAPI's BackgroundTasks after the
    response has already gone back to the browser.

    Every mutating endpoint used to call notify_group_activity inline, before
    returning - meaning every save waited on one real network round trip per
    reachable group member (Brevo's API, or the Gmail SMTP fallback if that
    fails) before the client ever saw a response. A group with two or three
    reachable members turned "save" into a multi-second wait for something
    the person saving never needed to wait for at all.

    Takes a bare group_id and opens its own database session rather than
    reusing the request's, because a background task runs after the request
    has finished - including after get_db's `finally: db.close()` has
    already torn down the session the endpoint was using. Querying a closed
    session raises, and since this is best-effort already, that failure
    would have silently undone every notification this same session's work
    only just got working. A fresh, short-lived session sidesteps that
    entirely.
    """
    from database import get_session_factory
    from models import Group

    db = get_session_factory()()
    try:
        group = db.query(Group).filter(Group.id == group_id).first()
        if group is not None:
            notify_group_activity(db, group, actor_name, verb, summary, skip_names)
    except Exception as e:
        print(f"[email] backgrounded notify_group_activity failed: {e}")
    finally:
        db.close()


def notify_added_to_group_bg(group_id: int, actor_name: str, added_names: list[str]) -> None:
    """notify_added_to_group, backgrounded - see notify_group_activity_bg for
    why this opens its own session instead of reusing the request's."""
    from database import get_session_factory
    from models import Group

    db = get_session_factory()()
    try:
        group = db.query(Group).filter(Group.id == group_id).first()
        if group is not None:
            notify_added_to_group(db, group, actor_name, added_names)
    except Exception as e:
        print(f"[email] backgrounded notify_added_to_group failed: {e}")
    finally:
        db.close()


def send_notice(db, name: str, subject: str, lines: list[str], push_body: str,
                url: str = "/loans") -> None:
    """One plain notification to one person - email if they have one, push
    if they've enabled it, independently, the same rule the group
    notifications follow. `lines` are plain text; escaped here for the HTML
    version so callers don't each have to remember to."""
    email = _email_for(db, name)
    if email:
        link = f"{get_settings().frontend_url}{url}"
        try:
            _send(
                email, subject, "\n\n".join(lines) + f"\n\nOpen SplitEasy: {link}",
                _layout(subject, [escape(l) for l in lines],
                        button_url=link, button_label="Open in SplitEasy",
                        footer="Sent automatically by SplitEasy."),
            )
        except Exception as e:
            print(f"[email] send_notice error: {e}")
    _push.send_push_to_user(db, name, subject, push_body, url=url)

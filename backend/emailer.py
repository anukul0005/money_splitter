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


def notify_group_activity(group, actor_name: str, verb: str, summary: str) -> None:
    """Notify the other member of a 2-person group about new activity.

    Only fires when both members are in the known PEOPLE registry (i.e. it's
    an AG/AS-style master-grouped pair) — silently no-ops otherwise.
    """
    member_names = [m.name for m in group.members]
    if len(member_names) != 2:
        return
    infos = {n: person_info(n) for n in member_names}
    if any(v is None for v in infos.values()):
        return

    settings = get_settings()
    link = f"{settings.frontend_url}/groups/{group.id}"

    for name, info in infos.items():
        if name.lower() == (actor_name or "").lower():
            continue  # skip notifying whoever triggered it
        subject = f"{actor_name} {verb} in {group.name}"
        body = (
            f"{actor_name} {verb} in \"{group.name}\":\n\n"
            f"{summary}\n\n"
            f"View it here: {link}"
        )
        try:
            _send(info["email"], subject, body)
        except Exception as e:
            print(f"[email] notify_group_activity error: {e}")

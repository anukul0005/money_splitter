import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from auth import create_token, current_user, require_admin
from database import get_db
from models import User
from schemas import (
    UserSignup, UserLogin, UserOut, LoginOut, SetRecovery, ResetPassword,
    AdminReset, AdminSetRecovery, AdminIssueCode, RedeemCode,
    SetEmail, RequestLoginCode, VerifyLoginCode, UserMeOut,
)
from emailer import send_login_code

router = APIRouter(prefix="/users", tags=["users"])

ADMIN_NAMES = {"anukul", "anubhav"}


def _hash(password: str, salt: str) -> str:
    return hashlib.sha256((salt + password).encode()).hexdigest()


def _norm_answer(answer: str) -> str:
    """Recovery answers are compared case- and whitespace-insensitively —
    "New Delhi " and "new delhi" are the same answer to a human."""
    return " ".join((answer or "").strip().lower().split())


def _set_password(user: User, new_password: str) -> None:
    user.salt = secrets.token_hex(16)
    user.password_hash = _hash(new_password, user.salt)


@router.post("/signup", response_model=UserOut, status_code=201)
def signup(payload: UserSignup, db: Session = Depends(get_db)):
    name = payload.name.strip()
    if not name or not payload.password:
        raise HTTPException(400, "Name and password are required")
    existing = db.query(User).filter(User.name.ilike(name)).first()
    if existing:
        raise HTTPException(409, "Username already taken")
    salt = secrets.token_hex(16)
    user = User(
        name=name,
        password_hash=_hash(payload.password, salt),
        salt=salt,
        is_admin=name.lower() in ADMIN_NAMES,
    )

    # Recovery question is optional here; without one the user needs an admin
    # to reset, which is exactly what the reset page tells them.
    answer = _norm_answer(payload.recovery_answer or "")
    question = (payload.recovery_question or "").strip()
    if question and len(answer) >= 3:
        user.recovery_salt = secrets.token_hex(16)
        user.recovery_answer_hash = _hash(answer, user.recovery_salt)
        user.recovery_question = question

    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.post("/login", response_model=LoginOut)
def login(payload: UserLogin, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.name.ilike(payload.name.strip())).first()
    if not user:
        raise HTTPException(401, "Incorrect username or password")
    if not secrets.compare_digest(user.password_hash, _hash(payload.password, user.salt)):
        raise HTTPException(401, "Incorrect username or password")
    return LoginOut(
        id=user.id, name=user.name, is_admin=user.is_admin, email=user.email,
        created_at=user.created_at, token=create_token(user),
    )


@router.get("/", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db), _: User = Depends(current_user)):
    """Names only, and only for people already signed in — the group editor
    needs them to offer members to add."""
    return db.query(User).order_by(User.created_at).all()


@router.patch("/{user_id}/password", response_model=UserOut)
def change_password(user_id: int, payload: dict, db: Session = Depends(get_db),
                    caller: User = Depends(current_user)):
    if caller.id != user_id:
        raise HTTPException(403, "You can only change your own password")
    current = payload.get("current_password", "")
    new = payload.get("new_password", "")
    if not current or not new:
        raise HTTPException(400, "Both current and new password are required")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")
    if user.password_hash != _hash(current, user.salt):
        raise HTTPException(401, "Current password is incorrect")
    user.salt = secrets.token_hex(16)
    user.password_hash = _hash(new, user.salt)
    db.commit()
    db.refresh(user)
    return user


@router.patch("/{user_id}/recovery", response_model=UserOut)
def set_recovery(user_id: int, payload: SetRecovery, db: Session = Depends(get_db),
                 caller: User = Depends(current_user)):
    """Set, replace, or regenerate your security answer / 6-digit passkey.

    Authorised by your current password OR your existing security answer.
    Either is proof of identity, and offering both means a lost passkey is
    recoverable by someone who still knows their password, and vice versa.
    """
    if caller.id != user_id:
        raise HTTPException(403, "You can only change your own recovery settings")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")

    if payload.current_password:
        if user.password_hash != _hash(payload.current_password, user.salt):
            raise HTTPException(401, "Current password is incorrect")
    elif payload.current_answer:
        # Shares the reset lockout, so this isn't a softer way in
        _check_answer(user, payload.current_answer, db)
    else:
        raise HTTPException(400, "Enter your current password or your security answer")

    question = payload.question.strip()
    answer = _norm_answer(payload.answer)
    if not question:
        raise HTTPException(400, "Pick a security question")
    if len(answer) < 3:
        raise HTTPException(400, "Answer must be at least 3 characters")

    user.recovery_salt = secrets.token_hex(16)
    user.recovery_answer_hash = _hash(answer, user.recovery_salt)
    user.recovery_question = question
    user.reset_fail_count = 0
    user.reset_locked_until = None
    db.commit()
    db.refresh(user)
    return user


@router.get("/recovery-question", response_model=dict)
def get_recovery_question(name: str, db: Session = Depends(get_db)):
    """The question to show on the reset page, if this user has set one."""
    user = db.query(User).filter(User.name.ilike(name.strip())).first()
    if not user or not user.recovery_question or not user.recovery_answer_hash:
        return {"has_recovery": False, "question": None}
    return {"has_recovery": True, "question": user.recovery_question}


MAX_RESET_ATTEMPTS = 5
LOCKOUT_MINUTES = 15
GENERIC_ANSWER_ERROR = "That answer doesn't match our records."


def _check_answer(user: User | None, answer: str, db: Session) -> User:
    """Verify a recovery answer, counting failures so a 6-digit key can't be
    walked through by a script. Raises on any failure; returns the user on
    success. The error is identical for unknown user / no recovery / wrong
    answer, so this can't be used to enumerate accounts."""
    now = datetime.now(timezone.utc)

    if user and user.reset_locked_until is not None:
        locked_until = user.reset_locked_until
        if locked_until.tzinfo is None:
            locked_until = locked_until.replace(tzinfo=timezone.utc)
        if locked_until > now:
            mins = max(1, int((locked_until - now).total_seconds() // 60) + 1)
            raise HTTPException(429, f"Too many wrong attempts. Try again in {mins} minute(s).")

    if not user or not user.recovery_answer_hash or not user.recovery_salt:
        raise HTTPException(401, GENERIC_ANSWER_ERROR)

    expected = _hash(_norm_answer(answer), user.recovery_salt)
    if not secrets.compare_digest(user.recovery_answer_hash, expected):
        user.reset_fail_count = (user.reset_fail_count or 0) + 1
        if user.reset_fail_count >= MAX_RESET_ATTEMPTS:
            user.reset_locked_until = now + timedelta(minutes=LOCKOUT_MINUTES)
            user.reset_fail_count = 0
        db.commit()
        raise HTTPException(401, GENERIC_ANSWER_ERROR)

    # Clean slate on success
    user.reset_fail_count = 0
    user.reset_locked_until = None
    return user


def _require_admin(payload_name: str, answer: str, db: Session) -> User:
    admin = db.query(User).filter(User.name.ilike((payload_name or "").strip())).first()
    admin = _check_answer(admin, answer, db)
    if not (admin.is_admin or admin.name.lower() in ADMIN_NAMES):
        raise HTTPException(403, "Only admins can do that")
    return admin


@router.post("/reset-password", response_model=UserOut)
def reset_password(payload: ResetPassword, db: Session = Depends(get_db)):
    """Self-serve reset: the correct recovery answer buys a new password."""
    if len(payload.new_password or "") < 4:
        raise HTTPException(400, "New password must be at least 4 characters")

    user = db.query(User).filter(User.name.ilike(payload.name.strip())).first()
    user = _check_answer(user, payload.answer, db)

    _set_password(user, payload.new_password)
    db.commit()
    db.refresh(user)
    return user


@router.post("/admin-reset", response_model=UserOut)
def admin_reset_password(payload: AdminReset, db: Session = Depends(get_db)):
    """An admin sets a new password for someone else. The admin proves
    themselves with their own recovery key, so a locked-out admin can still
    help — which a password check would not allow."""
    _require_admin(payload.admin_name, payload.admin_answer, db)
    if len(payload.new_password or "") < 4:
        raise HTTPException(400, "New password must be at least 4 characters")

    target = db.query(User).filter(User.name.ilike(payload.target_name.strip())).first()
    if not target:
        raise HTTPException(404, f"No user named {payload.target_name}")

    _set_password(target, payload.new_password)
    db.commit()
    db.refresh(target)
    return target


CODE_TTL_HOURS = 24


@router.post("/admin-issue-code", response_model=dict)
def admin_issue_code(payload: AdminIssueCode, db: Session = Depends(get_db)):
    """Mint a one-time 6-digit code for another user.

    Authorised by the admin's own passkey. Returned exactly once — only the
    hash is stored, so it cannot be read back afterwards.
    """
    admin = _require_admin(payload.admin_name, payload.admin_answer, db)

    target_name = (payload.target_name or "").strip()
    if not target_name:
        raise HTTPException(400, "Pick who the code is for")
    if target_name.lower() == admin.name.lower():
        raise HTTPException(400, "Issue the code to someone else — use your own passkey to reset yourself")

    target = db.query(User).filter(User.name.ilike(target_name)).first()
    if not target:
        raise HTTPException(404, f"No user named {target_name}")

    code = str(secrets.randbelow(1000000)).zfill(6)
    expires = datetime.now(timezone.utc) + timedelta(hours=CODE_TTL_HOURS)
    target.otc_salt = secrets.token_hex(16)
    target.otc_hash = _hash(code, target.otc_salt)
    target.otc_expires_at = expires
    # A fresh code should not inherit an old lockout
    target.reset_fail_count = 0
    target.reset_locked_until = None
    db.commit()

    return {
        "target": target.name,
        "code": code,
        "expires_at": expires.isoformat(),
        "expires_in_hours": CODE_TTL_HOURS,
    }


@router.post("/redeem-code", response_model=UserOut)
def redeem_code(payload: RedeemCode, db: Session = Depends(get_db)):
    """Spend a one-time code: set a new password and your own security
    question. The code is cleared on success and cannot be reused."""
    if len(payload.new_password or "") < 4:
        raise HTTPException(400, "New password must be at least 4 characters")

    question = payload.question.strip()
    answer = _norm_answer(payload.answer)
    if not question:
        raise HTTPException(400, "Pick a security question")
    if len(answer) < 3:
        raise HTTPException(400, "Answer must be at least 3 characters")

    user = db.query(User).filter(User.name.ilike(payload.name.strip())).first()
    now = datetime.now(timezone.utc)
    generic = "That code isn't valid. Ask an admin for a new one."

    # Same lockout counter as the reset page, so codes can't be brute-forced
    if user and user.reset_locked_until is not None:
        locked = user.reset_locked_until
        if locked.tzinfo is None:
            locked = locked.replace(tzinfo=timezone.utc)
        if locked > now:
            mins = max(1, int((locked - now).total_seconds() // 60) + 1)
            raise HTTPException(429, f"Too many wrong attempts. Try again in {mins} minute(s).")

    if not user or not user.otc_hash or not user.otc_salt:
        raise HTTPException(401, generic)

    expires = user.otc_expires_at
    if expires is not None and expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires is None or expires < now:
        raise HTTPException(401, "That code has expired. Ask an admin for a new one.")

    if not secrets.compare_digest(user.otc_hash, _hash((payload.code or "").strip(), user.otc_salt)):
        user.reset_fail_count = (user.reset_fail_count or 0) + 1
        if user.reset_fail_count >= MAX_RESET_ATTEMPTS:
            user.reset_locked_until = now + timedelta(minutes=LOCKOUT_MINUTES)
            user.reset_fail_count = 0
        db.commit()
        raise HTTPException(401, generic)

    _set_password(user, payload.new_password)
    user.recovery_salt = secrets.token_hex(16)
    user.recovery_answer_hash = _hash(answer, user.recovery_salt)
    user.recovery_question = question
    # Burn the code
    user.otc_hash = None
    user.otc_salt = None
    user.otc_expires_at = None
    user.reset_fail_count = 0
    user.reset_locked_until = None
    db.commit()
    db.refresh(user)
    return user


@router.post("/admin-set-recovery", response_model=UserOut)
def admin_set_recovery(payload: AdminSetRecovery, db: Session = Depends(get_db)):
    """An admin creates or replaces another user's security question."""
    _require_admin(payload.admin_name, payload.admin_answer, db)

    question = payload.question.strip()
    answer = _norm_answer(payload.answer)
    if not question:
        raise HTTPException(400, "Pick a security question")
    if len(answer) < 3:
        raise HTTPException(400, "Answer must be at least 3 characters")

    target = db.query(User).filter(User.name.ilike(payload.target_name.strip())).first()
    if not target:
        raise HTTPException(404, f"No user named {payload.target_name}")

    target.recovery_salt = secrets.token_hex(16)
    target.recovery_answer_hash = _hash(answer, target.recovery_salt)
    target.recovery_question = question
    target.reset_fail_count = 0
    target.reset_locked_until = None
    db.commit()
    db.refresh(target)
    return target


def _valid_email(email: str) -> bool:
    email = (email or "").strip()
    if "@" not in email:
        return False
    local, _, domain = email.partition("@")
    return bool(local) and "." in domain and not domain.startswith(".")


@router.get("/me", response_model=UserMeOut)
def get_me(caller: User = Depends(current_user)):
    """The signed-in caller's own record, email included - the one place
    that's safe to read it back from, since list_users (everyone else's
    names) deliberately never includes it."""
    return caller


@router.post("/me/email", response_model=UserMeOut)
def set_my_email(payload: SetEmail, db: Session = Depends(get_db),
                 caller: User = Depends(current_user)):
    """Attach (or replace) the email your login code and every notification
    about your groups goes to. Self-service only — nobody sets this for you,
    since a wrong address would mean a login code goes to somebody else."""
    email = payload.email.strip().lower()
    if not _valid_email(email):
        raise HTTPException(400, "That doesn't look like an email address")

    taken = db.query(User).filter(User.email.ilike(email), User.id != caller.id).first()
    if taken:
        raise HTTPException(409, "That email is already attached to another account")

    caller.email = email
    db.commit()
    db.refresh(caller)
    return caller


@router.get("/email-diagnostics", response_model=dict)
def email_diagnostics(caller: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Why email isn't arriving, answered from the running server.

    Every send path deliberately swallows its exception so a broken mailbox
    can't fail the request that triggered it - which also means the real
    reason only ever reached a log line on the host. This reports the same
    facts over the API: what the process actually has for config, whether
    Gmail is reachable from there, and which accounts even have an address
    for a notification to go to.
    """
    import socket as _socket

    from database import get_settings
    from emailer import _ipv4_only, credentials

    settings = get_settings()
    sender, password = credentials()
    raw_password = settings.smtp_app_password or ""

    dns = {}
    for family, label in ((_socket.AF_INET, "ipv4"), (_socket.AF_INET6, "ipv6")):
        try:
            dns[label] = sorted({r[4][0] for r in _socket.getaddrinfo("smtp.gmail.com", 465, family)})
        except Exception as e:
            dns[label] = f"{type(e).__name__}: {e}"

    # 465 and 587 are the ports Gmail actually offers, and both time out on
    # Render - the host drops outbound SMTP rather than refusing it. 2525 is
    # here as the interesting case: it is not a standard SMTP port, so hosts
    # that block SMTP by port number sometimes leave it open, and several
    # relays (Brevo, SendGrid, Mailgun) listen on it for exactly that reason.
    # Gmail does not, so this probe points at Brevo - an "open" here means
    # SMTP is still viable from this host via a relay, and a timeout means
    # the block is broad and only an HTTPS-based email API will work.
    # Probed through the same IPv4-only patch the real send uses. Without it
    # these connect over IPv6 and fail with "[Errno 101] Network is
    # unreachable" on a host with no IPv6 route - which says nothing about
    # whether the port is blocked, and is a different failure from the
    # timeout an actual send hits. A diagnostic that does not reproduce the
    # thing it is diagnosing is worse than none.
    reachable = {}
    for host, port in (("smtp.gmail.com", 465), ("smtp.gmail.com", 587),
                       ("smtp-relay.brevo.com", 2525)):
        try:
            with _ipv4_only():
                with _socket.create_connection((host, port), timeout=8):
                    reachable[f"{host}:{port}"] = "open"
        except Exception as e:
            reachable[f"{host}:{port}"] = f"{type(e).__name__}: {e}"

    users = db.query(User).all()
    return {
        "config": {
            "smtp_sender": sender or None,
            "smtp_app_password_set": bool(password),
            "smtp_app_password_length": len(password),
            "smtp_app_password_had_spaces": raw_password != raw_password.replace(" ", ""),
            "frontend_url": settings.frontend_url,
            # Every notification links back to the app through this. It
            # defaults to localhost, which is correct on a laptop and useless
            # in a deployed one - the link arrives in someone's inbox and
            # opens nothing. Nothing else fails when it is wrong, so it needs
            # saying out loud rather than being left to notice.
            "frontend_url_looks_local": (
                "localhost" in settings.frontend_url
                or "127.0.0.1" in settings.frontend_url
            ),
        },
        "dns_smtp_gmail_com": dns,
        "tcp_reachable": reachable,
        "accounts": {
            "total": len(users),
            "with_email": sum(1 for u in users if u.email),
            "without_email": sorted(u.name for u in users if not u.email),
        },
        "note": (
            "smtp_app_password_length should be 16. If tcp_reachable shows "
            "both ports blocked, the host is blocking outbound SMTP and no "
            "config change here will help - switch to an HTTP email API. "
            "POST to this same path with {\"to\": \"you@example.com\"} to "
            "attempt a real send and see the exact error."
        ),
    }


@router.post("/email-diagnostics", response_model=dict)
def email_diagnostics_send(payload: dict, caller: User = Depends(require_admin)):
    """Attempt one real send and report what happened, verbatim."""
    from emailer import deliver

    to = (payload.get("to") or caller.email or "").strip()
    if not to:
        raise HTTPException(400, "Pass {\"to\": \"someone@example.com\"} - your account has no email set.")
    try:
        transport = deliver(
            to,
            "Money Splitter email test",
            "If you're reading this, the server can send mail. "
            "Login codes and group notifications will arrive the same way.",
        )
    except Exception as e:
        return {"sent": False, "to": to, "error": f"{type(e).__name__}: {e}"}
    return {"sent": True, "to": to, "transport": transport}


LOGIN_CODE_TTL_MINUTES = 10


@router.post("/email-code", response_model=dict)
def request_login_code(payload: RequestLoginCode, db: Session = Depends(get_db)):
    """Email a 6-digit code that logs you in, no password needed.

    Responds the same way whether or not the email is on file — a different
    message for "no such account" would let anyone check who has signed up
    just by trying addresses.
    """
    generic = {"sent": True, "message": "If that email is on an account, a code is on its way."}
    email = (payload.email or "").strip().lower()
    if not email:
        return generic

    user = db.query(User).filter(User.email.ilike(email)).first()
    if not user:
        return generic

    code = str(secrets.randbelow(1000000)).zfill(6)
    user.login_code_salt = secrets.token_hex(16)
    user.login_code_hash = _hash(code, user.login_code_salt)
    user.login_code_expires_at = datetime.now(timezone.utc) + timedelta(minutes=LOGIN_CODE_TTL_MINUTES)
    # A fresh code should not inherit an old lockout from a mistyped password
    # or a previous code that was never used.
    user.reset_fail_count = 0
    user.reset_locked_until = None
    db.commit()

    try:
        send_login_code(user.email, code)
    except Exception as e:
        print(f"[email] login code send failed: {e}")

    return generic


@router.post("/email-code/verify", response_model=LoginOut)
def verify_login_code(payload: VerifyLoginCode, db: Session = Depends(get_db)):
    """Spend a login code for a session token — the same lockout counter the
    password-reset flow uses, so this can't be brute-forced any more than
    that already refuses to allow."""
    email = (payload.email or "").strip().lower()
    generic = "That code isn't valid or has expired. Request a new one."
    now = datetime.now(timezone.utc)

    user = db.query(User).filter(User.email.ilike(email)).first()

    if user and user.reset_locked_until is not None:
        locked = user.reset_locked_until
        if locked.tzinfo is None:
            locked = locked.replace(tzinfo=timezone.utc)
        if locked > now:
            mins = max(1, int((locked - now).total_seconds() // 60) + 1)
            raise HTTPException(429, f"Too many wrong attempts. Try again in {mins} minute(s).")

    if not user or not user.login_code_hash or not user.login_code_salt:
        raise HTTPException(401, generic)

    expires = user.login_code_expires_at
    if expires is not None and expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires is None or expires < now:
        raise HTTPException(401, generic)

    if not secrets.compare_digest(user.login_code_hash, _hash((payload.code or "").strip(), user.login_code_salt)):
        user.reset_fail_count = (user.reset_fail_count or 0) + 1
        if user.reset_fail_count >= MAX_RESET_ATTEMPTS:
            user.reset_locked_until = now + timedelta(minutes=LOCKOUT_MINUTES)
            user.reset_fail_count = 0
        db.commit()
        raise HTTPException(401, generic)

    # Burn the code - one login per code, same as the admin-issued kind.
    user.login_code_hash = None
    user.login_code_salt = None
    user.login_code_expires_at = None
    user.reset_fail_count = 0
    user.reset_locked_until = None
    db.commit()

    return LoginOut(
        id=user.id, name=user.name, is_admin=user.is_admin, email=user.email,
        created_at=user.created_at, token=create_token(user),
    )


@router.delete("/{user_id}", status_code=204)
def delete_user(user_id: int, db: Session = Depends(get_db),
                _: User = Depends(require_admin)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")
    db.delete(user)
    db.commit()

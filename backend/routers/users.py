import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from database import get_db
from models import User
from schemas import (
    UserSignup, UserLogin, UserOut, SetRecovery, ResetPassword,
    AdminReset, AdminSetRecovery, AdminIssueCode, RedeemCode,
)

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


@router.post("/login", response_model=UserOut)
def login(payload: UserLogin, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.name.ilike(payload.name.strip())).first()
    if not user:
        raise HTTPException(401, "Incorrect username or password")
    if user.password_hash != _hash(payload.password, user.salt):
        raise HTTPException(401, "Incorrect username or password")
    return user


@router.get("/", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db)):
    return db.query(User).order_by(User.created_at).all()


@router.patch("/{user_id}/password", response_model=UserOut)
def change_password(user_id: int, payload: dict, db: Session = Depends(get_db)):
    from pydantic import BaseModel
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
def set_recovery(user_id: int, payload: SetRecovery, db: Session = Depends(get_db)):
    """Set or replace the recovery question. Gated on the current password so a
    borrowed session can't quietly swap in a recovery route of its own."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")
    if user.password_hash != _hash(payload.current_password, user.salt):
        raise HTTPException(401, "Current password is incorrect")

    question = payload.question.strip()
    answer = _norm_answer(payload.answer)
    if not question:
        raise HTTPException(400, "Pick a recovery question")
    if len(answer) < 3:
        raise HTTPException(400, "Recovery answer must be at least 3 characters")

    user.recovery_salt = secrets.token_hex(16)
    user.recovery_answer_hash = _hash(answer, user.recovery_salt)
    user.recovery_question = question
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


@router.delete("/{user_id}", status_code=204)
def delete_user(user_id: int, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")
    db.delete(user)
    db.commit()

import hashlib
import secrets
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from database import get_db
from models import User
from schemas import UserSignup, UserLogin, UserOut, SetRecovery, ResetPassword, AdminReset

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


@router.post("/reset-password", response_model=UserOut)
def reset_password(payload: ResetPassword, db: Session = Depends(get_db)):
    """Self-serve reset: correct recovery answer buys a new password."""
    if len(payload.new_password or "") < 4:
        raise HTTPException(400, "New password must be at least 4 characters")

    user = db.query(User).filter(User.name.ilike(payload.name.strip())).first()
    # Same message whether the user is unknown, has no recovery set, or answered
    # wrong — otherwise this endpoint becomes a username/answer oracle.
    generic = "That answer doesn't match our records."
    if not user or not user.recovery_answer_hash or not user.recovery_salt:
        raise HTTPException(401, generic)
    if user.recovery_answer_hash != _hash(_norm_answer(payload.answer), user.recovery_salt):
        raise HTTPException(401, generic)

    _set_password(user, payload.new_password)
    db.commit()
    db.refresh(user)
    return user


@router.post("/admin-reset", response_model=UserOut)
def admin_reset_password(payload: AdminReset, db: Session = Depends(get_db)):
    """Fallback for users who never set a recovery question: an admin proves
    themselves with their own password and sets a new one for the target."""
    admin = db.query(User).filter(User.name.ilike(payload.admin_name.strip())).first()
    if not admin or admin.password_hash != _hash(payload.admin_password, admin.salt):
        raise HTTPException(401, "Admin credentials are incorrect")
    if not (admin.is_admin or admin.name.lower() in ADMIN_NAMES):
        raise HTTPException(403, "Only admins can reset another user's password")
    if len(payload.new_password or "") < 4:
        raise HTTPException(400, "New password must be at least 4 characters")

    target = db.query(User).filter(User.name.ilike(payload.target_name.strip())).first()
    if not target:
        raise HTTPException(404, f"No user named {payload.target_name}")

    _set_password(target, payload.new_password)
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

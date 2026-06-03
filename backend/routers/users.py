import hashlib
import secrets
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from database import get_db
from models import User
from schemas import UserSignup, UserLogin, UserOut

router = APIRouter(prefix="/users", tags=["users"])

ADMIN_NAMES = {"anukul", "anubhav"}


def _hash(password: str, salt: str) -> str:
    return hashlib.sha256((salt + password).encode()).hexdigest()


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


@router.delete("/{user_id}", status_code=204)
def delete_user(user_id: int, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")
    db.delete(user)
    db.commit()

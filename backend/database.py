from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker, Session
from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    database_url: str
    allowed_origins: str = "http://localhost:5173"
    frontend_url: str = "http://localhost:5173"
    smtp_sender: str = ""
    smtp_app_password: str = ""

    class Config:
        env_file = ".env"


@lru_cache
def get_settings() -> Settings:
    return Settings()


class Base(DeclarativeBase):
    pass


_engine = None
_SessionLocal = None


def get_engine():
    global _engine
    if _engine is None:
        settings = get_settings()
        _engine = create_engine(settings.database_url, pool_pre_ping=True, pool_size=5, max_overflow=10)
    return _engine


def get_session_factory():
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = sessionmaker(bind=get_engine(), autocommit=False, autoflush=False)
    return _SessionLocal


def get_db() -> Session:
    db = get_session_factory()()
    try:
        yield db
    finally:
        db.close()


def create_tables():
    from sqlalchemy import text
    Base.metadata.create_all(bind=get_engine())
    # Safe migration: add split_json column if it doesn't exist yet
    with get_engine().connect() as conn:
        conn.execute(text(
            "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS split_json TEXT"
        ))
        conn.execute(text(
            "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(50)"
        ))
        conn.execute(text(
            "ALTER TABLE groups ADD COLUMN IF NOT EXISTS category VARCHAR(50)"
        ))
        conn.execute(text(
            "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS settled_by TEXT"
        ))
        conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_question VARCHAR(200)"
        ))
        conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_answer_hash VARCHAR(128)"
        ))
        conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_salt VARCHAR(64)"
        ))
        conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_fail_count INTEGER DEFAULT 0"
        ))
        conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_locked_until TIMESTAMPTZ"
        ))
        conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS otc_hash VARCHAR(128)"
        ))
        conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS otc_salt VARCHAR(64)"
        ))
        conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS otc_expires_at TIMESTAMPTZ"
        ))
        # Strength on a hand-entered price. create_all() only builds tables it
        # has never seen, so an existing price_overrides table needs this added
        # explicitly or every read of the column fails.
        conn.execute(text(
            "ALTER TABLE price_overrides ADD COLUMN IF NOT EXISTS abv DOUBLE PRECISION"
        ))
        conn.commit()

    # `payments`, `activities` and `activity_seen` are created by create_all
    # above; nothing to backfill since they start empty.

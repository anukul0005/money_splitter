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
    # Brevo's HTTP API, used because Render drops outbound SMTP on every port
    # Gmail offers - see emailer.deliver. Empty means "no HTTP transport
    # configured", which is the normal state locally, where SMTP works fine.
    brevo_api_key: str = ""

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


# An arbitrary, fixed id for the advisory lock below - it only has to be
# consistent across every process that calls create_tables(), never meaning
# anything to Postgres beyond "the same lock as last time."
MIGRATION_LOCK_ID = 987654321


def create_tables():
    from sqlalchemy import text

    Base.metadata.create_all(bind=get_engine())

    # A rolling deploy briefly runs the old instance and the new one
    # together, and both call this on startup - two ALTER TABLE statements
    # racing on the same tables is exactly what triggers a Postgres
    # deadlock, which crashed the whole boot (an uncaught OperationalError)
    # the one time it happened, rather than just costing a slightly slower
    # start. An advisory lock serialises them instead of letting them
    # collide: the second instance blocks here until the first finishes and
    # commits, then runs through a table already migrated - every statement
    # below is IF NOT EXISTS, so that second pass is a genuine no-op, not a
    # second race.
    with get_engine().connect() as conn:
        conn.execute(text("SELECT pg_advisory_lock(:id)"), {"id": MIGRATION_LOCK_ID})
        try:
            _run_migrations(conn, text)
        finally:
            conn.execute(text("SELECT pg_advisory_unlock(:id)"), {"id": MIGRATION_LOCK_ID})
            conn.commit()


def _run_migrations(conn, text) -> None:
    """Every ALTER TABLE this app has ever needed after create_all(), which
    only builds tables it has never seen and never touches an existing one's
    columns. Called with the migration lock already held - see create_tables.
    """
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
    conn.execute(text(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(200)"
    ))
    conn.execute(text(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS login_code_hash VARCHAR(128)"
    ))
    conn.execute(text(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS login_code_salt VARCHAR(64)"
    ))
    conn.execute(text(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS login_code_expires_at TIMESTAMPTZ"
    ))
    # Case-insensitive and NULL-safe: a plain UNIQUE constraint on email
    # would reject a second account with no email at all, since two NULLs
    # would collide under most people's mental model of "unique" even
    # though SQL itself treats them as distinct. A partial index only
    # constrains the rows that actually have one set.
    conn.execute(text(
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email "
        "ON users (lower(email)) WHERE email IS NOT NULL"
    ))
    # Strength on a hand-entered price. create_all() only builds tables it
    # has never seen, so an existing price_overrides table needs this added
    # explicitly or every read of the column fails.
    conn.execute(text(
        "ALTER TABLE price_overrides ADD COLUMN IF NOT EXISTS abv DOUBLE PRECISION"
    ))
    # The knowledge base's vector column. pgvector has no SQLAlchemy type
    # here, so the column is added by hand after create_all() has built
    # the rest of the table. Wrapped because a database without the
    # extension should still start - the app degrades to no retrieval
    # rather than refusing to boot.
    try:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        conn.execute(text(
            "ALTER TABLE knowledge_items "
            "ADD COLUMN IF NOT EXISTS embedding vector(2048)"
        ))
    except Exception as e:  # pragma: no cover - depends on the server
        print(f"[warn] pgvector unavailable, retrieval disabled: {e}")
    conn.commit()

    # `payments`, `activities` and `activity_seen` are created by create_all
    # above; nothing to backfill since they start empty.

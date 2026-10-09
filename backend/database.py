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
    # Shared secret an external daily cron pinger sends back, so /cron/* isn't
    # something anyone who finds the URL can trigger on someone else's
    # behalf. Empty means the daily-jobs endpoint refuses every request -
    # deliberately unusable until a real secret is actually set, rather than
    # silently open in an environment that never configured one.
    cron_secret: str = ""

    # Receipt OCR (routers/receipts.py) - three independent providers, each
    # skipped rather than erroring when its own keys are blank, so this app
    # runs fine with zero, one, two or three of these configured.
    ocrspace_api_key: str = ""
    azure_vision_key: str = ""
    azure_vision_endpoint: str = ""
    google_vision_api_key: str = ""
    # Structured extraction of a scanned receipt's fields (GPT-OSS-120B via
    # Groq) - see llm_receipt_parser.py. Falls back to the regex extractor
    # in receipt_parser.py when this is blank. statement_extractor.py (the
    # credit card feature) reuses this same key and model.
    groq_api_key: str = ""
    # A second Groq key and an OpenRouter key (same GPT-OSS-120B model),
    # tried in order after the first when a request 429s - statement_extractor.py
    # scans several emails back-to-back and one free-tier Groq key's TPM
    # limit (8000) is easy to blow through in a single scan.
    groq_api_key_2: str = ""
    openrouter_api_key: str = ""

    # Gmail OAuth (routers/gmail_auth.py) - a Google Cloud OAuth client,
    # read-only Gmail scope, used to find and download credit card
    # statement emails. Blank means the "Connect Gmail" flow 400s rather
    # than starting with a client id Google will reject.
    google_client_id: str = ""
    google_client_secret: str = ""
    # This server's own public URL - needed because the OAuth redirect has
    # to point back at the backend's /gmail/callback, not the frontend, and
    # nothing else in this app has previously needed to know its own address.
    api_base_url: str = "https://money-splitter-api.onrender.com"

    # Web push (push.py / routers/push.py) - a VAPID keypair identifies this
    # server to every browser push service. Both blank means push is simply
    # unavailable; the app degrades the same way it does with any other
    # optional integration here rather than erroring.
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    # The contact address VAPID requires in every push's claims - not shown
    # to users, just what a push service could use to reach the sender if
    # something's wrong (e.g. a push service throttling this key).
    vapid_claim_email: str = "admin@example.com"

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
    #
    # The advisory lock doesn't stop a migration colliding with the OLD
    # instance's live queries, though, and that is what deadlocked a deploy:
    # every statement below used to run in one transaction, so the
    # exclusive lock an ALTER took on `expenses` was still held while the
    # next one waited on `groups` - which an old-instance request held while
    # it waited on `expenses`. Hence _run_migrations: it only issues DDL for
    # what is actually missing (ADD COLUMN IF NOT EXISTS takes the exclusive
    # lock even when the column is already there), one short transaction per
    # change, with a lock timeout and retries.
    with get_engine().connect() as conn:
        conn.execute(text("SELECT pg_advisory_lock(:id)"), {"id": MIGRATION_LOCK_ID})
        conn.commit()
        try:
            _run_migrations(conn, text)
        finally:
            # A failed statement leaves the transaction aborted, and the
            # unlock would fail on top of it and hide the real error.
            conn.rollback()
            conn.execute(text("SELECT pg_advisory_unlock(:id)"), {"id": MIGRATION_LOCK_ID})
            conn.commit()


# Every column this app has ever added after create_all(), which only builds
# tables it has never seen and never touches an existing one's columns.
# (table, column, type/definition)
_ADDED_COLUMNS = [
    ("expenses", "split_json", "TEXT"),
    ("expenses", "payment_mode", "VARCHAR(50)"),
    ("groups", "category", "VARCHAR(50)"),
    ("expenses", "settled_by", "TEXT"),
    ("users", "recovery_question", "VARCHAR(200)"),
    ("users", "recovery_answer_hash", "VARCHAR(128)"),
    ("users", "recovery_salt", "VARCHAR(64)"),
    ("users", "reset_fail_count", "INTEGER DEFAULT 0"),
    ("users", "reset_locked_until", "TIMESTAMPTZ"),
    ("users", "otc_hash", "VARCHAR(128)"),
    ("users", "otc_salt", "VARCHAR(64)"),
    ("users", "otc_expires_at", "TIMESTAMPTZ"),
    ("users", "email", "VARCHAR(200)"),
    ("users", "login_code_hash", "VARCHAR(128)"),
    ("users", "login_code_salt", "VARCHAR(64)"),
    ("users", "login_code_expires_at", "TIMESTAMPTZ"),
    # Strength on a hand-entered price.
    ("price_overrides", "abv", "DOUBLE PRECISION"),
    # Community reviews' aggregate, added to Product after it already existed.
    ("products", "community_rating", "DOUBLE PRECISION"),
    ("products", "community_review_count", "INTEGER NOT NULL DEFAULT 0"),
    ("users", "birthday", "VARCHAR(5)"),
    ("users", "last_birthday_wish_sent", "VARCHAR(10)"),
    ("users", "birth_year", "INTEGER"),
    ("groups", "last_memory_sent", "VARCHAR(10)"),
    ("users", "last_debt_reminder_sent", "VARCHAR(10)"),
    ("expenses", "txn_time", "VARCHAR(5)"),
    ("expenses", "time_bucket", "VARCHAR(20)"),
    ("expenses", "txn_ref", "VARCHAR(100)"),
    ("loans", "emi_plan", "TEXT"),
    ("loans", "interest_day", "INTEGER"),
    ("users", "excluded_payees", "TEXT"),
    ("users", "daily_summary", "BOOLEAN NOT NULL DEFAULT FALSE"),
    ("users", "last_daily_summary_sent", "VARCHAR(10)"),
    ("expenses", "subcategory", "VARCHAR(100)"),
]

# (index name, statement)
_ADDED_INDEXES = [
    # Case-insensitive and NULL-safe: a plain UNIQUE constraint on email
    # would reject a second account with no email at all, since two NULLs
    # would collide under most people's mental model of "unique" even
    # though SQL itself treats them as distinct. A partial index only
    # constrains the rows that actually have one set.
    ("ux_users_email", "CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email "
                       "ON users (lower(email)) WHERE email IS NOT NULL"),
    ("ix_expenses_txn_ref", "CREATE INDEX IF NOT EXISTS ix_expenses_txn_ref ON expenses (txn_ref)"),
]


def _ddl(conn, text, sql: str, attempts: int = 5) -> None:
    """One DDL statement in its own short transaction. lock_timeout makes a
    statement stuck behind live traffic give up and retry instead of
    queueing - and, while queued, blocking every request behind it."""
    import time
    from sqlalchemy.exc import OperationalError

    for i in range(attempts):
        try:
            conn.execute(text("SET LOCAL lock_timeout = '5s'"))
            conn.execute(text(sql))
            conn.commit()
            return
        except OperationalError as e:  # lock timeout or deadlock - both transient
            conn.rollback()
            if i == attempts - 1:
                raise
            print(f"[migrate] retrying after {type(e.orig).__name__}: {sql}")
            time.sleep(2 * (i + 1))


def _run_migrations(conn, text) -> None:
    """Bring existing tables up to the models. Called with the migration
    lock already held - see create_tables. A database that is already up to
    date gets only catalog reads: no DDL, so no table locks at all."""
    have = {
        (r[0], r[1]) for r in conn.execute(text(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_schema = current_schema()"
        ))
    }
    tables = {t for t, _ in have}
    indexes = {r[0] for r in conn.execute(text(
        "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()"
    ))}
    conn.commit()

    for table, column, ddl in _ADDED_COLUMNS:
        if table in tables and (table, column) not in have:
            _ddl(conn, text, f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {ddl}")
    for name, sql in _ADDED_INDEXES:
        if name not in indexes:
            _ddl(conn, text, sql)

    # The knowledge base's vector column. pgvector has no SQLAlchemy type
    # here, so the column is added by hand after create_all() has built
    # the rest of the table. Wrapped because a database without the
    # extension should still start - the app degrades to no retrieval
    # rather than refusing to boot.
    if "knowledge_items" in tables and ("knowledge_items", "embedding") not in have:
        try:
            _ddl(conn, text, "CREATE EXTENSION IF NOT EXISTS vector")
            _ddl(conn, text, "ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS embedding vector(2048)")
        except Exception as e:  # pragma: no cover - depends on the server
            conn.rollback()
            print(f"[warn] pgvector unavailable, retrieval disabled: {e}")

    # `payments`, `activities` and `activity_seen` are created by create_all
    # above; nothing to backfill since they start empty.

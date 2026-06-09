from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from database import create_tables, get_settings
from routers import groups, expenses, settlements, stats, users


def _settle_existing_historical():
    """One-time migration: settle all expenses in already-historical groups."""
    from database import get_session_factory
    from models import Group
    from routers.groups import _settle_all_expenses
    db = get_session_factory()()
    try:
        for group in db.query(Group).filter(Group.is_historical == True).all():
            _settle_all_expenses(group, db)
        db.commit()
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_tables()
    try:
        _settle_existing_historical()
    except Exception as e:
        print(f"[warn] startup settle migration failed (non-fatal): {e}")
    yield


app = FastAPI(title="Money Splitter API", version="1.0.0", lifespan=lifespan)

settings = get_settings()
origins = [o.strip() for o in settings.allowed_origins.split(",")]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(users.router)
app.include_router(groups.router)
app.include_router(expenses.router)
app.include_router(settlements.router)
app.include_router(stats.router)


@app.get("/health")
def health():
    return {"status": "ok"}

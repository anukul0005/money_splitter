from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from database import create_tables, get_settings
from routers import (
    groups, expenses, settlements, stats, users, payments, activity, recommend,
    food, knowledge_api,
)


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


@app.middleware("http")
async def no_caching(request, call_next):
    """Never let one person's data be served to the next one.

    Identity used to travel in the URL (`?name=Utkarsh`), which meant every
    user fetched different URLs and a cache could not confuse them. Once
    identity moved into the Authorization header — which is the right place
    for it — everyone started requesting the *same* URLs, and a browser
    holding a cached /stats/overview/all from the previous account would
    happily hand it to the next one. That is why people saw someone else's
    groups and numbers until the page was refreshed.

    Every response here is personal and cheap to recompute, so none of it
    should ever be stored. `Vary` is belt and braces for any proxy in front
    of us that caches despite being told not to.
    """
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Vary"] = "Authorization"
    return response

app.include_router(users.router)
app.include_router(groups.router)
app.include_router(expenses.router)
app.include_router(settlements.router)
app.include_router(stats.router)
app.include_router(payments.router)
app.include_router(activity.router)
app.include_router(recommend.router)
app.include_router(food.router)
app.include_router(knowledge_api.router)


@app.get("/health")
def health():
    return {"status": "ok"}

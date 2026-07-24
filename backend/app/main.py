"""AI Study Tutor — FastAPI application entrypoint.

Run locally with:
    uvicorn app.main:app --reload --port 8000

The app wires CORS, a health check, and all feature routers. Each router
declares its own prefix (``/auth``, ``/modules``, …), so they are mounted here
without an extra prefix.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers import (
    auth,
    export,
    favourites,
    flashcards,
    groups,
    lectures,
    modules,
    practice_exam,
    practice_mode,
    qa,
    quizzes,
    sources,
    stats,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Startup/shutdown hook. Place DB warm-up or client init here."""
    # --- startup ---
    # Lecture generation runs on a worker thread but publishes SSE deltas into
    # the event loop, so the broadcaster needs a handle on the running loop.
    import asyncio

    from app.services import broadcast

    broadcast.bind_loop(asyncio.get_running_loop())
    yield
    # --- shutdown ---


APP_VERSION = "1.0.0"

app = FastAPI(
    title=f"{settings.app_name} API",
    version=APP_VERSION,
    description="Interactive AI lectures and study tools — Notebook LM style.",
    debug=settings.debug,
    lifespan=lifespan,
)

# --- Middleware -----------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=settings.cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Root & health --------------------------------------------------------
@app.get("/", tags=["meta"])
async def root() -> dict[str, str]:
    return {
        "status": f"{settings.app_name} API is running",
        "version": APP_VERSION,
        "docs": "/docs",
    }


@app.get("/health", tags=["meta"])
async def health() -> dict[str, str]:
    return {"status": "ok", "environment": settings.environment}


# --- Routers --------------------------------------------------------------
# Prefixes live on the routers themselves; passing one here would double it
# (e.g. ``/auth/auth/login``).
app.include_router(auth.router)
app.include_router(modules.router)
app.include_router(sources.router)
app.include_router(lectures.router)
app.include_router(qa.router)
app.include_router(qa.sessions_router)
app.include_router(stats.router)
app.include_router(flashcards.router)
app.include_router(quizzes.router)
app.include_router(practice_exam.router)
app.include_router(practice_mode.router)
app.include_router(groups.router)
app.include_router(favourites.router)
app.include_router(export.router)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
    )

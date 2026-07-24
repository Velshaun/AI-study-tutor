"""Favourites — spec Prompt 7.3.

    GET /favourites   the caller's starred lectures, flashcards and quizzes

One endpoint for the whole Favourites page: three separate per-domain queries
from the client would be a fan-out, and the page shows all three sections at
once regardless of domain.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.database import get_supabase
from app.routers.auth import AuthUser, get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/favourites", tags=["favourites"])


# --- Schemas ----------------------------------------------------------------
class FavouriteLecture(BaseModel):
    id: str
    domain_id: str | None = None
    module_id: str | None = None
    title: str = "Lecture"
    tutor_voice: str | None = None
    duration_secs: int | None = None
    last_position_secs: int = 0


class FavouriteFlashcard(BaseModel):
    id: str
    domain_id: str | None = None
    front: str
    back: str
    difficulty: str | None = None


class FavouriteQuiz(BaseModel):
    id: str
    domain_id: str | None = None
    title: str = "Quiz"
    difficulty: str | None = None
    question_count: int = 0
    score: float | None = None


class FavouritesResponse(BaseModel):
    lectures: list[FavouriteLecture] = Field(default_factory=list)
    flashcards: list[FavouriteFlashcard] = Field(default_factory=list)
    quizzes: list[FavouriteQuiz] = Field(default_factory=list)


# --- Route ------------------------------------------------------------------
@router.get("", response_model=FavouritesResponse)
async def list_favourites(
    user: AuthUser = Depends(get_current_user),
) -> FavouritesResponse:
    """All of the caller's favourited items, grouped by type."""
    try:
        client = get_supabase()
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc

    def favourites(table: str, columns: str) -> list[dict[str, Any]]:
        return (
            client.table(table).select(columns)
            .eq("user_id", user.id).eq("is_favourite", True)
            .order("created_at", desc=True).execute()
        ).data or []

    lectures = favourites(
        "lectures",
        "id, domain_id, module_id, title, tutor_voice, duration_secs, "
        "last_position_secs",
    )
    flashcards = favourites("flashcards", "id, domain_id, front, back, difficulty")
    quizzes = favourites(
        "quizzes", "id, domain_id, title, difficulty, question_count, score"
    )

    return FavouritesResponse(
        lectures=[FavouriteLecture(**_lecture(row)) for row in lectures],
        flashcards=[FavouriteFlashcard(**_flashcard(row)) for row in flashcards],
        quizzes=[FavouriteQuiz(**_quiz(row)) for row in quizzes],
    )


def _lecture(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "domain_id": row.get("domain_id"),
        "module_id": row.get("module_id"),
        "title": row.get("title") or "Lecture",
        "tutor_voice": row.get("tutor_voice"),
        "duration_secs": row.get("duration_secs"),
        "last_position_secs": row.get("last_position_secs") or 0,
    }


def _flashcard(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "domain_id": row.get("domain_id"),
        "front": row.get("front") or "",
        "back": row.get("back") or "",
        "difficulty": row.get("difficulty"),
    }


def _quiz(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "domain_id": row.get("domain_id"),
        "title": row.get("title") or "Quiz",
        "difficulty": row.get("difficulty"),
        "question_count": row.get("question_count") or 0,
        "score": row.get("score"),
    }

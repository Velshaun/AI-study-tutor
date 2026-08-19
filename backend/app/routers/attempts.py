"""Saved progress through a quiz, exam, practice set or deck.

    GET    /attempts/{item_type}/{item_id}   what was saved, if anything
    PUT    /attempts/{item_type}/{item_id}   save where the learner has got to
    DELETE /attempts/{item_type}/{item_id}   forget it (finished, or restarted)
    GET    /attempts/open                    everything unfinished, newest first

Lectures resume through ``lectures.last_position_secs``; everything else had no
memory at all, so a learner forty questions into a ninety-question exam who
tapped away came back to question one. One row per learner per item — see the
20260820000000 migration for why it's polymorphic rather than a table per type.

Writes are last-one-wins by design: a run happens in one place at a time, and a
learner who resumes on their phone should overwrite what their laptop last saved
rather than be asked to reconcile it.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.database import get_supabase
from app.routers.auth import AuthUser, get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/attempts", tags=["attempts"])

ItemType = Literal["quiz", "exam", "practice", "flashcards"]

# A runaway client shouldn't be able to store an essay in `answers`.
MAX_ANSWERS = 500


# --- Schemas ----------------------------------------------------------------
class AttemptSave(BaseModel):
    """Where the learner has got to."""

    position: int = Field(0, ge=0, le=MAX_ANSWERS)
    # One entry per question answered so far; null for anything skipped.
    answers: list[Any] = Field(default_factory=list, max_length=MAX_ANSWERS)
    # Whatever else the run needs to come back intact — a timed exam's
    # deadline, how many cards were marked known.
    state: dict[str, Any] = Field(default_factory=dict)
    # True once the run is over, so it stops being offered as resumable.
    completed: bool = False


class Attempt(AttemptSave):
    item_type: str
    item_id: str
    updated_at: datetime | None = None


class OpenAttempt(BaseModel):
    item_type: str
    item_id: str
    position: int = 0
    updated_at: datetime | None = None


# --- Helpers ----------------------------------------------------------------
def _client():
    try:
        return get_supabase()
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc


def _row_to_attempt(row: dict[str, Any]) -> Attempt:
    return Attempt(
        item_type=row["item_type"],
        item_id=row["item_id"],
        position=row.get("position") or 0,
        answers=row.get("answers") or [],
        state=row.get("state") or {},
        completed=bool(row.get("completed_at")),
        updated_at=row.get("updated_at"),
    )


# --- Routes -----------------------------------------------------------------
@router.get("/open", response_model=list[OpenAttempt])
async def open_attempts(
    limit: int = Query(10, ge=1, le=50),
    user: AuthUser = Depends(get_current_user),
) -> list[OpenAttempt]:
    """Everything the learner started and hasn't finished, newest first."""
    rows = (
        _client().table("study_attempts")
        .select("item_type, item_id, position, updated_at")
        .eq("user_id", user.id).is_("completed_at", "null")
        .order("updated_at", desc=True).limit(limit).execute()
    ).data or []
    return [OpenAttempt(**r) for r in rows]


@router.get("/{item_type}/{item_id}", response_model=Attempt | None)
async def get_attempt(
    item_type: ItemType,
    item_id: str,
    user: AuthUser = Depends(get_current_user),
) -> Attempt | None:
    """What was saved for this item, or null if the learner hasn't started it.

    Null rather than a 404: "nothing saved" is the ordinary case on a first
    visit, and a screen shouldn't have to treat it as an error.
    """
    rows = (
        _client().table("study_attempts").select("*")
        .eq("user_id", user.id).eq("item_type", item_type).eq("item_id", item_id)
        .limit(1).execute()
    ).data or []
    if not rows:
        return None
    attempt = _row_to_attempt(rows[0])
    # A finished run isn't progress to restore — it's history.
    return None if attempt.completed else attempt


@router.put("/{item_type}/{item_id}", response_model=Attempt)
async def save_attempt(
    item_type: ItemType,
    item_id: str,
    payload: AttemptSave,
    user: AuthUser = Depends(get_current_user),
) -> Attempt:
    """Save where the learner has got to, replacing whatever was there."""
    row = {
        "user_id": user.id,
        "item_type": item_type,
        "item_id": item_id,
        "position": payload.position,
        "answers": payload.answers,
        "state": payload.state,
        "completed_at": (
            datetime.now(timezone.utc).isoformat() if payload.completed else None
        ),
    }
    saved = (
        _client().table("study_attempts")
        .upsert(row, on_conflict="user_id,item_type,item_id").execute()
    ).data or [row]
    return _row_to_attempt(saved[0])


@router.delete("/{item_type}/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def clear_attempt(
    item_type: ItemType,
    item_id: str,
    user: AuthUser = Depends(get_current_user),
) -> None:
    """Forget the saved progress — the run finished, or started over."""
    _client().table("study_attempts").delete().eq("user_id", user.id).eq(
        "item_type", item_type
    ).eq("item_id", item_id).execute()

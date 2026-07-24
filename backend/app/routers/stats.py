"""Dashboard aggregates — spec §5.4.

    GET /stats/dashboard   the resume card plus the four KPI widgets

One endpoint rather than letting the dashboard assemble this itself: the KPIs
span four tables, and doing it client-side would mean a request per module to
count completed domains. That N+1 lands on the first screen after sign-in,
which is the worst possible place for it.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.database import get_supabase
from app.routers.auth import AuthUser, get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/stats", tags=["stats"])


# --- Schemas ----------------------------------------------------------------
class ResumeCard(BaseModel):
    """The most recently played lecture that isn't finished."""

    lecture_id: str
    domain_id: str | None = None
    module_id: str | None = None
    domain_title: str | None = None
    module_title: str | None = None
    position_secs: int = 0
    duration_secs: int | None = None
    progress_pct: float = 0.0
    tutor_voice: str | None = None
    last_played_at: datetime | None = None


class DashboardStats(BaseModel):
    total_modules: int = 0
    domains_completed: int = 0
    domains_total: int = 0
    # None when no quiz has been scored yet — the widget shows a dash rather
    # than a misleading 0%.
    quiz_average_score: float | None = None
    quizzes_taken: int = 0
    study_seconds_this_week: int = 0
    study_by_day: list[dict[str, Any]] = Field(default_factory=list)


class DashboardResponse(BaseModel):
    stats: DashboardStats
    resume: ResumeCard | None = None
    has_modules: bool = False


# --- Helpers ----------------------------------------------------------------
def _client():
    try:
        return get_supabase()
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc


def _count(table: str, user_id: str, **filters: Any) -> int:
    query = _client().table(table).select("id", count="exact").eq("user_id", user_id)
    for column, value in filters.items():
        query = query.eq(column, value)
    result = query.execute()
    return result.count or len(result.data or [])


# --- Routes -----------------------------------------------------------------
@router.get("/dashboard", response_model=DashboardResponse)
async def dashboard(
    user: AuthUser = Depends(get_current_user),
) -> DashboardResponse:
    """Everything the dashboard needs, in one round trip."""
    client = _client()

    # --- KPI 1: modules ---------------------------------------------------
    total_modules = _count("modules", user.id)

    # --- KPI 2: domains completed ----------------------------------------
    domains_total = _count("domains", user.id)
    domains_completed = _count("domains", user.id, status="completed")

    # --- KPI 3: quiz average ---------------------------------------------
    scored = (
        client.table("quizzes").select("score")
        .eq("user_id", user.id).not_.is_("score", "null").execute()
    ).data or []
    scores = [
        float(row["score"]) for row in scored
        if row.get("score") is not None
    ]
    quiz_average = round(sum(scores) / len(scores), 1) if scores else None

    # --- KPI 4: study time this week -------------------------------------
    # Rolling 7 days including today, not calendar-week, so the number never
    # collapses to near-zero every Monday morning.
    today = datetime.now(timezone.utc).date()
    week_start = today - timedelta(days=6)
    rows = (
        client.table("study_time").select("day, seconds")
        .eq("user_id", user.id)
        .gte("day", week_start.isoformat())
        .lte("day", today.isoformat())
        .order("day").execute()
    ).data or []

    by_day = {row["day"]: int(row.get("seconds") or 0) for row in rows}
    study_by_day = [
        {
            "day": (week_start + timedelta(days=offset)).isoformat(),
            "seconds": by_day.get((week_start + timedelta(days=offset)).isoformat(), 0),
        }
        for offset in range(7)
    ]
    study_seconds = sum(entry["seconds"] for entry in study_by_day)

    # --- Resume card ------------------------------------------------------
    resume = _resume_card(user.id)

    return DashboardResponse(
        stats=DashboardStats(
            total_modules=total_modules,
            domains_completed=domains_completed,
            domains_total=domains_total,
            quiz_average_score=quiz_average,
            quizzes_taken=len(scores),
            study_seconds_this_week=study_seconds,
            study_by_day=study_by_day,
        ),
        resume=resume,
        has_modules=total_modules > 0,
    )


def _resume_card(user_id: str) -> ResumeCard | None:
    """The lecture to offer resuming, or None.

    "Paused" means started but not finished. A lecture at position 0 has not
    been started, and one with `completed_at` set is done — offering either
    would make the card noise rather than a shortcut.
    """
    client = get_supabase()
    rows = (
        client.table("lectures").select("*")
        .eq("user_id", user_id)
        .is_("completed_at", "null")
        .gt("last_position_secs", 0)
        .order("last_played_at", desc=True)
        .limit(1).execute()
    ).data or []
    if not rows:
        return None

    lecture = rows[0]
    duration = lecture.get("duration_secs") or 0
    position = lecture.get("last_position_secs") or 0

    domain_title = None
    if lecture.get("domain_id"):
        found = (
            client.table("domains").select("title")
            .eq("id", lecture["domain_id"]).limit(1).execute()
        ).data or []
        domain_title = found[0].get("title") if found else None

    module_title = None
    if lecture.get("module_id"):
        found = (
            client.table("modules").select("title")
            .eq("id", lecture["module_id"]).limit(1).execute()
        ).data or []
        module_title = found[0].get("title") if found else None

    return ResumeCard(
        lecture_id=lecture["id"],
        domain_id=lecture.get("domain_id"),
        module_id=lecture.get("module_id"),
        domain_title=domain_title,
        module_title=module_title,
        position_secs=position,
        duration_secs=lecture.get("duration_secs"),
        progress_pct=round(min(100.0, position / duration * 100), 1) if duration else 0.0,
        tutor_voice=lecture.get("tutor_voice"),
        last_played_at=lecture.get("last_played_at"),
    )

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
from app.services import performance

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


class ModuleStats(BaseModel):
    """KPIs scoped to a single module (spec: KPIs live in the module view)."""

    domains_completed: int = 0
    domains_total: int = 0
    quiz_average_score: float | None = None
    quizzes_taken: int = 0
    lectures_generated: int = 0
    # Sum of saved lecture positions in this module — a per-module proxy for
    # time studied (study_time itself is only tracked per day, not per module).
    listened_seconds: int = 0


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


@router.get("/module/{module_id}", response_model=ModuleStats)
async def module_stats(
    module_id: str,
    user: AuthUser = Depends(get_current_user),
) -> ModuleStats:
    """KPIs for one module — domains done, quiz average, listening time."""
    client = _client()

    # Ownership: the module must be the caller's.
    owned = (
        client.table("modules").select("id")
        .eq("id", module_id).eq("user_id", user.id).limit(1).execute()
    ).data or []
    if not owned:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Module not found.")

    # Domains in this module.
    domain_rows = (
        client.table("domains").select("id, status")
        .eq("module_id", module_id).eq("user_id", user.id).execute()
    ).data or []
    domain_ids = [d["id"] for d in domain_rows]
    domains_completed = sum(1 for d in domain_rows if d.get("status") == "completed")

    # Quiz average across this module's domains.
    scores: list[float] = []
    if domain_ids:
        scored = (
            client.table("quizzes").select("score")
            .in_("domain_id", domain_ids).not_.is_("score", "null").execute()
        ).data or []
        scores = [float(r["score"]) for r in scored if r.get("score") is not None]

    # Lectures + listening time for this module.
    lectures = (
        client.table("lectures").select("last_position_secs")
        .eq("module_id", module_id).eq("user_id", user.id).execute()
    ).data or []
    listened = sum(int(l.get("last_position_secs") or 0) for l in lectures)

    return ModuleStats(
        domains_completed=domains_completed,
        domains_total=len(domain_rows),
        quiz_average_score=round(sum(scores) / len(scores), 1) if scores else None,
        quizzes_taken=len(scores),
        lectures_generated=len(lectures),
        listened_seconds=listened,
    )


# --- Domain performance -----------------------------------------------------
class DomainPerformance(BaseModel):
    """One domain's standing, as shown and as planned with.

    `display` is the encouraging number: it rises quickly, falls slowly, and
    never sits far under the best the learner has demonstrated. `session` is
    what they actually scored last time, kept separate so today can be a bad day
    without the week having been one.

    `internal` is not for display. It reacts fully to a regression and is what
    decides where the next questions come from — see `services/performance`.
    """

    domain_id: str
    title: str
    weight_pct: float = 0.0
    display: float | None = None
    session: float | None = None
    peak: float | None = None
    internal: float | None = None
    attempts: int = 0
    questions: int = 0
    # 'strong' | 'developing' | 'weak' | 'untouched'
    status: str = "untouched"
    # 'up' | 'down' | 'steady' | 'none'
    trend: str = "none"
    regressed: bool = False
    # One encouraging, true sentence about the most recent session.
    note: str = ""


class PerformanceResponse(BaseModel):
    module_id: str
    available: bool = True
    # Weighted by each domain's share of the paper, from `display` — so the
    # headline moves the way the parts do.
    overall: float | None = None
    domains: list[DomainPerformance] = Field(default_factory=list)
    # Weakest first: the answer to "what next", in order.
    focus: list[str] = Field(default_factory=list)
    attempts: int = 0
    has_baseline: bool = False


@router.get("/baseline/{module_id}")
async def baseline_comparison(
    module_id: str,
    user: AuthUser = Depends(get_current_user),
) -> dict[str, Any] | None:
    """Where you started against where you are now.

    Null when there is no baseline, which is most modules — the pre-assessment
    is optional, and a module without one is not a module with a problem.
    """
    return performance.comparison(module_id, user.id)


@router.get("/performance/{module_id}", response_model=PerformanceResponse)
async def module_performance(
    module_id: str,
    user: AuthUser = Depends(get_current_user),
) -> PerformanceResponse:
    """How strong each domain is, on the evidence of everything graded."""
    owned = (
        _client().table("modules").select("id")
        .eq("id", module_id).eq("user_id", user.id).limit(1).execute()
    ).data
    if not owned:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Module not found.")

    scored = performance.for_module(module_id, user.id)
    domains = [DomainPerformance(**d) for d in scored]

    graded = [d for d in domains if d.display is not None]
    weight = sum(d.weight_pct for d in graded)
    overall = (
        round(sum(d.display * d.weight_pct for d in graded) / weight, 1)
        if graded and weight > 0
        else round(sum(d.display for d in graded) / len(graded), 1) if graded
        else None
    )

    # Weakest first, and only where there is evidence — an untouched domain
    # isn't a weakness, it's a blank.
    focus = [
        d.title for d in sorted(
            graded, key=lambda d: (d.internal or 0) - (d.weight_pct or 0),
        ) if d.status != "strong"
    ][:5]

    return PerformanceResponse(
        module_id=module_id,
        available=performance.available(),
        overall=overall,
        domains=domains,
        focus=focus,
        attempts=performance.attempt_count(module_id, user.id),
        has_baseline=performance.baseline(module_id, user.id) is not None,
    )

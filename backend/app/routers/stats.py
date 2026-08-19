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


class DomainReadiness(BaseModel):
    """How ready one domain is, and what that judgement is made of."""

    domain_id: str
    title: str
    weight_pct: float = 0.0
    # 0-100, or None when nothing has been attempted here yet — a dash is
    # honest where a zero would read as "you scored nothing".
    score: float | None = None
    quiz_average: float | None = None
    quizzes_taken: int = 0
    lecture_progress_pct: float = 0.0
    practice_answered: int = 0
    practice_total: int = 0
    flagged_for_review: int = 0
    # 'strong' | 'developing' | 'weak' | 'untouched'
    status: str = "untouched"


class ReadinessResponse(BaseModel):
    """Exam readiness for a module: the whole, and the parts."""

    # Weighted by domain share of the exam, so a shaky 32% domain hurts more
    # than a shaky 4% one. None until something has been attempted.
    overall: float | None = None
    # Share of the exam's weight sitting in domains never touched.
    untouched_weight_pct: float = 0.0
    domains: list[DomainReadiness] = Field(default_factory=list)
    # Weakest first, so the answer to "what do I do next" is at the top.
    focus: list[str] = Field(default_factory=list)


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


def _readiness_status(score: float | None) -> str:
    if score is None:
        return "untouched"
    if score >= 75:
        return "strong"
    if score >= 50:
        return "developing"
    return "weak"


@router.get("/readiness/{module_id}", response_model=ReadinessResponse)
async def readiness(
    module_id: str,
    user: AuthUser = Depends(get_current_user),
) -> ReadinessResponse:
    """How ready this learner is for the exam, domain by domain.

    Built from what the app already records — quiz scores, lecture progress,
    practice answered and what's still flagged for review — rather than a new
    kind of test. A domain's score leans on quiz results where they exist,
    because a score is evidence in a way that "listened to the lecture" isn't.
    """
    client = _client()
    owned = (
        client.table("modules").select("id")
        .eq("id", module_id).eq("user_id", user.id).limit(1).execute()
    ).data
    if not owned:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Module not found.")

    domains = (
        client.table("domains").select("id, title, weight_pct, order_index")
        .eq("module_id", module_id).eq("user_id", user.id)
        .order("order_index").execute()
    ).data or []
    if not domains:
        return ReadinessResponse()

    domain_ids = [d["id"] for d in domains]

    quiz_rows = (
        client.table("quizzes").select("domain_id, score")
        .in_("domain_id", domain_ids).eq("user_id", user.id).execute()
    ).data or []
    lecture_rows = (
        client.table("lectures")
        .select("domain_id, last_position_secs, duration_secs, completed_at")
        .in_("domain_id", domain_ids).eq("user_id", user.id).execute()
    ).data or []
    practice_rows = (
        client.table("practice_questions").select("id, domain_id")
        .in_("domain_id", domain_ids).is_("exam_id", "null").execute()
    ).data or []
    attempt_rows = (
        client.table("study_attempts").select("item_id, position")
        .eq("user_id", user.id).eq("item_type", "practice").execute()
    ).data or []
    flag_rows = (
        client.table("review_later").select("item_id")
        .eq("user_id", user.id).eq("item_type", "practice_question").execute()
    ).data or []

    flagged_ids = {r["item_id"] for r in flag_rows}
    answered_of = {r["item_id"]: r.get("position") or 0 for r in attempt_rows}

    practice_total: dict[str, int] = {}
    flagged_count: dict[str, int] = {}
    for row in practice_rows:
        dom = row.get("domain_id")
        if not dom:
            continue
        practice_total[dom] = practice_total.get(dom, 0) + 1
        if row["id"] in flagged_ids:
            flagged_count[dom] = flagged_count.get(dom, 0) + 1

    scores: dict[str, list[float]] = {}
    for row in quiz_rows:
        if row.get("score") is not None and row.get("domain_id"):
            scores.setdefault(row["domain_id"], []).append(float(row["score"]))

    listened: dict[str, float] = {}
    for row in lecture_rows:
        dom = row.get("domain_id")
        if not dom:
            continue
        if row.get("completed_at"):
            listened[dom] = 100.0
            continue
        duration = row.get("duration_secs") or 0
        position = row.get("last_position_secs") or 0
        if duration:
            listened[dom] = max(
                listened.get(dom, 0.0), min(100.0, position / duration * 100),
            )

    out: list[DomainReadiness] = []
    for domain in domains:
        did = domain["id"]
        quiz_scores = scores.get(did, [])
        quiz_average = round(sum(quiz_scores) / len(quiz_scores), 1) if quiz_scores else None
        total = practice_total.get(did, 0)
        answered = min(answered_of.get(did, 0), total)
        progress = round(listened.get(did, 0.0), 1)

        # A score is evidence; listening and answering are effort. Effort counts
        # for something on its own, but never as much as a result.
        parts: list[tuple[float, float]] = []
        if quiz_average is not None:
            parts.append((quiz_average, 0.6))
        # Only count practice the learner has actually done: a set generated
        # and never opened is untouched, not failed.
        if answered:
            parts.append((answered / total * 100, 0.25))
        if progress:
            parts.append((progress, 0.15))

        score = None
        if parts:
            weight = sum(w for _, w in parts)
            score = round(sum(v * w for v, w in parts) / weight, 1)
            # Questions the learner themselves flagged as shaky pull it down.
            flagged = flagged_count.get(did, 0)
            if flagged and total:
                score = round(max(0.0, score - min(20.0, flagged / total * 100)), 1)

        out.append(DomainReadiness(
            domain_id=did,
            title=domain.get("title") or "",
            weight_pct=float(domain.get("weight_pct") or 0),
            score=score,
            quiz_average=quiz_average,
            quizzes_taken=len(quiz_scores),
            lecture_progress_pct=progress,
            practice_answered=answered,
            practice_total=total,
            flagged_for_review=flagged_count.get(did, 0),
            status=_readiness_status(score),
        ))

    scored = [d for d in out if d.score is not None]
    weight = sum(d.weight_pct for d in scored)
    overall = (
        round(sum(d.score * d.weight_pct for d in scored) / weight, 1)
        if weight else (
            round(sum(d.score for d in scored) / len(scored), 1) if scored else None
        )
    )

    # What to do next: the weakest domains, heaviest first — an untouched 32%
    # of the paper is the most valuable hour a learner has.
    focus = [
        d.title for d in sorted(
            (d for d in out if d.status in ("untouched", "weak")),
            key=lambda d: (-d.weight_pct, d.score if d.score is not None else -1),
        )
    ][:3]

    return ReadinessResponse(
        overall=overall,
        untouched_weight_pct=round(
            sum(d.weight_pct for d in out if d.status == "untouched"), 1,
        ),
        domains=out,
        focus=focus,
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

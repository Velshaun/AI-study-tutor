"""Study modules.

A "module" is a top-level container (a subject or course) that holds uploaded
sources plus the AI-generated progression map, domains, lectures, flashcards and
quizzes. Backed by Supabase.

The backend uses the service-role key, which bypasses RLS, so every query is
scoped to ``user_id`` explicitly — that filter is the access check.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import logging

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from pydantic import BaseModel, Field

from app.config import settings
from app.database import get_supabase
from app.routers.auth import AuthUser, get_current_user
from app.services import coverage, dead_links, exam_catalog, exam_profile, tutor
from app.services.ai_service import GenerationError, discover_resources
from app.services.link_check import validate_resources

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/modules", tags=["modules"])

# A syllabus is a short document; anything longer is almost certainly the course
# material itself, which belongs in /sources instead.
MAX_COURSE_CONTEXT_CHARS = 50_000


# --- Schemas --------------------------------------------------------------
class ModuleCreate(BaseModel):
    # Optional: the pipeline auto-names the module from the detected subject, so
    # a learner never types a name. A supplied title is still honoured.
    title: str | None = Field(default=None, max_length=200)
    description: str = ""
    color: str = "#6C63FF"


class ModuleUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    color: str | None = None
    # The real exam's shape, which every practice generator sizes itself from
    # (see app.services.exam_profile). Null clears it, falling back to the
    # largest imported past paper.
    exam_question_count: int | None = Field(default=None, ge=1, le=200)
    exam_duration_minutes: int | None = Field(default=None, ge=1, le=600)


class Domain(BaseModel):
    id: str
    title: str
    description: str = ""
    order_index: int | None = None
    weight_pct: float | None = None
    status: str = "locked"
    completed_at: datetime | None = None
    # Lecture progress — populated on the module-detail route (not the dashboard
    # list) so the screen can show a per-domain progress bar and offer "Resume"
    # when playback is part-way through.
    lecture_id: str | None = None
    lecture_status: str | None = None
    last_position_secs: int = 0
    lecture_duration_secs: int | None = None
    # How many of this domain's practice questions are flagged for review — the
    # count badge on the Review Later entry point (spec 6.4 / Prompt 11).
    review_later_count: int = 0
    # An imported flashcard deck (a Quizlet export, say) rather than a domain of
    # the exam blueprint: no weight, no lecture, but its cards are real study
    # material, so it can be quizzed and practised like anything else.
    is_imported_deck: bool = False


class CourseContext(BaseModel):
    """The learner's syllabus, used to validate and prioritise domain weights."""

    module_id: str
    course_context: str | None = None
    course_context_source: str | None = None
    course_context_filename: str | None = None
    char_count: int = 0


class RecommendedExam(BaseModel):
    """The published sitting for the certification this module is about.

    This is the *baseline* — what the certification's vendor publishes — not
    necessarily what this module now uses. Once a learner sets their own length
    it takes over as the module's recommendation; see `exam_profile_source`.

    `matched` is false when the module isn't a recognised certification (a
    college course, say), in which case these are the app's generic defaults.
    `published` is false where the vendor states a duration but not a question
    count, so the UI can say the count is a well-reported estimate.
    """

    label: str = exam_catalog.GENERIC_LABEL
    question_count: int = exam_catalog.GENERIC_QUESTION_COUNT
    duration_minutes: int = exam_catalog.GENERIC_DURATION_MINUTES
    matched: bool = False
    published: bool = False


class Module(BaseModel):
    id: str
    title: str
    description: str = ""
    color: str = "#6C63FF"
    status: str = "processing"
    status_detail: str | None = None
    error_message: str | None = None
    source_summary: str | None = None
    course_context: str | None = None
    course_context_source: str | None = None
    course_context_filename: str | None = None
    detected_subject: str | None = None
    subject_confidence: float | None = None
    progression_map: dict[str, Any] | None = None
    weighting_sources: list[dict[str, Any]] = Field(default_factory=list)
    # The exam being revised for. `exam_question_count` is what the learner
    # stated; `practice_question_count` is what practice sets will actually use
    # (falls back to the largest imported past paper, then to a default).
    exam_question_count: int | None = None
    exam_duration_minutes: int | None = None
    practice_question_count: int = exam_profile.DEFAULT_QUESTION_COUNT
    practice_duration_minutes: int = exam_catalog.GENERIC_DURATION_MINUTES
    # Where practice_* came from, so the setup screen can say whose numbers
    # these are: 'custom' (this learner set them, and they now carry forward to
    # every exam in this module), 'certification' (the published spec) or
    # 'generic' (no certification matched).
    exam_profile_source: str = "generic"
    # The published baseline, so a learner who has customised can still see —
    # and go back to — what the real paper does.
    recommended_exam: RecommendedExam = Field(default_factory=RecommendedExam)
    created_at: datetime
    updated_at: datetime | None = None
    source_count: int = 0
    domain_count: int = 0
    # An in-progress lecture in this module, if any — powers the "Resume" button
    # on the dashboard module card. `resume_last_played_at` is when it was last
    # played, so the dashboard can flag the most recently accessed module.
    resume_lecture_id: str | None = None
    resume_last_played_at: datetime | None = None
    # When the learner last opened this module — the primary "last visited"
    # signal for the dashboard.
    last_accessed_at: datetime | None = None
    # Lightweight domain list for the dashboard's progress pills. The detail
    # view carries the same field with full descriptions/weights.
    domains: list[Domain] = Field(default_factory=list)


class ModuleDetail(Module):
    """Same shape as Module; the domains are populated with full detail."""


# --- Helpers ----------------------------------------------------------------
def _client():
    try:
        return get_supabase()
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc


def _counts(module_id: str) -> tuple[int, int]:
    """(source_count, domain_count) for a module."""
    client = _client()
    sources = (
        client.table("user_files")
        .select("id", count="exact")
        .eq("module_id", module_id)
        .execute()
    )
    domains = (
        client.table("domains")
        .select("id", count="exact")
        .eq("module_id", module_id)
        .execute()
    )
    return (
        sources.count or len(sources.data or []),
        domains.count or len(domains.data or []),
    )


def _to_domain(d: dict[str, Any]) -> Domain:
    # `_lecture` is attached only by the detail route; the dashboard list leaves
    # it absent, so those fields fall back to their empty defaults.
    lec = d.get("_lecture") or {}
    return Domain(
        id=d["id"],
        title=d.get("title") or "",
        description=d.get("description") or "",
        order_index=d.get("order_index"),
        weight_pct=d.get("weight_pct"),
        status=d.get("status") or "locked",
        completed_at=d.get("completed_at"),
        lecture_id=lec.get("id"),
        lecture_status=lec.get("status"),
        last_position_secs=lec.get("last_position_secs") or 0,
        lecture_duration_secs=lec.get("duration_secs"),
        review_later_count=d.get("_review_count") or 0,
        is_imported_deck=bool(d.get("_is_deck")),
    )


def _to_module(row: dict[str, Any], sources: int = 0, domains: int = 0,
               domain_rows: list[dict[str, Any]] | None = None,
               practice_count: int | None = None) -> Module:
    # The dashboard lists many modules at once, so it passes no practice_count
    # and takes the stated length (or the default) rather than paying a lookup
    # per module; the detail route resolves the imported-paper fallback too.
    resolved = practice_count or row.get("exam_question_count") \
        or exam_profile.DEFAULT_QUESTION_COUNT
    baseline = exam_catalog.recommend(row.get("title"), row.get("detected_subject"))
    resolved_minutes = exam_profile.exam_duration_minutes(resolved, row)

    # A length the learner set themselves becomes this module's recommendation
    # from here on. Matching the published spec doesn't count as customising —
    # someone who typed 40 for a 40-question paper hasn't overridden anything,
    # and shouldn't be told they have.
    customised = (
        resolved != baseline["question_count"]
        or resolved_minutes != baseline["duration_minutes"]
    )
    if customised:
        source = "custom"
    elif baseline["matched"]:
        source = "certification"
    else:
        source = "generic"

    return Module(
        id=row["id"],
        title=row.get("title") or "",
        description=row.get("description") or "",
        color=row.get("color") or "#6C63FF",
        status=row.get("status") or "processing",
        status_detail=row.get("status_detail"),
        error_message=row.get("error_message"),
        source_summary=row.get("source_summary"),
        course_context=row.get("course_context"),
        course_context_source=row.get("course_context_source"),
        course_context_filename=row.get("course_context_filename"),
        detected_subject=row.get("detected_subject"),
        subject_confidence=row.get("subject_confidence"),
        progression_map=row.get("progression_map"),
        weighting_sources=row.get("weighting_sources") or [],
        exam_question_count=row.get("exam_question_count"),
        exam_duration_minutes=row.get("exam_duration_minutes"),
        practice_question_count=resolved,
        practice_duration_minutes=resolved_minutes,
        exam_profile_source=source,
        recommended_exam=RecommendedExam(**baseline),
        created_at=row["created_at"],
        updated_at=row.get("updated_at"),
        source_count=sources,
        domain_count=domains,
        resume_lecture_id=row.get("_resume_lecture_id"),
        resume_last_played_at=row.get("_resume_last_played_at"),
        last_accessed_at=row.get("_last_accessed_at"),
        domains=[_to_domain(d) for d in (domain_rows or [])],
    )


def _fetch_own(module_id: str, user_id: str) -> dict[str, Any]:
    result = (
        _client()
        .table("modules")
        .select("*")
        .eq("id", module_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Module not found.")
    return rows[0]


# --- Routes ---------------------------------------------------------------
@router.get("", response_model=list[Module])
async def list_modules(user: AuthUser = Depends(get_current_user)) -> list[Module]:
    """List modules, each with its ordered domains for the dashboard pills.

    Domains and source counts are fetched in two batched queries and grouped in
    memory, rather than a per-module round trip — the dashboard is the first
    screen after sign-in and shouldn't fan out to an N+1.
    """
    client = _client()
    rows = (
        client.table("modules").select("*")
        .eq("user_id", user.id).order("updated_at", desc=True).execute()
    ).data or []
    if not rows:
        return []

    module_ids = [r["id"] for r in rows]

    domain_rows = (
        client.table("domains")
        .select("id, module_id, title, description, order_index, weight_pct, "
                "status, completed_at")
        .in_("module_id", module_ids).eq("user_id", user.id)
        .order("order_index").execute()
    ).data or []
    domains_by_module: dict[str, list[dict[str, Any]]] = {}
    for d in domain_rows:
        domains_by_module.setdefault(d["module_id"], []).append(d)

    source_rows = (
        client.table("user_files").select("id, module_id")
        .in_("module_id", module_ids).eq("user_id", user.id).execute()
    ).data or []
    source_counts: dict[str, int] = {}
    for s in source_rows:
        source_counts[s["module_id"]] = source_counts.get(s["module_id"], 0) + 1

    # A resumable lecture per module (started, not finished) — newest first, so
    # the first seen for a module is the one to resume.
    resume_rows = (
        client.table("lectures").select("id, module_id, last_played_at")
        .in_("module_id", module_ids).eq("user_id", user.id)
        .is_("completed_at", "null").gt("last_position_secs", 0)
        .order("last_played_at", desc=True).execute()
    ).data or []
    resume_by_module: dict[str, dict[str, Any]] = {}
    for lec in resume_rows:
        resume_by_module.setdefault(lec["module_id"], lec)

    access_rows = (
        client.table("module_access").select("module_id, accessed_at")
        .eq("user_id", user.id).in_("module_id", module_ids).execute()
    ).data or []
    access_by_module = {a["module_id"]: a.get("accessed_at") for a in access_rows}

    for row in rows:
        r = resume_by_module.get(row["id"])
        row["_resume_lecture_id"] = r["id"] if r else None
        row["_resume_last_played_at"] = r.get("last_played_at") if r else None
        row["_last_accessed_at"] = access_by_module.get(row["id"])

    return [
        _to_module(
            row,
            sources=source_counts.get(row["id"], 0),
            domains=len(domains_by_module.get(row["id"], [])),
            domain_rows=domains_by_module.get(row["id"], []),
        )
        for row in rows
    ]


@router.post("", response_model=Module, status_code=status.HTTP_201_CREATED)
async def create_module(
    payload: ModuleCreate,
    user: AuthUser = Depends(get_current_user),
) -> Module:
    """Create an empty module, ready for sources to be uploaded into it.

    The title is left blank when not supplied — the pipeline fills it in from the
    detected subject once sources are processed, so the learner never names it.
    """
    row = {
        "user_id": user.id,
        "title": (payload.title or "").strip(),
        "description": payload.description,
        "color": payload.color,
        "status": "processing",
        "status_detail": "awaiting sources",
    }
    inserted = _client().table("modules").insert(row).execute()
    if not inserted.data:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "Could not create the module."
        )
    return _to_module(inserted.data[0])


@router.get("/{module_id}", response_model=ModuleDetail)
async def get_module(
    module_id: str,
    user: AuthUser = Depends(get_current_user),
) -> ModuleDetail:
    """A module plus its ordered domain list, each with its lecture progress."""
    client = _client()
    row = _fetch_own(module_id, user.id)
    domain_rows = (
        client
        .table("domains")
        .select("*")
        .eq("module_id", module_id)
        .order("order_index")
        .execute()
    ).data or []

    # One batched query for the domains' lectures rather than N per-domain round
    # trips. Ordered newest-first so, if a domain ever has more than one, the
    # most recent wins the per-domain slot.
    domain_ids = [d["id"] for d in domain_rows]
    if domain_ids:
        lecture_rows = (
            client.table("lectures")
            .select("id, domain_id, status, last_position_secs, duration_secs")
            .in_("domain_id", domain_ids)
            .eq("user_id", user.id)
            .order("created_at", desc=True)
            .execute()
        ).data or []
        lectures_by_domain: dict[str, dict[str, Any]] = {}
        for lec in lecture_rows:
            lectures_by_domain.setdefault(lec["domain_id"], lec)
        for d in domain_rows:
            d["_lecture"] = lectures_by_domain.get(d["id"])

        # Review-later count per domain — the badge on the Review Later button.
        # Two batched queries: this module's practice questions, then which of
        # them the user has flagged.
        pq_rows = (
            client.table("practice_questions").select("id, domain_id")
            .in_("domain_id", domain_ids).execute()
        ).data or []
        domain_by_question = {r["id"]: r["domain_id"] for r in pq_rows}
        review_count: dict[str, int] = {}
        if domain_by_question:
            flagged = (
                client.table("review_later").select("item_id")
                .eq("user_id", user.id).eq("item_type", "practice_question")
                .in_("item_id", list(domain_by_question.keys())).execute()
            ).data or []
            for f in flagged:
                dom = domain_by_question.get(f["item_id"])
                if dom:
                    review_count[dom] = review_count.get(dom, 0) + 1
        for d in domain_rows:
            d["_review_count"] = review_count.get(d["id"], 0)

        # An unweighted domain that owns flashcards is an imported deck. The
        # flag drives the UI: decks offer study tiles but sit out of bulk
        # lecture generation, and they never distort the exam blueprint.
        card_rows = (
            client.table("flashcards").select("domain_id")
            .in_("domain_id", domain_ids).eq("user_id", user.id).execute()
        ).data or []
        with_cards = {r["domain_id"] for r in card_rows if r.get("domain_id")}
        for d in domain_rows:
            d["_is_deck"] = d["id"] in with_cards and not (d.get("weight_pct") or 0)

    sources, _ = _counts(module_id)
    base = _to_module(
        row, sources, len(domain_rows), domain_rows=domain_rows,
        practice_count=exam_profile.exam_question_count(
            module_id, user.id, module_row=row
        ),
    )
    return ModuleDetail(**base.model_dump())


@router.post("/{module_id}/touch", status_code=status.HTTP_204_NO_CONTENT)
async def touch_module(
    module_id: str,
    user: AuthUser = Depends(get_current_user),
) -> None:
    """Record that the learner just opened this module ("last visited").

    Written to `module_access` (not `modules`) so the module list order — by
    `modules.updated_at` — doesn't shuffle every time a module is opened.
    """
    _fetch_own(module_id, user.id)
    _client().table("module_access").upsert(
        {
            "user_id": user.id,
            "module_id": module_id,
            "accessed_at": datetime.now(timezone.utc).isoformat(),
        },
        on_conflict="user_id,module_id",
    ).execute()


# --- Studio media (everything generated for a module) ----------------------
class StudioLecture(BaseModel):
    id: str
    # What the lecture is actually about, written when it was generated.
    # Falls back to the domain's own title for anything made before that.
    title: str = "Lecture"
    domain_title: str | None = None
    duration_secs: int | None = None
    status: str | None = None
    created_at: datetime | None = None


class StudioSet(BaseModel):
    """A per-domain deck/set (flashcards, practice questions)."""

    domain_id: str
    title: str = ""
    domain_title: str | None = None
    count: int = 0
    created_at: datetime | None = None


class StudioQuiz(BaseModel):
    id: str
    domain_id: str | None = None
    domain_title: str | None = None
    title: str = "Quiz"
    question_count: int = 0
    score: float | None = None
    created_at: datetime | None = None


class StudioExam(BaseModel):
    """A sat-in-one-go practice exam, generated or imported from a PDF.

    Imported papers are stored in the same tables as generated ones, so nothing
    here distinguishes them — deliberately: they are the same experience.
    """

    id: str
    title: str = "Practice Exam"
    question_count: int = 0
    duration_minutes: int = 0
    created_at: datetime | None = None


class StudioMedia(BaseModel):
    lectures: list[StudioLecture] = Field(default_factory=list)
    flashcards: list[StudioSet] = Field(default_factory=list)
    quizzes: list[StudioQuiz] = Field(default_factory=list)
    practice: list[StudioSet] = Field(default_factory=list)
    exams: list[StudioExam] = Field(default_factory=list)


@router.get("/{module_id}/studio", response_model=StudioMedia)
async def studio_media(
    module_id: str,
    user: AuthUser = Depends(get_current_user),
) -> StudioMedia:
    """Everything already generated for this module, grouped by type and
    labelled with the domain it belongs to — the Studio tab's "Generated media".
    """
    client = _client()
    _fetch_own(module_id, user.id)

    domains = (
        client.table("domains").select("id, title")
        .eq("module_id", module_id).eq("user_id", user.id).execute()
    ).data or []
    title_of = {d["id"]: d.get("title") for d in domains}
    domain_ids = list(title_of.keys())

    lecture_rows = (
        client.table("lectures")
        .select("id, domain_id, title, duration_secs, status, created_at")
        .eq("module_id", module_id).eq("user_id", user.id).execute()
    ).data or []
    lectures = [
        StudioLecture(
            id=l["id"],
            title=(l.get("title") or "").strip()
            or title_of.get(l.get("domain_id"))
            or "Lecture",
            domain_title=title_of.get(l.get("domain_id")),
            duration_secs=l.get("duration_secs"), status=l.get("status"),
            created_at=l.get("created_at"),
        )
        for l in lecture_rows
        if l.get("status") == "ready"
    ]

    quiz_rows = (
        client.table("quizzes")
        .select("id, domain_id, title, question_count, score, created_at")
        .eq("module_id", module_id).eq("user_id", user.id).execute()
    ).data or []
    quizzes = [
        StudioQuiz(
            id=q["id"], domain_id=q.get("domain_id"),
            domain_title=title_of.get(q.get("domain_id")),
            title=q.get("title") or "Quiz",
            question_count=q.get("question_count") or 0, score=q.get("score"),
            created_at=q.get("created_at"),
        )
        for q in quiz_rows
    ]

    def _by_domain(rows: list[dict[str, Any]], noun: str) -> list[StudioSet]:
        """Group a per-domain set, naming it after what it covers.

        Decks and practice sets have no row of their own to hang a generated
        title on, so the name is built from the domain and the size — "Core CLI
        Commands — 50 cards" — which is what the learner is choosing between.
        """
        counts: dict[str, int] = {}
        newest: dict[str, Any] = {}
        titles: dict[str, str] = {}
        for r in rows:
            dom = r.get("domain_id")
            if not dom:
                continue
            counts[dom] = counts.get(dom, 0) + 1
            named = (r.get("deck_title") or "").strip()
            if named:
                titles.setdefault(dom, named)
            stamp = r.get("created_at")
            if stamp and (dom not in newest or str(stamp) > str(newest[dom])):
                newest[dom] = stamp
        return [
            StudioSet(
                domain_id=d,
                title=titles.get(d)
                or f"{title_of.get(d) or 'Set'} — {n} {noun}{'' if n == 1 else 's'}",
                domain_title=title_of.get(d),
                count=n,
                created_at=newest.get(d),
            )
            for d, n in counts.items()
        ]

    flashcards = _by_domain(
        (client.table("flashcards").select("domain_id, created_at, deck_title")
         .eq("module_id", module_id).eq("user_id", user.id).execute()).data or [],
        "card",
    )

    practice: list[StudioSet] = []
    if domain_ids:
        practice = _by_domain(
            (client.table("practice_questions").select("domain_id, created_at")
             .in_("domain_id", domain_ids).is_("exam_id", "null").execute()).data or [],
            "question",
        )

    exam_rows = (
        client.table("practice_exams")
        .select("id, title, total_points, duration_minutes, created_at")
        .eq("module_id", module_id).eq("user_id", user.id)
        .order("created_at", desc=True).execute()
    ).data or []
    exams = [
        StudioExam(
            id=e["id"],
            title=e.get("title") or "Practice Exam",
            question_count=e.get("total_points") or 0,
            duration_minutes=e.get("duration_minutes") or 0,
            created_at=e.get("created_at"),
        )
        for e in exam_rows
    ]

    return StudioMedia(
        lectures=lectures, flashcards=flashcards, quizzes=quizzes,
        practice=practice, exams=exams,
    )


# --- Chat: web source discovery --------------------------------------------
class DiscoverRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=500)


class DiscoverResource(BaseModel):
    title: str
    url: str
    type: str = "website"  # youtube | pdf | docs | website


class DiscoverResponse(BaseModel):
    answer: str = ""
    resources: list[DiscoverResource] = Field(default_factory=list)
    # How many suggestions were dropped as dead, walled or off-topic — the Chat
    # tab says so, rather than silently returning a short list.
    filtered_count: int = 0


@router.post("/{module_id}/discover", response_model=DiscoverResponse)
async def discover(
    module_id: str,
    payload: DiscoverRequest,
    user: AuthUser = Depends(get_current_user),
) -> DiscoverResponse:
    """Search the web for free study material for this module, plus a short
    answer grounded in the module's own sources. Not a general chatbot — a
    module-scoped source-discovery tool.
    """
    module = _fetch_own(module_id, user.id)
    subject = module.get("detected_subject") or module.get("title") or "this subject"
    context = module.get("source_summary") or module.get("course_context") or ""

    try:
        result = discover_resources(payload.query, subject=subject, context=context)
    except GenerationError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    # The model suggests generously; only links that actually load, are free to
    # read, are on topic and haven't been reported dead reach the learner.
    suggested = result.get("resources", [])
    blocked = dead_links.for_user(user.id)
    resources = await validate_resources(
        suggested, query=payload.query,
        reported_urls=blocked.urls, reported_hosts=blocked.hosts,
    )

    return DiscoverResponse(
        answer=result.get("answer", ""),
        resources=[DiscoverResource(**r) for r in resources],
        filtered_count=max(0, len(suggested) - len(resources)),
    )


# --- Tutor -----------------------------------------------------------------
class TutorMessage(BaseModel):
    """One turn of the module conversation.

    `kind` says what the tutor did — answered, assessed the material, or
    searched — and `payload` carries the structured part of that answer so a
    past turn re-renders as it first appeared.
    """

    id: str
    role: str
    content: str = ""
    kind: str = "question"
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime | None = None


class TutorAskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=1000)
    # Set by the "Assess my material" action, which skips the classifier: the
    # learner has already said what they want.
    force_assessment: bool = False
    # Set when finishing an assessment that was waiting on the sources being
    # read. The placeholder becomes the answer in place, so the learner sees
    # the one question they asked rather than the app asking it again on their
    # behalf.
    resume_message_id: str | None = None


class TutorReply(BaseModel):
    messages: list[TutorMessage] = Field(default_factory=list)


def _to_tutor_message(row: dict[str, Any]) -> TutorMessage:
    return TutorMessage(
        id=row["id"],
        role=row.get("role") or "assistant",
        content=row.get("content") or "",
        kind=row.get("kind") or "question",
        payload=row.get("payload") or {},
        created_at=row.get("created_at"),
    )


def _save_tutor_message(
    module_id: str, user_id: str, *, role: str, content: str,
    kind: str = "question", payload: dict[str, Any] | None = None,
) -> TutorMessage:
    row = (
        _client().table("tutor_messages").insert({
            "module_id": module_id,
            "user_id": user_id,
            "role": role,
            "content": content[:8000],
            "kind": kind,
            "payload": payload or {},
        }).execute()
    ).data
    return _to_tutor_message(row[0])


def _replace_tutor_message(
    message_id: str, user_id: str, *, content: str,
    kind: str = "question", payload: dict[str, Any] | None = None,
) -> TutorMessage | None:
    """Turn a placeholder into the answer it was standing in for."""
    row = (
        _client().table("tutor_messages").update({
            "content": content[:8000],
            "kind": kind,
            "payload": payload or {},
        }).eq("id", message_id).eq("user_id", user_id).execute()
    ).data or []
    return _to_tutor_message(row[0]) if row else None


@router.get("/{module_id}/tutor", response_model=list[TutorMessage])
async def tutor_history(
    module_id: str,
    user: AuthUser = Depends(get_current_user),
) -> list[TutorMessage]:
    """The conversation so far, oldest first."""
    _fetch_own(module_id, user.id)
    rows = (
        _client().table("tutor_messages").select("*")
        .eq("module_id", module_id).eq("user_id", user.id)
        .order("created_at").execute()
    ).data or []
    return [_to_tutor_message(r) for r in rows]


@router.delete("/{module_id}/tutor", status_code=status.HTTP_204_NO_CONTENT)
async def clear_tutor_history(
    module_id: str,
    user: AuthUser = Depends(get_current_user),
) -> None:
    """Start the conversation over."""
    _fetch_own(module_id, user.id)
    _client().table("tutor_messages").delete().eq("module_id", module_id).eq(
        "user_id", user.id
    ).execute()


@router.post("/{module_id}/tutor", response_model=TutorReply)
async def ask_tutor(
    module_id: str,
    payload: TutorAskRequest,
    background: BackgroundTasks,
    user: AuthUser = Depends(get_current_user),
) -> TutorReply:
    """Ask the module tutor something, and keep the exchange.

    Three things can come back, decided by what was asked: an answer grounded in
    the module's own material, an assessment of whether the uploaded sources
    cover the exam, or a search for free study resources. All three are stored,
    so the conversation survives leaving the tab.
    """
    module = _fetch_own(module_id, user.id)
    question = payload.question.strip()

    history = [
        {"role": r.get("role"), "content": r.get("content") or ""}
        for r in (
            _client().table("tutor_messages").select("role, content")
            .eq("module_id", module_id).eq("user_id", user.id)
            .order("created_at", desc=True).limit(tutor.HISTORY_TURNS).execute()
        ).data or []
    ][::-1]

    # Resuming replaces a placeholder rather than starting a new exchange, so
    # the learner's original question stays the only one on screen.
    resume_id = (payload.resume_message_id or "").strip() or None
    asked = (
        None if resume_id
        else _save_tutor_message(module_id, user.id, role="user", content=question)
    )

    def reply(
        content: str, *, kind: str = "question",
        body: dict[str, Any] | None = None,
    ) -> TutorReply:
        replied = (
            _replace_tutor_message(
                resume_id, user.id, content=content, kind=kind, payload=body,
            ) if resume_id else None
        ) or _save_tutor_message(
            module_id, user.id, role="assistant", content=content,
            kind=kind, payload=body,
        )
        return TutorReply(messages=[m for m in (asked, replied) if m])

    intent = "assessment" if (payload.force_assessment or resume_id) else None
    answer = ""
    if intent is None:
        try:
            decided = tutor.answer_question(module_id, user.id, question, history)
            intent, answer = decided["intent"], decided["answer"]
        except tutor.TutorError as exc:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    if intent == "assessment":
        # An assessment is only as good as the map behind it. If the map is
        # missing or stale — a source was added or removed since the last one —
        # the honest answer is to say it's reading, start the read, and let the
        # tab pick the answer up when it lands. Guessing from a sample is what
        # this feature exists to stop.
        state, stored = tutor.coverage_state(module_id, user.id)
        if state in ("stale", "computing"):
            if state == "stale":
                background.add_task(coverage.ensure, module_id, user.id, force=True)
            return reply(
                "Reading your sources in full…",
                kind="assessment", body={"status": "computing"},
            )

        try:
            assessment = tutor.assess_material(
                module_id, user.id, coverage_map=stored,
            )
        except tutor.TutorError as exc:
            return reply(str(exc))
        return reply(
            assessment["verdict"], kind="assessment", body=assessment,
        )

    if intent == "resources":
        subject = module.get("detected_subject") or module.get("title") or "this subject"
        context = module.get("source_summary") or module.get("course_context") or ""
        try:
            found = discover_resources(question, subject=subject, context=context)
        except GenerationError as exc:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
        blocked = dead_links.for_user(user.id)
        resources = await validate_resources(
            found.get("resources", []), query=question,
            reported_urls=blocked.urls, reported_hosts=blocked.hosts,
        )
        return reply(
            found.get("answer", ""), kind="resources",
            body={"resources": resources},
        )

    return reply(answer)


# --- Coverage map ----------------------------------------------------------
class CoverageDomain(BaseModel):
    """One exam domain, as the sources actually cover it."""

    title: str = ""
    domain_id: str | None = None
    weight_pct: float = 0
    coverage: str = "missing"
    depth: str = "none"
    topics: list[str] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)
    chunk_hits: int = 0


class CoverageMap(BaseModel):
    """What reading every source in full established, and how current it is.

    ``stale`` is the field the tab watches: it means the sources or the
    blueprint have moved since the map was built, so what it says is about a
    module that no longer exists in that shape.
    """

    module_id: str
    available: bool = True
    status: str = "missing"
    stale: bool = True
    domains: list[CoverageDomain] = Field(default_factory=list)
    chunk_count: int = 0
    chars_analysed: int = 0
    source_count: int = 0
    truncated: bool = False
    error: str | None = None
    computed_at: datetime | None = None


def _to_coverage(module_id: str, state: str, row: dict[str, Any] | None) -> CoverageMap:
    if state == "unavailable":
        return CoverageMap(module_id=module_id, available=False, status="unavailable")
    if not row:
        return CoverageMap(module_id=module_id, status="missing")
    return CoverageMap(
        module_id=module_id,
        status=row.get("status") or "missing",
        stale=state != "ready",
        domains=[CoverageDomain(**d) for d in (row.get("domains") or [])],
        chunk_count=row.get("chunk_count") or 0,
        chars_analysed=row.get("chars_analysed") or 0,
        source_count=row.get("source_count") or 0,
        truncated=bool(row.get("truncated")),
        error=row.get("error"),
        computed_at=row.get("computed_at"),
    )


@router.get("/{module_id}/coverage", response_model=CoverageMap)
async def module_coverage(
    module_id: str,
    user: AuthUser = Depends(get_current_user),
) -> CoverageMap:
    """The module's coverage map — what the sources cover, domain by domain."""
    _fetch_own(module_id, user.id)
    try:
        state, row = tutor.coverage_state(module_id, user.id)
    except tutor.TutorError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return _to_coverage(module_id, state, row)


@router.post("/{module_id}/coverage/refresh", response_model=CoverageMap)
async def refresh_coverage(
    module_id: str,
    background: BackgroundTasks,
    user: AuthUser = Depends(get_current_user),
) -> CoverageMap:
    """Re-read every source and rebuild the map. Returns immediately.

    Poll ``GET /modules/{id}/coverage`` until ``status`` is ``ready``. Reading a
    large pack takes as long as it takes; holding the request open for it would
    only give the learner a spinner that can time out.
    """
    _fetch_own(module_id, user.id)
    if not coverage.available():
        raise HTTPException(
            status.HTTP_501_NOT_IMPLEMENTED,
            "Coverage maps aren't available on this deployment yet.",
        )
    background.add_task(coverage.ensure, module_id, user.id, force=True)
    # The row on disk still describes the previous read; what's true right now
    # is that a new one is running.
    pending = _to_coverage(module_id, "computing", coverage.get_map(module_id, user.id))
    pending.status = "computing"
    pending.stale = True
    return pending


class ReportLinkRequest(BaseModel):
    url: str = Field(..., min_length=8, max_length=1000)
    reason: str = Field(
        "dead", description="dead | paywalled | irrelevant",
    )


@router.post("/{module_id}/discover/report",
             status_code=status.HTTP_204_NO_CONTENT)
async def report_dead_link(
    module_id: str,
    payload: ReportLinkRequest,
    user: AuthUser = Depends(get_current_user),
) -> None:
    """Flag a discovered source as dead, walled or off-topic.

    The link stops appearing in this learner's searches, and a host they've
    rejected repeatedly is dropped wholesale — the validator can prove a page is
    broken now, but only the learner can tell it the page is useless.
    """
    _fetch_own(module_id, user.id)
    if not payload.url.startswith(("http://", "https://")):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "That isn't a web link."
        )
    try:
        dead_links.report(user.id, payload.url, payload.reason)
    except Exception as exc:  # noqa: BLE001 — surface a usable message
        logger.warning("dead-link report failed: %s", exc)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Could not save that report. If this persists, the "
            "dead_link_reports migration may not have been applied.",
        ) from exc


@router.delete("/{module_id}/discover/report",
               status_code=status.HTTP_204_NO_CONTENT)
async def unreport_dead_link(
    module_id: str,
    url: str = Query(..., min_length=8, max_length=1000),
    user: AuthUser = Depends(get_current_user),
) -> None:
    """Undo a report — the learner mis-tapped, or the page came back."""
    _fetch_own(module_id, user.id)
    dead_links.unreport(user.id, url)


# --- Course Context (upload screen) ----------------------------------------
@router.put("/{module_id}/course-context", response_model=CourseContext)
async def set_course_context(
    module_id: str,
    text: str | None = Form(
        None, description="Pasted syllabus text. Use this or `file`."
    ),
    file: UploadFile | None = File(
        None, description="Syllabus PDF or plain-text file."
    ),
    user: AuthUser = Depends(get_current_user),
) -> CourseContext:
    """Attach a syllabus to a module as an extra reference layer.

    Accepts pasted text or an uploaded PDF/text file. The stored context is fed
    into the domain-extraction prompt, where it validates the official exam
    weightings and prioritises the topics this course actually tests.

    Unlike ``/sources``, the syllabus is *not* treated as study material — it
    describes the course rather than teaching it, so it is never turned into
    lectures or flashcards.
    """
    _fetch_own(module_id, user.id)

    if bool(text and text.strip()) == bool(file):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Provide exactly one of `text` (pasted syllabus) or `file` "
            "(syllabus PDF).",
        )

    filename: str | None = None
    if file:
        data = await file.read()
        if not data:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "That file is empty.")
        if len(data) > settings.max_upload_mb * 1024 * 1024:
            raise HTTPException(
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                f"Syllabus exceeds the {settings.max_upload_mb} MB limit.",
            )

        from app.services.extraction import (
            ExtractionError,
            extract_pdf,
            extract_text_file,
        )
        from app.services.storage import detect_source_type

        kind = detect_source_type(file.filename or "", file.content_type)
        if kind not in ("pdf", "text"):
            raise HTTPException(
                status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                "A syllabus must be a PDF or a plain-text file.",
            )
        try:
            content = extract_pdf(data) if kind == "pdf" else extract_text_file(data)
        except ExtractionError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
        filename = file.filename
    else:
        content = (text or "").strip()

    if len(content) < 20:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "That syllabus is too short to be useful — paste the course outline "
            "or upload the syllabus document.",
        )
    if len(content) > MAX_COURSE_CONTEXT_CHARS:
        content = content[:MAX_COURSE_CONTEXT_CHARS]

    updated = (
        _client()
        .table("modules")
        .update(
            {
                "course_context": content,
                "course_context_source": "user",
                "course_context_filename": filename,
            }
        )
        .eq("id", module_id)
        .eq("user_id", user.id)
        .execute()
    )
    if not updated.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Module not found.")
    row = updated.data[0]
    return CourseContext(
        module_id=module_id,
        course_context=row.get("course_context"),
        course_context_source=row.get("course_context_source"),
        course_context_filename=row.get("course_context_filename"),
        char_count=len(row.get("course_context") or ""),
    )


@router.get("/{module_id}/course-context", response_model=CourseContext)
async def get_course_context(
    module_id: str,
    user: AuthUser = Depends(get_current_user),
) -> CourseContext:
    """Read a module's course context, for display on the upload screen."""
    row = _fetch_own(module_id, user.id)
    return CourseContext(
        module_id=module_id,
        course_context=row.get("course_context"),
        course_context_source=row.get("course_context_source"),
        course_context_filename=row.get("course_context_filename"),
        char_count=len(row.get("course_context") or ""),
    )


@router.delete("/{module_id}/course-context", status_code=status.HTTP_204_NO_CONTENT)
async def clear_course_context(
    module_id: str,
    user: AuthUser = Depends(get_current_user),
) -> None:
    """Remove the syllabus so extraction falls back to the official blueprint."""
    _fetch_own(module_id, user.id)
    _client().table("modules").update(
        {
            "course_context": None,
            "course_context_source": None,
            "course_context_filename": None,
        }
    ).eq("id", module_id).eq("user_id", user.id).execute()


@router.patch("/{module_id}", response_model=Module)
async def update_module(
    module_id: str,
    payload: ModuleUpdate,
    user: AuthUser = Depends(get_current_user),
) -> Module:
    _fetch_own(module_id, user.id)
    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        return _to_module(_fetch_own(module_id, user.id), *_counts(module_id))

    updated = (
        _client()
        .table("modules")
        .update(updates)
        .eq("id", module_id)
        .eq("user_id", user.id)
        .execute()
    )
    if not updated.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Module not found.")
    sources, domains = _counts(module_id)
    return _to_module(updated.data[0], sources, domains)


@router.delete("/{module_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_module(
    module_id: str,
    user: AuthUser = Depends(get_current_user),
) -> None:
    """Delete a module. Domains, lectures and sources cascade in the database."""
    _fetch_own(module_id, user.id)

    # Storage objects aren't covered by the FK cascade — clear them first.
    from app.services import storage as storage_service

    for row in storage_service.list_module_sources(module_id):
        if row.get("storage_path"):
            try:
                storage_service.delete_source(row["id"])
            except Exception:  # noqa: BLE001 - never block the delete
                pass

    _client().table("modules").delete().eq("id", module_id).eq(
        "user_id", user.id
    ).execute()

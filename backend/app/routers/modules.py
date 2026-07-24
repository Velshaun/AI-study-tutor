"""Study modules.

A "module" is a top-level container (a subject or course) that holds uploaded
sources plus the AI-generated progression map, domains, lectures, flashcards and
quizzes. Backed by Supabase.

The backend uses the service-role key, which bypasses RLS, so every query is
scoped to ``user_id`` explicitly — that filter is the access check.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, Field

from app.config import settings
from app.database import get_supabase
from app.routers.auth import AuthUser, get_current_user

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


class CourseContext(BaseModel):
    """The learner's syllabus, used to validate and prioritise domain weights."""

    module_id: str
    course_context: str | None = None
    course_context_source: str | None = None
    course_context_filename: str | None = None
    char_count: int = 0


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
    created_at: datetime
    updated_at: datetime | None = None
    source_count: int = 0
    domain_count: int = 0
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
    )


def _to_module(row: dict[str, Any], sources: int = 0, domains: int = 0,
               domain_rows: list[dict[str, Any]] | None = None) -> Module:
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
        created_at=row["created_at"],
        updated_at=row.get("updated_at"),
        source_count=sources,
        domain_count=domains,
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

    sources, _ = _counts(module_id)
    base = _to_module(row, sources, len(domain_rows), domain_rows=domain_rows)
    return ModuleDetail(**base.model_dump())


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

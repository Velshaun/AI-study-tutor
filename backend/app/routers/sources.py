"""Source upload & AI processing pipeline — spec §4.3.

    POST   /sources/upload            files  -> Storage + user_files   (step 1)
    POST   /sources/link              URL    -> user_files             (step 1)
    POST   /sources/{module_id}/process      -> runs steps 2-8 in the background
    GET    /sources/{module_id}/status       -> pipeline progress      (step 8)
    GET    /sources/{module_id}              -> list a module's sources
    DELETE /sources/file/{file_id}           -> remove a source

Every route authenticates the caller and verifies they own the target module
before touching it — the backend uses the service-role key, which bypasses RLS,
so ownership has to be enforced here explicitly.
"""

from __future__ import annotations

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
from app.services import coverage, storage
from app.services.extraction import classify_url
from app.services.pipeline import process_module, sat_exam_domains

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sources", tags=["sources"])


# --- Schemas ----------------------------------------------------------------
class LinkRequest(BaseModel):
    module_id: str
    url: str = Field(..., min_length=8, max_length=2000)


class SourceFile(BaseModel):
    id: str
    module_id: str | None = None
    filename: str
    source_type: str
    source_url: str | None = None
    status: str
    char_count: int = 0
    size_bytes: int = 0
    error_message: str | None = None
    download_url: str | None = None
    # First ~120 chars of the parsed text, for the "transcript ready" preview.
    preview: str | None = None


class ProcessResponse(BaseModel):
    module_id: str
    status: str
    detail: str
    sources_queued: int


class ModuleStatus(BaseModel):
    module_id: str
    status: str
    status_detail: str | None = None
    error_message: str | None = None
    detected_subject: str | None = None
    subject_confidence: float | None = None
    weighting_sources: list[dict[str, Any]] = Field(default_factory=list)
    progression_map: dict[str, Any] | None = None
    domain_count: int = 0
    sources: list[SourceFile] = Field(default_factory=list)


# --- Helpers ----------------------------------------------------------------
def _client():
    try:
        return get_supabase()
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc


def _own_module(module_id: str, user_id: str) -> dict[str, Any]:
    """Fetch a module, 404ing if it doesn't exist or isn't the caller's."""
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


def _to_source(row: dict[str, Any], *, with_url: bool = False) -> SourceFile:
    return SourceFile(
        id=row["id"],
        module_id=row.get("module_id"),
        filename=row.get("filename") or "",
        source_type=row.get("source_type") or "pdf",
        source_url=row.get("source_url"),
        status=row.get("status") or "pending",
        char_count=row.get("char_count") or 0,
        size_bytes=row.get("size_bytes") or 0,
        error_message=row.get("error_message"),
        download_url=(
            storage.signed_url(row.get("storage_path") or "") if with_url else None
        ),
        preview=((row.get("extracted_text") or "").strip()[:120] or None),
    )


# --- Step 1: receive files --------------------------------------------------
@router.post(
    "/upload",
    response_model=list[SourceFile],
    status_code=status.HTTP_201_CREATED,
)
async def upload_sources(
    module_id: str = Form(...),
    files: list[UploadFile] = File(...),
    user: AuthUser = Depends(get_current_user),
) -> list[SourceFile]:
    """Store uploaded files and register them against a module."""
    _own_module(module_id, user.id)

    max_bytes = settings.max_upload_mb * 1024 * 1024
    created: list[SourceFile] = []

    for upload in files:
        data = await upload.read()
        if not data:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"{upload.filename or 'file'} is empty.",
            )
        if len(data) > max_bytes:
            raise HTTPException(
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                f"{upload.filename} exceeds the {settings.max_upload_mb} MB limit.",
            )

        detected = storage.detect_source_type(
            upload.filename or "", upload.content_type
        )
        if detected == "unknown":
            raise HTTPException(
                status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                f"We can't read {upload.filename or 'that file'} yet. "
                "Try a PDF, a photo of your notes (JPG, PNG, HEIC), a screen "
                "recording (MP4, MOV, WEBM), audio (MP3, M4A, WAV), a CSV, or "
                "a text file.",
            )

        try:
            row = storage.upload_source_file(
                user_id=user.id,
                module_id=module_id,
                filename=upload.filename or "upload",
                data=data,
                content_type=upload.content_type,
            )
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, f"Upload failed: {exc}"
            ) from exc

        created.append(_to_source(row))

    return created


@router.post(
    "/link", response_model=SourceFile, status_code=status.HTTP_201_CREATED
)
async def add_link_source(
    payload: LinkRequest,
    user: AuthUser = Depends(get_current_user),
) -> SourceFile:
    """Register a YouTube video or web page as a source."""
    _own_module(payload.module_id, user.id)

    url = payload.url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "URL must start with http:// or https://"
        )

    row = storage.record_link_source(
        user_id=user.id,
        module_id=payload.module_id,
        url=url,
        source_type=classify_url(url),
    )
    return _to_source(row)


class DomainAtRisk(BaseModel):
    domain_id: str
    title: str
    # {'lectures': 1, 'practice_questions': 40, ...}
    counts: dict[str, int] = Field(default_factory=dict)
    # True where this domain's questions are in an exam that has already been
    # sat. A forced rebuild will refuse to delete it rather than leave a graded
    # attempt pointing at a paper with questions missing — so the dialog can say
    # "this one stays" instead of warning about a loss that won't happen.
    protected: bool = False


class ReprocessImpact(BaseModel):
    module_id: str
    at_risk_domains: list[DomainAtRisk] = Field(default_factory=list)


# --- Steps 2-8: run the pipeline -------------------------------------------
@router.get("/{module_id}/reprocess-impact", response_model=ReprocessImpact)
async def reprocess_impact(
    module_id: str,
    user: AuthUser = Depends(get_current_user),
) -> ReprocessImpact:
    """What a forced rebuild would destroy, so the learner can be asked first.

    Re-processing normally preserves domains that hold generated content; this
    reports what a `force` run would delete, for the confirmation dialog.
    """
    _own_module(module_id, user.id)
    from app.services.pipeline import domains_with_content

    at_risk = domains_with_content(module_id)
    undeletable = sat_exam_domains([d["domain_id"] for d in at_risk])
    return ReprocessImpact(
        module_id=module_id,
        at_risk_domains=[
            DomainAtRisk(
                domain_id=d["domain_id"], title=d["title"], counts=d["counts"],
                protected=d["domain_id"] in undeletable,
            )
            for d in at_risk
        ],
    )


@router.post("/{module_id}/process", response_model=ProcessResponse)
async def process_sources(
    module_id: str,
    background: BackgroundTasks,
    force: bool = Query(
        False,
        description=(
            "Rebuild the domain list outright, deleting generated content "
            "attached to domains that go away. Requires the learner to have "
            "confirmed — see GET /reprocess-impact."
        ),
    ),
    user: AuthUser = Depends(get_current_user),
) -> ProcessResponse:
    """Kick off parsing and AI analysis; returns immediately.

    Poll ``GET /sources/{module_id}/status`` until status is ``ready`` or
    ``failed``.

    By default this is non-destructive: domains holding lectures, flashcards,
    quizzes or practice questions are updated in place rather than replaced.
    """
    _own_module(module_id, user.id)

    sources = storage.list_module_sources(module_id)
    if not sources:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This module has no sources yet — upload a file or add a link first.",
        )

    _client().table("modules").update(
        {"status": "processing", "status_detail": "queued", "error_message": None}
    ).eq("id", module_id).execute()

    if force:
        logger.warning(
            "Module %s: forced re-ingestion requested by %s — generated content "
            "on dropped domains will be deleted.",
            module_id, user.id,
        )
    background.add_task(process_module, module_id, user.id, force=force)

    return ProcessResponse(
        module_id=module_id,
        status="processing",
        detail="queued",
        sources_queued=len(sources),
    )


@router.get("/{module_id}/status", response_model=ModuleStatus)
async def module_status(
    module_id: str,
    user: AuthUser = Depends(get_current_user),
) -> ModuleStatus:
    """Pipeline progress for a module — what the frontend polls (step 8)."""
    module = _own_module(module_id, user.id)

    domains = (
        _client()
        .table("domains")
        .select("id", count="exact")
        .eq("module_id", module_id)
        .execute()
    )
    sources = storage.list_module_sources(module_id)

    return ModuleStatus(
        module_id=module_id,
        status=module.get("status") or "processing",
        status_detail=module.get("status_detail"),
        error_message=module.get("error_message"),
        detected_subject=module.get("detected_subject"),
        subject_confidence=module.get("subject_confidence"),
        weighting_sources=module.get("weighting_sources") or [],
        progression_map=module.get("progression_map"),
        domain_count=domains.count or len(domains.data or []),
        sources=[_to_source(row) for row in sources],
    )


@router.get("/{module_id}", response_model=list[SourceFile])
async def list_sources(
    module_id: str,
    user: AuthUser = Depends(get_current_user),
) -> list[SourceFile]:
    """List a module's sources, each with a signed download URL."""
    _own_module(module_id, user.id)
    return [
        _to_source(row, with_url=True)
        for row in storage.list_module_sources(module_id)
    ]


@router.delete("/file/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_source_file(
    file_id: str,
    background: BackgroundTasks,
    user: AuthUser = Depends(get_current_user),
) -> None:
    """Delete a source row and its stored object."""
    result = (
        _client()
        .table("user_files")
        .select("id, module_id")
        .eq("id", file_id)
        .eq("user_id", user.id)
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Source not found.")
    storage.delete_source(file_id)

    # The coverage map still describes text the learner no longer has. Mark it
    # stale first so nothing reads it in the meantime, then rebuild without it.
    module_id = rows[0].get("module_id")
    if module_id:
        coverage.mark_stale(module_id, user.id)
        background.add_task(coverage.ensure, module_id, user.id, force=True)

"""Importing study material into a module.

    POST /import/paste          stage a batch of pasted sources as one job
    GET  /import/jobs/{module}  what's importing, and what recently did
    POST /import/jobs/{id}/retry  re-queue only the items that failed

The work itself happens in the worker, not here. A paste of thirty sources is
minutes of parsing and storing, and a request that held the browser open for it
would be the exact thing the durable queue was built to stop.

The learner's content-type label rides along with each item untouched. Detection
runs in the parser and only ever pre-selects a pill — see `services/ingest`.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.database import get_supabase
from app.routers.auth import AuthUser, get_current_user
from app.services import ingest, import_jobs, jobs

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/import", tags=["import"])

# Generous, but not unbounded: a paste this size is a file, and files have their
# own route that stores the bytes rather than the text.
MAX_ITEM_CHARS = 400_000
MAX_ITEMS = 50


class PasteItem(BaseModel):
    """One staged source, as the learner labelled it."""

    text: str = Field(..., min_length=1, max_length=MAX_ITEM_CHARS)
    # 'flashcards' | 'quiz' | 'practice_exam' | 'reference'. Authoritative:
    # detection may suggest, and never overrides.
    content_type: str = "reference"
    title: str | None = Field(default=None, max_length=200)


class PasteRequest(BaseModel):
    module_id: str
    items: list[PasteItem] = Field(..., min_length=1, max_length=MAX_ITEMS)


class ImportJob(BaseModel):
    id: str
    kind: str
    status: str
    total_items: int = 0
    completed_items: int = 0
    failed_items: int = 0
    error: str | None = None
    created_at: datetime | None = None
    finished_at: datetime | None = None
    items: list[dict[str, Any]] = Field(default_factory=list)


class DetectRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=MAX_ITEM_CHARS)


class DetectResponse(BaseModel):
    """A suggestion for the type pill, and nothing more."""

    detected: str
    # What the parser would make of it, so the staging list can warn before the
    # import rather than after: "this is a definition list, not an exam".
    would_be: str
    note: str = ""


def _client():
    return get_supabase()


def _own_module(module_id: str, user_id: str) -> dict[str, Any]:
    rows = (
        _client().table("modules").select("id, title")
        .eq("id", module_id).eq("user_id", user_id).limit(1).execute()
    ).data or []
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Module not found.")
    return rows[0]


@router.post("/detect", response_model=DetectResponse)
async def detect_type(
    payload: DetectRequest,
    user: AuthUser = Depends(get_current_user),  # noqa: ARG001 — auth only
) -> DetectResponse:
    """Suggest a content type for pasted text, and say what it would become.

    Deliberately separate from importing. The learner sees the suggestion and
    can overrule it before anything is stored, which is the whole point of the
    label being theirs.
    """
    result = ingest.parse(payload.text, None)
    return DetectResponse(
        detected=ingest.detect(payload.text),
        would_be=result.kind,
        note=result.note,
    )


@router.post("/paste", response_model=ImportJob,
             status_code=status.HTTP_202_ACCEPTED)
async def import_paste(
    payload: PasteRequest,
    user: AuthUser = Depends(get_current_user),
) -> ImportJob:
    """Queue a staged batch. Returns immediately with the job to watch.

    Progress arrives over Realtime on the `jobs` row — the browser can close and
    reopen without losing track, which a held-open request could never offer.
    """
    _own_module(payload.module_id, user.id)

    if not jobs.available():
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Imports aren't available on this deployment yet.",
        )

    job = import_jobs.enqueue_paste_import(
        module_id=payload.module_id,
        user_id=user.id,
        items=[i.model_dump() for i in payload.items],
    )
    if not job:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "Could not queue that import.",
        )
    logger.info(
        "Queued paste import %s for module %s (%d source(s))",
        job["id"], payload.module_id, len(payload.items),
    )
    return _to_job(job, [])


def _to_job(row: dict[str, Any], items: list[dict[str, Any]]) -> ImportJob:
    return ImportJob(
        id=row["id"],
        kind=row.get("kind") or "",
        status=row.get("status") or "queued",
        total_items=row.get("total_items") or 0,
        completed_items=row.get("completed_items") or 0,
        failed_items=row.get("failed_items") or 0,
        error=row.get("error"),
        created_at=row.get("created_at"),
        finished_at=row.get("finished_at"),
        items=[
            {
                "id": i["id"],
                "position": i.get("position"),
                "status": i.get("status"),
                "title": (i.get("payload") or {}).get("title"),
                "content_type": (i.get("payload") or {}).get("content_type"),
                "checkpoint": i.get("checkpoint") or {},
                "result": i.get("result") or {},
                "error": i.get("error"),
                "failure_kind": i.get("failure_kind"),
            }
            for i in items
        ],
    )


@router.get("/jobs/{module_id}", response_model=list[ImportJob])
async def list_jobs(
    module_id: str,
    user: AuthUser = Depends(get_current_user),
) -> list[ImportJob]:
    """Imports for a module, newest first — running and recently finished."""
    _own_module(module_id, user.id)
    if not jobs.available():
        return []
    rows = (
        _client().table("jobs").select("*")
        .eq("module_id", module_id).eq("user_id", user.id)
        .order("created_at", desc=True).limit(10).execute()
    ).data or []
    return [_to_job(r, jobs.items(r["id"])) for r in rows]


@router.post("/jobs/{job_id}/retry", response_model=ImportJob)
async def retry_job(
    job_id: str,
    user: AuthUser = Depends(get_current_user),
) -> ImportJob:
    """Re-queue only the items that failed.

    Nothing the learner supplied is asked for again — the items still hold their
    pasted text, so a retry is a status change rather than a re-import.
    """
    job = jobs.get(job_id, user.id)
    if not job:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Import not found.")

    requeued = jobs.retry_failed(job_id)
    if not requeued:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "There's nothing left to retry on this import.",
        )
    logger.info("Re-queued %d failed item(s) of import %s", requeued, job_id)
    refreshed = jobs.get(job_id, user.id) or job
    return _to_job(refreshed, jobs.items(job_id))

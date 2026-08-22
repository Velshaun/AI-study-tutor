"""Importing study material into a module.

    POST /import/paste          stage a batch of pasted sources as one job
    POST /import/youtube        a pasted video/playlist link, or a search
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
from app.services import (
    domain_assign, ingest, import_jobs, jobs, subject_match, youtube,
)

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
    # When a worker actually picked it up. The remaining-time estimate is
    # derived from this rather than `created_at`, so time spent queued behind
    # another import doesn't make every video look slow.
    claimed_at: datetime | None = None
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


class YouTubeRequest(BaseModel):
    module_id: str
    # Either a pasted link…
    url: str | None = None
    # …or a search. `query` is the exam or course name; instructor narrows it.
    query: str | None = Field(default=None, max_length=200)
    instructor: str | None = Field(default=None, max_length=120)
    # Playlists by default: a course is a series, and someone searching for one
    # wants the series rather than whichever single video ranks highest.
    playlist: bool = True
    # Confirmed in the preview. Absent for the search door, which has no
    # preview step yet, and for anything queued before the preview existed.
    domain_id: str | None = None


@router.post("/youtube", response_model=ImportJob,
             status_code=status.HTTP_202_ACCEPTED)
async def import_youtube(
    payload: YouTubeRequest,
    user: AuthUser = Depends(get_current_user),
) -> ImportJob:
    """Import a video or playlist, by link or by search.

    The link door needs no API key and no quota, which is why it is tried first
    and why the app stays usable when search is exhausted for the day.
    """
    _own_module(payload.module_id, user.id)
    if not jobs.available():
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Imports aren't available on this deployment yet.",
        )

    title = None
    target = youtube.parse_target(payload.url or "")

    if not target:
        if payload.url:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "That doesn't look like a YouTube video or playlist link.",
            )
        if not (payload.query or "").strip():
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Paste a YouTube link, or give a course name to search for.",
            )
        try:
            found = youtube.search(
                payload.query, instructor=payload.instructor,
                playlist=payload.playlist,
            )
        except youtube.QuotaExhausted as exc:
            # 429 rather than 502: this is a limit that resets, and the message
            # points at the door that still works.
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS, str(exc),
            ) from exc
        except youtube.YouTubeError as exc:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
        if not found:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Nothing came back for that. Try different words, or paste a link.",
            )
        target = {"kind": found["kind"], "id": found["id"]}
        title = found.get("title")

    if target["kind"] == "playlist" and not title:
        try:
            title = youtube.playlist_title(target["id"])
        except youtube.YouTubeError:
            # Listing needs the key too, so the job will fail with a clear
            # reason. Naming it isn't worth failing the request over.
            title = "YouTube playlist"

    job = import_jobs.enqueue_youtube_import(
        module_id=payload.module_id, user_id=user.id, target=target, title=title,
        domain_id=payload.domain_id,
    )
    if not job:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Could not queue that import.")
    logger.info("Queued YouTube import %s (%s %s)", job["id"], target["kind"], target["id"])
    return _to_job(job, [])


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
        claimed_at=row.get("claimed_at"),
        finished_at=row.get("finished_at"),
        items=[
            {
                "id": i["id"],
                "position": i.get("position"),
                "status": i.get("status"),
                # A playlist is one parent item and one child per video. Without
                # this the UI can only draw a flat list of twenty-two rows and
                # call it an import.
                "parent_item_id": i.get("parent_item_id"),
                "kind": i.get("kind"),
                "updated_at": i.get("updated_at"),
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


class YouTubePreview(BaseModel):
    """What a pasted link turns out to be, before anything is queued."""

    kind: str                      # 'video' | 'playlist'
    target_id: str
    title: str
    video_count: int = 1
    # The domain this looks like it belongs in, and everything it could be
    # moved to. The learner confirms or corrects before a job exists.
    domain_id: str | None = None
    domain_title: str | None = None
    domains: list[dict[str, str]] = Field(default_factory=list)
    note: str = ""
    # Set when the playlist looks like it belongs to a different exam than
    # this module. Empty the rest of the time, which is nearly always.
    subject_warning: str = ""


class PreviewRequest(BaseModel):
    module_id: str
    url: str


@router.post("/youtube/preview", response_model=YouTubePreview)
async def preview_youtube(
    payload: PreviewRequest,
    user: AuthUser = Depends(get_current_user),
) -> YouTubePreview:
    """Say what a link is, and where it would go, without queueing anything.

    Importing used to start the moment a link was pasted, so the first time a
    learner found out they had pasted the wrong playlist — or that a 97-video
    course was about to be filed under one domain — was after it had been read.
    A transcript is cheap to fetch and expensive to unpick from a module.

    So identification happens first and costs nothing: a playlist listing is one
    Data API call, and the domain is matched against titles the module already
    has. Nothing is written until the learner confirms.
    """
    module = _own_module(payload.module_id, user.id)

    target = youtube.parse_target(payload.url or "")
    if not target:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "That doesn't look like a YouTube video or playlist link.",
        )

    title = ""
    count = 1
    if target["kind"] == "playlist":
        try:
            videos = youtube.list_playlist(target["id"])
            count = len(videos)
            title = youtube.playlist_title(target["id"]) or "YouTube playlist"
        except youtube.QuotaExhausted as exc:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, str(exc)) from exc
        except youtube.YouTubeError as exc:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
        if not count:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "That playlist has no videos we can read.",
            )
    else:
        title = f"YouTube video {target['id']}"

    rows = (
        _client().table("domains").select("id, title, weight_pct, status")
        .eq("module_id", payload.module_id).order("order_index").execute()
    ).data or []
    # Flashcard decks are their own locked, zero-weight domain and are not part
    # of the blueprint, so they are not somewhere to file a transcript.
    choices = [
        {"id": d["id"], "title": d.get("title") or ""}
        for d in rows
        if (d.get("weight_pct") or 0) or not d.get("is_deck")
    ]

    suggested = domain_assign.suggest_from_title(
        title, choices, subject=module.get("title") or "",
    )

    # The same comparison the upload paths make, at the one moment this path
    # has an answer to compare: a Network+ course was imported into an LPI
    # module because a pasted playlist never passed through this check, and
    # forty-six transcripts had to be deleted by hand afterwards.
    verdict = subject_match.against_module(
        material_texts=[title],
        module_id=payload.module_id,
        module_title=module.get("title") or "",
    )

    return YouTubePreview(
        kind=target["kind"],
        subject_warning=subject_match.question(verdict) if verdict.should_ask else "",
        target_id=target["id"],
        title=title,
        video_count=count,
        domain_id=(suggested or {}).get("domain_id"),
        domain_title=(suggested or {}).get("title"),
        domains=choices,
        note=(
            f"{count} video{'s' if count != 1 else ''} will be read and filed "
            "under one domain."
            if target["kind"] == "playlist"
            else "One transcript will be read and filed under one domain."
        ),
    )


@router.post("/jobs/{job_id}/cancel", response_model=ImportJob)
async def cancel_job(
    job_id: str,
    user: AuthUser = Depends(get_current_user),
) -> ImportJob:
    """Stop an import that's running. What already landed stays."""
    job = jobs.get(job_id, user.id)
    if not job:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Import not found.")
    if job.get("status") in ("succeeded", "failed", "cancelled"):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "That import has already finished.",
        )
    jobs.cancel(job_id)
    refreshed = jobs.get(job_id, user.id) or job
    return _to_job(refreshed, jobs.items(job_id))


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

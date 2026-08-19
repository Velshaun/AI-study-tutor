"""Interactive AI lectures — spec §4.4.

    POST   /lectures/generate            domain_id, length, voice
    GET    /lectures/{domain_id}         the lecture for a domain
    GET    /lectures/{id}/stream         SSE: transcript appears live
    GET    /lectures/{id}/audio          signed URLs for the cached MP3 chunks
    PATCH  /lectures/{id}/position       last_position_secs (saved every 5s)
    PATCH  /lectures/{id}/complete       completes the domain, unlocks the next
    PATCH  /lectures/{id}/favourite      toggles is_favourite
    DELETE /lectures/{id}

Text comes from Gemini and streams over SSE as it is produced; audio comes from
OpenAI TTS HD and is cached in Supabase Storage.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    Header,
    HTTPException,
    Query,
    Request,
    status,
)
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.config import settings
from app.database import get_supabase
from app.routers.auth import AuthUser, get_current_user
from app.services import broadcast
from app.services.lecture_gen import LENGTHS, VOICES, generate_lecture

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/lectures", tags=["lectures"])

# Long enough that an idle proxy won't drop the SSE connection mid-generation.
SSE_KEEPALIVE_SECS = 15.0
SSE_MAX_SECS = 900.0


# --- Schemas ----------------------------------------------------------------
class LectureGenerateRequest(BaseModel):
    domain_id: str
    length: Literal["short", "medium", "long"] = "medium"
    voice: Literal["marcus", "sophia"] = "marcus"
    regenerate: bool = Field(
        False, description="Replace an existing lecture with these settings."
    )


class AudioChunk(BaseModel):
    index: int
    storage_path: str
    chars: int = 0
    duration_secs: int = 0
    url: str | None = None


class Lecture(BaseModel):
    id: str
    domain_id: str | None = None
    module_id: str | None = None
    # Human labels for the player header and Media Session metadata (lock screen
    # / notification tray). Populated by the detail endpoint; None elsewhere.
    title: str | None = None
    module_title: str | None = None
    status: str = "pending"
    error_message: str | None = None
    transcript: str | None = None
    word_count: int = 0
    duration_secs: int | None = None
    tutor_voice: str | None = None
    length_preference: str | None = None
    last_position_secs: int = 0
    is_favourite: bool = False
    completed_at: datetime | None = None
    generated_at: datetime | None = None
    audio_chunks: list[AudioChunk] = Field(default_factory=list)


class PositionUpdate(BaseModel):
    position_secs: int = Field(..., ge=0, description="Playback offset in seconds.")


class CompleteResponse(BaseModel):
    lecture_id: str
    domain_id: str
    domain_completed: bool
    next_domain_id: str | None = None
    next_domain_title: str | None = None
    module_complete: bool = False


# --- Helpers ----------------------------------------------------------------
def _client():
    try:
        return get_supabase()
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _to_lecture(row: dict[str, Any], *, with_urls: bool = False,
                with_transcript: bool = True) -> Lecture:
    chunks = []
    for chunk in row.get("audio_chunks") or []:
        url = None
        if with_urls:
            url = _signed(chunk.get("storage_path") or "")
        chunks.append(AudioChunk(**{**chunk, "url": url}))

    return Lecture(
        id=row["id"],
        domain_id=row.get("domain_id"),
        module_id=row.get("module_id"),
        status=row.get("status") or "pending",
        error_message=row.get("error_message"),
        transcript=row.get("transcript") if with_transcript else None,
        word_count=row.get("word_count") or 0,
        duration_secs=row.get("duration_secs"),
        tutor_voice=row.get("tutor_voice"),
        length_preference=row.get("length_preference"),
        last_position_secs=row.get("last_position_secs") or 0,
        is_favourite=bool(row.get("is_favourite")),
        completed_at=row.get("completed_at"),
        generated_at=row.get("generated_at"),
        audio_chunks=chunks,
    )


def _signed(path: str) -> str | None:
    if not path:
        return None
    try:
        result = _client().storage.from_(
            settings.lecture_audio_bucket
        ).create_signed_url(path, settings.signed_url_ttl_secs)
    except Exception:  # noqa: BLE001 - a missing object shouldn't 500 the list
        return None
    if isinstance(result, dict):
        return result.get("signedURL") or result.get("signedUrl")
    return None


def _own_lecture(lecture_id: str, user_id: str) -> dict[str, Any]:
    result = (
        _client().table("lectures").select("*")
        .eq("id", lecture_id).eq("user_id", user_id).limit(1).execute()
    )
    rows = result.data or []
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Lecture not found.")
    return rows[0]


def _own_domain(domain_id: str, user_id: str) -> dict[str, Any]:
    result = (
        _client().table("domains").select("*")
        .eq("id", domain_id).eq("user_id", user_id).limit(1).execute()
    )
    rows = result.data or []
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Domain not found.")
    return rows[0]


# --- Generate ---------------------------------------------------------------
@router.post("/generate", response_model=Lecture,
             status_code=status.HTTP_202_ACCEPTED)
async def generate(
    payload: LectureGenerateRequest,
    background: BackgroundTasks,
    user: AuthUser = Depends(get_current_user),
) -> Lecture:
    """Start generating a lecture for a domain.

    Returns immediately with ``status='pending'``. Open
    ``GET /lectures/{id}/stream`` to watch the transcript appear live, or poll
    ``GET /lectures/{domain_id}``.
    """
    domain = _own_domain(payload.domain_id, user.id)

    if domain.get("status") == "locked":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This domain is still locked — complete the preceding domain first.",
        )

    client = _client()
    existing = (
        client.table("lectures").select("*")
        .eq("domain_id", payload.domain_id)
        .eq("user_id", user.id)
        .eq("tutor_voice", payload.voice)
        .eq("length_preference", payload.length)
        .limit(1).execute()
    ).data or []

    if existing and not payload.regenerate:
        row = existing[0]
        if row.get("status") in ("ready", "generating_text", "generating_audio"):
            # Already have it (or it's on the way) — hand it back rather than
            # paying for the same generation twice.
            return _to_lecture(row, with_urls=True)

    module = (
        client.table("modules").select("*")
        .eq("id", domain["module_id"]).limit(1).execute()
    ).data or [{}]

    if existing:
        lecture_id = existing[0]["id"]
        client.table("lectures").update({
            "status": "pending", "transcript": "", "audio_chunks": [],
            "error_message": None, "duration_secs": None, "last_position_secs": 0,
        }).eq("id", lecture_id).execute()
        row = _own_lecture(lecture_id, user.id)
    else:
        inserted = client.table("lectures").insert({
            "domain_id": payload.domain_id,
            "module_id": domain["module_id"],
            "user_id": user.id,
            "title": domain.get("title") or "Lecture",
            "tutor_voice": payload.voice,
            "length_preference": payload.length,
            "status": "pending",
        }).execute()
        if not inserted.data:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY,
                                "Could not create the lecture.")
        row = inserted.data[0]

    # Mark the domain as started the first time a lecture is generated for it.
    if domain.get("status") == "unlocked":
        client.table("domains").update({
            "status": "in_progress", "started_at": _now_iso(),
        }).eq("id", payload.domain_id).execute()

    background.add_task(
        generate_lecture, row["id"], user.id, domain, module[0],
        payload.length, payload.voice,
    )
    return _to_lecture(row)


# --- Live transcript (SSE) --------------------------------------------------
async def _sse_events(lecture_id: str, request: Request, replay: str):
    """Yield SSE frames: stored text first, then live deltas."""
    channel = f"lecture:{lecture_id}"
    queue = await broadcast.subscribe(channel)
    try:
        if replay:
            yield _frame("replay", {"text": replay})

        elapsed = 0.0
        while True:
            if await request.is_disconnected():
                break
            try:
                event = await asyncio.wait_for(queue.get(), timeout=SSE_KEEPALIVE_SECS)
            except asyncio.TimeoutError:
                elapsed += SSE_KEEPALIVE_SECS
                if elapsed >= SSE_MAX_SECS:
                    yield _frame("timeout", {"message": "Stream idle too long."})
                    break
                # Comment frame keeps proxies from closing an idle connection.
                yield ": keepalive\n\n"
                continue

            elapsed = 0.0
            yield _frame(event["event"], event["data"])
            if event["event"] in ("complete", "error"):
                break
    finally:
        await broadcast.unsubscribe(channel, queue)


def _frame(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.get("/{lecture_id}/stream")
async def stream_lecture(
    lecture_id: str,
    request: Request,
    token: str | None = Query(
        None,
        description="Supabase access token. EventSource cannot send headers, "
                    "so SSE clients pass the token here instead.",
    ),
    authorization: str | None = Header(None),
) -> StreamingResponse:
    """Server-Sent Events carrying the transcript as it is generated.

    Events: ``replay`` (text already generated), ``delta`` (new text),
    ``status``, ``audio_chunk``, ``complete``, ``error``.

    A client that connects late or reconnects gets a ``replay`` frame with
    everything stored so far, then joins the live feed — so a dropped
    connection never loses transcript.
    """
    header = authorization or (f"Bearer {token}" if token else None)
    if not header:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED,
                            "Missing access token.")
    user = await get_current_user(authorization=header)
    row = _own_lecture(lecture_id, user.id)

    # A finished lecture needs no live channel — replay and close.
    if row.get("status") in ("ready", "failed"):
        async def _finished():
            yield _frame("replay", {"text": row.get("transcript") or ""})
            if row.get("status") == "ready":
                yield _frame("complete", {
                    "duration_secs": row.get("duration_secs") or 0,
                    "chunks": len(row.get("audio_chunks") or []),
                    "word_count": row.get("word_count") or 0,
                })
            else:
                yield _frame("error", {"message": row.get("error_message") or "Failed."})

        return StreamingResponse(_finished(), media_type="text/event-stream")

    return StreamingResponse(
        _sse_events(lecture_id, request, row.get("transcript") or ""),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # stop nginx buffering the stream
        },
    )


# --- Playback ---------------------------------------------------------------
@router.get("/{lecture_id}/detail", response_model=Lecture)
async def lecture_detail(
    lecture_id: str,
    user: AuthUser = Depends(get_current_user),
) -> Lecture:
    """A single lecture by its own id, with transcript and signed audio URLs.

    Distinct from ``GET /lectures/{domain_id}``, which keys off the *domain*
    per §4.4. The player routes on the lecture id, so it needs this.
    """
    row = _own_lecture(lecture_id, user.id)
    lecture = _to_lecture(row, with_urls=True)

    # Enrich with human titles for the player header and the lock-screen /
    # notification-tray metadata: the lecture's own name is its domain's title,
    # and the "album" shown on the lock screen is the module it belongs to.
    client = _client()
    if row.get("domain_id"):
        rows = (client.table("domains").select("title")
                .eq("id", row["domain_id"]).limit(1).execute()).data or []
        if rows:
            lecture.title = rows[0].get("title")
    if row.get("module_id"):
        rows = (client.table("modules").select("title")
                .eq("id", row["module_id"]).limit(1).execute()).data or []
        if rows:
            lecture.module_title = rows[0].get("title")
    return lecture


class LectureStatus(BaseModel):
    """Just enough to know whether a lecture can be opened yet."""

    id: str
    status: str = "pending"
    error_message: str | None = None
    chunk_count: int = 0


@router.get("/{lecture_id}/status", response_model=LectureStatus)
async def lecture_status(
    lecture_id: str,
    user: AuthUser = Depends(get_current_user),
) -> LectureStatus:
    """Whether a lecture is ready, without paying for the transcript.

    Generation returns a row before there is anything to play, so callers that
    just offered someone an "Open" button need to know when that button starts
    telling the truth. ``/detail`` would answer it too, but it ships the whole
    transcript and signs every audio URL — a poll's worth of work, several
    times a minute, for one word.
    """
    row = _own_lecture(lecture_id, user.id)
    return LectureStatus(
        id=row["id"],
        status=row.get("status") or "pending",
        error_message=row.get("error_message"),
        chunk_count=len(row.get("audio_chunks") or []),
    )


@router.get("/{lecture_id}/audio", response_model=list[AudioChunk])
async def lecture_audio(
    lecture_id: str,
    user: AuthUser = Depends(get_current_user),
) -> list[AudioChunk]:
    """Signed URLs for the cached audio chunks, in playback order."""
    row = _own_lecture(lecture_id, user.id)
    chunks = sorted(row.get("audio_chunks") or [], key=lambda c: c.get("index", 0))
    return [
        AudioChunk(**{**c, "url": _signed(c.get("storage_path") or "")})
        for c in chunks
    ]


@router.patch("/{lecture_id}/position", response_model=Lecture)
async def save_position(
    lecture_id: str,
    payload: PositionUpdate,
    user: AuthUser = Depends(get_current_user),
) -> Lecture:
    """Persist playback position. The player calls this every 5 seconds.

    Also banks the forward delta as study time, which is the only signal the
    app has for how long someone actually listened — `last_position_secs` is a
    bookmark, so replaying a lecture would otherwise register as no study at
    all. Rewinds and seeks are discarded inside ``record_study_time``.
    """
    existing = _own_lecture(lecture_id, user.id)
    previous = existing.get("last_position_secs") or 0
    delta = payload.position_secs - previous

    client = _client()
    updated = (
        client.table("lectures")
        .update({
            "last_position_secs": payload.position_secs,
            "last_played_at": _now_iso(),
        })
        .eq("id", lecture_id).eq("user_id", user.id).execute()
    )
    if not updated.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Lecture not found.")

    if delta > 0:
        try:
            client.rpc(
                "record_study_time",
                {"_user_id": user.id, "_seconds": delta},
            ).execute()
        except Exception:  # noqa: BLE001 - a stats miss must not fail playback
            logger.warning("Could not record study time for %s", lecture_id)

    return _to_lecture(updated.data[0], with_transcript=False)


@router.patch("/{lecture_id}/complete", response_model=CompleteResponse)
async def complete_lecture(
    lecture_id: str,
    user: AuthUser = Depends(get_current_user),
) -> CompleteResponse:
    """Mark the lecture's domain complete and unlock the next one."""
    row = _own_lecture(lecture_id, user.id)
    domain_id = row.get("domain_id")
    if not domain_id:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "This lecture is not attached to a domain.")

    client = _client()
    now = _now_iso()
    client.table("lectures").update({"completed_at": now}).eq("id", lecture_id).execute()

    domain = _own_domain(domain_id, user.id)
    client.table("domains").update(
        {"status": "completed", "completed_at": now}
    ).eq("id", domain_id).execute()

    # Unlock the next domain by order_index within the same module.
    siblings = (
        client.table("domains").select("*")
        .eq("module_id", domain["module_id"]).eq("user_id", user.id)
        .order("order_index").execute()
    ).data or []

    current_order = domain.get("order_index") or 0
    following = [
        d for d in siblings
        if (d.get("order_index") or 0) > current_order and d["id"] != domain_id
    ]

    next_domain = None
    for candidate in following:
        if candidate.get("status") == "locked":
            client.table("domains").update({"status": "unlocked"}).eq(
                "id", candidate["id"]
            ).execute()
            next_domain = candidate
            break
        if candidate.get("status") in ("unlocked", "in_progress"):
            next_domain = candidate  # already open; nothing to unlock
            break

    remaining = [
        d for d in siblings
        if d["id"] != domain_id and d.get("status") != "completed"
    ]

    return CompleteResponse(
        lecture_id=lecture_id,
        domain_id=domain_id,
        domain_completed=True,
        next_domain_id=next_domain["id"] if next_domain else None,
        next_domain_title=next_domain.get("title") if next_domain else None,
        module_complete=not remaining,
    )


@router.patch("/{lecture_id}/favourite", response_model=Lecture)
async def toggle_favourite(
    lecture_id: str,
    user: AuthUser = Depends(get_current_user),
) -> Lecture:
    """Toggle is_favourite."""
    row = _own_lecture(lecture_id, user.id)
    updated = (
        _client().table("lectures")
        .update({"is_favourite": not bool(row.get("is_favourite"))})
        .eq("id", lecture_id).eq("user_id", user.id).execute()
    )
    if not updated.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Lecture not found.")
    return _to_lecture(updated.data[0], with_transcript=False)


@router.delete("/{lecture_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_lecture(
    lecture_id: str,
    user: AuthUser = Depends(get_current_user),
) -> None:
    """Delete a lecture and its cached audio."""
    row = _own_lecture(lecture_id, user.id)

    paths = [
        c.get("storage_path") for c in (row.get("audio_chunks") or [])
        if c.get("storage_path")
    ]
    # Q&A rows cascade in the database, but their narrated answers live in
    # Storage, which the FK cascade cannot reach — collect them here too.
    qa_rows = (
        _client().table("lecture_qa").select("answer_audio_path")
        .eq("lecture_id", lecture_id).eq("user_id", user.id).execute()
    ).data or []
    paths += [r["answer_audio_path"] for r in qa_rows if r.get("answer_audio_path")]

    if paths:
        try:
            _client().storage.from_(settings.lecture_audio_bucket).remove(paths)
        except Exception:  # noqa: BLE001 - orphaned audio must not block delete
            logger.warning("Could not remove audio for lecture %s", lecture_id)

    _client().table("lectures").delete().eq("id", lecture_id).eq(
        "user_id", user.id
    ).execute()


# --- Read -------------------------------------------------------------------
# Declared last so the literal sub-paths above are matched first.
@router.get("", response_model=list[Lecture])
async def list_lectures(
    module_id: str | None = None,
    favourites_only: bool = False,
    user: AuthUser = Depends(get_current_user),
) -> list[Lecture]:
    """List the caller's lectures, newest first."""
    query = _client().table("lectures").select("*").eq("user_id", user.id)
    if module_id:
        query = query.eq("module_id", module_id)
    if favourites_only:
        query = query.eq("is_favourite", True)
    rows = (query.order("created_at", desc=True).execute()).data or []
    return [_to_lecture(r, with_transcript=False) for r in rows]


@router.get("/{domain_id}", response_model=Lecture)
async def get_lecture_for_domain(
    domain_id: str,
    voice: str | None = Query(None, description="marcus | sophia"),
    length: str | None = Query(None, description="short | medium | long"),
    user: AuthUser = Depends(get_current_user),
) -> Lecture:
    """The lecture for a domain, per spec §4.4.

    ``{domain_id}`` really is a domain id here, not a lecture id — the other
    routes in this section key off the lecture id. Optional ``voice``/``length``
    select between variants when a domain has more than one.
    """
    if voice and voice not in VOICES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"voice must be one of: {', '.join(VOICES)}")
    if length and length not in LENGTHS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"length must be one of: {', '.join(LENGTHS)}")

    query = (
        _client().table("lectures").select("*")
        .eq("domain_id", domain_id).eq("user_id", user.id)
    )
    if voice:
        query = query.eq("tutor_voice", voice)
    if length:
        query = query.eq("length_preference", length)

    rows = (query.order("created_at", desc=True).limit(1).execute()).data or []
    if not rows:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "No lecture for this domain yet — POST /lectures/generate first.",
        )
    return _to_lecture(rows[0], with_urls=True)

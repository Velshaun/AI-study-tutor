"""Mid-lecture voice Q&A, threaded into sessions — spec §4.5a / §4.5b.

    POST   /lectures/{lecture_id}/qa               ask (voice transcription)
    POST   /lectures/{lecture_id}/qa/end-session   end the active session
    GET    /lectures/{lecture_id}/qa-sessions      sessions for a lecture
    GET    /lectures/{lecture_id}/qa/stream        SSE: answers as they land
    GET    /qa-sessions/{session_id}/exchanges     full dialogue for a session
    DELETE /qa-sessions/{session_id}               delete a session
    DELETE /qa-exchanges/{entry_id}                delete one exchange

The browser owns speech recognition, the microphone button and the 2-second
silence threshold; this router receives the final transcription.

Every utterance is classified first (§4.5b). Only genuine questions get an
answer generated and increment the session badge — confirmations and closings
get a short in-character acknowledgement with no model call, and a closing ends
the session.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
from datetime import datetime, timezone
from typing import Any

from fastapi import (
    APIRouter,
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
from app.services import broadcast, question_bank
from app.services.qa import (
    QAError,
    answer_question,
    derive_session_title,
    synthesise_answer,
)
from app.services.qa_session import (
    SESSION_IDLE_SECS,
    classify_exchange,
    classify_intent,
    end_session,
    get_or_create_active_session,
    increment_question_count,
    touch_session,
)

logger = logging.getLogger(__name__)

# Two routers: the spec nests asking under a lecture, but reads a session's
# exchanges from the top level.
router = APIRouter(prefix="/lectures", tags=["qa"])
sessions_router = APIRouter(tags=["qa"])

SSE_KEEPALIVE_SECS = 15.0
SSE_MAX_SECS = 900.0

# Canned replies for non-questions. Generating these would add a model call and
# a second of latency to "got it" — the student wants the lecture to resume,
# not a considered response.
ACKNOWLEDGEMENTS: dict[str, dict[str, list[str]]] = {
    "marcus": {
        "confirmation": [
            "Good. Let me know if anything else comes up.",
            "Glad that landed. Anything else on this?",
            "Right, that's the key point. Anything further?",
        ],
        "closing": [
            "Good — let's pick up where we left off.",
            "Right then, back to it.",
            "Excellent. Carrying on.",
        ],
    },
    "sophia": {
        "confirmation": [
            "Perfect. Anything else you want to nail down?",
            "Great — that's the bit that matters. Anything else?",
            "Exactly. Any other questions on this?",
        ],
        "closing": [
            "Brilliant — let's keep going.",
            "Great, picking it back up.",
            "Perfect. Back to the lecture.",
        ],
    },
}


# --- Schemas ----------------------------------------------------------------
class AskRequest(BaseModel):
    voice_transcription: str = Field(
        ..., min_length=1, max_length=5000,
        description="Raw Web Speech API output, filler words and all.",
    )
    timestamp_secs: int = Field(0, ge=0)
    session_id: str | None = Field(
        None, description="Omit to continue the active session, or start one."
    )
    speak: bool = Field(True, description="Narrate the reply in the tutor's voice.")
    tutor_message: str | None = Field(
        None,
        max_length=5000,
        description="The tutor's last spoken message, for intent classification.",
    )


class ClassifyRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    tutor_message: str | None = Field(
        None,
        max_length=5000,
        description="The tutor's last message (the closing check-in), for "
                    "context-aware intent detection.",
    )


class ClassifyResponse(BaseModel):
    kind: str  # 'confirmation' | 'knowledge' | 'unclear'
    classified_by: str
    # True for the voice-first resume flow: a confirmation — or an unclear reply,
    # which is treated as one — means "carry on with the lecture"; a knowledge
    # question means "answer me".
    is_resume_signal: bool


class QAExchange(BaseModel):
    id: str
    session_id: str | None = None
    lecture_id: str | None = None
    question_summary: str | None = None
    answer: str | None = None
    timestamp_secs: int | None = None
    exchange_kind: str = "knowledge"
    is_knowledge_question: bool = True
    classified_by: str | None = None
    created_at: datetime | None = None
    answer_audio_url: str | None = None
    answer_audio_secs: int | None = None
    answer_voice: str | None = None
    full_transcription: str | None = None


class AskResponse(BaseModel):
    exchange: QAExchange
    session_id: str
    session_title: str | None = None
    question_count: int = 0
    exchange_kind: str = "knowledge"
    classified_by: str | None = None
    session_started: bool = False
    session_ended: bool = False
    end_reason: str | None = None
    audio_error: str | None = None


class QASession(BaseModel):
    id: str
    lecture_id: str | None = None
    domain_id: str | None = None
    session_title: str | None = None
    question_count: int = 0
    started_at: datetime | None = None
    ended_at: datetime | None = None
    end_reason: str | None = None
    last_activity_at: datetime | None = None
    is_active: bool = False
    exchanges: list[QAExchange] = Field(default_factory=list)


class QASessionSummary(BaseModel):
    """A session card's collapsed state (§5.6b) — enough to render without
    fetching the full dialogue."""

    id: str
    domain_id: str | None = None
    domain_title: str | None = None
    lecture_id: str | None = None
    session_title: str | None = None
    question_count: int = 0
    started_at: datetime | None = None
    ended_at: datetime | None = None
    end_reason: str | None = None
    # First genuine exchange, for the collapsed preview.
    preview_question: str | None = None
    preview_answer: str | None = None


# --- Helpers ----------------------------------------------------------------
def _client():
    try:
        return get_supabase()
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _one(table: str, row_id: str, user_id: str, label: str) -> dict[str, Any]:
    rows = (
        _client().table(table).select("*")
        .eq("id", row_id).eq("user_id", user_id).limit(1).execute()
    ).data or []
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{label} not found.")
    return rows[0]


def _audio_url(path: str | None) -> str | None:
    if not path:
        return None
    try:
        result = _client().storage.from_(
            settings.lecture_audio_bucket
        ).create_signed_url(path, settings.signed_url_ttl_secs)
    except Exception:  # noqa: BLE001
        return None
    if isinstance(result, dict):
        return result.get("signedURL") or result.get("signedUrl")
    return None


def _to_exchange(row: dict[str, Any], *, raw: bool = False) -> QAExchange:
    return QAExchange(
        id=row["id"],
        session_id=row.get("session_id"),
        lecture_id=row.get("lecture_id"),
        question_summary=row.get("question_summary"),
        answer=row.get("answer"),
        timestamp_secs=row.get("timestamp_secs"),
        exchange_kind=row.get("exchange_kind") or "knowledge",
        is_knowledge_question=bool(row.get("is_knowledge_question", True)),
        classified_by=row.get("classified_by"),
        created_at=row.get("created_at"),
        answer_audio_url=_audio_url(row.get("answer_audio_path")),
        answer_audio_secs=row.get("answer_audio_secs"),
        answer_voice=row.get("answer_voice"),
        full_transcription=row.get("full_transcription") if raw else None,
    )


def _to_session(row: dict[str, Any]) -> QASession:
    return QASession(
        id=row["id"],
        lecture_id=row.get("lecture_id"),
        domain_id=row.get("domain_id"),
        session_title=row.get("session_title"),
        question_count=row.get("question_count") or 0,
        started_at=row.get("started_at"),
        ended_at=row.get("ended_at"),
        end_reason=row.get("end_reason"),
        last_activity_at=row.get("last_activity_at"),
        is_active=not row.get("ended_at"),
    )


def _remove_audio(paths: list[str | None]) -> None:
    """Storage isn't reachable by the FK cascade — clean it explicitly."""
    real = [p for p in paths if p]
    if not real:
        return
    try:
        _client().storage.from_(settings.lecture_audio_bucket).remove(real)
    except Exception:  # noqa: BLE001 - orphaned audio must not block deletion
        logger.warning("Could not remove answer audio: %s", real)


# --- Ask --------------------------------------------------------------------
@router.post("/{lecture_id}/qa", response_model=AskResponse,
             status_code=status.HTTP_201_CREATED)
async def ask(
    lecture_id: str,
    payload: AskRequest,
    user: AuthUser = Depends(get_current_user),
) -> AskResponse:
    """Handle one spoken utterance.

    Classifies it first (§4.5b): a genuine question gets an answer, a cleaned
    summary and a badge increment; a confirmation gets a brief acknowledgement;
    a closing acknowledges and ends the session.
    """
    client = _client()
    lecture = _one("lectures", lecture_id, user.id, "Lecture")
    voice = lecture.get("tutor_voice") or "marcus"
    channel = f"qa:{lecture_id}"

    kind, classified_by = classify_exchange(
        payload.voice_transcription, payload.tutor_message
    )
    is_knowledge = kind == "knowledge"
    broadcast.publish(channel, {
        "event": "classified",
        "data": {"kind": kind, "classified_by": classified_by},
    })

    # Session resolution. An explicit id is honoured; otherwise the active
    # session continues, unless it has been idle past the 30s threshold.
    session_started = False
    if payload.session_id:
        session = _one("qa_sessions", payload.session_id, user.id, "Session")
        if session.get("ended_at"):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "That session has ended — omit session_id to start a new one.",
            )
    else:
        session, session_started = get_or_create_active_session(
            lecture_id, lecture.get("domain_id"), user.id
        )

    audio_error: str | None = None

    if is_knowledge:
        domain: dict[str, Any] = {}
        if lecture.get("domain_id"):
            rows = (client.table("domains").select("*")
                    .eq("id", lecture["domain_id"]).limit(1).execute()).data or []
            domain = rows[0] if rows else {}
        module: dict[str, Any] = {}
        if lecture.get("module_id"):
            rows = (client.table("modules").select("*")
                    .eq("id", lecture["module_id"]).limit(1).execute()).data or []
            module = rows[0] if rows else {}

        prior = (
            client.table("lecture_qa").select("*")
            .eq("user_id", user.id).eq("lecture_id", lecture_id)
            .eq("is_knowledge_question", True)
            .order("created_at").execute()
        ).data or []

        try:
            result = answer_question(
                voice=voice,
                raw_transcription=payload.voice_transcription,
                domain=domain,
                module=module,
                lecture_transcript=lecture.get("transcript") or "",
                prior=prior,
                timestamp_secs=payload.timestamp_secs,
            )
        except QAError as exc:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
        answer = result["answer"]
        summary = result["question_summary"]
    else:
        # No model call — the reply is a fixed pleasantry.
        answer = random.choice(
            ACKNOWLEDGEMENTS.get(voice, ACKNOWLEDGEMENTS["marcus"])[kind]
        )
        summary = payload.voice_transcription.strip()[:200]

    inserted = client.table("lecture_qa").insert({
        "lecture_id": lecture_id,
        "session_id": session["id"],
        "user_id": user.id,
        "question_summary": summary,
        "full_transcription": payload.voice_transcription,
        "answer": answer,
        "timestamp_secs": payload.timestamp_secs,
        "is_knowledge_question": is_knowledge,
        "exchange_kind": kind,
        "classified_by": classified_by,
    }).execute()
    if not inserted.data:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY,
                            "Could not save the exchange.")
    row = inserted.data[0]

    # Mirrored into the module's Q&A container. Only real questions: a
    # pleasantry is not something anyone wants to revise from, and
    # `is_knowledge_question` is the classification that already exists to say
    # which is which.
    if is_knowledge:
        question_bank.mirror_lecture_qa(
            user_id=user.id,
            module_id=(lecture or {}).get("module_id"),
            exchange_id=row["id"],
            question=payload.voice_transcription or summary,
            answer=answer,
            domain_id=(lecture or {}).get("domain_id"),
        )

    broadcast.publish(channel, {
        "event": "answer",
        "data": {"exchange_id": row["id"], "answer": answer,
                 "question_summary": summary, "kind": kind},
    })

    # Narrate. A TTS failure degrades to text rather than losing the reply.
    if payload.speak:
        try:
            path, secs = synthesise_answer(
                entry_id=row["id"], user_id=user.id, answer=answer, voice=voice,
            )
            updated = client.table("lecture_qa").update({
                "answer_audio_path": path,
                "answer_audio_secs": secs,
                "answer_voice": voice,
            }).eq("id", row["id"]).execute()
            if updated.data:
                row = updated.data[0]
            broadcast.publish(channel, {
                "event": "audio_ready",
                "data": {"exchange_id": row["id"], "duration_secs": secs},
            })
        except QAError as exc:
            audio_error = str(exc)
            logger.warning("Answer narration failed for %s: %s", row["id"], exc)

    # Badge counts genuine questions only (§4.5b).
    count = increment_question_count(session["id"], is_knowledge)
    if is_knowledge and not session.get("session_title"):
        title = derive_session_title(summary)
        client.table("qa_sessions").update(
            {"session_title": title}
        ).eq("id", session["id"]).execute()
        session["session_title"] = title

    # A closing ends the thread; anything else restarts the idle window.
    session_ended = False
    end_reason = None
    if kind == "closing":
        end_session(session["id"], "closing")
        session_ended = True
        end_reason = "closing"
        broadcast.publish(channel, {
            "event": "session_ended",
            "data": {"session_id": session["id"], "reason": "closing",
                     "question_count": count},
        })
    else:
        touch_session(session["id"])

    return AskResponse(
        exchange=_to_exchange(row),
        session_id=session["id"],
        session_title=session.get("session_title"),
        question_count=count,
        exchange_kind=kind,
        classified_by=classified_by,
        session_started=session_started,
        session_ended=session_ended,
        end_reason=end_reason,
        audio_error=audio_error,
    )


@router.post("/{lecture_id}/qa/classify", response_model=ClassifyResponse)
async def classify(
    lecture_id: str,
    payload: ClassifyRequest,
    user: AuthUser = Depends(get_current_user),
) -> ClassifyResponse:
    """Classify an utterance without answering, saving, or narrating it.

    The voice-first resume flow needs to know, the instant the student finishes
    speaking, whether they confirmed (resume the lecture) or asked something
    (generate an answer). Running the full ``/qa`` pipeline just to find out
    would generate a throwaway acknowledgement and its TTS for every "yeah" —
    so this exposes the classifier on its own.

    Intent is decided by AI from the meaning of the reply in the context of the
    tutor's last message — no keyword matching. An ``unclear`` reply is a resume
    signal too: the student is never asked to repeat themselves.
    """
    _one("lectures", lecture_id, user.id, "Lecture")
    intent, classified_by = classify_intent(payload.text, payload.tutor_message)
    return ClassifyResponse(
        kind=intent,
        classified_by=classified_by,
        is_resume_signal=intent in ("confirmation", "unclear"),
    )


@router.post("/{lecture_id}/qa/end-session", response_model=QASession)
async def end_active_session(
    lecture_id: str,
    user: AuthUser = Depends(get_current_user),
) -> QASession:
    """End the lecture's active session — the "End session" button."""
    _one("lectures", lecture_id, user.id, "Lecture")
    open_rows = (
        _client().table("qa_sessions").select("*")
        .eq("lecture_id", lecture_id).eq("user_id", user.id)
        .is_("ended_at", "null")
        .order("last_activity_at", desc=True).limit(1).execute()
    ).data or []
    if not open_rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            "No active session for this lecture.")

    closed = end_session(open_rows[0]["id"], "manual")
    broadcast.publish(f"qa:{lecture_id}", {
        "event": "session_ended",
        "data": {"session_id": open_rows[0]["id"], "reason": "manual"},
    })
    return _to_session(closed or open_rows[0])


# --- Read -------------------------------------------------------------------
@router.get("/{lecture_id}/qa-sessions", response_model=list[QASession])
async def lecture_sessions(
    lecture_id: str,
    include_empty: bool = Query(
        False,
        description="Include sessions with no genuine questions (nothing to "
                    "review).",
    ),
    user: AuthUser = Depends(get_current_user),
) -> list[QASession]:
    """All sessions for a lecture, with question_count and session_title."""
    _one("lectures", lecture_id, user.id, "Lecture")
    rows = (
        _client().table("qa_sessions").select("*")
        .eq("lecture_id", lecture_id).eq("user_id", user.id)
        .order("started_at", desc=True).execute()
    ).data or []
    return [
        _to_session(r) for r in rows
        if include_empty or (r.get("question_count") or 0) > 0
    ]


@sessions_router.get("/qa-sessions", response_model=list[QASessionSummary])
async def domain_sessions(
    domain_id: str = Query(..., description="Domain whose Q&A review to show."),
    user: AuthUser = Depends(get_current_user),
) -> list[QASessionSummary]:
    """All Q&A sessions for a domain, newest first — the §5.6b review screen.

    Domain-scoped rather than lecture-scoped: a domain can have several lectures
    (voice and length variants), and review is about the topic, not one
    recording. Each summary carries a first-exchange preview so the cards render
    without a per-session round trip; the full dialogue loads on expand.

    Sessions with no genuine question are omitted — a "got it, thanks" that
    started and ended a thread has nothing to review.
    """
    client = _client()
    rows = (
        client.table("qa_sessions").select("*")
        .eq("domain_id", domain_id).eq("user_id", user.id)
        .order("started_at", desc=True).execute()
    ).data or []
    sessions = [r for r in rows if (r.get("question_count") or 0) > 0]
    if not sessions:
        return []

    # The domain's title, for the "Q&A History — {domain}" page heading.
    domain_rows = (
        client.table("domains").select("title")
        .eq("id", domain_id).eq("user_id", user.id).limit(1).execute()
    ).data or []
    domain_title = domain_rows[0].get("title") if domain_rows else None

    # One query for the first knowledge exchange of every session, rather than
    # a query per card.
    session_ids = [s["id"] for s in sessions]
    exchanges = (
        client.table("lecture_qa")
        .select("session_id, question_summary, answer, created_at")
        .in_("session_id", session_ids)
        .eq("is_knowledge_question", True)
        .order("created_at").execute()
    ).data or []

    preview: dict[str, dict[str, Any]] = {}
    for ex in exchanges:
        preview.setdefault(ex["session_id"], ex)  # first (oldest) wins

    return [
        QASessionSummary(
            id=s["id"],
            domain_id=s.get("domain_id"),
            domain_title=domain_title,
            lecture_id=s.get("lecture_id"),
            session_title=s.get("session_title"),
            question_count=s.get("question_count") or 0,
            started_at=s.get("started_at"),
            ended_at=s.get("ended_at"),
            end_reason=s.get("end_reason"),
            preview_question=(preview.get(s["id"]) or {}).get("question_summary"),
            preview_answer=(preview.get(s["id"]) or {}).get("answer"),
        )
        for s in sessions
    ]


@sessions_router.get("/qa-sessions/{session_id}/exchanges",
                     response_model=QASession)
async def session_exchanges(
    session_id: str,
    include_all: bool = Query(
        True,
        description="Include confirmations and closings, so the thread reads "
                    "as a conversation. False shows questions only.",
    ),
    include_raw: bool = Query(
        False, description="Include the raw voice transcription."
    ),
    user: AuthUser = Depends(get_current_user),
) -> QASession:
    """The full dialogue for one session, in order."""
    session = _one("qa_sessions", session_id, user.id, "Session")
    query = (
        _client().table("lecture_qa").select("*")
        .eq("session_id", session_id).eq("user_id", user.id)
    )
    if not include_all:
        query = query.eq("is_knowledge_question", True)
    rows = (query.order("created_at").execute()).data or []

    payload = _to_session(session)
    payload.exchanges = [_to_exchange(r, raw=include_raw) for r in rows]
    return payload


@sessions_router.delete("/qa-sessions/{session_id}",
                        status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
) -> None:
    """Delete a session; exchanges cascade and their audio is removed."""
    _one("qa_sessions", session_id, user.id, "Session")
    client = _client()
    entries = (
        client.table("lecture_qa").select("answer_audio_path")
        .eq("session_id", session_id).eq("user_id", user.id).execute()
    ).data or []
    _remove_audio([e.get("answer_audio_path") for e in entries])
    client.table("qa_sessions").delete().eq("id", session_id).eq(
        "user_id", user.id
    ).execute()


@sessions_router.delete("/qa-exchanges/{entry_id}",
                        status_code=status.HTTP_204_NO_CONTENT)
async def delete_exchange(
    entry_id: str,
    user: AuthUser = Depends(get_current_user),
) -> None:
    """Delete one exchange, keeping the session's badge count consistent."""
    entry = _one("lecture_qa", entry_id, user.id, "Exchange")
    client = _client()
    _remove_audio([entry.get("answer_audio_path")])
    client.table("lecture_qa").delete().eq("id", entry_id).eq(
        "user_id", user.id
    ).execute()

    if entry.get("is_knowledge_question") and entry.get("session_id"):
        rows = (
            client.table("qa_sessions").select("question_count")
            .eq("id", entry["session_id"]).limit(1).execute()
        ).data or []
        if rows:
            client.table("qa_sessions").update(
                {"question_count": max(0, (rows[0].get("question_count") or 1) - 1)}
            ).eq("id", entry["session_id"]).execute()


# --- Live channel -----------------------------------------------------------
@router.get("/{lecture_id}/qa/stream")
async def stream_qa(
    lecture_id: str,
    request: Request,
    token: str | None = Query(
        None, description="Access token; EventSource cannot send headers."
    ),
    authorization: str | None = Header(None),
) -> StreamingResponse:
    """SSE channel for Q&A activity on a lecture.

    Events: ``classified``, ``answer``, ``audio_ready``, ``session_ended``.

    The answer arrives as one ``answer`` event rather than token-by-token: it
    comes from a structured-output call that returns the reply and the cleaned
    question together, and partial JSON cannot be streamed usefully. The
    ``classified`` event fires first, so the UI can show "thinking…" for a
    question or resume immediately for a confirmation.
    """
    header = authorization or (f"Bearer {token}" if token else None)
    if not header:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing access token.")
    user = await get_current_user(authorization=header)
    _one("lectures", lecture_id, user.id, "Lecture")

    channel = f"qa:{lecture_id}"

    async def events():
        queue = await broadcast.subscribe(channel)
        try:
            elapsed = 0.0
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(
                        queue.get(), timeout=SSE_KEEPALIVE_SECS
                    )
                except asyncio.TimeoutError:
                    elapsed += SSE_KEEPALIVE_SECS
                    if elapsed >= SSE_MAX_SECS:
                        break
                    yield ": keepalive\n\n"
                    continue
                elapsed = 0.0
                yield (f"event: {event['event']}\n"
                       f"data: {json.dumps(event['data'])}\n\n")
        finally:
            await broadcast.unsubscribe(channel, queue)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive",
                 "X-Accel-Buffering": "no"},
    )

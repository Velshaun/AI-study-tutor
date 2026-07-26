"""Q&A session grouping — spec §4.5b.

A session is one conversational thread on one topic. Follow-ups stay in the
same session; a new topic starts a new one.

    classify_intent(response, tutor_message) -> 'confirmation'|'knowledge'|'unclear'
    classify_exchange(text, tutor_message)   -> stored 'knowledge'|'confirmation'
    create_session(lecture_id, domain_id) -> session id
    end_session(session_id)               -> sets ended_at
    increment_question_count(session_id)  -> only for knowledge questions
    get_or_create_active_session(lecture_id) -> open session, or a new one

Classification is entirely AI-driven: a single Gemini call reads the student's
spoken reply in the context of the tutor's last message (the closing check-in)
and returns the student's *intent*. There are no hardcoded word or phrase lists
anywhere — "right on", "good to go", "I think I understand" and countless other
natural confirmations are recognised by meaning, not by matching a fixed list.

Intent is one of:
  * confirmation — satisfied, ready to continue the lecture
  * knowledge    — asking a new question or for more explanation
  * unclear      — too ambiguous to classify confidently

An unclear reply is treated as a confirmation and the lecture resumes: the
student is never asked to repeat themselves, and can re-open the mic if they
did have a question.

Session boundaries (§4.5b):
  * the student signals they're ready to continue  -> 'closing'
  * they tap "End session"                         -> 'manual'
  * 30 seconds pass with no new question           -> 'timeout'

The timeout is evaluated lazily, when the next question arrives. Nothing
observes an expired session in the meantime, so a background sweep would buy
nothing.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from app.config import settings
from app.database import get_supabase

logger = logging.getLogger(__name__)

# What the AI classifier decides — the student's intent.
Intent = Literal["confirmation", "knowledge", "unclear"]
# What gets stored on the exchange row (the DB CHECK constraint permits these).
ExchangeKind = Literal["knowledge", "confirmation", "closing"]

# §4.5b: a session lapses after 30 seconds of silence and the lecture resumes.
SESSION_IDLE_SECS = 30

INTENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "intent": {
            "type": "string",
            "enum": ["confirmation", "knowledge", "unclear"],
            "description": (
                "'confirmation' if the student is satisfied and ready to "
                "continue the lecture; 'knowledge' if they are asking a new "
                "question or for more explanation; 'unclear' if the reply is "
                "too ambiguous to classify confidently."
            ),
        },
        "confidence": {
            "type": "number",
            "description": "Confidence in the chosen intent, from 0 to 1.",
        },
    },
    "required": ["intent"],
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --- classification ---------------------------------------------------------
def classify_intent(
    student_response: str, tutor_message: str | None = None
) -> tuple[Intent, str]:
    """Detect the student's intent with a single Gemini call — no keyword lists.

    Reads the student's spoken reply in the context of the tutor's last message
    (the closing check-in, e.g. "Does that make sense?") and decides intent from
    *meaning*, so any natural confirmation works — "right on", "good to go",
    "I think I understand", "makes sense now" — without matching a fixed list.

    Returns ``(intent, decided_by)``. Falls back to ``'knowledge'`` only when
    Gemini is unavailable, so an API outage never silently swallows a real
    question. A genuine *unclear* verdict is returned as-is (the caller resumes).
    """
    text = (student_response or "").strip()
    if not text:
        return "unclear", "empty"
    if not settings.gemini_api_key:
        return "knowledge", "default"

    import json

    from google.genai import types

    from app.services.domains import _generate

    tutor = (tutor_message or "").strip()
    context = (
        f'The tutor had just said to them: "{tutor[:600]}"\n'
        if tutor
        else "The tutor had not asked them anything yet.\n"
    )
    prompt = (
        "A student is partway through an audio lecture, which they paused to "
        "speak to the tutor. Decide the student's intent from the MEANING of "
        "what they said in context — never from specific keywords or phrases, "
        "and never from how short or long the reply is.\n\n"
        + context
        + f'The student then said: "{text[:600]}"\n\n'
        "Classify the reply as exactly one intent:\n"
        "- confirmation: the student is satisfied and ready to continue the "
        "lecture. This covers any agreement or acknowledgement — from a plain "
        "\"yes\" to \"good to go\", \"makes sense now\", \"I understand now\", "
        "\"sounds good\", \"alright let's keep going\" — i.e. any signal that "
        "they are done for now.\n"
        "- knowledge: the student is asking a new question, or asking for more "
        "explanation, clarification, repetition or an example.\n"
        "- unclear: the reply is too ambiguous to classify confidently, such as "
        "a hesitant \"hmm\", \"maybe\", or \"okay I think so\".\n\n"
        "Give a confidence from 0 to 1 for your chosen intent."
    )
    try:
        response = _generate(
            "classify_intent",
            model=settings.gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=INTENT_SCHEMA,
                temperature=0.0,
            ),
        )
        intent = json.loads(response.text).get("intent")
        if intent in ("confirmation", "knowledge", "unclear"):
            return intent, "gemini"
    except Exception as exc:  # noqa: BLE001 - classification must never block
        logger.warning(
            "Intent classification failed, defaulting to knowledge: %s", exc
        )
    return "knowledge", "default"


def classify_exchange(
    text: str, tutor_message: str | None = None
) -> tuple[ExchangeKind, str]:
    """Classify an utterance for the ask endpoint, mapping the AI intent onto
    the stored ``exchange_kind``.

        knowledge    -> 'knowledge'    (answered; counts toward the badge)
        confirmation -> 'confirmation' (brief acknowledgement, no answer)
        unclear      -> 'confirmation' (treated as one; the lecture resumes)
    """
    intent, decided_by = classify_intent(text, tutor_message)
    kind: ExchangeKind = "knowledge" if intent == "knowledge" else "confirmation"
    return kind, decided_by


# --- session titling --------------------------------------------------------
def auto_generate_session_title(first_question_summary: str) -> str:
    """A short card title derived from a session's first question (Prompt 5).

    The cleaned summary is already a single sentence, so this just trims the
    trailing question mark, caps the length, and sentence-cases it.
    """
    title = (first_question_summary or "").strip().rstrip("?").strip()
    if not title:
        return "Q&A session"
    if len(title) > 60:
        title = title[:57].rsplit(" ", 1)[0] + "…"
    return title[:1].upper() + title[1:]


# --- session lifecycle ------------------------------------------------------
def create_session(lecture_id: str, domain_id: str | None,
                   user_id: str) -> dict[str, Any]:
    """Open a new session for a lecture."""
    inserted = get_supabase().table("qa_sessions").insert({
        "lecture_id": lecture_id,
        "domain_id": domain_id,
        "user_id": user_id,
        "question_count": 0,
        "last_activity_at": _now().isoformat(),
    }).execute()
    if not inserted.data:
        raise RuntimeError("Could not create a Q&A session.")
    logger.info("Opened Q&A session %s for lecture %s",
                inserted.data[0]["id"], lecture_id)
    return inserted.data[0]


def end_session(session_id: str, reason: str = "manual") -> dict[str, Any] | None:
    """Close a session, recording why. Idempotent."""
    client = get_supabase()
    existing = (
        client.table("qa_sessions").select("*")
        .eq("id", session_id).limit(1).execute()
    ).data or []
    if not existing:
        return None
    if existing[0].get("ended_at"):
        return existing[0]

    updated = client.table("qa_sessions").update({
        "ended_at": _now().isoformat(),
        "end_reason": reason,
    }).eq("id", session_id).execute()
    logger.info("Closed Q&A session %s (%s)", session_id, reason)
    return (updated.data or [existing[0]])[0]


def increment_question_count(session_id: str,
                             is_knowledge_question: bool) -> int:
    """Bump the badge count — only ever for genuine questions (§4.5b)."""
    client = get_supabase()
    rows = (
        client.table("qa_sessions").select("question_count")
        .eq("id", session_id).limit(1).execute()
    ).data or []
    current = (rows[0].get("question_count") if rows else 0) or 0

    if not is_knowledge_question:
        return current

    updated = client.table("qa_sessions").update(
        {"question_count": current + 1}
    ).eq("id", session_id).execute()
    return (updated.data[0]["question_count"] if updated.data else current + 1)


def touch_session(session_id: str) -> None:
    """Record activity, restarting the 30-second idle window."""
    get_supabase().table("qa_sessions").update(
        {"last_activity_at": _now().isoformat()}
    ).eq("id", session_id).execute()


def is_expired(session: dict[str, Any], idle_secs: int = SESSION_IDLE_SECS) -> bool:
    """Whether a session has been silent past the idle threshold."""
    if session.get("ended_at"):
        return True
    stamp = session.get("last_activity_at") or session.get("started_at")
    if not stamp:
        return False
    try:
        last = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return False
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return _now() - last > timedelta(seconds=idle_secs)


def get_or_create_active_session(
    lecture_id: str,
    domain_id: str | None,
    user_id: str,
    *,
    idle_secs: int = SESSION_IDLE_SECS,
) -> tuple[dict[str, Any], bool]:
    """The session to record into. Returns ``(session, created)``.

    Closes an idle session first, so the next question starts a fresh thread —
    this is where the 30-second rule is actually enforced.
    """
    open_sessions = (
        get_supabase().table("qa_sessions").select("*")
        .eq("lecture_id", lecture_id).eq("user_id", user_id)
        .is_("ended_at", "null")
        .order("last_activity_at", desc=True).limit(1).execute()
    ).data or []

    if open_sessions:
        session = open_sessions[0]
        if not is_expired(session, idle_secs):
            return session, False
        end_session(session["id"], "timeout")
        logger.info("Session %s timed out after %ds idle", session["id"], idle_secs)

    return create_session(lecture_id, domain_id, user_id), True

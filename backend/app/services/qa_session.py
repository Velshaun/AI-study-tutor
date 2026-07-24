"""Q&A session grouping — spec §4.5b.

A session is one conversational thread on one topic. Follow-ups stay in the
same session; a new topic starts a new one.

    classify_exchange(text)              -> 'knowledge' | 'confirmation' | 'closing'
    create_session(lecture_id, domain_id) -> session id
    end_session(session_id)               -> sets ended_at
    increment_question_count(session_id)  -> only for knowledge questions
    get_or_create_active_session(lecture_id) -> open session, or a new one

Classification uses keyword matching *then* Gemini, in that order. The keyword
pass resolves the overwhelmingly common cases — "got it", "yeah let's go",
anything phrased as a question — without an API call, which matters because
this sits on the hot path while the student is paused mid-lecture. Gemini is
consulted only for genuinely ambiguous utterances.

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
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from app.config import settings
from app.database import get_supabase

logger = logging.getLogger(__name__)

ExchangeKind = Literal["knowledge", "confirmation", "closing"]

# §4.5b: a session lapses after 30 seconds of silence and the lecture resumes.
SESSION_IDLE_SECS = 30

# Keyword matching only applies to short utterances. "Okay, so what is a
# Trojan?" starts like a confirmation but is plainly a question, so length and
# question-shape are checked first.
MAX_KEYWORD_CHARS = 70

CONFIRMATION_PHRASES = (
    "got it", "gotcha", "okay", "ok", "oh ok", "alright", "all right",
    "that makes sense", "makes sense", "understood", "i see", "i understand",
    "yes", "yeah", "yep", "yup", "sure", "right", "cool", "nice", "perfect",
    "great", "thanks", "thank you", "cheers", "brilliant", "fair enough",
    "no worries", "sounds good", "clear",
)

CLOSING_PHRASES = (
    "ready to continue", "ready", "let's go", "lets go", "let's continue",
    "lets continue", "move on", "moving on", "good to go", "carry on",
    "keep going", "continue", "next", "go ahead", "play", "resume",
    "i'm done", "im done", "that's all", "thats all", "no more questions",
    "nothing else", "we can continue", "back to the lecture",
)

QUESTION_STARTERS = (
    "what", "why", "how", "when", "where", "which", "who", "whose", "whom",
    "can you", "could you", "would you", "is it", "are they", "does",
    "do you", "did", "should", "explain", "tell me", "describe", "define",
    "clarify", "elaborate", "give me an example", "i don't understand",
    "i dont understand", "i'm confused", "im confused", "not sure what",
    "what's the difference", "whats the difference",
)

# Interrogative phrases that mark a question wherever they appear, not just at
# the start — spoken questions are routinely prefixed with a filler
# acknowledgement ("okay but what about worms", "right but how does that
# differ"). Without these, such utterances fall through to a Gemini call for
# what is obviously a question.
#
# Deliberately narrow: bare "what" would misfire on "that's what I thought",
# so each pattern pins the interrogative to its following word.
INTERROGATIVE_PATTERNS = tuple(re.compile(p) for p in (
    r"\bwhat(?:'?s| is| are| was| were| does| do| about| happens| makes)\b",
    r"\bhow(?:'?s| is| are| does| do| did| can| would| much| many| come)\b",
    r"\bwhy(?:'?s| is| are| does| do| did| would| not)\b",
    r"\bwhen(?:'?s| is| are| does| do| did| would)\b",
    r"\bwhere(?:'?s| is| are| does| do| did)\b",
    r"\bwhich(?: is| are| one| of)\b",
    r"\b(?:can|could|would|should) (?:you|i|we|it|they)\b",
    r"\bis (?:there|that|it|this) (?:a|an|the|any)\b",
    r"\b(?:difference|differ) (?:between|from)\b",
    r"\bnot (?:really )?sure (?:what|how|why|if|when)\b",
    r"\b(?:don'?t|do not) (?:understand|get|follow)\b",
    r"\b(?:explain|clarify|elaborate)\b",
    r"\btell me (?:about|more|what|how|why)\b",
    r"\bwhat if\b",
))

CLASSIFY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "kind": {
            "type": "string",
            "enum": ["knowledge", "confirmation", "closing"],
            "description": (
                "'knowledge' if asking for information, clarification or "
                "explanation; 'confirmation' for acknowledgements and "
                "pleasantries; 'closing' if signalling they're ready to "
                "resume the lecture."
            ),
        },
    },
    "required": ["kind"],
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _normalise(text: str) -> str:
    """Lowercase, strip punctuation and filler, for keyword comparison."""
    cleaned = (text or "").lower().strip()
    cleaned = re.sub(r"\b(um|uh|er|erm|like|you know|i mean|so|well)\b", " ", cleaned)
    cleaned = re.sub(r"[^\w\s']", " ", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


# --- classification ---------------------------------------------------------
def classify_by_keyword(text: str) -> ExchangeKind | None:
    """Fast path. Returns None when the utterance needs a real model."""
    raw = (text or "").strip()
    if not raw:
        return None

    normalised = _normalise(raw)
    if not normalised:
        return None

    words = normalised.split()

    # Anything question-shaped is a knowledge question, whatever its length.
    if "?" in raw or any(normalised.startswith(q) for q in QUESTION_STARTERS):
        return "knowledge"

    # ...including questions buried behind a filler acknowledgement.
    lowered = raw.lower()
    if any(pattern.search(lowered) for pattern in INTERROGATIVE_PATTERNS):
        return "knowledge"

    # Beyond this point only short utterances are safe to match on keywords.
    if len(raw) > MAX_KEYWORD_CHARS or len(words) > 12:
        return None

    # Closing is checked before confirmation: "yeah, let's go" is both an
    # acknowledgement and a signal to resume, and resuming is what matters.
    if any(phrase in normalised for phrase in CLOSING_PHRASES):
        return "closing"

    if any(phrase in normalised for phrase in CONFIRMATION_PHRASES):
        # Every word must be part of the pleasantry — "okay but what about
        # worms" must not slip through as a confirmation.
        filler = set()
        for phrase in CONFIRMATION_PHRASES:
            filler.update(phrase.split())
        filler.update({"that", "it", "this", "now", "very", "really", "much", "a"})
        # Students address the tutor by name: "got it, thanks Marcus".
        filler.update({"marcus", "sophia"})
        if all(word in filler for word in words):
            return "confirmation"

    return None


def classify_by_gemini(text: str) -> ExchangeKind | None:
    """Ask Gemini when keywords are inconclusive. None if unavailable."""
    if not settings.gemini_api_key:
        return None

    from google.genai import types

    from app.services.domains import _generate

    prompt = (
        "A student paused an audio lecture and said this out loud. Classify "
        "what they are doing.\n\n"
        "knowledge    — asking for information, clarification or explanation\n"
        "confirmation — acknowledging or thanking; no new question\n"
        "closing      — signalling they are ready to resume the lecture\n\n"
        f"They said: \"{text.strip()[:600]}\""
    )
    try:
        response = _generate(
            "classify",
            model=settings.gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=CLASSIFY_SCHEMA,
                temperature=0.0,
            ),
        )
        import json

        kind = json.loads(response.text).get("kind")
        return kind if kind in ("knowledge", "confirmation", "closing") else None
    except Exception as exc:  # noqa: BLE001 - classification must never block
        logger.warning("Gemini classification failed, defaulting: %s", exc)
        return None


def classify_exchange(text: str) -> tuple[ExchangeKind, str]:
    """Classify an utterance. Returns ``(kind, decided_by)``.

    Defaults to 'knowledge' when nothing is certain — answering a pleasantry
    wastes a little money, but silently swallowing a real question loses the
    student's actual point.
    """
    keyword = classify_by_keyword(text)
    if keyword:
        return keyword, "keyword"

    gemini = classify_by_gemini(text)
    if gemini:
        return gemini, "gemini"

    return "knowledge", "default"


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

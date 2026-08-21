"""Mid-lecture voice Q&A — spec §4.5a.

Scope boundary: the Web Speech API runs in the **browser**. Live transcription,
the 2-second silence threshold, and the microphone button are all frontend
concerns. This module starts where the browser finishes — it receives the final
raw transcription and turns it into a saved exchange.

The defining constraint is that Gemini must do two things in **one** API call:

    a) answer the question conversationally, in the tutor's character
    b) produce a clean summary of the question, stripping 'um', 'like',
       false starts and tangents while keeping the actual question

A second call would double both latency and cost on the hot path — the student
is waiting mid-lecture. A ``response_schema`` gets both fields back at once,
which works because no search grounding is involved here (the API rejects tools
combined with a JSON schema).

A third field, ``is_knowledge_question``, distinguishes real questions from
confirmations and closings ("got it, thanks"). Only real questions count toward
``qa_sessions.question_count`` and appear in review.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from app.config import settings
from app.services.domains import _generate, quota_hint
from app.services.lecture_gen import WORDS_PER_MINUTE
# The tutors — shared with lecture generation so both speak as the same person.
from app.services.personas import PERSONAS

logger = logging.getLogger(__name__)

# How much prior conversation to carry. Enough for follow-ups ("what about the
# other one?") to resolve, without unbounded prompt growth over a long session.
MAX_PRIOR_EXCHANGES = 12
MAX_TRANSCRIPT_CHARS = 12000

QA_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "answer": {
            "type": "string",
            "description": "The spoken answer, in character, 2-5 sentences.",
        },
        "question_summary": {
            "type": "string",
            "description": (
                "The student's question, cleaned up: filler words, false "
                "starts, self-corrections and tangents removed. One clear "
                "sentence, phrased as a question, in the student's own voice."
            ),
        },
        "is_knowledge_question": {
            "type": "boolean",
            "description": (
                "True if the student is genuinely asking about the subject. "
                "False for acknowledgements, confirmations, closings, or "
                "off-topic chatter ('got it thanks', 'can you repeat that')."
            ),
        },
    },
    "required": ["answer", "question_summary", "is_knowledge_question"],
}


class QAError(RuntimeError):
    """A question could not be answered."""


def transcript_up_to(transcript: str, timestamp_secs: int) -> str:
    """The portion of the lecture the student has actually heard.

    Answers must not spoil material still ahead of the playhead, so the script
    is cut at the current position. Words-per-minute is the same figure used to
    estimate lecture duration, so the two stay consistent.
    """
    if not transcript:
        return ""
    if timestamp_secs <= 0:
        return ""

    words = transcript.split()
    spoken = max(1, int(WORDS_PER_MINUTE * (timestamp_secs / 60)))
    heard = " ".join(words[:spoken])
    return heard[-MAX_TRANSCRIPT_CHARS:]


def _history_block(prior: list[dict[str, Any]]) -> str:
    """Render earlier exchanges so follow-up questions resolve."""
    if not prior:
        return ""
    lines = []
    for entry in prior[-MAX_PRIOR_EXCHANGES:]:
        question = entry.get("question_summary") or entry.get("full_transcription") or ""
        answer = entry.get("answer") or ""
        if question:
            lines.append(f"Student: {question}\nYou: {answer}")
    if not lines:
        return ""
    return (
        "\n--- EARLIER IN THIS DOMAIN (most recent last) ---\n"
        + "\n\n".join(lines)
        + "\n"
    )


def build_prompt(
    *,
    voice: str,
    raw_transcription: str,
    domain: dict[str, Any],
    module: dict[str, Any],
    heard_transcript: str,
    prior: list[dict[str, Any]],
    timestamp_secs: int,
) -> str:
    persona = PERSONAS.get((voice or "marcus").lower(), PERSONAS["marcus"])
    subject = module.get("detected_subject") or module.get("title") or "this subject"
    minutes, seconds = divmod(max(0, timestamp_secs), 60)

    return (
        f"You are {persona['name']}, an AI tutor delivering an audio lecture.\n"
        f"CHARACTER: {persona['style']}\n\n"
        f"SUBJECT: {subject}\n"
        f"CURRENT TOPIC: {domain.get('title')}\n"
        + (f"TOPIC SCOPE: {domain.get('description')}\n" if domain.get("description") else "")
        + f"\nThe student paused you {minutes}m{seconds:02d}s into the lecture to ask "
        "something out loud. Their speech was transcribed automatically, so it "
        "contains filler words, false starts and self-corrections.\n"
        + (f"\n--- LECTURE SO FAR (all they have heard) ---\n{heard_transcript}\n"
           if heard_transcript else "")
        + _history_block(prior)
        + f"\n--- RAW VOICE TRANSCRIPTION ---\n{raw_transcription}\n\n"
        "Do BOTH of the following:\n\n"
        "1. ANSWER — reply as " + persona["name"] + " would speak it aloud. "
        "Stay in character. Answer what they asked, in 2-5 sentences. "
        "Write plain spoken prose: no markdown, no lists, no headings.\n"
        "   ALWAYS answer the question directly. Never refuse, defer, or tell "
        "them to wait — 'we haven't covered that yet' is not an acceptable "
        "reply. They stopped the lecture precisely because they want to know "
        "now. If the answer runs ahead of the material, or belongs to another "
        "topic entirely, give them the full answer anyway; you may add one "
        "short closing sentence noting you will go deeper on it later.\n"
        "   The lecture text above is context for what they already know — use "
        "it to pitch the answer at the right level, not to limit what you are "
        "willing to explain.\n"
        "   If their question is ambiguous, answer the most likely reading "
        "rather than asking them to clarify — they are mid-lecture.\n"
        "   FINISH with a brief, natural check-in spoken in your own voice — "
        "something like 'Does that make sense?' or 'Want to keep going?' — as a "
        "single short closing sentence. This is how you hand back to the "
        "student: it invites them to either ask another question or simply say "
        "they're ready to continue. Phrase it as natural speech, never as an "
        "on-screen instruction like 'tap to continue'.\n\n"
        "2. SUMMARISE THE QUESTION — rewrite what they asked as one clean "
        "sentence for their revision notes. Strip every 'um', 'like', 'you "
        "know', repetition, false start and tangent. Keep only the actual "
        "question, phrased in their own voice. Do not answer it here and do "
        "not add context they did not ask about.\n\n"
        "Also decide whether this was a genuine subject question, or just an "
        "acknowledgement/confirmation/closing remark.\n\n"
        "Use British spelling throughout."
    )


def answer_question(
    *,
    voice: str,
    raw_transcription: str,
    domain: dict[str, Any],
    module: dict[str, Any],
    lecture_transcript: str,
    prior: list[dict[str, Any]],
    timestamp_secs: int,
) -> dict[str, Any]:
    """One Gemini call returning answer + cleaned question + classification."""
    if not settings.gemini_api_key:
        raise QAError("GEMINI_API_KEY is not configured.")

    cleaned = (raw_transcription or "").strip()
    if len(cleaned) < 2:
        raise QAError("No speech was transcribed.")

    from google.genai import types

    prompt = build_prompt(
        voice=voice,
        raw_transcription=cleaned,
        domain=domain,
        module=module,
        heard_transcript=transcript_up_to(lecture_transcript, timestamp_secs),
        prior=prior,
        timestamp_secs=timestamp_secs,
    )

    try:
        response = _generate(
            "qa",
            model=settings.gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=QA_SCHEMA,
                temperature=0.6,
                # Thinking off, and only here.
                #
                # Measured: it takes the first token from 1370ms to 356ms — a
                # second of silence removed by one line, which is more than the
                # entire rest of this round of latency work saved put together.
                #
                # It is the right trade for exactly this call and the wrong one
                # almost everywhere else. A spoken reply is two or three
                # sentences of recall while a learner sits waiting in a paused
                # lecture; deriving a blueprint or judging coverage is a
                # judgement, and those paths keep their thinking budget.
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        )
        data = json.loads(response.text)
    except json.JSONDecodeError as exc:
        raise QAError(f"Tutor returned invalid JSON: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise QAError(quota_hint(exc) or f"Could not answer the question: {exc}") from exc

    answer = (data.get("answer") or "").strip()
    summary = (data.get("question_summary") or "").strip()
    if not answer:
        raise QAError("The tutor returned an empty answer.")

    # Fall back to the raw text if summarisation produced nothing usable, so an
    # exchange is never saved with no readable question.
    if not summary:
        summary = cleaned[:200]

    return {
        "answer": answer,
        "question_summary": summary[:500],
        "is_knowledge_question": bool(data.get("is_knowledge_question", True)),
    }


def narrate(*, answer: str, voice: str, entry_id: str = "") -> tuple[bytes, int]:
    """Turn an answer into audio bytes. Stores nothing.

    Split out from `synthesise_answer` because playback was waiting on
    persistence it does not need: the old path synthesised, uploaded to
    Storage, handed back a signed URL, and only then could the browser start
    downloading. That is a full round trip through a bucket inserted between a
    learner finishing a question and hearing a reply — measurable dead air
    bought nothing, since the bytes were already in memory.

    Answers are 2-5 sentences, comfortably inside the ~4096-character TTS
    limit, so this is always a single object. An unusually long answer is cut
    at a sentence boundary rather than split into chunks the player would have
    to stitch together.
    """
    if not settings.openai_api_key:
        raise QAError("OPENAI_API_KEY is not configured.")

    from openai import OpenAI

    from app.database import get_supabase
    from app.services.extraction import _transcription_error
    from app.services.lecture_gen import (
        TTS_CHUNK_CHARS,
        estimate_duration,
        resolve_voice,
        split_for_tts,
    )

    text = answer.strip()
    if len(text) > TTS_CHUNK_CHARS:
        text = split_for_tts(text, TTS_CHUNK_CHARS)[0]
        logger.warning("Answer %s truncated to one TTS chunk for narration", entry_id)

    try:
        openai_voice = resolve_voice(voice)
    except Exception as exc:  # noqa: BLE001 - unknown voice shouldn't 500
        raise QAError(str(exc)) from exc

    try:
        audio = OpenAI(api_key=settings.openai_api_key).audio.speech.create(
            # Q&A replies use the faster (non-HD) model — in a live back-and-forth
            # latency matters more than fidelity. Lectures keep tts-1-hd.
            model=settings.openai_tts_model_qa,
            voice=openai_voice,
            input=text,
            response_format="mp3",
        ).content
    except Exception as exc:  # noqa: BLE001
        raise QAError(_transcription_error(exc)) from exc

    return audio, estimate_duration(text)


def store_narration(
    *, entry_id: str, user_id: str, audio: bytes,
) -> str:
    """Put narration in Storage, after the learner has already heard it.

    Kept so a past exchange can be replayed without paying for synthesis twice.
    Called from a background task: nothing is waiting on it, and a failed
    upload costs a re-synthesis later rather than an answer now.
    """
    from app.database import get_supabase

    path = f"{user_id}/qa/{entry_id}.mp3"
    get_supabase().storage.from_(settings.lecture_audio_bucket).upload(
        path=path,
        file=audio,
        file_options={"content-type": "audio/mpeg", "upsert": "true"},
    )
    return path


def synthesise_answer(
    *, entry_id: str, user_id: str, answer: str, voice: str
) -> tuple[str, int]:
    """Narrate and store, returning ``(storage_path, duration_secs)``.

    The original two-in-one, kept for callers that genuinely want the file to
    exist before they continue. New paths should call `narrate` and store in
    the background instead.
    """
    audio, secs = narrate(answer=answer, voice=voice, entry_id=entry_id)
    try:
        path = store_narration(entry_id=entry_id, user_id=user_id, audio=audio)
    except Exception as exc:  # noqa: BLE001
        raise QAError(f"Could not cache the answer audio: {exc}") from exc
    return path, secs


# Session titling lives in qa_session.py (spec Prompt 5). Re-exported here under
# its historical name so the router's existing import keeps working.
from app.services.qa_session import auto_generate_session_title  # noqa: E402

derive_session_title = auto_generate_session_title

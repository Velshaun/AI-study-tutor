"""Flashcard & quiz generation — spec Prompt 6.

Gemini turns a domain's material into study content: flashcards (front/back) and
multiple-choice quizzes (question, four options, correct answer, explanation).

Both calls use a strict ``response_schema`` — no search grounding here, so the
tools-vs-JSON limitation that forced the domain pipeline into two calls doesn't
apply, and each is a single structured call. Reuses ``_generate`` from the
domain service for its retry/backoff and quota handling.

Difficulty (easy / medium / hard) shapes what is asked, not just the wording:
recall at easy, application at medium, scenario analysis at hard.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from app.config import settings
from app.database import get_supabase
from app.services.domains import _generate, quota_hint

logger = logging.getLogger(__name__)

DIFFICULTIES = ("easy", "medium", "hard")

# Bounds so a caller can't ask for 500 cards in one generation.
MAX_FLASHCARDS = 30
MAX_QUIZ_QUESTIONS = 20

# How much domain material to feed the model.
MAX_CONTENT_CHARS = 24000

DIFFICULTY_GUIDANCE = {
    "easy": (
        "EASY: test recall and core definitions. Ask 'what is X?' style items "
        "with a single clear correct answer. Keep language plain."
    ),
    "medium": (
        "MEDIUM: test application and understanding. Ask the learner to compare, "
        "distinguish or apply a concept to a straightforward situation."
    ),
    "hard": (
        "HARD: test analysis and judgement. Use short scenarios where the learner "
        "must reason about trade-offs or pick the best option among plausible "
        "ones. Distractors should be genuinely tempting."
    ),
}


class GenerationError(RuntimeError):
    """Flashcards or a quiz could not be generated."""


def _norm_difficulty(value: str | None) -> str:
    v = (value or "").lower()
    return v if v in DIFFICULTIES else "medium"


# --- domain content ---------------------------------------------------------
# Cards read per domain. A large imported deck is plenty of material long
# before this, and the whole block is still bounded by MAX_CONTENT_CHARS.
MAX_MATERIAL_CARDS = 400


def _flashcard_material(domain_id: str, user_id: str) -> str:
    """A domain's flashcards, rendered as study material for the model."""
    try:
        rows = (
            get_supabase().table("flashcards").select("front, back")
            .eq("domain_id", domain_id).eq("user_id", user_id)
            .limit(MAX_MATERIAL_CARDS).execute()
        ).data or []
    except Exception as exc:  # noqa: BLE001 — material is additive, never fatal
        logger.warning("flashcard lookup failed for domain %s: %s", domain_id, exc)
        return ""

    lines = [
        f"- {(r.get('front') or '').strip()} => {(r.get('back') or '').strip()}"
        for r in rows
        if (r.get("front") or "").strip() and (r.get("back") or "").strip()
    ]
    if not lines:
        return ""
    return (
        "Flashcards for this topic (term => definition), written by the learner "
        "or imported from their own deck:\n" + "\n".join(lines)
    )


def gather_domain_content(domain_id: str, user_id: str) -> dict[str, Any]:
    """Assemble what's known about a domain into text the model can study.

    Prefers the generated lecture transcripts (the richest, most on-topic
    material); falls back to the domain description, the module summary and the
    domain's own flashcards, so generation still works before any lecture
    exists — and works at all for an imported deck, which never gets one.
    """
    client = get_supabase()

    rows = (
        client.table("domains").select("*")
        .eq("id", domain_id).eq("user_id", user_id).limit(1).execute()
    ).data or []
    if not rows:
        raise GenerationError("Domain not found.")
    domain = rows[0]

    module = {}
    if domain.get("module_id"):
        mrows = (
            client.table("modules").select(
                "title, detected_subject, source_summary, course_context"
            ).eq("id", domain["module_id"]).limit(1).execute()
        ).data or []
        module = mrows[0] if mrows else {}

    transcripts = [
        r["transcript"]
        for r in (
            client.table("lectures").select("transcript")
            .eq("domain_id", domain_id).eq("user_id", user_id).execute()
        ).data or []
        if r.get("transcript")
    ]

    parts: list[str] = []
    if domain.get("description"):
        parts.append(f"Topic scope: {domain['description']}")
    if module.get("source_summary"):
        parts.append(f"Source summary: {module['source_summary']}")
    parts.extend(transcripts)

    # A domain's own flashcards are study material too. This is what makes an
    # imported deck (a Quizlet export, say) usable: it arrives as a domain with
    # cards and no lecture, and without this there is nothing to generate from.
    cards = _flashcard_material(domain_id, user_id)
    if cards:
        parts.append(cards)

    content = "\n\n".join(parts).strip()

    return {
        "domain": domain,
        "module": module,
        "subject": module.get("detected_subject") or module.get("title") or "this subject",
        "content": content[:MAX_CONTENT_CHARS],
        "has_material": len(content) >= 120,
    }


# --- flashcards -------------------------------------------------------------
FLASHCARD_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "cards": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "front": {"type": "string",
                              "description": "The prompt side — a term or question."},
                    "back": {"type": "string",
                             "description": "The answer side — concise, self-contained."},
                },
                "required": ["front", "back"],
            },
        },
    },
    "required": ["cards"],
}


def generate_flashcards(
    domain_content: str, difficulty: str, count: int, *, subject: str = "this subject",
    topic: str = "", context: dict[str, Any] | None = None,
) -> list[dict[str, str]]:
    """Return ``[{front, back}]`` for a domain."""
    if not settings.gemini_api_key:
        raise GenerationError("GEMINI_API_KEY is not configured.")

    from google.genai import types

    difficulty = _norm_difficulty(difficulty)
    count = max(1, min(count or 10, MAX_FLASHCARDS))

    prompt = (
        f"Create {count} study flashcards for a learner revising {subject}"
        + (f", specifically the topic '{topic}'." if topic else ".") + "\n\n"
        f"{DIFFICULTY_GUIDANCE[difficulty]}\n\n"
        "Rules:\n"
        "- FRONT is a single term, concept or question. BACK is the answer, "
        "concise and self-contained (one to three sentences).\n"
        "- One idea per card. No card should give away another.\n"
        "- Base every card on the material below — do not invent facts that "
        "contradict it. You may add widely-known context where it helps.\n"
        "- Plain text only: no markdown, numbering or 'Front:'/'Back:' labels.\n"
        "- British spelling.\n\n"
        f"--- DOMAIN MATERIAL ---\n{domain_content or topic or subject}"
    )

    try:
        response = _generate(
            "flashcards",
            model=settings.gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=FLASHCARD_SCHEMA,
                temperature=0.5,
            ),
        )
        data = json.loads(response.text)
    except json.JSONDecodeError as exc:
        raise GenerationError(f"Model returned invalid JSON: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise GenerationError(quota_hint(exc) or f"Flashcard generation failed: {exc}") from exc

    cards = []
    for card in data.get("cards", [])[:count]:
        front = (card.get("front") or "").strip()
        back = (card.get("back") or "").strip()
        if front and back:
            cards.append({"front": front[:500], "back": back[:1000]})
    if not cards:
        raise GenerationError("No usable flashcards were produced.")
    return cards


# --- quiz -------------------------------------------------------------------
QUIZ_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "question": {"type": "string"},
                    "options": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Exactly four options, in order A, B, C, D.",
                    },
                    "correct_index": {
                        "type": "integer",
                        "description": "0-based index (0=A) of the correct option.",
                    },
                    "explanation": {
                        "type": "string",
                        "description": "Why the correct option is right, one or two "
                                       "sentences.",
                    },
                },
                "required": ["question", "options", "correct_index", "explanation"],
            },
        },
    },
    "required": ["questions"],
}


def generate_quiz(
    domain_content: str, difficulty: str, question_count: int, *,
    subject: str = "this subject", topic: str = "",
) -> list[dict[str, Any]]:
    """Return ``[{question, options[4], correct_index, explanation}]``."""
    if not settings.gemini_api_key:
        raise GenerationError("GEMINI_API_KEY is not configured.")

    from google.genai import types

    difficulty = _norm_difficulty(difficulty)
    question_count = max(1, min(question_count or 5, MAX_QUIZ_QUESTIONS))

    prompt = (
        f"Write a {question_count}-question multiple-choice quiz for a learner "
        f"revising {subject}"
        + (f", specifically the topic '{topic}'." if topic else ".") + "\n\n"
        f"{DIFFICULTY_GUIDANCE[difficulty]}\n\n"
        "Rules:\n"
        "- Each question has EXACTLY four options in order A, B, C, D, with "
        "exactly one correct answer.\n"
        "- correct_index is the 0-based position of the right option (0=A, "
        "3=D). Vary which position is correct across the quiz.\n"
        "- Distractors must be plausible and roughly the same length as the "
        "answer — no obviously silly options.\n"
        "- The explanation says why the correct option is right (and, where "
        "useful, why a tempting distractor is wrong).\n"
        "- Base questions on the material below. Plain text, British spelling, "
        "no markdown or 'A)' prefixes inside the option text.\n\n"
        f"--- DOMAIN MATERIAL ---\n{domain_content or topic or subject}"
    )

    try:
        response = _generate(
            "quiz",
            model=settings.gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=QUIZ_SCHEMA,
                temperature=0.5,
            ),
        )
        data = json.loads(response.text)
    except json.JSONDecodeError as exc:
        raise GenerationError(f"Model returned invalid JSON: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise GenerationError(quota_hint(exc) or f"Quiz generation failed: {exc}") from exc

    questions = []
    for q in data.get("questions", [])[:question_count]:
        text = (q.get("question") or "").strip()
        options = [str(o).strip() for o in (q.get("options") or []) if str(o).strip()]
        if not text or len(options) != 4:
            continue
        try:
            correct = int(q.get("correct_index"))
        except (TypeError, ValueError):
            continue
        if not 0 <= correct <= 3:
            continue
        questions.append({
            "question": text[:1000],
            "options": [o[:400] for o in options],
            "correct_index": correct,
            "explanation": (q.get("explanation") or "").strip()[:1000],
        })
    if not questions:
        raise GenerationError("No usable quiz questions were produced.")
    return questions


# --- imported exam parsing (Prompt 10c) -------------------------------------
IMPORTED_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "question_text": {"type": "string"},
                    "options": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string",
                                          "description": "A, B, C, D…"},
                                "text": {"type": "string"},
                            },
                            "required": ["label", "text"],
                        },
                    },
                    "correct_option": {
                        "type": "string",
                        "description": "The label of the correct option, or empty "
                                       "if the source doesn't mark an answer.",
                    },
                    "why_summary": {
                        "type": "string",
                        "description": "A one-sentence rationale for the correct "
                                       "answer, or empty if none is given.",
                    },
                },
                "required": ["question_text", "options", "correct_option",
                             "why_summary"],
            },
        },
    },
    "required": ["questions"],
}


def parse_imported_exam(pdf_text: str) -> list[dict[str, Any]]:
    """Extract multiple-choice questions from a practice-exam PDF's text.

    Returns ``[{question_text, options:[{label,text}], correct_option,
    why_summary}]``. Faithful extraction, not generation — it lifts the
    questions the author already wrote and only summarises the rationale.
    """
    if not settings.gemini_api_key:
        raise GenerationError("GEMINI_API_KEY is not configured.")

    from google.genai import types

    excerpt = (pdf_text or "").strip()[:MAX_CONTENT_CHARS]
    if len(excerpt) < 40:
        raise GenerationError("The PDF had too little text to parse.")

    prompt = (
        "You are extracting multiple-choice questions from a practice-exam "
        "document. Below is the raw text of the PDF.\n\n"
        "Pull out EVERY multiple-choice question you can find, faithfully:\n"
        "- question_text: the question exactly as written (drop question "
        "numbers like 'Q1.' or '14)').\n"
        "- options: each answer choice as {label, text}, where label is the "
        "letter (A, B, C, D…) and text is the option wording without its "
        "letter prefix.\n"
        "- correct_option: the label of the correct answer IF the document "
        "marks one (an answer key, a highlighted/starred option, 'Answer: C'). "
        "If the source gives no answer, return an empty string — do NOT guess.\n"
        "- why_summary: a one-sentence rationale IF the document provides an "
        "explanation; otherwise an empty string.\n\n"
        "Do not invent questions, options or answers that aren't in the text. "
        "Skip anything that isn't a real multiple-choice question (headers, "
        "instructions, page numbers). Preserve the original wording; only tidy "
        "obvious OCR/whitespace artefacts.\n\n"
        f"--- PDF TEXT ---\n{excerpt}"
    )

    try:
        response = _generate(
            "import",
            model=settings.gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=IMPORTED_SCHEMA,
                temperature=0.1,  # faithful extraction, low creativity
            ),
        )
        data = json.loads(response.text)
    except json.JSONDecodeError as exc:
        raise GenerationError(f"Model returned invalid JSON: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise GenerationError(quota_hint(exc) or f"Could not parse the PDF: {exc}") from exc

    out = []
    for q in data.get("questions", []):
        text = (q.get("question_text") or "").strip()
        options = [
            {"label": (o.get("label") or "").strip()[:4],
             "text": (o.get("text") or "").strip()[:500]}
            for o in (q.get("options") or [])
            if (o.get("text") or "").strip()
        ]
        if not text or len(options) < 2:
            continue
        out.append({
            "question_text": text[:1500],
            "options": options,
            "correct_option": (q.get("correct_option") or "").strip()[:4],
            "why_summary": (q.get("why_summary") or "").strip()[:1000],
        })
    if not out:
        raise GenerationError("No multiple-choice questions were found in that PDF.")
    return out


# --- practice-exam mode (spec 6.4) ------------------------------------------
# Richer than a quiz: every option carries its own 1-2 line explanation and a
# normalised term_key (for the concept cache), and each question carries a Why
# Card summary — the 2-3 sentence rationale shown after answering.
PRACTICE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "question_text": {"type": "string"},
                    "options": {
                        "type": "array",
                        "description": "Exactly four options, labelled A, B, C, D.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string",
                                          "description": "A, B, C or D."},
                                "text": {"type": "string"},
                                "term_key": {
                                    "type": "string",
                                    "description": "The core term this option "
                                    "names, normalised to lower snake_case "
                                    "(e.g. 'tcp_ip', 'mitochondrion').",
                                },
                            },
                            "required": ["label", "text", "term_key"],
                        },
                    },
                    "correct_option": {
                        "type": "string",
                        "description": "Label (A/B/C/D) of the correct option.",
                    },
                    "why_summary": {
                        "type": "string",
                        "description": "2-3 sentences explaining WHY the correct "
                        "answer is correct — the Why Card.",
                    },
                },
                "required": [
                    "question_text", "options", "correct_option", "why_summary",
                ],
            },
        },
    },
    "required": ["questions"],
}

# A whole 40- or 50-question paper asked for in one call comes back thin and
# repetitive, so a large set is generated in batches of this size and stitched
# together, each batch told what the previous ones already covered.
PRACTICE_BATCH_SIZE = 20
# Upper bound on one practice set — matches exam_profile.MAX_QUESTION_COUNT.
MAX_PRACTICE_QUESTIONS = 100


def generate_practice_questions(
    domain_content: str, count: int, *,
    subject: str = "this subject", topic: str = "", difficulty: str = "medium",
    avoid: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Practice-mode questions plus a Why Card, with term-keyed options.

    Returns ``[{question_text, options:[{label,text,term_key}], correct_option,
    why_summary}]``. Per-option explanations are NOT produced here — practice
    mode resolves and stores them with the questions so the answer-time path
    stays a single read.

    ``count`` is the length of the set the learner is revising for (a real
    paper, so commonly 40-50). ``avoid`` lists questions the domain already
    holds, so a top-up doesn't repeat them.
    """
    count = max(1, min(count or PRACTICE_BATCH_SIZE, MAX_PRACTICE_QUESTIONS))
    written = list(avoid or [])
    seen = {_question_key(t) for t in written}
    out: list[dict[str, Any]] = []

    while len(out) < count:
        want = min(PRACTICE_BATCH_SIZE, count - len(out))
        try:
            batch = _generate_practice_batch(
                domain_content, want, subject=subject, topic=topic,
                difficulty=difficulty, written=written,
            )
        except GenerationError as exc:
            # A partial set beats none; only a first-batch failure is fatal.
            if not out:
                raise
            logger.warning(
                "practice batch failed after %d of %d questions: %s",
                len(out), count, exc,
            )
            break

        fresh = [q for q in batch if _question_key(q["question_text"]) not in seen]
        for q in fresh:
            seen.add(_question_key(q["question_text"]))
            written.append(q["question_text"])
        out.extend(fresh)
        if not fresh:  # the model has run dry — stop rather than loop
            logger.info(
                "practice generation converged at %d of %d questions", len(out), count
            )
            break

    return out[:count]


def _question_key(text: str) -> str:
    """Loose identity for a question, so batches don't repeat one another."""
    return " ".join((text or "").lower().split())[:160]


def _generate_practice_batch(
    domain_content: str, count: int, *,
    subject: str, topic: str, difficulty: str, written: list[str],
) -> list[dict[str, Any]]:
    """One Gemini call for up to ``PRACTICE_BATCH_SIZE`` questions."""
    if not settings.gemini_api_key:
        raise GenerationError("GEMINI_API_KEY is not configured.")

    from google.genai import types

    difficulty = _norm_difficulty(difficulty)
    # Only the most recent titles — the whole set would crowd out the material.
    recent = "\n".join(f"- {t}" for t in written[-40:])
    avoid_clause = (
        "- These questions have already been set for this learner. Cover "
        "different ground; do not repeat or paraphrase them:\n"
        f"{recent}\n"
    ) if recent else ""

    prompt = (
        f"Write {count} multiple-choice practice questions for a learner "
        f"revising {subject}"
        + (f", specifically '{topic}'." if topic else ".") + "\n\n"
        f"{DIFFICULTY_GUIDANCE[difficulty]}\n\n"
        "Rules:\n"
        "- Each question has EXACTLY four options labelled A, B, C, D, with "
        "exactly one correct answer. Vary which label is correct across the set.\n"
        "- Distractors must be plausible and roughly the same length as the "
        "answer — no obviously silly options.\n"
        "- term_key is the single core term the option names, normalised to "
        "lower snake_case (letters, digits and underscores only, e.g. 'tcp_ip').\n"
        "- why_summary is a 2-3 sentence explanation of WHY the correct answer "
        "is correct — this is shown as a highlighted 'Why' card.\n"
        + avoid_clause
        + "- Base everything on the material below. Plain text, British spelling, "
        "no markdown and no 'A)' prefixes inside option text.\n\n"
        f"--- DOMAIN MATERIAL ---\n{domain_content or topic or subject}"
    )

    try:
        response = _generate(
            "practice",
            model=settings.gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=PRACTICE_SCHEMA,
                temperature=0.5,
            ),
        )
        data = json.loads(response.text)
    except json.JSONDecodeError as exc:
        raise GenerationError(f"Model returned invalid JSON: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise GenerationError(
            quota_hint(exc) or f"Practice generation failed: {exc}"
        ) from exc

    out = []
    for q in data.get("questions", [])[:count]:
        text = (q.get("question_text") or "").strip()
        options = []
        for o in (q.get("options") or []):
            otext = (o.get("text") or "").strip()
            label = (o.get("label") or "").strip().upper()[:1]
            if not otext or label not in "ABCD":
                continue
            options.append({
                "label": label,
                "text": otext[:400],
                "term_key": _normalise_term(o.get("term_key") or otext),
            })
        # Keep only well-formed 4-option questions with a valid correct label.
        labels = [o["label"] for o in options]
        correct = (q.get("correct_option") or "").strip().upper()[:1]
        if not text or len(options) != 4 or len(set(labels)) != 4 or correct not in labels:
            continue
        out.append({
            "question_text": text[:1500],
            "options": options,
            "correct_option": correct,
            "why_summary": (q.get("why_summary") or "").strip()[:1200],
        })
    if not out:
        raise GenerationError("No usable practice questions were produced.")
    return out


def _normalise_term(value: str) -> str:
    """Lower snake_case a term for the concept cache: 'TCP/IP' -> 'tcp_ip'."""
    out = []
    prev_us = False
    for ch in (value or "").strip().lower():
        if ch.isalnum():
            out.append(ch)
            prev_us = False
        elif not prev_us:
            out.append("_")
            prev_us = True
    return "".join(out).strip("_")[:80] or "term"


TERM_EXPLANATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "explanations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "term_key": {"type": "string"},
                    "explanation": {
                        "type": "string",
                        "description": "1-2 line plain explanation of this term.",
                    },
                },
                "required": ["term_key", "explanation"],
            },
        },
    },
    "required": ["explanations"],
}


def generate_term_explanations(
    terms: list[dict[str, str]], *, subject: str = "this subject",
    question_text: str = "",
) -> dict[str, str]:
    """Explain a batch of option terms in one call.

    ``terms`` is ``[{term_key, text}]`` — only the terms that missed the concept
    cache. Returns ``{term_key: explanation}``. Called at answer time so each
    distinct term is explained (and cached) exactly once, ever.
    """
    if not terms:
        return {}
    if not settings.gemini_api_key:
        raise GenerationError("GEMINI_API_KEY is not configured.")

    from google.genai import types

    listing = "\n".join(f"- {t['term_key']}: {t.get('text', '')}" for t in terms)
    prompt = (
        f"A learner is revising {subject}. For each term below, write a 1-2 line "
        "plain-language explanation of what it is — enough for the learner to "
        "understand why it would or wouldn't be the right answer to a "
        "multiple-choice question. British spelling, no markdown.\n\n"
        + (f"Question context: {question_text}\n\n" if question_text else "")
        + "Return one explanation per term, echoing back the exact term_key.\n\n"
        f"--- TERMS ---\n{listing}"
    )

    try:
        response = _generate(
            "term-explain",
            model=settings.gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=TERM_EXPLANATION_SCHEMA,
                temperature=0.3,
            ),
        )
        data = json.loads(response.text)
    except json.JSONDecodeError as exc:
        raise GenerationError(f"Model returned invalid JSON: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise GenerationError(
            quota_hint(exc) or f"Explanation generation failed: {exc}"
        ) from exc

    out: dict[str, str] = {}
    for e in data.get("explanations", []):
        key = (e.get("term_key") or "").strip()
        exp = (e.get("explanation") or "").strip()
        if key and exp:
            out[key] = exp[:600]
    return out


# --- web source discovery (Chat tab) ----------------------------------------
DISCOVER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "answer": {
            "type": "string",
            "description": "A short 2-3 sentence answer to the learner's question "
            "using the course context — empty string if it was purely a search.",
        },
        "resources": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "url": {"type": "string", "description": "Full https URL."},
                    "type": {
                        "type": "string",
                        "description": "One of: youtube, pdf, docs, website.",
                    },
                },
                "required": ["title", "url", "type"],
            },
        },
    },
    "required": ["answer", "resources"],
}

DISCOVER_TYPES = {"youtube", "pdf", "docs", "website"}


def discover_resources(
    query: str, *, subject: str = "this subject", context: str = "",
) -> dict[str, Any]:
    """Find free web study resources for a query + a short grounded answer.

    Two calls, because Gemini rejects search grounding combined with a
    ``response_schema``: (1) a grounded web search that finds resources and
    answers the question, then (2) a structuring call that returns clean
    ``{answer, resources:[{title, url, type}]}``.
    """
    if not settings.gemini_api_key:
        raise GenerationError("GEMINI_API_KEY is not configured.")
    from google.genai import types

    q = (query or "").strip()[:500]
    if not q:
        raise GenerationError("Ask for something to search for.")
    ctx = (context or "").strip()[:4000]

    search_prompt = (
        f'A learner studying {subject} asked: "{q}".\n\n'
        "1. Search the web for FREE study resources that would help — prefer "
        "YouTube videos, free PDFs, official documentation and reputable "
        "websites. Offer up to 10, each with its exact title and a real, working "
        "https URL. Avoid anything paywalled or behind a sign-up — every link "
        "is checked before the learner sees it, so walled ones are wasted.\n"
        "2. If the message is also a question, answer it briefly (2-3 sentences) "
        "using this course context where relevant:\n"
        f"{ctx or '(no course context)'}"
    )
    try:
        r1 = _generate(
            "discover-search",
            model=settings.gemini_model,
            contents=search_prompt,
            config=types.GenerateContentConfig(
                tools=[types.Tool(google_search=types.GoogleSearch())],
                temperature=0.3,
            ),
        )
    except Exception as exc:  # noqa: BLE001
        raise GenerationError(quota_hint(exc) or f"Search failed: {exc}") from exc

    findings = (r1.text or "").strip()
    grounded: list[str] = []
    try:
        md = r1.candidates[0].grounding_metadata
        for chunk in (md.grounding_chunks or []) if md else []:
            if chunk.web and chunk.web.uri:
                grounded.append(f"- {chunk.web.title or ''} :: {chunk.web.uri}")
    except (AttributeError, IndexError):  # grounding is best-effort
        pass

    struct_prompt = (
        "From the research below produce (a) a short 2-3 sentence answer to the "
        "learner's question — an empty string if it was purely a resource "
        "search — and (b) a clean list of the most useful FREE resources, each "
        "with a concise title, a full https URL, and a type (youtube, pdf, docs "
        "or website).\n"
        "For each URL, use the real DESTINATION link that appears in the RESEARCH "
        "text (e.g. a youtube.com/watch link, the actual PDF or documentation "
        "URL). The SEARCH RESULT LINKS below are Google redirect links — only "
        "fall back to one of those if no direct URL is available. Skip any "
        "resource you can't give a real URL for.\n\n"
        f"Question: {q}\n\n--- RESEARCH ---\n{findings}\n\n"
        f"--- SEARCH RESULT LINKS ---\n{chr(10).join(grounded) or '(none)'}"
    )
    try:
        r2 = _generate(
            "discover-structure",
            model=settings.gemini_model,
            contents=struct_prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=DISCOVER_SCHEMA,
                temperature=0.2,
            ),
        )
        data = json.loads(r2.text)
    except json.JSONDecodeError as exc:
        raise GenerationError(f"Model returned invalid JSON: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise GenerationError(quota_hint(exc) or f"Structuring failed: {exc}") from exc

    resources = []
    for res in data.get("resources", []):
        url = (res.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            continue
        rtype = (res.get("type") or "website").strip().lower()
        if rtype not in DISCOVER_TYPES:
            rtype = "website"
        resources.append({
            "title": (res.get("title") or url).strip()[:200],
            "url": url[:1000],
            "type": rtype,
        })
    return {
        "answer": (data.get("answer") or "").strip()[:2000],
        # Over-supplied on purpose: link_check.validate_resources drops the dead
        # and walled ones, and a short list here would leave nothing behind.
        "resources": resources[:12],
    }

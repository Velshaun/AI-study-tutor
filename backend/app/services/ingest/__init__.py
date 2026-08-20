"""The ingestion boundary: incoming material in, canonical records out.

Everything that arrives — a pasted Quizlet set, a downloaded caption file,
a block of exam questions — passes through here and comes out as the same two
record types. Nothing downstream learns where material came from, which is what
stops each new source growing its own path through the app.

Two rules run this module.

**The learner's label decides where material is filed.** They said Flashcards,
so it is filed as flashcards. Detection exists only to pre-select the pill, and
never overrides what they chose.

**A parser converts; it does not invent.** A list of terms and definitions has
no options and no answer key, so labelling it Quiz cannot conjure them. When the
material cannot support the label, it is kept as reference text with a note
saying exactly that — a half-built exam a learner can sit and cannot pass is
worse than no exam.
"""

from __future__ import annotations

from app.services.ingest.canonical import (
    Card,
    ParseResult,
    Question,
    as_reference,
)
from app.services.ingest.parsers import captions, qa_text, quizlet

# What the learner can label a paste as.
CONTENT_TYPES = ("flashcards", "quiz", "practice_exam", "reference")
# The two labels that promise a sittable, gradeable paper.
QUESTION_TYPES = ("quiz", "practice_exam")


def detect(text: str) -> str:
    """A suggestion for the type pill. Never authoritative."""
    if captions.looks_like_captions(text):
        return "reference"
    if qa_text.looks_like_questions(text):
        return "quiz"
    if quizlet.looks_like_quizlet(text):
        return "flashcards"
    return "reference"


def parse(text: str, declared_type: str | None = None) -> ParseResult:
    """Convert pasted material, filed as the learner asked.

    `declared_type` is their pill. Where it is absent, detection stands in.
    """
    body = text or ""
    wanted = (declared_type or detect(body)).strip().lower()

    if wanted in QUESTION_TYPES:
        result = qa_text.parse(body)
        if result.kind == "questions":
            return result
        # They asked for an exam and the material cannot support one. Say which
        # of the two problems it was, rather than a generic failure.
        if quizlet.looks_like_quizlet(body):
            return as_reference(
                body,
                "That looks like a set of terms and definitions rather than "
                "exam questions — there are no options or answers to score "
                "against. It's been kept as study material, and it would work "
                "as flashcards.",
                detected="flashcards",
            )
        return result

    if wanted == "flashcards":
        result = quizlet.parse(body)
        if result.kind == "flashcards":
            return result
        return result

    if captions.looks_like_captions(body):
        return captions.parse(body)

    return as_reference(
        body.strip(),
        f"Kept {len(body.strip()):,} characters as study material.",
        detected="reference",
    )


__all__ = [
    "CONTENT_TYPES",
    "QUESTION_TYPES",
    "Card",
    "ParseResult",
    "Question",
    "as_reference",
    "detect",
    "parse",
]

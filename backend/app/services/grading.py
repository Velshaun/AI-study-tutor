"""Is this answer right? One answer, wherever the question came from.

Four question kinds run through the app — multiple choice, multi-select,
short answer and fill-in-the-blank — and at least three places grade them: a
quiz submission, an exam submission, and practice mode's per-question check.
Three graders drifting apart is how "correct" quietly comes to depend on which
screen asked, so the rule lives here and everywhere imports it.

The shared question shape, wherever questions are stored (rows, quiz jsonb,
bank snapshots):

    kind             'mcq' | 'multi' | 'short' | 'blank'   (absent = mcq)
    correct_index    int                   — mcq
    correct_indices  list[int]             — multi
    accepted         list[str]             — short and blank

`blank` is short-answer with the gap written into the prompt; the display
differs, the grading does not.
"""

from __future__ import annotations

import re
from typing import Any

KINDS = ("mcq", "multi", "short", "blank")

# Kinds whose answer is typed rather than picked.
TEXT_KINDS = ("short", "blank")


def kind_of(question: dict[str, Any]) -> str:
    kind = (question.get("kind") or "mcq").strip().lower()
    return kind if kind in KINDS else "mcq"


def normalise_answer(text: str) -> str:
    """What two spellings of the same answer have in common.

    Case, surrounding punctuation and internal whitespace are presentation;
    "chmod" and " Chmod. " are one answer. Anything smarter — stemming, typo
    distance — starts marking wrong answers right, which is worse than
    marking awkward ones wrong: a learner can see why "chmod." matched, and
    cannot see why "chown" did.
    """
    cleaned = re.sub(r"\s+", " ", (text or "").strip().lower())
    return cleaned.strip(" .,:;!?'\"`")


def accepted_answers(question: dict[str, Any]) -> list[str]:
    meta = question.get("answer_meta") or {}
    raw = question.get("accepted") or meta.get("accepted") or []
    return [a for a in (str(x) for x in raw) if a.strip()]


def correct_indices(question: dict[str, Any]) -> list[int]:
    meta = question.get("answer_meta") or {}
    raw = question.get("correct_indices") or meta.get("correct_indices")
    if raw:
        return sorted(int(i) for i in raw)
    single = question.get("correct_index")
    return [int(single)] if single is not None else []


def is_answered(answer: Any) -> bool:
    """Whether a response was given at all — [] and "" are as blank as None."""
    if answer is None:
        return False
    if isinstance(answer, (list, tuple)):
        return len(answer) > 0
    if isinstance(answer, str):
        return bool(answer.strip())
    return True


def grade(question: dict[str, Any], answer: Any) -> bool:
    """One answer against one question. Unanswered is wrong, as every exam has
    it — `is_answered` is there for callers that need the distinction."""
    if not is_answered(answer):
        return False

    kind = kind_of(question)
    if kind == "multi":
        # The whole set, exactly: partial credit turns "select all that apply"
        # into "select any that apply", which is a different question.
        if not isinstance(answer, (list, tuple)):
            return False
        try:
            chosen = sorted(int(i) for i in answer)
        except (TypeError, ValueError):
            return False
        return chosen == correct_indices(question)

    if kind in TEXT_KINDS:
        if not isinstance(answer, str):
            return False
        given = normalise_answer(answer)
        return bool(given) and given in {
            normalise_answer(a) for a in accepted_answers(question)
        }

    # mcq
    try:
        chosen_index = int(answer)
    except (TypeError, ValueError):
        return False
    correct = question.get("correct_index")
    return correct is not None and chosen_index == int(correct)

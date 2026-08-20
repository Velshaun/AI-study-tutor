"""One shape for a question, whatever it came from.

Every source of study material — a generated exam, an imported PDF, a pasted
Quizlet set, a scraped page — converts into these two records at the ingestion
boundary and nothing downstream needs to know where they came from. That is the
whole point: exams, practice mode, the per-domain breakdown and the performance
model all read `practice_questions`, and a second shape means either teaching
them a second shape or writing a translation layer per source.

The rule that keeps it honest is `Question.usable`. A question with no options,
or no correct answer, or a correct answer pointing outside its own options, is
not a question — it is text that resembled one. Storing it anyway produces a
paper the learner can sit and cannot pass, which is worse than not storing it,
so a parser that can't do better hands back reference text and says so.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Below this, a "question" is almost certainly a stray heading the parser
# mistook for a prompt.
MIN_PROMPT_CHARS = 8
MIN_OPTIONS = 2
MAX_OPTIONS = 8

ORIGINS = ("generated", "imported_pdf", "scraped", "pasted")


@dataclass
class Question:
    """One multiple-choice question, in the canonical shape."""

    prompt: str
    options: list[str] = field(default_factory=list)
    correct_index: int | None = None
    explanation: str = ""
    # One line per option, positionally aligned. Absent from most pasted
    # material; generation fills it in later rather than the parser inventing it.
    option_explanations: list[str] = field(default_factory=list)

    @property
    def usable(self) -> bool:
        """Is this something a learner could actually be asked?"""
        if len((self.prompt or "").strip()) < MIN_PROMPT_CHARS:
            return False
        if not MIN_OPTIONS <= len(self.options) <= MAX_OPTIONS:
            return False
        if any(not (o or "").strip() for o in self.options):
            return False
        # An unanswerable question cannot be graded, and a paper of them scores
        # everyone zero.
        return self.correct_index is not None and 0 <= self.correct_index < len(
            self.options
        )

    def to_row(
        self, *, position: int, origin: str = "pasted",
        exam_id: str | None = None, domain_id: str | None = None,
        batch_id: str | None = None,
    ) -> dict[str, Any]:
        """The `practice_questions` row for this question.

        Options are stored as objects rather than strings because that is what
        the table already holds — per-option explanations ride inside them, and
        both shapes are read.
        """
        return {
            "exam_id": exam_id,
            "domain_id": domain_id,
            "kind": "mcq",
            "prompt": self.prompt.strip(),
            "options": [
                {
                    "label": chr(ord("A") + i),
                    "text": text.strip(),
                    "explanation": (
                        self.option_explanations[i]
                        if i < len(self.option_explanations) else ""
                    ),
                }
                for i, text in enumerate(self.options)
            ],
            "correct_index": self.correct_index,
            "expected_answer": self.explanation.strip(),
            "points": 1,
            "position": position,
            "origin": origin,
            "import_batch_id": batch_id,
        }


@dataclass
class Card:
    """One flashcard. Term/definition material converts to these, not questions."""

    front: str
    back: str

    @property
    def usable(self) -> bool:
        return bool((self.front or "").strip()) and bool((self.back or "").strip())

    def to_row(
        self, *, domain_id: str | None = None, user_id: str | None = None,
        origin: str = "pasted", batch_id: str | None = None,
    ) -> dict[str, Any]:
        return {
            "domain_id": domain_id,
            "user_id": user_id,
            "front": self.front.strip(),
            "back": self.back.strip(),
            "origin": origin,
            "import_batch_id": batch_id,
        }


@dataclass
class ParseResult:
    """What a parser made of some material, and what to tell the learner.

    `kind` is what was actually extracted, which is not always what was asked
    for — the learner's label decides where material is filed, but it cannot
    conjure options and an answer key out of a list of definitions. When a
    parser falls short it returns `reference` with the text intact and a `note`
    saying plainly what happened, rather than a half-built exam.
    """

    # 'questions' | 'flashcards' | 'reference'
    kind: str
    questions: list[Question] = field(default_factory=list)
    cards: list[Card] = field(default_factory=list)
    text: str = ""
    note: str = ""
    # What the parser thinks it was looking at, for the suggested-type pill.
    # Never overrides the learner's choice.
    detected: str | None = None

    @property
    def usable_questions(self) -> list[Question]:
        return [q for q in self.questions if q.usable]

    @property
    def usable_cards(self) -> list[Card]:
        return [c for c in self.cards if c.usable]


def as_reference(text: str, note: str, detected: str | None = None) -> ParseResult:
    """Keep the material as plain study text, and say why."""
    return ParseResult(kind="reference", text=text.strip(), note=note, detected=detected)

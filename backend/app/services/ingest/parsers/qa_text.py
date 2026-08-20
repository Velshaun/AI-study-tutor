"""Pasted questions with lettered options and an answer key.

This is the parser that turns pasted material into a paper a learner can sit and
be scored on. It is deliberately deterministic — no model call — because the
alternative is paying a per-import cost to have something invent options that
were never in the source. A parser converts; anything that has to *create* a
distractor is generation and belongs elsewhere.

The shapes it handles are the ones people actually paste:

    1. Which command lists files?
    A. cd
    B. ls
    Answer: B

with the numbering optional, the letters allowed a `)` or `.`, the key written
as "Answer:", "Ans:", "Correct:" or "Key:", and a trailing key block
("1. B  2. D  3. A") instead of per-question answers. An asterisk or a trailing
"(correct)" on the option itself is also honoured, because plenty of exported
banks mark it that way.

Whatever it cannot resolve to a full question — prompt, at least two options, a
correct answer inside them — it declines to store as a question at all.
"""

from __future__ import annotations

import re

from app.services.ingest.canonical import (
    MAX_OPTIONS,
    Question,
    ParseResult,
    as_reference,
)

# "1." / "1)" / "Q1." / "Question 1:" at the start of a line.
QUESTION_START = re.compile(
    r"^\s*(?:Q(?:uestion)?\s*)?(\d{1,3})\s*[.):]\s+(?P<text>\S.*)$", re.I
)
# "A." / "B)" / "(C)" — one letter, then punctuation, then the option.
OPTION = re.compile(r"^\s*\(?([A-H])\)?\s*[.):]\s+(?P<text>\S.*)$")
# The answer for the question just read.
INLINE_KEY = re.compile(
    r"^\s*(?:correct\s+)?(?:answer|ans|key|correct)\s*[:\-]\s*\(?([A-H])\)?\b", re.I
)
# A separate key block at the end: "1. B", "1) B", "1 - B".
KEY_LINE = re.compile(r"(\d{1,3})\s*[.):\-]\s*\(?([A-H])\)?(?![A-Za-z])")
# An option marked correct in place.
MARKED = re.compile(r"^\s*\*+\s*|\s*\*+\s*$|\s*\((?:correct|answer)\)\s*$", re.I)

# Below this share of parsed questions being usable, the paste was probably not
# an exam and a partial one is worse than none.
MIN_USABLE_RATIO = 0.5
MIN_QUESTIONS = 1


def _letter_to_index(letter: str) -> int:
    return ord(letter.upper()) - ord("A")


def looks_like_questions(text: str) -> bool:
    """Are there lettered options here at all? Cheap pre-check for the pill."""
    lines = (text or "").splitlines()
    return sum(1 for line in lines if OPTION.match(line)) >= 2


def _trailing_key(text: str) -> dict[int, int]:
    """An answer key printed after the questions, as {question number: index}.

    Only the tail is searched: "1. B" appearing mid-paper is a question and an
    option, not a key.
    """
    lines = [line for line in (text or "").splitlines() if line.strip()]
    tail = "\n".join(lines[-max(6, len(lines) // 4):])
    if not re.search(r"answer\s*key|answers", tail, re.I):
        return {}
    return {
        int(num): _letter_to_index(letter)
        for num, letter in KEY_LINE.findall(tail)
    }


def parse(text: str) -> ParseResult:
    """Read questions, options and answers out of pasted text."""
    body = (text or "").strip()
    if not body:
        return as_reference("", "There was nothing to import.")

    key = _trailing_key(body)
    questions: list[Question] = []
    numbers: list[int | None] = []

    current: Question | None = None
    current_number: int | None = None
    marked_index: int | None = None

    def flush() -> None:
        nonlocal current, current_number, marked_index
        if current is None:
            return
        if current.correct_index is None and marked_index is not None:
            current.correct_index = marked_index
        questions.append(current)
        numbers.append(current_number)
        current, current_number, marked_index = None, None, None

    for raw in body.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue

        option = OPTION.match(line)
        start = QUESTION_START.match(line)
        answer = INLINE_KEY.match(line)

        # Order matters: "A. ls" matches an option, and a question numbered 1
        # matches a question start. An answer line is checked first because
        # "Answer: B" would otherwise read as prose continuing the prompt.
        if answer and current is not None:
            current.correct_index = _letter_to_index(answer.group(1))
            continue

        if option and current is not None and len(current.options) < MAX_OPTIONS:
            option_text = option.group("text").strip()
            cleaned = MARKED.sub("", option_text).strip()
            if cleaned != option_text:
                marked_index = len(current.options)
            current.options.append(cleaned)
            continue

        if start:
            flush()
            current = Question(prompt=start.group("text").strip())
            current_number = int(start.group(1))
            continue

        if current is not None and not current.options:
            # A prompt that wrapped onto a second line, before any options.
            current.prompt = f"{current.prompt} {line.strip()}".strip()

    flush()

    # Fill in anything the trailing key answers.
    if key:
        for question, number in zip(questions, numbers, strict=False):
            if question.correct_index is None and number in key:
                question.correct_index = key[number]

    usable = [q for q in questions if q.usable]
    if len(usable) < MIN_QUESTIONS:
        return as_reference(
            body,
            "No complete questions could be read from that — a question needs "
            "its options and its answer. It's been kept as study material "
            "instead.",
            detected="reference",
        )

    if questions and len(usable) / len(questions) < MIN_USABLE_RATIO:
        return as_reference(
            body,
            f"Only {len(usable)} of {len(questions)} questions had a complete "
            "set of options and an answer, so it's been kept as study material "
            "rather than turned into a patchy exam.",
            detected="reference",
        )

    note = f"Read {len(usable)} question{'s' if len(usable) != 1 else ''}."
    dropped = len(questions) - len(usable)
    if dropped:
        note += f" {dropped} had no answer and were left out."
    return ParseResult(
        kind="questions", questions=usable, note=note, detected="questions"
    )

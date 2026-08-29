"""A CSV of questions, with a type column deciding what each row becomes.

The header names the columns; nothing is positional beyond that. Recognised
(case-insensitive, with the obvious aliases):

    type          mcq | multiple choice | multi | multi-select | checkbox |
                  short | short answer | text | blank | fill in the blank |
                  cloze — absent or blank, the row's shape decides.
    question      or: prompt
    options       one cell, pipe- or semicolon-separated — or option_a..h /
                  bare a..h columns.
    answer        or: correct. Letters for choice kinds ("B", "A|C"), answer
                  text for short/blank ("chmod|change mode").
    explanation   optional, carried onto the question.

Sixty rows in means sixty questions out, or a per-row reason why not —
nothing invented, nothing padded. The parser converts; it never invents.
"""

from __future__ import annotations

import csv
import io
import re

from app.services.ingest.canonical import (
    ParseResult,
    Question,
    as_reference,
)

# Header spellings → canonical column.
_COLUMNS = {
    "type": "type", "kind": "type", "question type": "type",
    "question": "prompt", "prompt": "prompt", "q": "prompt",
    "options": "options", "choices": "options",
    "answer": "answer", "correct": "answer", "correct answer": "answer",
    "answers": "answer", "key": "answer",
    "explanation": "explanation", "why": "explanation", "rationale": "explanation",
}

_KINDS = {
    "mcq": "mcq", "multiple choice": "mcq", "choice": "mcq", "single": "mcq",
    "multi": "multi", "multi-select": "multi", "multiselect": "multi",
    "multiple select": "multi", "checkbox": "multi", "multi select": "multi",
    "short": "short", "short answer": "short", "text": "short",
    "free text": "short", "open": "short",
    "blank": "blank", "fill in the blank": "blank", "fill-in-the-blank": "blank",
    "fill in blank": "blank", "cloze": "blank", "fitb": "blank",
}

_SPLIT = re.compile(r"\s*[|;]\s*")


def looks_like_question_csv(text: str) -> bool:
    """A delimited header naming a question column is the tell."""
    head = (text or "").strip().splitlines()
    if not head:
        return False
    try:
        row = next(csv.reader(io.StringIO(head[0])))
    except (csv.Error, StopIteration):
        return False
    named = {_COLUMNS.get(c.strip().lower()) for c in row}
    return "prompt" in named and ("answer" in named or "options" in named)


def _letters_to_indices(value: str) -> list[int]:
    letters = re.findall(r"[a-hA-H]", value or "")
    return sorted({ord(letter.upper()) - ord("A") for letter in letters})


def parse(text: str) -> ParseResult:
    """Every row becomes the question its type says, or a reason it could not."""
    reader = csv.reader(io.StringIO((text or "").strip()))
    try:
        header = next(reader)
    except StopIteration:
        return as_reference("", "There was nothing to import.")

    columns: dict[int, str] = {}
    option_slots: list[int] = []
    for i, cell in enumerate(header):
        name = cell.strip().lower()
        if name in _COLUMNS:
            columns[i] = _COLUMNS[name]
        elif re.fullmatch(r"(option[ _]?)?[a-h]", name):
            option_slots.append(i)

    questions: list[Question] = []
    skipped: list[str] = []

    for line, row in enumerate(reader, start=2):
        if not any(cell.strip() for cell in row):
            continue
        field = {name: "" for name in ("type", "prompt", "options", "answer",
                                       "explanation")}
        for i, cell in enumerate(row):
            name = columns.get(i)
            if name:
                field[name] = cell.strip()
        options = (
            [row[i].strip() for i in option_slots
             if i < len(row) and row[i].strip()]
            if option_slots
            else [o for o in _SPLIT.split(field["options"]) if o.strip()]
        )

        declared = _KINDS.get(field["type"].strip().lower(), "")
        answer = field["answer"]
        if not declared:
            # The row's own shape: options with several letters is multi, with
            # one is mcq; no options is short — blank if the prompt has a gap.
            if options:
                declared = "multi" if len(_letters_to_indices(answer)) > 1 else "mcq"
            else:
                declared = "blank" if "___" in field["prompt"] else "short"

        q = Question(prompt=field["prompt"], kind=declared,
                     explanation=field["explanation"])
        if declared in ("short", "blank"):
            q.accepted = [a for a in _SPLIT.split(answer) if a.strip()]
        else:
            q.options = options
            indices = _letters_to_indices(answer)
            if declared == "multi":
                q.correct_indices = indices
            else:
                q.correct_index = indices[0] if indices else None

        if q.usable:
            questions.append(q)
        elif declared in ("mcq", "multi") and not options:
            # The commonest miss deserves its own words: a choice question
            # without options cannot be imported without inventing the
            # distractors, and the parser never invents.
            skipped.append(f"row {line} ({declared} with no options)")
        else:
            skipped.append(f"row {line}")

    if not questions:
        return as_reference(
            text.strip(),
            "None of those rows could become a question — each one needs a "
            "prompt and a gradable answer. Kept as study material instead.",
        )

    note = f"Imported {len(questions)} question{'s' if len(questions) != 1 else ''}."
    if skipped:
        note += (
            f" {len(skipped)} row{'s' if len(skipped) != 1 else ''} left out: "
            f"{', '.join(skipped[:6])}{'…' if len(skipped) > 6 else ''}. "
            "A row needs a prompt and a gradable answer — and choice types "
            "need their options."
        )
    return ParseResult(
        kind="questions", questions=questions, note=note, detected="questions",
    )

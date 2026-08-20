"""Quizlet's own export format: term/definition pairs.

Quizlet exports let the learner pick the separators — a tab or " - " between
term and definition, a newline or a blank line or ";" between rows — so the
format is a small family rather than one thing. The separator is inferred from
what is actually consistent down the paste rather than assumed, because
guessing wrong turns fifty cards into one enormous one.

What comes out is flashcards. A term and its definition is a flashcard by
construction; it is not a question, because it has no options and no answer key
and inventing those would be generating rather than converting. Material pasted
here and labelled Quiz or Practice Exam therefore comes back as cards or as
reference text, with a note saying so — see `ingest.parse`.
"""

from __future__ import annotations

import re

from app.services.ingest.canonical import Card, ParseResult, as_reference

# Row separators, most distinctive first. A blank line beats a single newline:
# definitions frequently wrap.
ROW_SEPARATORS = ("\n\n", "\r\n\r\n", "\n", ";")
# Term/definition separators. Tab is Quizlet's default and the least ambiguous;
# " - " is the common hand-rolled alternative and is checked with spaces so it
# doesn't split hyphenated words.
TERM_SEPARATORS = ("\t", " - ", " – ", " — ", " : ", "|")

MIN_ROWS = 2
# A "definition" longer than this is almost certainly a bad split that swallowed
# the rest of the document.
MAX_SIDE_CHARS = 2000


def _split_rows(text: str) -> tuple[list[str], str]:
    """Rows, and the separator that produced them."""
    for sep in ROW_SEPARATORS:
        rows = [r.strip() for r in text.split(sep) if r.strip()]
        if len(rows) >= MIN_ROWS:
            return rows, sep
    return ([text.strip()] if text.strip() else []), ""


def _pick_term_separator(rows: list[str]) -> str | None:
    """The separator that splits the most rows cleanly into exactly two sides."""
    best, best_hits = None, 0
    for sep in TERM_SEPARATORS:
        hits = sum(1 for r in rows if len(r.split(sep)) == 2 and all(
            part.strip() for part in r.split(sep)
        ))
        if hits > best_hits:
            best, best_hits = sep, hits
    # Most of the paste has to agree, or this isn't a term/definition list at all.
    return best if best_hits >= max(MIN_ROWS, int(len(rows) * 0.6)) else None


def looks_like_quizlet(text: str) -> bool:
    rows, _ = _split_rows(text or "")
    return bool(rows) and _pick_term_separator(rows) is not None


def parse(text: str) -> ParseResult:
    """Term/definition pairs to flashcards."""
    body = (text or "").strip()
    if not body:
        return as_reference("", "There was nothing to import.")

    rows, _ = _split_rows(body)
    separator = _pick_term_separator(rows)
    if not separator:
        return as_reference(
            body,
            "That didn't look like a term-and-definition list, so it's been kept "
            "as study material rather than split into cards.",
            detected="reference",
        )

    cards: list[Card] = []
    skipped = 0
    for row in rows:
        parts = row.split(separator)
        if len(parts) != 2:
            skipped += 1
            continue
        front, back = parts[0].strip(), parts[1].strip()
        if not front or not back or len(back) > MAX_SIDE_CHARS:
            skipped += 1
            continue
        cards.append(Card(front=front, back=back))

    usable = [c for c in cards if c.usable]
    if not usable:
        return as_reference(
            body,
            "No usable cards could be read from that, so it's been kept as "
            "study material instead.",
            detected="reference",
        )

    note = f"Read {len(usable)} card{'s' if len(usable) != 1 else ''}."
    if skipped:
        note += f" {skipped} line{'s' if skipped != 1 else ''} didn't fit the pattern."
    return ParseResult(kind="flashcards", cards=usable, note=note, detected="flashcards")

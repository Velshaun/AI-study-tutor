"""Removing a piece of study material hides it; it never destroys what it made.

A learner who has finished with a lecture wants it off the screen. That is not
the same wish as wanting the twenty questions they asked during it forgotten —
and a real delete would forget them, because ``qa_sessions.lecture_id`` and
``lecture_qa.lecture_id`` both cascade. ``review_later`` and ``study_attempts``
are polymorphic with no foreign key at all, so they would survive as rows
pointing at nothing, which is worse than either outcome.

So removal writes ``deleted_at`` and every *listing* read skips it. Deliberately
only the listings: a removed quiz's score still counts towards the domain's
strength, because the learner really did sit it, and a strength that drops when
somebody tidies up their Classroom would be measuring housekeeping. The same
reason a sat exam outranks a forced rebuild.

Fetching one by id still works. A Q&A entry names the lecture it came from, and
a title that resolves to "not found" the day the pill was removed is the
cascade's damage arriving by another route.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from app.services import schema_features

COLUMN = "deleted_at"

# Everything a learner can remove from the Classroom.
TABLES = ("lectures", "quizzes", "flashcards", "practice_questions",
          "practice_exams")


def supported(table: str) -> bool:
    """True where the migration has landed. Probed once, then cached."""
    return schema_features.has_column(table, COLUMN)


def live(query: Any, table: str) -> Any:
    """Narrow a PostgREST query to rows that have not been removed."""
    return query.is_(COLUMN, "null") if supported(table) else query


def stamp() -> dict[str, str]:
    """The update payload that removes a row."""
    return {COLUMN: datetime.now(UTC).isoformat()}

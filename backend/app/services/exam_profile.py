"""How long is the exam the learner is actually sitting?

Every practice generator used to carry its own hardcoded size (practice mode: 8,
quizzes: 5, exams: 20), so a learner revising for a 40-question paper got an
8-question set. The length lives on the module instead, and is resolved here so
the practice-mode, practice-exam and flashcard paths all agree.

Resolution order — first hit wins:

  1. an explicit request (the learner picked a count in the UI),
  2. ``modules.exam_question_count`` — the real paper's length, as stated by the
     learner (LPI Linux Essentials: 40),
  3. the published spec for the certification the module is about, from
     ``exam_catalog`` — a module titled "CompTIA Security+" sits 90 questions
     in 90 minutes whether or not anyone has said so,
  4. the largest imported practice-exam batch for the module — a past paper the
     learner uploaded is evidence of the real length,
  5. ``DEFAULT_QUESTION_COUNT``.
"""

from __future__ import annotations

import logging
from typing import Any

from app.database import get_supabase
from app.services import exam_catalog

logger = logging.getLogger(__name__)

# Bounds shared by every caller, so a request can't ask for a 500-question set.
MIN_QUESTION_COUNT = 1
MAX_QUESTION_COUNT = 100
# Used only when nothing else is known about the exam.
DEFAULT_QUESTION_COUNT = 20
# Typical multiple-choice pacing, for a realistic timed run.
MINUTES_PER_QUESTION = 1.5
# Long enough for a bar-exam-style sitting, short enough to be a typo guard.
MAX_DURATION_MINUTES = 600


def clamp_count(value: int | None, default: int = DEFAULT_QUESTION_COUNT) -> int:
    """Bound a requested count into the supported range."""
    try:
        n = int(value) if value is not None else default
    except (TypeError, ValueError):
        n = default
    return max(MIN_QUESTION_COUNT, min(n, MAX_QUESTION_COUNT))


def module_for_domain(domain_id: str, user_id: str) -> str | None:
    """The module a domain belongs to, or None if it isn't the caller's."""
    rows = (
        get_supabase().table("domains").select("module_id")
        .eq("id", domain_id).eq("user_id", user_id).limit(1).execute()
    ).data or []
    return rows[0].get("module_id") if rows else None


def _largest_imported_batch(module_id: str, user_id: str) -> int:
    """Question count of the biggest imported past paper for this module.

    Read from the exams themselves now rather than from a second copy of their
    questions. An imported paper has always *been* an exam — the duplicate table
    this used to count was the thing that didn't belong.
    """
    client = get_supabase()
    exams = (
        client.table("practice_exams").select("id, import_batch_id")
        .eq("module_id", module_id).eq("user_id", user_id)
        .eq("origin", "imported_pdf").execute()
    ).data or []
    if not exams:
        return 0

    rows = (
        client.table("practice_questions").select("exam_id")
        .in_("exam_id", [e["id"] for e in exams]).execute()
    ).data or []
    batch_of = {e["id"]: e.get("import_batch_id") or e["id"] for e in exams}
    sizes: dict[str, int] = {}
    for r in rows:
        batch = batch_of.get(r.get("exam_id"), "_ungrouped")
        sizes[batch] = sizes.get(batch, 0) + 1
    return max(sizes.values())


def exam_question_count(
    module_id: str | None,
    user_id: str,
    *,
    requested: int | None = None,
    module_row: dict[str, Any] | None = None,
) -> int:
    """How many questions a practice set for this module should hold.

    ``module_row`` lets a caller that already fetched the module skip a query.
    """
    if requested is not None:
        return clamp_count(requested)
    if not module_id:
        return DEFAULT_QUESTION_COUNT

    row = module_row
    if row is None:
        try:
            rows = (
                get_supabase().table("modules").select("*")
                .eq("id", module_id).eq("user_id", user_id).limit(1).execute()
            ).data or []
            row = rows[0] if rows else {}
        except Exception as exc:  # noqa: BLE001 — never block a practice set
            logger.warning("module lookup failed for %s: %s", module_id, exc)
            row = {}

    stated = row.get("exam_question_count")
    if stated:
        return clamp_count(stated)

    known = exam_catalog.find(row.get("title"), row.get("detected_subject"))
    if known:
        return clamp_count(known.question_count)

    try:
        imported = _largest_imported_batch(module_id, user_id)
    except Exception as exc:  # noqa: BLE001 — inference is best-effort
        logger.warning("imported-batch lookup failed for %s: %s", module_id, exc)
        imported = 0
    if imported:
        return clamp_count(imported)

    return DEFAULT_QUESTION_COUNT


def exam_duration_minutes(
    question_count: int, module_row: dict[str, Any] | None = None,
    *, requested: int | None = None,
) -> int:
    """Timed-run length for a set of ``question_count`` questions.

    An explicit request wins. Otherwise the real paper's timing is used — the
    module's own, else the published spec for the certification it is about —
    pro rata, so a half-length practice run gets half the clock rather than the
    full sitting. Falls back to typical multiple-choice pacing.
    """
    if requested:
        return max(1, min(int(requested), MAX_DURATION_MINUTES))

    row = module_row or {}
    stated_minutes = row.get("exam_duration_minutes")
    stated_count = row.get("exam_question_count")

    if not stated_minutes:
        known = exam_catalog.find(row.get("title"), row.get("detected_subject"))
        if known:
            stated_minutes = known.duration_minutes
            stated_count = stated_count or known.question_count

    if stated_minutes and stated_count:
        return max(5, round(int(stated_minutes) * question_count / int(stated_count)))
    if stated_minutes:
        return int(stated_minutes)
    return max(5, round(question_count * MINUTES_PER_QUESTION))

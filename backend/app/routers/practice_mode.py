"""Practice Exam Mode — spec 6.4.

    GET    /practice/{domain_id}/questions      get-or-generate a domain's set
    GET    /practice/{domain_id}/review-later   the domain's flagged questions
    POST   /practice/questions/{id}/flag        add to Review Later
    DELETE /practice/questions/{id}/flag        remove from Review Later ("Got It")

A domain-scoped study experience with immediate per-question feedback: every
option carries its own explanation, each question a Why Card, and questions can
be flagged into the (shared, polymorphic) review_later queue.

Set length follows the exam the learner is actually sitting — see
``app.services.exam_profile`` — rather than a fixed constant, so a 40-question
paper is practised with 40 questions. A short cached set is topped up rather
than thrown away.

A full-length set is written in two stages: the first ``FIRST_CHUNK`` questions
are generated in the request, and the rest are backfilled in the background so
the learner can start straight away and the set grows underneath them.

Questions are cached in ``practice_questions`` (exam_id null, domain_id set) so
a domain generates once. Per-option explanations are resolved at generation
time and stored on the option (they are stripped from the pre-submission
payload), which keeps answering a single read — see ``submit_answer``.
"""
from __future__ import annotations

import logging
import threading
from typing import Any

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Query,
    status,
)
from pydantic import BaseModel, Field

from app.database import get_supabase
from app.routers.auth import AuthUser, get_current_user
from app.services import exam_profile, removal, schema_features
from app.services.ai_service import (
    PRACTICE_BATCH_SIZE,
    GenerationError,
    gather_domain_content,
    generate_practice_questions,
    generate_term_explanations,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/practice", tags=["practice_mode"])

LETTERS = "ABCD"
REVIEW_ITEM_TYPE = "practice_question"
MAX_COUNT = exam_profile.MAX_QUESTION_COUNT
# Terms explained per Gemini call — a 40-question set has ~160 options, which is
# far too many for one prompt.
EXPLAIN_BATCH_SIZE = 40
# Questions generated before the response is sent. Enough to start a run on
# while the rest is written in the background — a learner answering the first
# ten takes minutes, the backfill takes far less.
FIRST_CHUNK = 10

# Domains with a backfill already running, so a poll (or a second tab) can't
# start a duplicate. Per-process, which matches the deployment: the guard is a
# courtesy anyway — the backfill re-reads the set before it writes, and passes
# what already exists to the generator so it can't repeat questions.
_backfilling: set[str] = set()
_backfill_lock = threading.Lock()


def _claim_backfill(domain_id: str) -> bool:
    """Take the backfill slot for a domain, if it's free."""
    with _backfill_lock:
        if domain_id in _backfilling:
            return False
        _backfilling.add(domain_id)
        return True


def _release_backfill(domain_id: str) -> None:
    with _backfill_lock:
        _backfilling.discard(domain_id)


def _is_backfilling(domain_id: str) -> bool:
    with _backfill_lock:
        return domain_id in _backfilling


# --- Schemas ----------------------------------------------------------------
class PracticeOption(BaseModel):
    label: str
    text: str
    term_key: str = ""


class PracticeQuestion(BaseModel):
    """Pre-submission shape — deliberately carries no answer or explanations, so
    the correct option can't be read off the wire before the learner commits."""

    id: str
    question_text: str
    options: list[PracticeOption] = Field(default_factory=list)
    is_flagged: bool = False
    # Tappable vocabulary and acronyms found in this text, generated with it so
    # the definition popover opens with no round trip.
    terms: list[dict[str, Any]] = Field(default_factory=list)


class PracticeSet(BaseModel):
    """A domain's practice set, which may still be filling up.

    ``generating`` tells the client to keep polling: the questions already here
    are ready to answer, and more are being written behind them.
    """

    questions: list[PracticeQuestion] = Field(default_factory=list)
    target_count: int = 0
    generating: bool = False


class AnsweredOption(PracticeOption):
    explanation: str = ""


class SubmitAnswerRequest(BaseModel):
    chosen_option: str = Field(..., description="Label of the chosen option, e.g. 'B'.")


class AnswerResult(BaseModel):
    """Post-submission reveal — every option's explanation plus the Why Card."""

    question_id: str
    chosen_option: str
    correct_option: str
    is_correct: bool
    options: list[AnsweredOption] = Field(default_factory=list)
    why_summary: str = ""


# --- Helpers ----------------------------------------------------------------
def _client():
    try:
        return get_supabase()
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc


def _own_domain(domain_id: str, user_id: str) -> dict[str, Any]:
    rows = (
        _client().table("domains").select("*")
        .eq("id", domain_id).eq("user_id", user_id).limit(1).execute()
    ).data or []
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Domain not found.")
    return rows[0]


def _own_question(question_id: str, user_id: str) -> dict[str, Any]:
    """A practice question whose domain the caller owns."""
    rows = (
        _client().table("practice_questions").select("*")
        .eq("id", question_id).limit(1).execute()
    ).data or []
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Question not found.")
    q = rows[0]
    if not q.get("domain_id"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Question not found.")
    _own_domain(q["domain_id"], user_id)  # 404s if not the caller's domain
    return q


def _flagged_ids(user_id: str, question_ids: list[str]) -> set[str]:
    if not question_ids:
        return set()
    rows = (
        _client().table("review_later").select("item_id")
        .eq("user_id", user_id).eq("item_type", REVIEW_ITEM_TYPE)
        .in_("item_id", question_ids).execute()
    ).data or []
    return {r["item_id"] for r in rows}


def _row_to_question(row: dict[str, Any], *, flagged: bool) -> PracticeQuestion:
    """The pre-submission shape — no correct answer, no explanations."""
    options = [
        PracticeOption(
            label=(o.get("label") or "").strip(),
            text=(o.get("text") or "").strip(),
            term_key=(o.get("term_key") or "").strip(),
        )
        for o in (row.get("options") or [])
    ]
    return PracticeQuestion(
        id=row["id"],
        question_text=row.get("prompt") or "",
        options=options,
        is_flagged=flagged,
        terms=row.get("terms") or [],
    )


def _correct_letter(row: dict[str, Any]) -> str:
    idx = row.get("correct_index")
    return LETTERS[idx] if isinstance(idx, int) and 0 <= idx < len(LETTERS) else "A"


def _term_key(option: dict[str, Any]) -> str:
    return (option.get("term_key") or "").strip()


# --- Explanations -----------------------------------------------------------
def _cached_explanations(domain_id: str, term_keys: list[str]) -> dict[str, str]:
    """Read the concept cache for a batch of terms."""
    if not term_keys:
        return {}
    resolved: dict[str, str] = {}
    client = _client()
    # `in_` filters go into the query string, so chunk them rather than sending
    # one enormous URL for a full exam's worth of terms.
    for i in range(0, len(term_keys), EXPLAIN_BATCH_SIZE):
        chunk = term_keys[i:i + EXPLAIN_BATCH_SIZE]
        rows = (
            client.table("exam_concept_cache").select("concept, payload")
            .eq("domain_id", domain_id).in_("concept", chunk).execute()
        ).data or []
        for r in rows:
            explanation = (r.get("payload") or {}).get("explanation")
            if explanation:
                resolved[r["concept"]] = explanation
    return resolved


def _cache_explanations(
    domain_id: str, user_id: str, explanations: dict[str, str]
) -> None:
    """Write freshly generated explanations back to the concept cache."""
    if not explanations:
        return
    payload = [
        {"domain_id": domain_id, "user_id": user_id, "concept": k,
         "payload": {"explanation": v}}
        for k, v in explanations.items()
    ]
    try:
        _client().table("exam_concept_cache").upsert(
            payload, on_conflict="domain_id,concept"
        ).execute()
    except Exception as exc:  # noqa: BLE001 — cache write is best-effort
        logger.warning("concept cache upsert failed: %s", exc)


def _resolve_explanations(
    domain_id: str, user_id: str, options: list[dict[str, Any]],
    *, subject: str, question_text: str = "",
) -> dict[str, str]:
    """Explanation per term_key, cache-first (spec 6.4 caching).

    Reads exam_concept_cache by term_key; any misses are generated by Gemini in
    batches and written back, so each distinct term is explained exactly once,
    ever. A generation failure degrades gracefully to whatever was cached.
    """
    term_keys = list(dict.fromkeys(t for t in (_term_key(o) for o in options) if t))
    if not term_keys:
        return {}

    resolved = _cached_explanations(domain_id, term_keys)

    missing = [
        {"term_key": _term_key(o), "text": (o.get("text") or "").strip()}
        for o in options
        if _term_key(o) and _term_key(o) not in resolved
    ]
    # De-duplicate, keeping the first sighting of each term.
    missing = list({m["term_key"]: m for m in missing}.values())

    fresh: dict[str, str] = {}
    for i in range(0, len(missing), EXPLAIN_BATCH_SIZE):
        chunk = missing[i:i + EXPLAIN_BATCH_SIZE]
        try:
            fresh.update(
                generate_term_explanations(
                    chunk, subject=subject, question_text=question_text
                )
            )
        except GenerationError as exc:
            logger.warning("term explanation generation failed: %s", exc)
            break

    if fresh:
        resolved.update(fresh)
        _cache_explanations(domain_id, user_id, fresh)
    return resolved


def _attach_explanations(
    domain_id: str, user_id: str, questions: list[dict[str, Any]], *, subject: str
) -> None:
    """Make sure every option carries an explanation, in place.

    The generator now writes one per option as it writes the question — "why
    this is right", "why this is wrong" — which is both better feedback and one
    fewer model call. This fills any gaps from the concept cache, so a question
    whose options came back bare still explains itself.

    Either way the work happens at generation time, so answering is a plain
    read; explanations never reach the client before submission, because
    ``_row_to_question`` maps only label/text/term_key.
    """
    missing = [
        o for q in questions for o in q.get("options") or []
        if not (o.get("explanation") or "").strip()
    ]
    if not missing:
        return

    explanations = _resolve_explanations(
        domain_id, user_id, missing, subject=subject
    )
    for option in missing:
        option["explanation"] = explanations.get(_term_key(option), "")


# --- Generation -------------------------------------------------------------
def _stored_questions(domain_id: str) -> list[dict[str, Any]]:
    """The domain's cached practice set, in order."""
    return (
        removal.live(
            _client().table("practice_questions").select("*"),
            "practice_questions",
        )
        .eq("domain_id", domain_id).is_("exam_id", "null")
        .order("position").execute()
    ).data or []


def _backfill_set(domain: dict[str, Any], user_id: str, target: int) -> None:
    """Finish a partly generated set after the response has gone out.

    Runs in FastAPI's background thread pool. Generates in batches and writes
    each one as it lands, so a learner polling mid-run sees the set grow rather
    than waiting for the whole remainder. Re-reads what's stored between
    batches, so a concurrent top-up can't cause duplicates or clashing
    positions.
    """
    domain_id = domain["id"]
    try:
        while True:
            existing = _stored_questions(domain_id)
            missing = target - len(existing)
            if missing <= 0:
                return
            added = _generate_into(
                domain, user_id,
                wanted=min(missing, PRACTICE_BATCH_SIZE), existing=existing,
            )
            if not added:  # the model has run dry — don't spin
                logger.info(
                    "practice backfill for domain %s stopped at %d of %d",
                    domain_id, len(existing), target,
                )
                return
    except HTTPException as exc:
        # Nobody is waiting on this response; the learner keeps the questions
        # already written and a later visit retries.
        logger.warning("practice backfill failed for domain %s: %s", domain_id, exc.detail)
    except Exception as exc:  # noqa: BLE001 — a background thread must not die loudly
        logger.exception("practice backfill errored for domain %s: %s", domain_id, exc)
    finally:
        _release_backfill(domain_id)


def _target_count(domain: dict[str, Any], user_id: str, requested: int | None) -> int:
    """How many questions this domain's set should hold."""
    return exam_profile.exam_question_count(
        domain.get("module_id"), user_id, requested=requested
    )


def _generate_into(
    domain: dict[str, Any], user_id: str, *, wanted: int, existing: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Generate ``wanted`` new questions for a domain and store them.

    Returns the inserted rows. Existing prompts are passed to the generator so a
    top-up extends the set instead of repeating it.
    """
    domain_id = domain["id"]
    material = gather_domain_content(domain_id, user_id)
    try:
        generated = generate_practice_questions(
            material["content"], wanted,
            subject=material["subject"],
            topic=domain.get("title") or "",
            avoid=[r.get("prompt") or "" for r in existing],
        )
    except GenerationError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    _attach_explanations(
        domain_id, user_id, generated, subject=material["subject"]
    )

    start = max((r.get("position") or 0) for r in existing) + 1 if existing else 0
    rows = []
    for i, q in enumerate(generated):
        correct_idx = next(
            (n for n, o in enumerate(q["options"])
             if o["label"] == q["correct_option"]), 0
        )
        # No user_id column on practice_questions — ownership flows through
        # domain_id -> domains.user_id (enforced by _own_domain / _own_question).
        rows.append({
            "domain_id": domain_id,
            "exam_id": None,
            "kind": "mcq",
            "prompt": q["question_text"],
            "options": q["options"],
            "correct_index": correct_idx,
            "why_summary": q["why_summary"],
            "position": start + i,
            "points": 1,
            "terms": q.get("terms") or [],
        })
    if not rows:
        return []
    rows = schema_features.strip_unsupported("practice_questions", rows, "terms")
    return (_client().table("practice_questions").insert(rows).execute()).data or []


# --- Routes -----------------------------------------------------------------
@router.get("/{domain_id}/questions", response_model=PracticeSet)
async def get_questions(
    domain_id: str,
    count: int | None = Query(
        None, ge=1, le=MAX_COUNT,
        description="Override the set length; defaults to the module's exam length.",
    ),
    regenerate: bool = Query(False, description="Discard the cached set and rebuild."),
    background: BackgroundTasks = None,  # noqa: B008 — FastAPI injects this
    user: AuthUser = Depends(get_current_user),
) -> PracticeSet:
    """Get-or-generate the domain's practice questions.

    The set is as long as the exam the learner is revising for. Only the first
    ``FIRST_CHUNK`` are generated in the request — the rest are backfilled in
    the background, so a 40-question set is startable in the time a 10-question
    one takes. Poll while ``generating`` is true to pick up the rest. A cached
    set that predates a longer target is topped up rather than rebuilt.
    """
    domain = _own_domain(domain_id, user.id)
    client = _client()
    target = _target_count(domain, user.id, count)

    if regenerate:
        # Retired rather than deleted, for the same reason removal is: answers
        # have already been given against these, and review flags point at
        # them. The replacements are the domain's set from here on; the old
        # ones simply stop being listed.
        old_set = client.table("practice_questions")
        old_set = (
            old_set.update(removal.stamp())
            if removal.supported("practice_questions") else old_set.delete()
        )
        old_set.eq("domain_id", domain_id).is_("exam_id", "null").execute()

    existing = _stored_questions(domain_id)

    # Generate the opening chunk inline — unless a backfill is already writing
    # this domain, in which case this is a poll and the answer is whatever has
    # landed so far.
    stalled = False
    if len(existing) < target and not _is_backfilling(domain_id):
        added = _generate_into(
            domain, user.id,
            wanted=min(FIRST_CHUNK, target - len(existing)), existing=existing,
        )
        # Nothing came back: the material is exhausted, so stop promising more
        # rather than leaving the client polling forever.
        stalled = not added
        existing = sorted(existing + added, key=lambda r: r.get("position") or 0)

    # Still short of the target: finish the job after this response is sent.
    generating = len(existing) < target and not stalled
    if generating and background is not None and _claim_backfill(domain_id):
        background.add_task(_backfill_set, domain, user.id, target)

    existing = existing[:target]
    flagged = _flagged_ids(user.id, [r["id"] for r in existing])
    return PracticeSet(
        questions=[_row_to_question(r, flagged=r["id"] in flagged) for r in existing],
        target_count=target,
        generating=generating,
    )


@router.post("/questions/{question_id}/submit-answer", response_model=AnswerResult)
async def submit_answer(
    question_id: str,
    payload: SubmitAnswerRequest,
    user: AuthUser = Depends(get_current_user),
) -> AnswerResult:
    """Reveal the answer: every option's explanation + the Why Card.

    Explanations are written onto the options at generation time, so the happy
    path here is one read and no model call — grading is instant. Questions
    generated before that change (or whose explanations failed to generate) are
    resolved on first answer and backfilled onto the row, so each one pays that
    cost at most once.
    """
    q = _own_question(question_id, user.id)
    options = q.get("options") or []

    if options and not any((o.get("explanation") or "").strip() for o in options):
        _backfill_explanations(q, user.id)
        options = q.get("options") or []

    answered = [
        AnsweredOption(
            label=(o.get("label") or "").strip(),
            text=(o.get("text") or "").strip(),
            term_key=_term_key(o),
            explanation=(o.get("explanation") or "").strip(),
        )
        for o in options
    ]
    correct = _correct_letter(q)
    chosen = (payload.chosen_option or "").strip().upper()[:1]
    return AnswerResult(
        question_id=question_id,
        chosen_option=chosen,
        correct_option=correct,
        is_correct=chosen == correct,
        options=answered,
        why_summary=q.get("why_summary") or "",
    )


def _backfill_explanations(question: dict[str, Any], user_id: str) -> None:
    """Legacy path: resolve a stored question's explanations and persist them."""
    domain_id = question["domain_id"]
    options = question.get("options") or []
    material = gather_domain_content(domain_id, user_id)
    explanations = _resolve_explanations(
        domain_id, user_id, options,
        subject=material["subject"], question_text=question.get("prompt") or "",
    )
    if not explanations:
        return
    for option in options:
        option["explanation"] = explanations.get(_term_key(option), "")
    try:
        _client().table("practice_questions").update(
            {"options": options}
        ).eq("id", question["id"]).execute()
    except Exception as exc:  # noqa: BLE001 — the answer still returns fine
        logger.warning("explanation backfill failed for %s: %s", question["id"], exc)


@router.get("/{domain_id}/review-later", response_model=list[PracticeQuestion])
async def review_later(
    domain_id: str,
    user: AuthUser = Depends(get_current_user),
) -> list[PracticeQuestion]:
    """The domain's questions the caller has flagged for review."""
    _own_domain(domain_id, user.id)
    client = _client()

    flags = (
        client.table("review_later").select("item_id")
        .eq("user_id", user.id).eq("item_type", REVIEW_ITEM_TYPE).execute()
    ).data or []
    flagged_ids = [f["item_id"] for f in flags]
    if not flagged_ids:
        return []

    rows = (
        client.table("practice_questions").select("*")
        .eq("domain_id", domain_id).in_("id", flagged_ids)
        .order("position").execute()
    ).data or []
    return [_row_to_question(r, flagged=True) for r in rows]


@router.delete("/{domain_id}/questions", status_code=status.HTTP_204_NO_CONTENT)
async def delete_question_set(
    domain_id: str,
    user: AuthUser = Depends(get_current_user),
) -> None:
    """Remove a domain's practice set from the learner's screens.

    The questions are marked rather than deleted, so the answers already given
    against them — and the review flags in the polymorphic ``review_later``
    table, which has no foreign key to lean on — keep pointing at rows that
    exist. A deployment without the column falls back to the old delete, and
    clears the flags itself so nothing is left dangling.
    """
    _own_domain(domain_id, user.id)
    client = _client()
    rows = (
        removal.live(
            client.table("practice_questions").select("id"), "practice_questions",
        ).eq("domain_id", domain_id).is_("exam_id", "null").execute()
    ).data or []
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No practice set to remove.")

    if removal.supported("practice_questions"):
        # The flags stay. A question the learner marked for review is a note
        # they wrote to themselves, and it still points at a row that exists —
        # which is the whole reason the questions are marked rather than
        # deleted.
        client.table("practice_questions").update(removal.stamp()).eq(
            "domain_id", domain_id
        ).is_("exam_id", "null").execute()
        return

    ids = [r["id"] for r in rows]
    for start in range(0, len(ids), 100):
        chunk = ids[start:start + 100]
        client.table("review_later").delete().eq("user_id", user.id).eq(
            "item_type", REVIEW_ITEM_TYPE
        ).in_("item_id", chunk).execute()

    client.table("practice_questions").delete().eq(
        "domain_id", domain_id
    ).is_("exam_id", "null").execute()


@router.post("/questions/{question_id}/flag", status_code=status.HTTP_204_NO_CONTENT)
async def flag_question(
    question_id: str,
    user: AuthUser = Depends(get_current_user),
) -> None:
    """Add a question to Review Later (idempotent)."""
    _own_question(question_id, user.id)
    _client().table("review_later").upsert(
        {"user_id": user.id, "item_type": REVIEW_ITEM_TYPE, "item_id": question_id},
        on_conflict="user_id,item_type,item_id",
    ).execute()


def _remove_from_review(question_id: str, user_id: str) -> None:
    _own_question(question_id, user_id)
    _client().table("review_later").delete().eq("user_id", user_id).eq(
        "item_type", REVIEW_ITEM_TYPE
    ).eq("item_id", question_id).execute()


@router.post("/questions/{question_id}/got-it", status_code=status.HTTP_204_NO_CONTENT)
async def got_it(
    question_id: str,
    user: AuthUser = Depends(get_current_user),
) -> None:
    """"Got It" — remove a question from Review Later."""
    _remove_from_review(question_id, user.id)


@router.delete("/questions/{question_id}/flag", status_code=status.HTTP_204_NO_CONTENT)
async def unflag_question(
    question_id: str,
    user: AuthUser = Depends(get_current_user),
) -> None:
    """Remove a question from Review Later (same as got-it; kept for symmetry)."""
    _remove_from_review(question_id, user.id)

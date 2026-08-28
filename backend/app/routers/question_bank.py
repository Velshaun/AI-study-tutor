"""The two containers, and the sessions that feed them.

    GET    /bank/{module_id}/{container}          what's in it
    DELETE /bank/entry/{entry_id}                 remove one, by hand
    POST   /bank/{module_id}/{container}/add      the confirmation prompt's yes
    POST   /bank/{module_id}/{container}/generate make something from it

    POST   /bank/sessions                         record a finished sitting
    GET    /bank/sessions/{module_id}             past sittings, newest first

Nothing else in the app reads a container. Generation elsewhere goes through
`ai_service` against the module's sources, and these routes are the only path
that reaches `question_bank` at all — which is what "strictly isolated and
opt-in" means in practice, and is worth keeping true as things get added.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.database import get_supabase
from app.routers.auth import AuthUser, get_current_user
from app.services import (
    exam_profile, question_bank as bank, removal, schema_features,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/bank", tags=["question bank"])


def _client():
    return get_supabase()


def _own_module(module_id: str, user_id: str) -> dict[str, Any]:
    rows = (
        _client().table("modules").select("id, title")
        .eq("id", module_id).eq("user_id", user_id).limit(1).execute()
    ).data or []
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Module not found.")
    return rows[0]


def _check_container(container: str) -> str:
    if container not in bank.CONTAINERS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Unknown container. Expected one of {', '.join(bank.CONTAINERS)}.",
        )
    return container


class BankEntry(BaseModel):
    id: str
    container: str
    source_kind: str
    source_id: str | None = None
    domain_id: str | None = None
    missed: bool = False
    flagged: bool = False
    snapshot: dict[str, Any] = Field(default_factory=dict)
    correct_streak: int = 0
    graduated_at: datetime | None = None
    created_at: datetime | None = None


# Shared by both generation paths — a container and a past session ask the
# same question over different pools, so they answer in the same shape.
class GenerateRequest(BaseModel):
    # 'practice_exam' | 'quiz' | 'flashcards'
    media: str
    # 'all' | 'half' | a number
    how_many: str | int = "all"
    # 'recent' | 'oldest' | 'random'
    which: str = "recent"
    title: str | None = None
    # Narrow to one domain's misses. Absent means the whole module, which is
    # what the classroom-level control asks for.
    domain_id: str | None = None


class GenerateResponse(BaseModel):
    media: str
    created_id: str | None = None
    used: int
    available: int
    skipped: int = 0
    note: str = ""


# --- sessions ---------------------------------------------------------------
# Declared before the container routes on purpose. `/bank/sessions/{module_id}`
# and `/bank/{module_id}/{container}` are both three segments, so the generic
# one matches a sessions request with module_id="sessions" if it is registered
# first — a 404 that looks like a missing module rather than a routing mistake.
class SessionResult(BaseModel):
    prompt: str = ""
    options: list[Any] = Field(default_factory=list)
    correct_index: int | None = None
    chosen_index: int | None = None
    correct: bool = False
    flagged: bool = False
    source_kind: str = "practice_question"
    source_id: str | None = None
    domain_id: str | None = None
    # Set when this question came from a container, and the reason
    # auto-graduation works: without it here, model_dump() strips the field and
    # the streak is never updated for anything.
    bank_entry_id: str | None = None


class SessionRequest(BaseModel):
    module_id: str
    kind: str
    item_id: str | None = None
    title: str = ""
    results: list[SessionResult] = Field(default_factory=list)


class StudySession(BaseModel):
    id: str
    kind: str
    item_id: str | None = None
    # The thing this was a sitting of has since been removed from the screens.
    # The record stays — that is the whole point of keeping it — but a title the
    # learner deliberately cleared away should say why it is still here.
    item_removed: bool = False
    title: str = ""
    total: int = 0
    correct: int = 0
    score_pct: float | None = None
    results: list[dict[str, Any]] = Field(default_factory=list)
    created_at: datetime | None = None


@router.post("/sessions", response_model=StudySession,
             status_code=status.HTTP_201_CREATED)
async def record_session(
    payload: SessionRequest,
    user: AuthUser = Depends(get_current_user),
) -> StudySession:
    """Store a finished sitting, so it stays a source long after the run.

    Written for every runner, including flashcards — which had no record of a
    sitting at all before this, and so could never be looked back at.
    """
    _own_module(payload.module_id, user.id)

    results = [r.model_dump() for r in payload.results]
    total = len(results)
    correct = sum(1 for r in results if r.get("correct"))

    row = (
        _client().table("study_sessions").insert({
            "user_id": user.id,
            "module_id": payload.module_id,
            "kind": payload.kind,
            "item_id": payload.item_id,
            "title": (payload.title or "")[:200],
            "total": total,
            "correct": correct,
            "score_pct": round(correct / total * 100, 2) if total else None,
            "results": results,
        }).execute()
    ).data
    if not row:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Could not save that session.")
    session_id = row[0]["id"]

    # Auto-graduation, after the sitting exists.
    #
    # This loop used to run *before* the insert, which meant there was no
    # session id to attribute an answer to — the streak was a bare counter and
    # two correct answers in one run graduated a question. The row has to be
    # written first so each answer can say which sitting it belonged to.
    #
    # First occurrence wins, here as well as in the runner. The client already
    # sends only first answers, but a streak is the thing a client bug would
    # inflate, and the rule is cheap to hold in both places.
    seen: set[str] = set()
    for result in results:
        entry_id = (result.get("bank_entry_id")
                    if isinstance(result, dict) else None)
        if not entry_id or entry_id in seen:
            continue
        seen.add(entry_id)
        bank.record_answer(
            entry_id, bool(result.get("correct")), session_id=session_id,
        )

    return StudySession(**{k: v for k, v in row[0].items()
                           if k in StudySession.model_fields})


@router.get("/sessions/{module_id}", response_model=list[StudySession])
async def list_sessions(
    module_id: str,
    limit: int = 30,
    user: AuthUser = Depends(get_current_user),
) -> list[StudySession]:
    """Past sittings, newest first — the historical pills."""
    _own_module(module_id, user.id)
    rows = (
        _client().table("study_sessions").select("*")
        .eq("module_id", module_id).eq("user_id", user.id)
        .order("created_at", desc=True).limit(min(limit, 100)).execute()
    ).data or []
    # Which of these point at something the learner has since removed. One
    # batched read per table rather than one per row.
    removed: set[str] = set()
    for kind, table in (("quiz", "quizzes"), ("exam", "practice_exams")):
        ids = [r["item_id"] for r in rows if r.get("kind") == kind and r.get("item_id")]
        if not ids or not removal.supported(table):
            continue
        try:
            live = {
                x["id"] for x in (
                    removal.live(_client().table(table).select("id"), table)
                    .in_("id", list(set(ids))).execute()
                ).data or []
            }
            removed |= {i for i in ids if i not in live}
        except Exception:  # noqa: BLE001 — a label must not break the list
            logger.warning("could not resolve removed %s for the history", table)

    return [
        StudySession(**{
            **{k: v for k, v in r.items() if k in StudySession.model_fields},
            "item_removed": r.get("item_id") in removed,
        })
        for r in rows
    ]


class SessionGenerateRequest(BaseModel):
    media: str
    # 'missed' | 'flagged' | 'both'
    source: str = "both"
    how_many: str | int = "all"
    which: str = "recent"


@router.post("/sessions/{session_id}/generate", response_model=GenerateResponse)
async def generate_from_session(
    session_id: str,
    payload: SessionGenerateRequest,
    user: AuthUser = Depends(get_current_user),
) -> GenerateResponse:
    """Build something from one past sitting's missed and flagged questions.

    The same dials as a container, over a different pool. A session stores its
    own results, so this needs nothing from the exam it was a sitting of — which
    is what lets a sitting stay a source after the exam behind it is deleted.

    Deliberately does *not* write to a container on the way through. Generating
    from a session is not the same act as saving those questions for later, and
    doing both silently would fill a container the learner declined at the end
    of the run.
    """
    rows = (
        _client().table("study_sessions").select("*")
        .eq("id", session_id).eq("user_id", user.id).limit(1).execute()
    ).data or []
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That session isn't here.")
    session = rows[0]

    results = session.get("results") or []
    pool = [
        r for r in results
        if (payload.source == "missed" and not r.get("correct"))
        or (payload.source == "flagged" and r.get("flagged"))
        or (payload.source == "both" and (not r.get("correct") or r.get("flagged")))
    ]
    if not pool:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Nothing in that session matches — you got everything right and "
            "flagged nothing.",
        )

    # Reuses the container's dials and its entry->question conversion by
    # wrapping each result in the same shape, so "the thirty oldest" means one
    # thing in this app rather than two.
    as_entries = [
        {"id": None, "snapshot": {
            "prompt": r.get("prompt"),
            "options": r.get("options") or [],
            "correct_index": r.get("correct_index"),
            "explanation": r.get("explanation") or "",
        }}
        for r in pool
    ]
    chosen = bank.scope(as_entries, how_many=payload.how_many, which=payload.which)

    questions = []
    for position, entry in enumerate(chosen):
        question = bank.to_question({**entry, "id": None}, position)
        if question:
            # A session question has no bank entry behind it, so nothing to
            # graduate — it was never banked.
            question.pop("bank_entry_id", None)
            questions.append(question)
    skipped = len(chosen) - len(questions)

    module_id = session["module_id"]
    _own_module(module_id, user.id)
    title = f"From {session.get('title') or 'a past session'}"

    if payload.media in ("practice_exam", "quiz") and not questions:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Nothing in that selection can become a question.",
        )

    if payload.media == "practice_exam":
        created = _write_exam(module_id=module_id, user_id=user.id,
                              questions=questions, title=title)
    elif payload.media == "quiz":
        created = _write_quiz(module_id=module_id, user_id=user.id,
                              questions=questions, title=title)
    else:
        created = _write_flashcards(module_id=module_id, user_id=user.id,
                                    entries=chosen, title=title)

    logger.info("Generated %s from session %s: %d of %d",
                payload.media, session_id, len(chosen), len(pool))
    return GenerateResponse(
        media=payload.media, created_id=created, used=len(chosen),
        available=len(pool), skipped=skipped,
    )


@router.get("/{module_id}/{container}", response_model=list[BankEntry])
async def list_container(
    module_id: str,
    container: str,
    include_graduated: bool = False,
    domain_id: str | None = None,
    user: AuthUser = Depends(get_current_user),
) -> list[BankEntry]:
    """What's in a container, oldest first. `domain_id` narrows to one domain —
    the drill inside a domain shows and drills only that domain's misses."""
    _own_module(module_id, user.id)
    _check_container(container)
    return [
        BankEntry(**{k: v for k, v in row.items() if k in BankEntry.model_fields})
        for row in bank.list_entries(
            user_id=user.id, module_id=module_id, container=container,
            include_graduated=include_graduated, domain_id=domain_id,
        )
    ]


@router.delete("/entry/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_entry(
    entry_id: str,
    user: AuthUser = Depends(get_current_user),
) -> None:
    """Remove one entry by hand."""
    if not bank.delete_entry(entry_id, user.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That entry isn't here.")


class AddItem(BaseModel):
    source_kind: str
    source_id: str | None = None
    # Set when this result was answered on a question generated *from* the
    # container — the strongest possible "it already exists" signal.
    bank_entry_id: str | None = None
    domain_id: str | None = None
    missed: bool = False
    flagged: bool = False
    snapshot: dict[str, Any] = Field(default_factory=dict)


class AddRequest(BaseModel):
    items: list[AddItem] = Field(..., max_length=500)


@router.post("/{module_id}/{container}/add")
async def add_to_container(
    module_id: str,
    container: str,
    payload: AddRequest,
    user: AuthUser = Depends(get_current_user),
) -> dict[str, int]:
    """The confirmation prompt's "yes".

    The only way anything enters a container. A session that ends without the
    learner answering the prompt adds nothing, which is the whole point.
    """
    _own_module(module_id, user.id)
    _check_container(container)
    return bank.add_from_session(
        user_id=user.id, module_id=module_id, container=container,
        entries=[i.model_dump() for i in payload.items],
    )


@router.post("/{module_id}/{container}/generate", response_model=GenerateResponse)
async def generate_from_container(
    module_id: str,
    container: str,
    payload: GenerateRequest,
    user: AuthUser = Depends(get_current_user),
) -> GenerateResponse:
    """Build something from a container's entries.

    Deliberately *not* routed through `exam_profile`: its whole job is to
    resolve how long an exam should be from the published spec, and the length
    here is whatever the learner dialled from a pool of what they got wrong.
    Adaptive weighting is off for the same reason — a fixed pool cannot be
    allocated by domain weight. This is the second documented exception, after
    imported past papers, and both are exceptions for the same reason: the
    questions already exist and were not chosen by the blueprint.
    """
    module = _own_module(module_id, user.id)
    _check_container(container)

    if not bank.can_generate(container, payload.media):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A lecture can't be made from the Q&A container — that's where it "
            "came from."
            if payload.media == "lecture"
            else f"Can't make {payload.media} from that container.",
        )

    entries = bank.list_entries(
        user_id=user.id, module_id=module_id, container=container,
        domain_id=payload.domain_id,
    )
    if not entries:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "You haven't missed anything in this domain yet."
            if payload.domain_id else "There's nothing in there yet.",
        )

    chosen = bank.scope(entries, how_many=payload.how_many, which=payload.which)
    questions = [
        q for q in (bank.to_question(e, i) for i, e in enumerate(chosen)) if q
    ]
    skipped = len(chosen) - len(questions)

    if payload.media in ("practice_exam", "quiz") and not questions:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Nothing in that selection can become a question — Q&A answers "
            "have no options to choose between.",
        )

    # A second identical set, a minute later, is a double tap rather than a
    # decision. Generating the same thing again is sometimes exactly what
    # somebody wants — a week later, from a pool that has changed — so this
    # refuses only the window where it cannot be.
    recent = _recent_identical(
        module_id=module_id, user_id=user.id, media=payload.media,
        title=payload.title or f"From your {container} questions",
        count=len(questions),
    )
    if recent:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "You just made this one — it's in your review set. Give it a few "
            "minutes if you want another.",
        )

    created_id = None
    if payload.media == "practice_exam":
        created_id = _write_exam(
            module_id=module_id, user_id=user.id, questions=questions,
            title=payload.title or f"From your {container} questions",
            domain_id=payload.domain_id,
        )
    elif payload.media == "quiz":
        created_id = _write_quiz(
            module_id=module_id, user_id=user.id, questions=questions,
            title=payload.title or f"From your {container} questions",
            # A domain-scoped set belongs to that domain and lands in its
            # accordion; a whole-module one has no domain to belong to and
            # lands in the module's review set.
            domain_id=payload.domain_id,
        )
    else:
        created_id = _write_flashcards(
            module_id=module_id, user_id=user.id, entries=chosen,
            title=payload.title or f"From your {container} questions",
        )

    logger.info(
        "Generated %s from %s container of module %s: %d of %d entries",
        payload.media, container, module_id, len(chosen), len(entries),
    )
    return GenerateResponse(
        media=payload.media,
        created_id=created_id,
        used=len(chosen),
        available=len(entries),
        skipped=skipped,
        note=(
            f"{skipped} entr{'y' if skipped == 1 else 'ies'} couldn't become a "
            "question and were left out."
            if skipped else ""
        ),
    )


# How long an identical set counts as the same request rather than a new one.
DUPLICATE_WINDOW = timedelta(minutes=5)


def _recent_identical(
    *, module_id: str, user_id: str, media: str, title: str, count: int,
) -> bool:
    """Was this exact set built moments ago?

    Same module, same title, same number of questions, inside the window. Not a
    content hash: the pool is ordered and scoped the same way for the same
    dials, so two runs a minute apart produce the same set — and a hash would
    also refuse a genuinely-wanted rebuild whose questions happened to match.
    """
    since = (datetime.now(timezone.utc) - DUPLICATE_WINDOW).isoformat()
    table, size_column = (
        ("quizzes", "question_count") if media == "quiz"
        else ("practice_exams", "total_points") if media == "practice_exam"
        else (None, None)
    )
    if not table:
        # Cards are added to a deck rather than replacing one, so a second run
        # is additive and refusing it would lose material.
        return False
    try:
        rows = (
            # Live rows only. The window exists to absorb a double tap, and a
            # set the learner has since deleted is not a double tap — it is a
            # decision, and "you just made this" about something they removed
            # blocks the exact regeneration the delete was clearing room for.
            removal.live(
                _client().table(table).select(f"id, {size_column}"), table,
            )
            .eq("module_id", module_id).eq("user_id", user_id)
            .eq("title", title[:200]).gte("created_at", since)
            .limit(5).execute()
        ).data or []
    except Exception:  # noqa: BLE001 — a duplicate check must never block work
        return False
    return any((r.get(size_column) or 0) == count for r in rows)


def _write_exam(*, module_id, user_id, questions, title, domain_id=None) -> str:
    client = _client()
    exam = (
        client.table("practice_exams").insert({
            "module_id": module_id,
            # Set only by a domain drill. A regular paper spans the blueprint
            # and stays domain-less; a drill exam belongs to the domain it was
            # drilled from, which is also how the review list finds it.
            "domain_id": domain_id,
            "user_id": user_id,
            "title": title[:200],
            # Timed like any other paper. It briefly shipped with no timer on
            # the theory that a revision set is for working through — but a
            # practice exam is a type, and the type is what decides behaviour,
            # not how the questions were sourced. Same per-question rate the
            # regular generator uses, so a 20-question set gets a 20-question
            # clock rather than a 40-question one.
            "duration_minutes": exam_profile.exam_duration_minutes(len(questions)),
            "total_points": len(questions),
        }).execute()
    ).data
    if not exam:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Could not create that set.")
    exam_id = exam[0]["id"]
    # Two writes, and the second one can fail on its own.
    #
    # Nothing checked it, so a failed question insert left an exam row with no
    # questions in it: listed in the Classroom, tappable, and answering with a
    # 409 the moment it was opened. The parent goes back if the children do not
    # arrive — there is no transaction to lean on through PostgREST, so this is
    # the compensating delete.
    def as_row(q: dict) -> dict:
        meta = {}
        if q.get("correct_indices"):
            meta["correct_indices"] = q["correct_indices"]
        if q.get("accepted"):
            meta["accepted"] = q["accepted"]
        return {
            **{k: v for k, v in q.items()
               if k not in ("explanation", "correct_indices", "accepted")},
            "answer_meta": meta or None,
            # Where `submit_exam` reads the graded explanation from.
            "expected_answer": q.get("explanation") or "",
            "exam_id": exam_id,
        }

    try:
        written = (
            client.table("practice_questions").insert(
                schema_features.strip_unsupported(
                    "practice_questions",
                    [as_row(q) for q in questions],
                    "answer_meta",
                )
            ).execute()
        ).data
    except Exception:
        written = None
    if not written:
        client.table("practice_exams").delete().eq("id", exam_id).execute()
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "Could not save the questions for that set — nothing was created.",
        )
    return exam_id


def _write_quiz(*, module_id, user_id, questions, title, domain_id=None) -> str:
    """A quiz from container entries. `domain_id` is None for a whole-module set.

    Two things here were silently wrong for every quiz this ever wrote.

    The question text went in under `prompt`, and `quizzes._to_quiz` reads
    `question` — so the row was complete, the options were right, and every
    question rendered blank. Nothing failed; the toast was honest and the quiz
    was useless.

    And `question_count` was never written, so the pill had no size to show.

    Quiz questions live in jsonb, so the bank link rides inside the object —
    see the note in the migration. Which is only useful if it survives the trip
    out again; see `quizzes.Question`, which used to drop it.
    """
    payload = [
        {
            # `question`, because that is the key the reader wants. Both are
            # written for one release so a client mid-deploy sees text either
            # way; the duplicate comes out once nothing reads `prompt`.
            "question": q["prompt"],
            "prompt": q["prompt"],
            "kind": q.get("kind") or "mcq",
            "options": q["options"],
            "correct_index": q["correct_index"],
            "correct_indices": q.get("correct_indices") or [],
            "accepted": q.get("accepted") or [],
            # A regular quiz explains itself after each answer, and the reveal
            # is most of why a study quiz exists. The snapshot kept the
            # explanation; it rides along so this quiz behaves like any other.
            "explanation": q.get("explanation") or "",
            # Which domain the original miss belonged to, so re-missing this
            # question banks it back under the right heading.
            "domain_id": q.get("domain_id"),
            "bank_entry_id": q["bank_entry_id"],
        }
        for q in questions
    ]
    quiz = (
        _client().table("quizzes").insert({
            "module_id": module_id,
            "domain_id": domain_id,
            "user_id": user_id,
            "title": title[:200],
            "question_count": len(payload),
            "questions": payload,
        }).execute()
    ).data
    if not quiz:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Could not create that quiz.")
    return quiz[0]["id"]


def _write_flashcards(*, module_id, user_id, entries, title) -> str | None:
    """Cards from bank entries.

    A question becomes prompt-on-the-front, correct-option-on-the-back; a Q&A
    exchange becomes question-and-answer, which it already was. Nothing is sent
    to a model: the text exists, and paraphrasing it would risk changing what
    the learner actually got wrong.
    """
    rows = []
    for entry in entries:
        snapshot = entry.get("snapshot") or {}
        front = snapshot.get("prompt") or snapshot.get("question") or ""
        back = snapshot.get("answer") or ""
        if not back:
            options = snapshot.get("options") or []
            index = snapshot.get("correct_index")
            if isinstance(index, int) and 0 <= index < len(options):
                option = options[index]
                back = option.get("text") if isinstance(option, dict) else str(option)
        if front and back:
            rows.append({
                "module_id": module_id,
                "domain_id": entry.get("domain_id"),
                "user_id": user_id,
                "front": front[:2000],
                "back": str(back)[:2000],
                # Named, so the cards arrive as their own deck rather than
                # dissolving into the domain's pool — a deck of what you got
                # wrong is worth being able to pick up as a thing.
                "deck_title": title[:120],
            })
    if not rows:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Nothing in that selection had both a question and an answer to "
            "make a card from.",
        )
    rows = schema_features.strip_unsupported("flashcards", rows, "deck_title")
    _client().table("flashcards").insert(rows).execute()
    # Cards go into the module's pool rather than a set of their own, which is
    # how every other flashcard import behaves.
    return None

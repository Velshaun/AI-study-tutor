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
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.database import get_supabase
from app.routers.auth import AuthUser, get_current_user
from app.services import question_bank as bank

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

    # Anything carrying a bank link is a re-run of a banked question, so this
    # is where auto-graduation actually happens.
    for result in results:
        entry_id = (result.get("bank_entry_id")
                    if isinstance(result, dict) else None)
        if entry_id:
            bank.record_answer(entry_id, bool(result.get("correct")))

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
    return [
        StudySession(**{k: v for k, v in r.items() if k in StudySession.model_fields})
        for r in rows
    ]


@router.get("/{module_id}/{container}", response_model=list[BankEntry])
async def list_container(
    module_id: str,
    container: str,
    include_graduated: bool = False,
    user: AuthUser = Depends(get_current_user),
) -> list[BankEntry]:
    """What's in a container, oldest first."""
    _own_module(module_id, user.id)
    _check_container(container)
    return [
        BankEntry(**{k: v for k, v in row.items() if k in BankEntry.model_fields})
        for row in bank.list_entries(
            user_id=user.id, module_id=module_id, container=container,
            include_graduated=include_graduated,
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


class GenerateRequest(BaseModel):
    # 'practice_exam' | 'quiz' | 'flashcards'
    media: str
    # 'all' | 'half' | a number
    how_many: str | int = "all"
    # 'recent' | 'oldest' | 'random'
    which: str = "recent"
    title: str | None = None


class GenerateResponse(BaseModel):
    media: str
    created_id: str | None = None
    used: int
    available: int
    skipped: int = 0
    note: str = ""


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
    )
    if not entries:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "There's nothing in there yet.",
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

    created_id = None
    if payload.media == "practice_exam":
        created_id = _write_exam(
            module_id=module_id, user_id=user.id, questions=questions,
            title=payload.title or f"From your {container} questions",
        )
    elif payload.media == "quiz":
        created_id = _write_quiz(
            module_id=module_id, user_id=user.id, questions=questions,
            title=payload.title or f"From your {container} questions",
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


def _write_exam(*, module_id, user_id, questions, title) -> str:
    client = _client()
    exam = (
        client.table("practice_exams").insert({
            "module_id": module_id,
            "user_id": user_id,
            "title": title[:200],
            # No timer. A revision set built from your own mistakes is for
            # working through, not for sitting under exam conditions.
            "duration_minutes": 0,
            "total_points": len(questions),
        }).execute()
    ).data
    if not exam:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Could not create that set.")
    exam_id = exam[0]["id"]
    client.table("practice_questions").insert(
        [{**q, "exam_id": exam_id} for q in questions]
    ).execute()
    return exam_id


def _write_quiz(*, module_id, user_id, questions, title) -> str:
    # Quiz questions live in jsonb, so the bank link rides inside the object —
    # see the note in the migration.
    payload = [
        {
            "prompt": q["prompt"],
            "options": q["options"],
            "correct_index": q["correct_index"],
            "bank_entry_id": q["bank_entry_id"],
        }
        for q in questions
    ]
    quiz = (
        _client().table("quizzes").insert({
            "module_id": module_id,
            "user_id": user_id,
            "title": title[:200],
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
            })
    if not rows:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Nothing in that selection had both a question and an answer to "
            "make a card from.",
        )
    _client().table("flashcards").insert(rows).execute()
    # Cards go into the module's pool rather than a set of their own, which is
    # how every other flashcard import behaves.
    return None

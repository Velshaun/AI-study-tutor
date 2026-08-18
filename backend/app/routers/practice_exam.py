"""Practice exams — spec Prompt 10c.

    POST   /practice-exam/import                 PDF -> parsed imported questions
    GET    /practice-exam/imported/{module_id}   imported sets for a module
    DELETE /practice-exam/imported/{batch_id}    delete an imported set
    PATCH  /practice-exam/imported/{batch_id}/favourite
    POST   /practice-exam/generate               weighted exam (AI + imported mix)
    GET    /practice-exam?module_id=             list a module's exams
    GET    /practice-exam/{exam_id}              one exam's questions
    POST   /practice-exam/{exam_id}/submit       grade an attempt
    DELETE /practice-exam/{exam_id}

A generated exam is weighted by the module's domain blueprint: each domain gets
a share of the questions proportional to its weight_pct. When the learner opts
in and imported questions exist, part of the exam is filled from them and the
rest is generated, so real past-paper questions sit alongside fresh ones.
"""

from __future__ import annotations

import logging
import random
from datetime import datetime
from typing import Any
from uuid import uuid4

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from pydantic import BaseModel, Field

from app.database import get_supabase
from app.routers.auth import AuthUser, get_current_user
from app.services import exam_profile
from app.services.ai_service import (
    MAX_QUIZ_QUESTIONS,
    GenerationError,
    gather_domain_content,
    generate_quiz,
    parse_imported_exam,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/practice-exam", tags=["practice_exam"])

MAX_QUESTIONS = exam_profile.MAX_QUESTION_COUNT
LETTERS = "ABCDEFGH"
# Extra passes allowed to make up questions the model didn't return, so a
# 40-question exam doesn't quietly come back as 31.
TOPUP_ROUNDS = 2


# --- Schemas ----------------------------------------------------------------
class ImportedQuestion(BaseModel):
    id: str
    question_text: str
    options: list[dict[str, Any]] = Field(default_factory=list)
    correct_option: str | None = None
    why_summary: str | None = None


class ImportedSet(BaseModel):
    batch_id: str
    source_name: str
    question_count: int
    is_favourite: bool = False
    created_at: datetime | None = None
    questions: list[ImportedQuestion] = Field(default_factory=list)


class GenerateRequest(BaseModel):
    module_id: str
    # Unset means "as long as the real exam" — resolved from the module's stated
    # exam length, else its largest imported past paper.
    question_count: int | None = Field(None, ge=1, le=MAX_QUESTIONS)
    include_imported: bool = True
    difficulty: str | None = None


class ExamQuestion(BaseModel):
    index: int
    question: str
    options: list[str]
    correct_index: int
    explanation: str = ""
    origin: str = "generated"  # 'generated' | 'imported'
    domain_title: str | None = None


class PracticeExam(BaseModel):
    id: str
    module_id: str | None = None
    title: str = "Practice Exam"
    question_count: int = 0
    duration_minutes: int = 0
    questions: list[ExamQuestion] = Field(default_factory=list)
    created_at: datetime | None = None


class SubmitRequest(BaseModel):
    answers: list[int | None]


class QuestionResult(BaseModel):
    index: int
    chosen_index: int | None
    correct_index: int
    is_correct: bool
    explanation: str = ""


class ExamResult(BaseModel):
    exam_id: str
    score: float
    correct: int
    total: int
    results: list[QuestionResult]


# --- Helpers ----------------------------------------------------------------
def _client():
    try:
        return get_supabase()
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc


def _own_module(module_id: str, user_id: str) -> dict[str, Any]:
    rows = (
        _client().table("modules").select("*")
        .eq("id", module_id).eq("user_id", user_id).limit(1).execute()
    ).data or []
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Module not found.")
    return rows[0]


def _own_exam(exam_id: str, user_id: str) -> dict[str, Any]:
    rows = (
        _client().table("practice_exams").select("*")
        .eq("id", exam_id).eq("user_id", user_id).limit(1).execute()
    ).data or []
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Exam not found.")
    return rows[0]


def _preferred_difficulty(user_id: str) -> str:
    rows = (
        _client().table("profiles").select("preferences")
        .eq("id", user_id).limit(1).execute()
    ).data or []
    prefs = (rows[0].get("preferences") if rows else {}) or {}
    return prefs.get("quiz_difficulty") or "medium"


# ============================================================================
# Import
# ============================================================================
@router.post("/import", response_model=ImportedSet,
             status_code=status.HTTP_201_CREATED)
async def import_exam(
    module_id: str = Form(...),
    file: UploadFile = File(...),
    user: AuthUser = Depends(get_current_user),
) -> ImportedSet:
    """Upload a practice-exam PDF; extract its questions with Gemini and save."""
    _own_module(module_id, user.id)

    data = await file.read()
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That file is empty.")

    from app.services.extraction import ExtractionError, extract_pdf

    try:
        text = extract_pdf(data)
    except ExtractionError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc

    try:
        parsed = parse_imported_exam(text)
    except GenerationError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    batch_id = str(uuid4())
    source_name = file.filename or "Imported exam"
    rows = [
        {
            "user_id": user.id,
            "module_id": module_id,
            "import_batch_id": batch_id,
            "source_name": source_name,
            "question_text": q["question_text"],
            "options": q["options"],
            "correct_option": q["correct_option"] or None,
            "why_summary": q["why_summary"] or None,
        }
        for q in parsed
    ]
    inserted = _client().table("imported_practice_questions").insert(rows).execute()
    saved = inserted.data or rows

    return ImportedSet(
        batch_id=batch_id,
        source_name=source_name,
        question_count=len(saved),
        is_favourite=False,
        questions=[_to_imported(r) for r in saved],
    )


def _to_imported(row: dict[str, Any]) -> ImportedQuestion:
    return ImportedQuestion(
        id=row.get("id") or "",
        question_text=row.get("question_text") or "",
        options=row.get("options") or [],
        correct_option=row.get("correct_option"),
        why_summary=row.get("why_summary"),
    )


@router.get("/imported/{module_id}", response_model=list[ImportedSet])
async def list_imported(
    module_id: str,
    user: AuthUser = Depends(get_current_user),
) -> list[ImportedSet]:
    """Imported question sets for a module, grouped by import batch."""
    _own_module(module_id, user.id)
    rows = (
        _client().table("imported_practice_questions").select("*")
        .eq("module_id", module_id).eq("user_id", user.id)
        .order("created_at").execute()
    ).data or []

    sets: dict[str, ImportedSet] = {}
    for r in rows:
        batch = r.get("import_batch_id") or r["id"]
        if batch not in sets:
            sets[batch] = ImportedSet(
                batch_id=batch,
                source_name=r.get("source_name") or "Imported exam",
                question_count=0,
                is_favourite=bool(r.get("is_favourite")),
                created_at=r.get("created_at"),
            )
        sets[batch].questions.append(_to_imported(r))
        sets[batch].question_count += 1

    return sorted(sets.values(), key=lambda s: s.created_at or "", reverse=True)


@router.patch("/imported/{batch_id}/favourite", response_model=ImportedSet)
async def favourite_imported(
    batch_id: str,
    user: AuthUser = Depends(get_current_user),
) -> ImportedSet:
    """Toggle a set's favourite flag (stored across the set's rows)."""
    client = _client()
    rows = (
        client.table("imported_practice_questions").select("*")
        .eq("import_batch_id", batch_id).eq("user_id", user.id).execute()
    ).data or []
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Imported set not found.")

    new_value = not bool(rows[0].get("is_favourite"))
    client.table("imported_practice_questions").update(
        {"is_favourite": new_value}
    ).eq("import_batch_id", batch_id).eq("user_id", user.id).execute()

    return ImportedSet(
        batch_id=batch_id,
        source_name=rows[0].get("source_name") or "Imported exam",
        question_count=len(rows),
        is_favourite=new_value,
        created_at=rows[0].get("created_at"),
        questions=[_to_imported(r) for r in rows],
    )


@router.delete("/imported/{batch_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_imported(
    batch_id: str,
    user: AuthUser = Depends(get_current_user),
) -> None:
    """Delete a whole imported set."""
    client = _client()
    existing = (
        client.table("imported_practice_questions").select("id")
        .eq("import_batch_id", batch_id).eq("user_id", user.id).limit(1).execute()
    ).data
    if not existing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Imported set not found.")
    client.table("imported_practice_questions").delete().eq(
        "import_batch_id", batch_id
    ).eq("user_id", user.id).execute()


# ============================================================================
# Weighted generation
# ============================================================================
def _effective_weights(
    domains: list[dict[str, Any]], deck_ids: set[str],
) -> dict[str, float]:
    """Blueprint weights, with imported decks folded in.

    An imported deck is stored as a zero-weight domain so it never distorts the
    exam blueprint, which also meant it could never contribute a question. Decks
    that hold their own material are given the smallest stated weight in the
    blueprint: enough to be represented, not enough to displace a real domain.
    """
    weights = {d["id"]: float(d.get("weight_pct") or 0) for d in domains}
    if not deck_ids:
        return weights
    stated = [w for w in weights.values() if w > 0]
    if not stated:  # nothing is weighted — the even split already covers decks
        return weights
    floor = min(stated)
    for domain_id in deck_ids:
        if domain_id in weights and weights[domain_id] <= 0:
            weights[domain_id] = floor
    return weights


def _allocate(
    question_count: int, domains: list[dict[str, Any]],
    weight_by_id: dict[str, float] | None = None,
) -> dict[str, int]:
    """Split questions across domains by weight (largest-remainder rounding)."""
    weights = [
        (d, (weight_by_id or {}).get(d["id"], float(d.get("weight_pct") or 0)))
        for d in domains
    ]
    total_weight = sum(w for _, w in weights)
    if total_weight <= 0:  # unweighted — split evenly
        base, extra = divmod(question_count, len(domains))
        return {
            d["id"]: base + (1 if i < extra else 0)
            for i, (d, _) in enumerate(weights)
        }

    exact = {d["id"]: question_count * w / total_weight for d, w in weights}
    floors = {k: int(v) for k, v in exact.items()}
    remainder = question_count - sum(floors.values())
    # Hand the leftover to the largest fractional parts.
    order = sorted(exact, key=lambda k: exact[k] - floors[k], reverse=True)
    for k in order[:remainder]:
        floors[k] += 1
    return floors


def _deck_domain_ids(domains: list[dict[str, Any]], user_id: str) -> set[str]:
    """Zero-weight domains that hold flashcards — i.e. imported decks.

    One batched query: an imported deck can only contribute questions if it
    actually has cards to generate them from.
    """
    unweighted = [d["id"] for d in domains if not (d.get("weight_pct") or 0)]
    if not unweighted:
        return set()
    rows = (
        _client().table("flashcards").select("domain_id")
        .in_("domain_id", unweighted).eq("user_id", user_id).execute()
    ).data or []
    return {r["domain_id"] for r in rows if r.get("domain_id")}


def _question_key(text: str) -> str:
    """Loose identity for a question, so a top-up round can't repeat one."""
    return " ".join((text or "").lower().split())[:160]


def _generate_for_domain(
    domain: dict[str, Any], user_id: str, difficulty: str, count: int,
) -> list[dict[str, Any]]:
    """Generate ``count`` questions for one domain.

    ``generate_quiz`` tops out at ``MAX_QUIZ_QUESTIONS`` per call, so a domain
    that owes more than that is filled over several calls — otherwise a
    single-domain 40-question exam would silently come back as 20.
    """
    gathered = gather_domain_content(domain["id"], user_id)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    # One call per full batch, plus one spare for a batch that returned short.
    rounds = count // MAX_QUIZ_QUESTIONS + 2
    for _ in range(rounds):
        if len(out) >= count:
            break
        want = min(MAX_QUIZ_QUESTIONS, count - len(out))
        generated = generate_quiz(
            gathered["content"], difficulty, want,
            subject=gathered["subject"], topic=domain.get("title") or "",
        )
        fresh = [q for q in generated if _question_key(q["question"]) not in seen]
        for q in fresh:
            seen.add(_question_key(q["question"]))
        out.extend(fresh)
        if not fresh:  # nothing new came back — stop rather than loop
            break
    return out[:count]


def _imported_to_exam_q(row: dict[str, Any], index: int) -> ExamQuestion | None:
    options = row.get("options") or []
    texts = [o.get("text", "") for o in options if o.get("text")]
    if len(texts) < 2:
        return None
    correct = (row.get("correct_option") or "").strip().upper()
    correct_index = LETTERS.find(correct) if correct in LETTERS else 0
    if correct_index < 0 or correct_index >= len(texts):
        correct_index = 0
    return ExamQuestion(
        index=index,
        question=row.get("question_text") or "",
        options=texts,
        correct_index=correct_index,
        explanation=row.get("why_summary") or "",
        origin="imported",
        domain_title=None,
    )


@router.post("/generate", response_model=PracticeExam,
             status_code=status.HTTP_201_CREATED)
async def generate_exam(
    payload: GenerateRequest,
    user: AuthUser = Depends(get_current_user),
) -> PracticeExam:
    """Build a weighted exam, optionally mixing in imported questions."""
    module = _own_module(payload.module_id, user.id)
    client = _client()
    difficulty = (payload.difficulty or _preferred_difficulty(user.id)).lower()

    domains = (
        client.table("domains").select("*")
        .eq("module_id", payload.module_id).eq("user_id", user.id)
        .order("order_index").execute()
    ).data or []
    if not domains:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This module has no domains yet — generate its study plan first.",
        )

    # As long as the real paper unless the learner asked for a specific length.
    total = exam_profile.exam_question_count(
        payload.module_id, user.id,
        requested=payload.question_count, module_row=module,
    )
    questions: list[ExamQuestion] = []
    seen: set[str] = set()

    # 1. Imported share — real past-paper questions, up to half the exam.
    if payload.include_imported:
        imported_rows = (
            client.table("imported_practice_questions").select("*")
            .eq("module_id", payload.module_id).eq("user_id", user.id).execute()
        ).data or []
        random.shuffle(imported_rows)
        take = min(len(imported_rows), total // 2)
        for row in imported_rows[:take]:
            q = _imported_to_exam_q(row, len(questions))
            if q:
                questions.append(q)
                seen.add(_question_key(q.question))

    # 2. Fill the rest with AI-generated questions, weighted by domain. A model
    #    that returns short leaves the exam under length, so the shortfall is
    #    re-allocated over a couple of further rounds.
    by_id = {d["id"]: d for d in domains}
    weight_by_id = _effective_weights(domains, _deck_domain_ids(domains, user.id))
    for attempt in range(1 + TOPUP_ROUNDS):
        remaining = total - len(questions)
        if remaining <= 0:
            break
        # Chasing the last question or two isn't worth another fan-out of model
        # calls across every domain.
        if attempt and remaining < max(3, round(total * 0.1)):
            break
        before = len(questions)
        for domain_id, count in _allocate(remaining, domains, weight_by_id).items():
            if count <= 0:
                continue
            domain = by_id[domain_id]
            try:
                generated = _generate_for_domain(domain, user.id, difficulty, count)
            except GenerationError as exc:
                logger.warning("Exam gen failed for domain %s: %s", domain_id, exc)
                continue
            for gq in generated:
                key = _question_key(gq["question"])
                if key in seen:
                    continue
                seen.add(key)
                questions.append(ExamQuestion(
                    index=len(questions),
                    question=gq["question"],
                    options=gq["options"],
                    correct_index=gq["correct_index"],
                    explanation=gq["explanation"],
                    origin="generated",
                    domain_title=domain.get("title"),
                ))
        if len(questions) == before:  # no progress — further rounds won't help
            break

    questions = questions[:total]
    if len(questions) < total:
        logger.info(
            "exam for module %s came up short: %d of %d questions",
            payload.module_id, len(questions), total,
        )

    if not questions:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "Could not assemble any questions for this exam.",
        )

    # Shuffle so imported and generated interleave, then re-index.
    random.shuffle(questions)
    for i, q in enumerate(questions):
        q.index = i

    duration = exam_profile.exam_duration_minutes(len(questions), module)
    exam_row = client.table("practice_exams").insert({
        "module_id": payload.module_id,
        "user_id": user.id,
        "title": f"{module.get('title') or 'Practice'} exam",
        "duration_minutes": duration,
        "total_points": len(questions),
    }).execute().data[0]

    client.table("practice_questions").insert([
        {
            "exam_id": exam_row["id"],
            "kind": "mcq",
            "prompt": q.question,
            "options": q.options,
            "correct_index": q.correct_index,
            "expected_answer": q.explanation,
            "points": 1,
            "position": q.index,
        }
        for q in questions
    ]).execute()

    return PracticeExam(
        id=exam_row["id"],
        module_id=payload.module_id,
        title=exam_row["title"],
        question_count=len(questions),
        duration_minutes=duration,
        questions=questions,
        created_at=exam_row.get("created_at"),
    )


# ============================================================================
# Take / grade
# ============================================================================
def _exam_questions(exam_id: str) -> list[dict[str, Any]]:
    return (
        _client().table("practice_questions").select("*")
        .eq("exam_id", exam_id).order("position").execute()
    ).data or []


def _to_exam(row: dict[str, Any], questions: list[dict[str, Any]]) -> PracticeExam:
    return PracticeExam(
        id=row["id"],
        module_id=row.get("module_id"),
        title=row.get("title") or "Practice Exam",
        question_count=len(questions),
        duration_minutes=row.get("duration_minutes") or 0,
        created_at=row.get("created_at"),
        questions=[
            ExamQuestion(
                index=q.get("position", i),
                question=q.get("prompt") or "",
                options=q.get("options") or [],
                correct_index=int(q.get("correct_index") or 0),
                explanation=q.get("expected_answer") or "",
            )
            for i, q in enumerate(questions)
        ],
    )


@router.get("", response_model=list[PracticeExam])
async def list_exams(
    module_id: str | None = Query(None),
    user: AuthUser = Depends(get_current_user),
) -> list[PracticeExam]:
    """A module's past exams (metadata only — no questions)."""
    query = _client().table("practice_exams").select("*").eq("user_id", user.id)
    if module_id:
        query = query.eq("module_id", module_id)
    rows = (query.order("created_at", desc=True).execute()).data or []
    return [
        PracticeExam(
            id=r["id"], module_id=r.get("module_id"),
            title=r.get("title") or "Practice Exam",
            question_count=r.get("total_points") or 0,
            duration_minutes=r.get("duration_minutes") or 0,
            created_at=r.get("created_at"),
        )
        for r in rows
    ]


@router.get("/{exam_id}", response_model=PracticeExam)
async def get_exam(
    exam_id: str,
    user: AuthUser = Depends(get_current_user),
) -> PracticeExam:
    """One exam with its questions."""
    exam = _own_exam(exam_id, user.id)
    return _to_exam(exam, _exam_questions(exam_id))


@router.post("/{exam_id}/submit", response_model=ExamResult)
async def submit_exam(
    exam_id: str,
    payload: SubmitRequest,
    user: AuthUser = Depends(get_current_user),
) -> ExamResult:
    """Grade an attempt against the stored answers."""
    _own_exam(exam_id, user.id)
    questions = _exam_questions(exam_id)
    if not questions:
        raise HTTPException(status.HTTP_409_CONFLICT, "This exam has no questions.")

    results: list[QuestionResult] = []
    correct = 0
    for i, q in enumerate(questions):
        chosen = payload.answers[i] if i < len(payload.answers) else None
        correct_index = int(q.get("correct_index") or 0)
        is_correct = chosen == correct_index
        correct += int(is_correct)
        results.append(QuestionResult(
            index=i, chosen_index=chosen, correct_index=correct_index,
            is_correct=is_correct, explanation=q.get("expected_answer") or "",
        ))

    total = len(questions)
    score = round(correct / total * 100, 1) if total else 0.0
    return ExamResult(
        exam_id=exam_id, score=score, correct=correct, total=total, results=results,
    )


@router.delete("/{exam_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_exam(
    exam_id: str,
    user: AuthUser = Depends(get_current_user),
) -> None:
    """Delete an exam; its questions cascade."""
    _own_exam(exam_id, user.id)
    _client().table("practice_exams").delete().eq("id", exam_id).eq(
        "user_id", user.id
    ).execute()

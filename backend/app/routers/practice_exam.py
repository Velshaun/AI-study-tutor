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
import re
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
from app.services import exam_catalog, exam_profile, performance, schema_features
from app.services.ai_service import (
    MAX_QUIZ_QUESTIONS,
    GenerationError,
    explain_imported_questions,
    gather_domain_content,
    generate_quiz,
    parse_imported_exam,
    parse_imported_exams,
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


class ImportResult(BaseModel):
    """What an uploaded PDF turned into.

    One entry per exam found in the file: a PDF holding three papers produces
    three exams, each sat independently.
    """

    exams: list[PracticeExam] = Field(default_factory=list)
    question_count: int = 0
    source_name: str = ""


class GenerateRequest(BaseModel):
    module_id: str
    # Unset means "as long as the real exam" — resolved from the module's stated
    # exam length, the published spec for the certification it's about, else its
    # largest imported past paper.
    question_count: int | None = Field(None, ge=1, le=MAX_QUESTIONS)
    # Unset means "as long as the real sitting", scaled to a shorter run.
    duration_minutes: int | None = Field(
        None, ge=1, le=exam_profile.MAX_DURATION_MINUTES,
    )
    include_imported: bool = True
    difficulty: str | None = None
    # 'practice', or 'pre_assessment' for the baseline sitting taken before any
    # studying. Same generator, same weights, same runner — the flag only says
    # when it happened, because that is the only thing that makes it a baseline.
    kind: str = "practice"
    # Bend the allocation towards the domains this learner is weakest in. Off
    # for a pre-assessment, which has to measure the blueprint as published: a
    # baseline weighted by what they're bad at would report a score no real
    # sitting could produce.
    adaptive: bool = True


class ExamQuestion(BaseModel):
    index: int
    question: str
    options: list[str]
    # Null on the way out to a client that hasn't answered yet. Populated
    # internally while an exam is being built and written, and returned only by
    # the per-question answer endpoint — see `_without_answers`.
    correct_index: int | None = None
    explanation: str = ""
    # One line per option, positionally aligned with `options`: why that choice
    # is right, or why it is wrong. Shown for every option once an answer is in,
    # so a lucky guess still teaches the other three.
    option_explanations: list[str] = Field(default_factory=list)
    # Tappable vocabulary and acronyms found in this text, generated with it so
    # the definition popover opens with no round trip.
    terms: list[dict[str, Any]] = Field(default_factory=list)
    origin: str = "generated"  # 'generated' | 'imported'
    domain_title: str | None = None
    # Which blueprint domain this question came from. Written with the question,
    # because a per-domain result cannot be reconstructed afterwards — an exam
    # used to allocate questions by domain weight and then throw the attribution
    # away at insert time, leaving a percentage as the most the app could say
    # about a 90-question paper. Null for imported papers, where nothing in the
    # PDF says which domain a question belongs to.
    domain_id: str | None = None


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
    option_explanations: list[str] = Field(default_factory=list)


class DomainResult(BaseModel):
    """How one domain went, and what it is worth on the real paper."""

    domain_id: str | None = None
    title: str = ""
    weight_pct: float = 0.0
    correct: int = 0
    total: int = 0
    pct: float = 0.0


class ExamResult(BaseModel):
    exam_id: str
    # Null where the attempt couldn't be stored — the grade still stands.
    attempt_id: str | None = None
    kind: str = "practice"
    score: float
    correct: int
    total: int
    # The published threshold for this certification, as a share of questions.
    # Null for a module that isn't a recognised exam.
    pass_pct: float | None = None
    passed: bool | None = None
    domains: list[DomainResult] = Field(default_factory=list)
    # {verdict, strengths[], gaps[], next_steps[], written_by}
    summary: dict[str, Any] = Field(default_factory=dict)
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


def _without_answers(questions: list[ExamQuestion]) -> list[ExamQuestion]:
    """The same questions with the answer key removed.

    Applied at every point an exam leaves the API, not at the point it is built:
    the builder needs the answers to write them to the database, and a single
    strip on the way out is one thing to get right rather than three.
    """
    return [
        q.model_copy(update={
            "correct_index": None,
            "explanation": "",
            "option_explanations": [],
        })
        for q in questions
    ]


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
def _words(text: str) -> set[str]:
    return {w for w in re.split(r"[^a-z0-9]+", (text or "").lower()) if len(w) > 2}


def _titled(title: str, stem: str) -> str:
    """Name an imported paper, adding the filename only when it says something.

    "Practice Exam 2" alone doesn't say where it came from, so the file's name
    supplies the publisher — but only if the heading isn't already carrying it.
    Compared word-wise, since "professor-messer-practice" and "Professor Messer
    Practice Exam 1" are the same words punctuated differently.
    """
    if not stem:
        return title[:200]
    stem_words = _words(stem)
    if stem_words and stem_words <= _words(title):
        return title[:200]
    return f"{stem} — {title}"[:200]


def _letter_index(label: str, options: list[dict[str, Any]]) -> int:
    """Position of the labelled option, defaulting to the first."""
    wanted = (label or "").strip().upper()[:1]
    for i, option in enumerate(options):
        if (option.get("label") or "").strip().upper()[:1] == wanted:
            return i
    return 0


def _store_imported_exam(
    *, module_id: str, user_id: str, title: str, questions: list[dict[str, Any]],
    subject: str,
) -> PracticeExam:
    """Turn one transcribed paper into a practice exam the runner can sit.

    Written to `practice_exams`/`practice_questions` — the same tables a
    generated exam uses — so it behaves identically everywhere: same flow, same
    reveal, same delete. Questions the paper didn't explain are explained here,
    once, at import: the learner shouldn't be able to tell which is which.
    """
    client = _client()

    # Which questions still need a rationale, and per-option lines (a printed
    # explanation covers the answer, never each distractor).
    to_explain = [
        {"index": i, "question_text": q["question_text"], "options": q["options"],
         "correct_option": q.get("correct_option")}
        for i, q in enumerate(questions)
    ]
    try:
        written = explain_imported_questions(to_explain, subject=subject)
    except GenerationError as exc:
        logger.warning("Could not explain imported questions: %s", exc)
        written = {}

    duration = exam_profile.exam_duration_minutes(len(questions))
    exam_row = client.table("practice_exams").insert({
        "module_id": module_id,
        "user_id": user_id,
        "title": title[:200],
        "duration_minutes": duration,
        "total_points": len(questions),
    }).execute().data[0]

    built: list[ExamQuestion] = []
    for i, q in enumerate(questions):
        options = q["options"]
        extra = written.get(i, {})
        per_option = list(extra.get("option_explanations") or [])
        per_option += [""] * (len(options) - len(per_option))
        built.append(ExamQuestion(
            index=i,
            question=q["question_text"],
            options=[o["text"] for o in options],
            # An unmarked answer falls to whatever the explainer worked out,
            # which is the first option only when nothing else is known.
            correct_index=_letter_index(q.get("correct_option"), options),
            # The paper's own rationale wins; ours fills the gap.
            explanation=q.get("explanation") or extra.get("explanation") or "",
            option_explanations=per_option[:len(options)],
            origin="imported",
        ))

    client.table("practice_questions").insert(schema_features.strip_unsupported(
        "practice_questions",
        [
            {
                "exam_id": exam_row["id"],
                "kind": "mcq",
                "prompt": q.question,
                "options": _options_payload(q),
                "correct_index": q.correct_index,
                "expected_answer": q.explanation,
                "points": 1,
                "position": q.index,
                "terms": q.terms,
            }
            for q in built
        ],
        "terms",
    )).execute()

    return PracticeExam(
        id=exam_row["id"],
        module_id=module_id,
        title=exam_row["title"],
        question_count=len(built),
        duration_minutes=duration,
        questions=_without_answers(built),
        created_at=exam_row.get("created_at"),
    )


@router.post("/import", response_model=ImportResult,
             status_code=status.HTTP_201_CREATED)
async def import_exam(
    module_id: str = Form(...),
    file: UploadFile = File(...),
    user: AuthUser = Depends(get_current_user),
) -> ImportResult:
    """Turn an uploaded practice-exam PDF into exams the learner can sit.

    The questions are transcribed exactly as printed — wording, choices, order
    and marked answer — and a file holding several papers becomes several exams
    rather than one long one. Answer keys and printed rationales are stripped
    out of the question text and surface only after an answer is committed.
    """
    module = _own_module(module_id, user.id)

    data = await file.read()
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That file is empty.")

    from app.services.extraction import ExtractionError, extract_pdf

    try:
        text = extract_pdf(data)
    except ExtractionError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc

    try:
        papers = parse_imported_exams(text)
    except GenerationError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    source_name = file.filename or "Imported exam"
    stem = source_name.rsplit(".", 1)[0].strip()
    subject = module.get("detected_subject") or module.get("title") or "this subject"

    exams: list[PracticeExam] = []
    for paper in papers:
        title = _titled(paper["title"], stem)
        exams.append(_store_imported_exam(
            module_id=module_id, user_id=user.id, title=title,
            questions=paper["questions"], subject=subject,
        ))

    # Also kept as an imported set, which is what the "mix real past-paper
    # questions into a generated exam" toggle draws on.
    batch_id = str(uuid4())
    _client().table("imported_practice_questions").insert([
        {
            "user_id": user.id,
            "module_id": module_id,
            "import_batch_id": batch_id,
            "source_name": source_name,
            "question_text": q["question_text"],
            "options": q["options"],
            "correct_option": q["correct_option"] or None,
            "why_summary": q.get("explanation") or None,
        }
        for paper in papers
        for q in paper["questions"]
    ]).execute()

    return ImportResult(
        exams=exams,
        question_count=sum(e.question_count for e in exams),
        source_name=source_name,
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


def _exam_title(
    module: dict[str, Any], question_count: int, kind: str = "practice",
) -> str:
    """A name that says what this exam simulates.

    "Full Exam Simulation — CompTIA Security+" when it's the real length of a
    recognised paper, otherwise the module and the length, because a shorter run
    isn't a simulation of anything. A baseline says so outright — it will sit in
    the list beside a dozen later attempts, and which one was the starting point
    is the thing worth being able to see at a glance.
    """
    known = exam_catalog.find(module.get("title"), module.get("detected_subject"))
    label = known.label if known else (module.get("title") or "Practice")
    if kind == "pre_assessment":
        return f"Baseline assessment — {label}"[:200]
    if known and question_count >= known.question_count:
        return f"Full Exam Simulation — {label}"[:200]
    return f"{label} — {question_count}-question practice"[:200]


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
        # An imported paper explains its answer, not each distractor.
        option_explanations=[""] * len(texts),
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
    kind = "pre_assessment" if payload.kind == "pre_assessment" else "practice"

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

    # Bend the published weighting towards what this learner keeps getting
    # wrong. Only ever a bend: a domain worth 4% of the paper does not become
    # worth 30% because it is going badly, so the exam weight stays the base and
    # need multiplies it. Empty until there is something to go on.
    if payload.adaptive and payload.kind != "pre_assessment":
        need = performance.adaptive_weights(payload.module_id, user.id)
        if need:
            weight_by_id = {
                domain_id: need.get(domain_id, base) or base
                for domain_id, base in weight_by_id.items()
            }
            logger.info(
                "Exam for module %s weighted towards weak domains", payload.module_id,
            )

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
                    option_explanations=gq.get("option_explanations") or [],
                    terms=gq.get("terms") or [],
                    origin="generated",
                    domain_title=domain.get("title"),
                    domain_id=domain.get("id"),
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

    duration = exam_profile.exam_duration_minutes(
        len(questions), module, requested=payload.duration_minutes,
    )
    exam_row = client.table("practice_exams").insert(
        schema_features.strip_unsupported(
            "practice_exams",
            [{
                "module_id": payload.module_id,
                "user_id": user.id,
                "title": _exam_title(module, len(questions), kind),
                "duration_minutes": duration,
                "total_points": len(questions),
                "kind": kind,
            }],
            "kind",
        )[0]
    ).execute().data[0]

    client.table("practice_questions").insert(schema_features.strip_unsupported(
        "practice_questions",
        [
            {
                "exam_id": exam_row["id"],
                "kind": "mcq",
                "prompt": q.question,
                "options": _options_payload(q),
                "correct_index": q.correct_index,
                "expected_answer": q.explanation,
                "points": 1,
                "position": q.index,
                "terms": q.terms,
                "domain_id": q.domain_id,
            }
            for q in questions
        ],
        "terms",
    )).execute()

    return PracticeExam(
        id=exam_row["id"],
        module_id=payload.module_id,
        title=exam_row["title"],
        question_count=len(questions),
        duration_minutes=duration,
        questions=_without_answers(questions),
        created_at=exam_row.get("created_at"),
    )


# ============================================================================
# Take / grade
# ============================================================================
def _options_payload(q: ExamQuestion) -> list[dict[str, str]]:
    """How an exam question's options are stored.

    ``practice_questions.options`` is jsonb and already holds objects for
    practice mode, so per-option explanations ride along with the option text
    rather than needing a column of their own. Rows written before this keep
    working — see ``_option_texts``.
    """
    explanations = q.option_explanations or []
    return [
        {"text": text,
         "explanation": explanations[i] if i < len(explanations) else ""}
        for i, text in enumerate(q.options)
    ]


def _option_texts(raw: list[Any] | None) -> list[str]:
    """Option text, from either storage shape (plain string or {text,...})."""
    return [
        o if isinstance(o, str) else (o or {}).get("text", "")
        for o in (raw or [])
    ]


def _option_explanations(raw: list[Any] | None) -> list[str]:
    """Per-option explanations; empty strings for exams written before them."""
    return [
        "" if isinstance(o, str) else ((o or {}).get("explanation") or "")
        for o in (raw or [])
    ]


def _exam_questions(exam_id: str) -> list[dict[str, Any]]:
    return (
        _client().table("practice_questions").select("*")
        .eq("exam_id", exam_id).order("position").execute()
    ).data or []


def _to_exam(row: dict[str, Any], questions: list[dict[str, Any]]) -> PracticeExam:
    """The paper as the learner receives it: questions, and no answers.

    The answer key used to ride along with the paper. That is fine for a study
    quiz — the runner shows instant feedback from data it already holds, and a
    learner who wants to look is only cheating themselves out of practice. It is
    not fine for an exam whose first sitting is stored as the baseline every
    later attempt is measured against, and which decides how much of each domain
    gets generated from here on. A score that can be inflated by reading the
    payload isn't a measurement.

    So the key is withheld until each question is answered, one at a time,
    through ``POST /{exam_id}/answer`` — the same shape practice mode already
    uses, and no slower for it: the explanations were written at generation
    time, so revealing one is a read.
    """
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
                options=_option_texts(q.get("options")),
                # correct_index, explanation and option_explanations are
                # deliberately absent — see the docstring. The defaults on the
                # model are what a client sees until it answers.
                terms=q.get("terms") or [],
                domain_id=q.get("domain_id"),
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


class AttemptSummary(BaseModel):
    """A past sitting, as the history list shows it."""

    id: str
    exam_id: str
    kind: str = "practice"
    score: float = 0
    correct: int = 0
    total: int = 0
    pass_pct: float | None = None
    passed: bool | None = None
    domain_results: list[DomainResult] = Field(default_factory=list)
    summary: dict[str, Any] = Field(default_factory=dict)
    submitted_at: datetime | None = None


def _to_attempt(row: dict[str, Any]) -> AttemptSummary:
    return AttemptSummary(
        id=row["id"],
        exam_id=row.get("exam_id") or "",
        kind=row.get("kind") or "practice",
        score=float(row.get("score") or 0),
        correct=row.get("correct") or 0,
        total=row.get("total") or 0,
        pass_pct=row.get("pass_pct"),
        passed=row.get("passed"),
        domain_results=[
            DomainResult(**d) for d in (row.get("domain_results") or [])
        ],
        summary=row.get("summary") or {},
        submitted_at=row.get("submitted_at"),
    )


@router.get("/attempts/{module_id}", response_model=list[AttemptSummary])
async def list_attempts(
    module_id: str,
    user: AuthUser = Depends(get_current_user),
) -> list[AttemptSummary]:
    """Every sitting for a module, newest first. The baseline is in here too."""
    _own_module(module_id, user.id)
    if not performance.available():
        return []
    rows = (
        _client().table("exam_attempts").select("*")
        .eq("module_id", module_id).eq("user_id", user.id)
        .order("submitted_at", desc=True).execute()
    ).data or []
    return [_to_attempt(r) for r in rows]


@router.get("/attempt/{attempt_id}", response_model=AttemptSummary)
async def get_attempt(
    attempt_id: str,
    user: AuthUser = Depends(get_current_user),
) -> AttemptSummary:
    """One stored sitting — the summary screen, reopened."""
    if not performance.available():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attempt not found.")
    rows = (
        _client().table("exam_attempts").select("*")
        .eq("id", attempt_id).eq("user_id", user.id).limit(1).execute()
    ).data or []
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attempt not found.")
    return _to_attempt(rows[0])


@router.get("/{exam_id}", response_model=PracticeExam)
async def get_exam(
    exam_id: str,
    user: AuthUser = Depends(get_current_user),
) -> PracticeExam:
    """One exam with its questions."""
    exam = _own_exam(exam_id, user.id)
    return _to_exam(exam, _exam_questions(exam_id))


def _domain_breakdown(
    questions: list[dict[str, Any]], results: list[QuestionResult],
    module_id: str | None, user_id: str,
) -> list[DomainResult]:
    """Right and wrong per domain, in blueprint order.

    Questions with no domain — every question of an imported past paper, since
    a PDF never says which blueprint domain it is testing — are gathered under
    one honest heading rather than being dropped, or spread across the domains
    they might have belonged to.
    """
    tally: dict[str | None, list[int]] = {}
    for question, result in zip(questions, results, strict=False):
        entry = tally.setdefault(question.get("domain_id"), [0, 0])
        entry[0] += int(result.is_correct)
        entry[1] += 1
    if not tally:
        return []

    domains = []
    if module_id:
        domains = (
            _client().table("domains")
            .select("id, title, weight_pct, order_index")
            .eq("module_id", module_id).eq("user_id", user_id)
            .order("order_index").execute()
        ).data or []

    out: list[DomainResult] = []
    for domain in domains:
        counts = tally.get(domain["id"])
        if not counts:
            continue
        correct, total = counts
        out.append(DomainResult(
            domain_id=domain["id"],
            title=domain.get("title") or "",
            weight_pct=float(domain.get("weight_pct") or 0),
            correct=correct, total=total,
            pct=round(correct / total * 100, 1) if total else 0.0,
        ))
    if None in tally:
        correct, total = tally[None]
        out.append(DomainResult(
            title="Not attributed to a domain",
            correct=correct, total=total,
            pct=round(correct / total * 100, 1) if total else 0.0,
        ))
    return out


class AnswerRequest(BaseModel):
    """One question of a paper, answered."""

    index: int = Field(..., ge=0, description="The question's position.")
    # Null is a skip — the learner moved on. It still reveals, because the
    # runner shows the answer either way.
    chosen_index: int | None = None


class AnswerResult(BaseModel):
    index: int
    chosen_index: int | None = None
    correct_index: int
    is_correct: bool
    explanation: str = ""
    option_explanations: list[str] = Field(default_factory=list)


@router.post("/{exam_id}/answer", response_model=AnswerResult)
async def answer_question(
    exam_id: str,
    payload: AnswerRequest,
    user: AuthUser = Depends(get_current_user),
) -> AnswerResult:
    """Reveal one question's answer, once it has been answered.

    This exists so the paper itself can be sent without its answer key. It used
    to travel with the questions, which is defensible for a study quiz and not
    for an exam whose first sitting becomes the baseline every later attempt is
    measured against — and which decides how much of each domain gets generated
    from here on. A number that can be raised by reading the network response
    is not a measurement of anything.

    It costs a round trip per question and no model call: the explanations were
    written at generation time, so this is one read. The same trade practice
    mode already makes, measured there at 0.14s.
    """
    _own_exam(exam_id, user.id)
    rows = (
        _client().table("practice_questions").select("*")
        .eq("exam_id", exam_id).eq("position", payload.index).limit(1).execute()
    ).data or []
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such question on this exam.")

    question = rows[0]
    correct_index = int(question.get("correct_index") or 0)
    return AnswerResult(
        index=payload.index,
        chosen_index=payload.chosen_index,
        correct_index=correct_index,
        is_correct=payload.chosen_index == correct_index,
        explanation=question.get("expected_answer") or "",
        option_explanations=_option_explanations(question.get("options")),
    )


@router.post("/{exam_id}/submit", response_model=ExamResult)
async def submit_exam(
    exam_id: str,
    payload: SubmitRequest,
    user: AuthUser = Depends(get_current_user),
) -> ExamResult:
    """Grade an attempt, break it down by domain, and keep it.

    Grading used to end at a percentage that was returned and forgotten. The
    breakdown is the part that tells a learner what to do next, and keeping the
    attempt is what lets the app say anything at all about whether they are
    getting better.
    """
    exam = _own_exam(exam_id, user.id)
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
            option_explanations=_option_explanations(q.get("options")),
        ))

    total = len(questions)
    score = round(correct / total * 100, 1) if total else 0.0
    module_id = exam.get("module_id")
    kind = exam.get("kind") or "practice"

    module: dict[str, Any] = {}
    if module_id:
        rows = (
            _client().table("modules").select("title, detected_subject")
            .eq("id", module_id).limit(1).execute()
        ).data or []
        module = rows[0] if rows else {}

    threshold = (
        exam_catalog.pass_pct(module.get("detected_subject"), module.get("title"))
        if module else None
    )
    passed = score >= threshold if threshold is not None else None

    domains = _domain_breakdown(questions, results, module_id, user.id)
    domain_payload = [d.model_dump() for d in domains]
    summary = performance.summarise_attempt(
        subject=module.get("detected_subject") or module.get("title") or "this subject",
        score=score, correct=correct, total=total,
        pass_pct=threshold, passed=passed,
        domain_results=domain_payload, is_baseline=kind == "pre_assessment",
    )
    attempt_id = performance.record_attempt(
        exam_id=exam_id, module_id=module_id, user_id=user.id, kind=kind,
        score=score, correct=correct, total=total,
        pass_pct=threshold, passed=passed,
        domain_results=domain_payload, summary=summary,
    )

    return ExamResult(
        exam_id=exam_id, attempt_id=attempt_id, kind=kind,
        score=score, correct=correct, total=total,
        pass_pct=threshold, passed=passed,
        domains=domains, summary=summary, results=results,
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

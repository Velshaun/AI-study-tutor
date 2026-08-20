"""Storing what the ingestion boundary parsed.

`ingest` converts pasted material into canonical records and deliberately does
nothing else — no database, no model calls. This is the other half: taking those
records and putting them where the rest of the app already looks for them.

Nothing here invents a new home. Reference text becomes a `user_files` row, so
every generator, the coverage map and the tutor pick it up exactly as they would
an uploaded PDF. Flashcards become their own locked, zero-weight domain, the
same shape the CSV deck importer has always used, so bulk generation and exam
weighting skip them while the Classroom still lists them. Questions become a
`practice_exams` row and canonical `practice_questions`, which is what an
imported PDF has always produced and what makes a pasted paper sittable by
construction rather than by a second code path.

Everything written carries `origin` and `import_batch_id`, so one misbehaving
paste is one batch delete rather than an archaeology exercise.
"""

from __future__ import annotations

import logging
from typing import Any

from app.database import get_supabase
from app.services import schema_features
from app.services.ingest import ParseResult

logger = logging.getLogger(__name__)

MAX_TITLE_CHARS = 200
ORIGIN = "pasted"


def _client():
    return get_supabase()


def _provenance(rows: list[dict[str, Any]], table: str) -> list[dict[str, Any]]:
    """Drop origin/batch columns where the migration hasn't run yet.

    The same tolerance `schema_features` gives everything else: a deployment
    behind on migrations imports material without provenance rather than
    failing the import outright.
    """
    return schema_features.strip_unsupported(
        table, rows, "origin", "import_batch_id",
    )


def store_reference(
    *, module_id: str, user_id: str, title: str, text: str,
    source_type: str = ORIGIN,
) -> dict[str, Any]:
    """Keep prose as a source, indistinguishable from an upload.

    `source_type` is what the Sources list shows and what a learner reads to
    remember where something came from — so a transcript says `youtube` rather
    than inheriting the word `pasted` from the code path it happened to take.
    """
    row = {
        "user_id": user_id,
        "module_id": module_id,
        "filename": (title or "Pasted material")[:MAX_TITLE_CHARS],
        "storage_path": "",
        "source_type": source_type,
        "extracted_text": text,
        "char_count": len(text),
        # Already parsed by definition — there are no bytes to extract from, so
        # the pipeline should carry it straight into the blueprint.
        "status": "parsed",
    }
    inserted = (_client().table("user_files").insert(row).execute()).data or []
    return {"kind": "reference", "chars": len(text), "source_id": (inserted or [{}])[0].get("id")}


def store_flashcards(
    *, module_id: str, user_id: str, title: str, result: ParseResult, batch_id: str,
) -> dict[str, Any]:
    """Write cards into their own deck.

    A deck is a locked, zero-weight domain — the shape the CSV importer
    established. It keeps someone's pasted Quizlet set out of the exam weighting
    (it isn't part of the blueprint) while leaving it fully studiable.
    """
    client = _client()
    cards = result.usable_cards
    if not cards:
        return {"kind": "flashcards", "cards": 0}

    existing = (
        client.table("domains").select("order_index")
        .eq("module_id", module_id).eq("user_id", user_id).execute()
    ).data or []
    next_index = max((d.get("order_index") or 0 for d in existing), default=0) + 1

    domain = (
        client.table("domains").insert({
            "module_id": module_id,
            "user_id": user_id,
            "title": (title or "Imported flashcards")[:MAX_TITLE_CHARS],
            "description": "Imported flashcard deck",
            "status": "locked",
            "weight_pct": 0,
            "order_index": next_index,
        }).execute()
    ).data
    if not domain:
        raise RuntimeError("Could not create a domain for the imported deck.")
    domain_id = domain[0]["id"]

    rows = _provenance([
        {**card.to_row(domain_id=domain_id, user_id=user_id,
                       origin=ORIGIN, batch_id=batch_id),
         "module_id": module_id}
        for card in cards
    ], "flashcards")
    client.table("flashcards").insert(rows).execute()
    return {"kind": "flashcards", "cards": len(cards), "domain_id": domain_id}


def store_questions(
    *, module_id: str, user_id: str, title: str, result: ParseResult,
    batch_id: str, duration_minutes: int = 0,
) -> dict[str, Any]:
    """Write questions as a real exam the learner can sit and be scored on."""
    client = _client()
    questions = result.usable_questions
    if not questions:
        return {"kind": "questions", "questions": 0}

    exam_row = {
        "module_id": module_id,
        "user_id": user_id,
        "title": (title or "Imported questions")[:MAX_TITLE_CHARS],
        "duration_minutes": duration_minutes,
        "total_points": len(questions),
        "origin": ORIGIN,
        "import_batch_id": batch_id,
        "source_name": title,
    }
    exam = (
        client.table("practice_exams")
        .insert(schema_features.strip_unsupported(
            "practice_exams", [exam_row], "origin", "import_batch_id",
            "source_name", "kind",
        )[0])
        .execute()
    ).data
    if not exam:
        raise RuntimeError("Could not create an exam for the imported questions.")
    exam_id = exam[0]["id"]

    rows = _provenance([
        q.to_row(position=i, origin=ORIGIN, exam_id=exam_id, batch_id=batch_id)
        for i, q in enumerate(questions)
    ], "practice_questions")
    client.table("practice_questions").insert(rows).execute()
    return {"kind": "questions", "questions": len(questions), "exam_id": exam_id}


def store(
    *, module_id: str, user_id: str, title: str, result: ParseResult, batch_id: str,
) -> dict[str, Any]:
    """Put a parse result wherever it belongs, and say what happened.

    The parser has already decided what the material can honestly become — this
    only routes it. A result that came back as reference stays reference, even
    if the learner labelled it an exam: `ingest` is where that judgement lives,
    and second-guessing it here would be the same mistake in a new place.
    """
    if result.kind == "flashcards":
        summary = store_flashcards(
            module_id=module_id, user_id=user_id, title=title,
            result=result, batch_id=batch_id,
        )
    elif result.kind == "questions":
        summary = store_questions(
            module_id=module_id, user_id=user_id, title=title,
            result=result, batch_id=batch_id,
        )
    else:
        summary = store_reference(
            module_id=module_id, user_id=user_id, title=title,
            text=result.text,
        )

    summary["note"] = result.note
    summary["detected"] = result.detected
    return summary

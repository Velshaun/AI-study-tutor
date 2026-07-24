"""Export study material.

    POST /export/flashcards/csv|json     ad-hoc flashcard export (body-driven)
    POST /export/notes/markdown
    GET  /export/module/{id}             a whole module as structured JSON
    GET  /export/module/{id}/pdf         the same, as a formatted PDF

The module exports pull the owner's own module, domains, lecture transcripts,
Q&A sessions and quiz results straight from the database.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.database import get_supabase
from app.routers.auth import AuthUser, get_current_user

router = APIRouter(prefix="/export", tags=["export"])


# --- Schemas --------------------------------------------------------------
class FlashcardItem(BaseModel):
    front: str
    back: str


class FlashcardExport(BaseModel):
    title: str = "flashcards"
    cards: list[FlashcardItem] = Field(default_factory=list)


class NotesExport(BaseModel):
    title: str = "notes"
    sections: list[dict] = Field(default_factory=list)


# --- Routes ---------------------------------------------------------------
@router.post("/flashcards/csv")
async def export_flashcards_csv(payload: FlashcardExport) -> Response:
    """Return a CSV (front,back) suitable for importing into Anki/Quizlet."""
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["front", "back"])
    for card in payload.cards:
        writer.writerow([card.front, card.back])
    filename = f"{_slug(payload.title)}.csv"
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/flashcards/json")
async def export_flashcards_json(payload: FlashcardExport) -> Response:
    filename = f"{_slug(payload.title)}.json"
    body = json.dumps(payload.model_dump(), indent=2, ensure_ascii=False)
    return Response(
        content=body,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/notes/markdown")
async def export_notes_markdown(payload: NotesExport) -> Response:
    """Render a notes document (sections of {heading, body, key_points}) to Markdown."""
    lines: list[str] = [f"# {payload.title}", ""]
    for section in payload.sections:
        heading = section.get("heading", "Section")
        body = section.get("body") or section.get("narration", "")
        lines.append(f"## {heading}")
        lines.append("")
        if body:
            lines.append(str(body))
            lines.append("")
        for point in section.get("key_points", []):
            lines.append(f"- {point}")
        if section.get("key_points"):
            lines.append("")
    filename = f"{_slug(payload.title)}.md"
    return Response(
        content="\n".join(lines),
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _slug(value: str) -> str:
    import re

    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "export"


# ============================================================================
# Whole-module export — spec Prompt 9.3
# ============================================================================
def _gather_module(module_id: str, user_id: str) -> dict[str, Any]:
    """Assemble a module and everything under it, scoped to the owner."""
    try:
        client = get_supabase()
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc

    modules = (
        client.table("modules").select("*")
        .eq("id", module_id).eq("user_id", user_id).limit(1).execute()
    ).data or []
    if not modules:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Module not found.")
    module = modules[0]

    domains = (
        client.table("domains").select("*")
        .eq("module_id", module_id).eq("user_id", user_id)
        .order("order_index").execute()
    ).data or []
    domain_ids = [d["id"] for d in domains]

    lectures = qa_sessions = qa_entries = quizzes = []
    if domain_ids:
        lectures = (
            client.table("lectures")
            .select("id, domain_id, title, transcript, tutor_voice, "
                    "length_preference, duration_secs, completed_at")
            .in_("domain_id", domain_ids).eq("user_id", user_id).execute()
        ).data or []
        qa_sessions = (
            client.table("qa_sessions")
            .select("id, domain_id, session_title, question_count, started_at, "
                    "ended_at")
            .in_("domain_id", domain_ids).eq("user_id", user_id)
            .gt("question_count", 0).order("started_at").execute()
        ).data or []
        session_ids = [s["id"] for s in qa_sessions]
        if session_ids:
            qa_entries = (
                client.table("lecture_qa")
                .select("session_id, question_summary, answer, timestamp_secs, "
                        "is_knowledge_question, created_at")
                .in_("session_id", session_ids).eq("user_id", user_id)
                .eq("is_knowledge_question", True).order("created_at").execute()
            ).data or []
        quizzes = (
            client.table("quizzes")
            .select("id, domain_id, title, difficulty, question_count, score, "
                    "created_at")
            .in_("domain_id", domain_ids).eq("user_id", user_id).execute()
        ).data or []

    # Group children under their domain.
    entries_by_session: dict[str, list[dict]] = {}
    for e in qa_entries:
        entries_by_session.setdefault(e["session_id"], []).append(e)

    def for_domain(rows, key="domain_id", did=None):
        return [r for r in rows if r.get(key) == did]

    domain_blocks = []
    for d in domains:
        sessions = for_domain(qa_sessions, did=d["id"])
        domain_blocks.append({
            "title": d.get("title"),
            "description": d.get("description"),
            "weight_pct": d.get("weight_pct"),
            "status": d.get("status"),
            "order_index": d.get("order_index"),
            "lectures": [
                {
                    "title": lec.get("title"),
                    "tutor_voice": lec.get("tutor_voice"),
                    "length": lec.get("length_preference"),
                    "duration_secs": lec.get("duration_secs"),
                    "transcript": lec.get("transcript"),
                }
                for lec in for_domain(lectures, did=d["id"])
            ],
            "qa_sessions": [
                {
                    "title": s.get("session_title"),
                    "question_count": s.get("question_count"),
                    "exchanges": [
                        {"question": e.get("question_summary"),
                         "answer": e.get("answer"),
                         "timestamp_secs": e.get("timestamp_secs")}
                        for e in entries_by_session.get(s["id"], [])
                    ],
                }
                for s in sessions
            ],
            "quizzes": [
                {
                    "title": q.get("title"),
                    "difficulty": q.get("difficulty"),
                    "question_count": q.get("question_count"),
                    "last_score": q.get("score"),
                }
                for q in for_domain(quizzes, did=d["id"])
            ],
        })

    return {
        "module": {
            "title": module.get("title"),
            "detected_subject": module.get("detected_subject"),
            "source_summary": module.get("source_summary"),
            "status": module.get("status"),
        },
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "domains": domain_blocks,
    }


@router.get("/module/{module_id}")
async def export_module_json(
    module_id: str,
    user: AuthUser = Depends(get_current_user),
) -> Response:
    """A whole module as structured JSON — domains, transcripts, Q&A, quizzes."""
    data = _gather_module(module_id, user.id)
    title = _slug(data["module"]["title"] or "module")
    return Response(
        content=json.dumps(data, indent=2, ensure_ascii=False),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{title}.json"'},
    )


@router.get("/module/{module_id}/pdf")
async def export_module_pdf(
    module_id: str,
    user: AuthUser = Depends(get_current_user),
) -> Response:
    """The same module content as a formatted PDF (reportlab)."""
    data = _gather_module(module_id, user.id)
    pdf_bytes = _render_pdf(data)
    title = _slug(data["module"]["title"] or "module")
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{title}.pdf"'},
    )


def _render_pdf(data: dict[str, Any]) -> bytes:
    """Lay the gathered module out as a PDF."""
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        HRFlowable,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
    )

    def esc(text: Any) -> str:
        s = str(text or "")
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("h1", parent=styles["Heading1"], fontSize=20, spaceAfter=6)
    h2 = ParagraphStyle("h2", parent=styles["Heading2"], fontSize=14,
                        spaceBefore=14, spaceAfter=4)
    h3 = ParagraphStyle("h3", parent=styles["Heading3"], fontSize=11,
                        spaceBefore=8, spaceAfter=2, textColor="#4840d4")
    body = ParagraphStyle("body", parent=styles["BodyText"], fontSize=10,
                          leading=15, alignment=TA_LEFT, spaceAfter=4)
    meta = ParagraphStyle("meta", parent=body, fontSize=9, textColor="#666666")

    story: list[Any] = []
    module = data["module"]
    story.append(Paragraph(esc(module.get("title") or "Module"), h1))
    if module.get("detected_subject"):
        story.append(Paragraph(esc(module["detected_subject"]), meta))
    if module.get("source_summary"):
        story.append(Spacer(1, 4))
        story.append(Paragraph(esc(module["source_summary"]), body))
    story.append(Spacer(1, 6))
    story.append(HRFlowable(width="100%", color="#dddddd"))

    for d in data["domains"]:
        weight = f" · {d['weight_pct']}%" if d.get("weight_pct") else ""
        story.append(Paragraph(f"{esc(d.get('title'))}{esc(weight)}", h2))
        if d.get("description"):
            story.append(Paragraph(esc(d["description"]), meta))

        for lec in d.get("lectures", []):
            story.append(Paragraph(f"Lecture — {esc(lec.get('title'))}", h3))
            if lec.get("transcript"):
                for para in str(lec["transcript"]).split("\n\n"):
                    if para.strip():
                        story.append(Paragraph(esc(para.strip()), body))

        for s in d.get("qa_sessions", []):
            story.append(Paragraph(f"Q&amp;A — {esc(s.get('title'))}", h3))
            for e in s.get("exchanges", []):
                story.append(Paragraph(f"<b>Q:</b> {esc(e.get('question'))}", body))
                story.append(Paragraph(f"<b>A:</b> {esc(e.get('answer'))}", body))

        quizzes = d.get("quizzes", [])
        if quizzes:
            story.append(Paragraph("Quizzes", h3))
            for q in quizzes:
                score = (f" — last score {round(q['last_score'])}%"
                         if q.get("last_score") is not None else "")
                story.append(Paragraph(
                    f"{esc(q.get('title'))} ({q.get('question_count')} questions, "
                    f"{esc(q.get('difficulty'))}){esc(score)}", body))

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=A4,
        leftMargin=18 * mm, rightMargin=18 * mm,
        topMargin=18 * mm, bottomMargin=18 * mm,
        title=module.get("title") or "Module export",
    )
    doc.build(story)
    return buffer.getvalue()

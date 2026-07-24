"""Ingestion pipeline orchestration — spec §4.3 steps 2-8.

``process_module`` runs as a FastAPI background task: it parses every pending
source, hands the combined text to Gemini, writes the progression map and the
individual domain rows, and finally flips the module to ``ready`` so the
frontend's poll picks it up.

Module status transitions:

    processing  -> parsing    (extracting text from sources)
                -> analysing  (Gemini identifying subject + weightings)
                -> ready      (domains written; step 8)
                -> failed     (with error_message set)
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from app.database import get_supabase
from app.services import storage
from app.services.domains import DomainExtractionError, extract_domains
from app.services.extraction import ExtractionError, extract_source

logger = logging.getLogger(__name__)

# Gemini needs something substantive to classify a certification from.
MIN_USABLE_CHARS = 200


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def set_module_status(
    module_id: str,
    status: str,
    *,
    detail: str | None = None,
    error: str | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    """Update a module's pipeline state (step 8's signal to the frontend)."""
    payload: dict[str, Any] = {"status": status}
    if detail is not None:
        payload["status_detail"] = detail
    payload["error_message"] = error[:1000] if error else None
    if extra:
        payload.update(extra)
    get_supabase().table("modules").update(payload).eq("id", module_id).execute()


# --- step 2 -----------------------------------------------------------------
def parse_pending_sources(module_id: str) -> tuple[list[str], list[str]]:
    """Extract text from every unparsed source on a module.

    Returns ``(texts, errors)``. One bad source doesn't abort the batch — its
    row is marked failed and the rest continue.
    """
    texts: list[str] = []
    errors: list[str] = []

    for row in storage.list_module_sources(module_id):
        file_id = row["id"]

        if row.get("status") == "parsed" and row.get("extracted_text"):
            texts.append(row["extracted_text"])
            continue

        source_type = row.get("source_type") or "pdf"
        label = row.get("filename") or source_type
        try:
            get_supabase().table("user_files").update(
                {"status": "parsing"}
            ).eq("id", file_id).execute()

            data = None
            if row.get("storage_path"):
                data = storage.download_source_file(row["storage_path"])

            text = extract_source(
                source_type=source_type,
                data=data,
                url=row.get("source_url"),
                filename=row.get("filename") or "source",
            )
            storage.mark_parsed(file_id, text)
            texts.append(text)
        except ExtractionError as exc:
            logger.warning("Parse failed for %s: %s", label, exc)
            storage.mark_failed(file_id, str(exc))
            errors.append(f"{label}: {exc}")
        except Exception as exc:  # noqa: BLE001 - never let one source kill the run
            logger.exception("Unexpected parse error for %s", label)
            storage.mark_failed(file_id, str(exc))
            errors.append(f"{label}: {exc}")

    return texts, errors


# --- step 7 -----------------------------------------------------------------
def write_domains(module_id: str, user_id: str, domains: list[dict[str, Any]]) -> int:
    """Replace the module's AI-derived domains with a fresh set.

    User-authored domains (``source <> 'ai'``) are left alone so a re-run of the
    pipeline never destroys someone's manual edits.
    """
    client = get_supabase()
    client.table("domains").delete().eq("module_id", module_id).eq(
        "source", "ai"
    ).execute()

    rows = [
        {
            "module_id": module_id,
            "user_id": user_id,
            "title": domain["title"],
            "description": domain.get("description") or "",
            "order_index": domain["order_index"],
            "weight_pct": domain["weight_pct"],
            # The first domain is open; later ones unlock as study progresses.
            "status": "unlocked" if domain["order_index"] == 1 else "locked",
            "source": "ai",
        }
        for domain in domains
    ]
    if not rows:
        return 0
    inserted = client.table("domains").insert(rows).execute()
    return len(inserted.data or rows)


# --- steps 2-8 --------------------------------------------------------------
def process_module(module_id: str, user_id: str) -> dict[str, Any]:
    """Run the full pipeline for one module. Safe to call in the background."""
    logger.info("Pipeline starting for module %s", module_id)
    try:
        set_module_status(module_id, "processing", detail="parsing")
        texts, errors = parse_pending_sources(module_id)

        combined = "\n\n---\n\n".join(t for t in texts if t.strip())
        if len(combined) < MIN_USABLE_CHARS:
            reason = (
                "; ".join(errors)
                if errors
                else "No readable text was extracted from the uploaded sources."
            )
            set_module_status(module_id, "failed", detail="parsing", error=reason)
            return {"status": "failed", "error": reason, "errors": errors}

        # steps 3-6. A learner-supplied syllabus is passed in as a reference
        # layer so Gemini can validate weightings against what this course
        # actually examines.
        set_module_status(module_id, "processing", detail="analysing")
        module = (
            get_supabase()
            .table("modules")
            .select("course_context, course_context_source")
            .eq("id", module_id)
            .limit(1)
            .execute()
        ).data or [{}]
        user_context = (
            module[0].get("course_context")
            if module[0].get("course_context_source") == "user"
            else None
        )
        if user_context:
            logger.info(
                "Module %s: applying %d chars of user course context",
                module_id, len(user_context),
            )

        result, sources = extract_domains(combined, user_context)

        # step 7
        domain_count = write_domains(module_id, user_id, result["domains"])

        # step 8
        extra: dict[str, Any] = {
            "progression_map": result,
            "source_summary": result.get("summary") or "",
            "detected_subject": result.get("subject"),
            "subject_confidence": result.get("subject_confidence"),
            "weighting_sources": sources,
            "processed_at": _now_iso(),
        }
        # Never overwrite a syllabus the learner supplied — Gemini's own
        # description of the course only fills an otherwise-empty field.
        if not user_context:
            extra["course_context"] = result.get("course_context") or ""
            extra["course_context_source"] = "ai"

        set_module_status(module_id, "ready", detail="complete", extra=extra)
        logger.info(
            "Pipeline complete for module %s: %s (%d domains)",
            module_id, result.get("subject"), domain_count,
        )
        return {
            "status": "ready",
            "subject": result.get("subject"),
            "domain_count": domain_count,
            "weights_are_official": result.get("weights_are_official"),
            "sources": sources,
            "parse_errors": errors,
        }

    except DomainExtractionError as exc:
        logger.error("Domain extraction failed for %s: %s", module_id, exc)
        set_module_status(module_id, "failed", detail="analysing", error=str(exc))
        return {"status": "failed", "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 - a background task must never escape
        logger.exception("Pipeline crashed for module %s", module_id)
        set_module_status(module_id, "failed", error=str(exc))
        return {"status": "failed", "error": str(exc)}

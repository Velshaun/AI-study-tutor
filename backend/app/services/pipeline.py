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
# Everything a learner accumulates against a domain. Deleting the domain row
# cascades all of it away, which is why re-ingestion has to tread carefully.
GENERATED_TABLES = ("lectures", "flashcards", "quizzes", "practice_questions")


def _generated_content(domain_ids: list[str]) -> dict[str, dict[str, int]]:
    """How much generated study content hangs off each domain.

    One batched query per table rather than per domain — a module with twenty
    domains shouldn't cost eighty round trips to answer "is anything here?".
    """
    if not domain_ids:
        return {}
    client = get_supabase()
    counts: dict[str, dict[str, int]] = {d: {} for d in domain_ids}
    for table in GENERATED_TABLES:
        try:
            rows = (
                client.table(table).select("domain_id")
                .in_("domain_id", domain_ids).execute()
            ).data or []
        except Exception as exc:  # noqa: BLE001 — never block ingestion on this
            logger.warning("Could not count %s while guarding domains: %s", table, exc)
            continue
        for row in rows:
            domain = row.get("domain_id")
            if domain in counts:
                counts[domain][table] = counts[domain].get(table, 0) + 1
    return {d: c for d, c in counts.items() if c}


def domains_with_content(module_id: str) -> list[dict[str, Any]]:
    """The module's AI domains that hold generated content, and how much.

    Powers the confirmation dialog: a learner asked to approve a rebuild should
    see exactly what it would destroy.
    """
    rows = (
        get_supabase().table("domains").select("id, title")
        .eq("module_id", module_id).eq("source", "ai").execute()
    ).data or []
    counts = _generated_content([r["id"] for r in rows])
    return [
        {"domain_id": r["id"], "title": r.get("title") or "", "counts": counts[r["id"]]}
        for r in rows
        if r["id"] in counts
    ]


def _describe(counts: dict[str, int]) -> str:
    """'3 lectures, 40 practice_questions' — for the warning log."""
    return ", ".join(f"{n} {table}" for table, n in sorted(counts.items()) if n)


def _match_key(title: str) -> str:
    """Loose identity for a domain, so a re-run recognises its own work."""
    return " ".join((title or "").lower().split())


def write_domains(
    module_id: str, user_id: str, domains: list[dict[str, Any]],
    *, force: bool = False,
) -> dict[str, Any]:
    """Reconcile the module's AI-derived domains with a freshly extracted set.

    Domains cascade: deleting one takes its lectures, flashcards, quizzes and
    practice questions with it. Re-running ingestion after uploading one extra
    source used to do exactly that — silently, and for the whole module.

    So a domain that holds generated content is never deleted here. If the fresh
    blueprint still contains it (matched on title), its metadata is updated in
    place and the content stays attached. If the blueprint has dropped it, it is
    kept anyway and logged, because losing a learner's study material is far
    worse than carrying a stale domain they can delete themselves.

    Empty domains — no generated content — are replaced as before.

    ``force=True`` is the explicit "rebuild everything" path: it deletes even
    domains holding content, and logs exactly what it destroyed. Callers are
    expected to have confirmed with the learner first.

    User-authored domains (``source <> 'ai'``) are untouched either way.
    """
    client = get_supabase()

    existing = (
        client.table("domains").select("id, title, order_index")
        .eq("module_id", module_id).eq("source", "ai").execute()
    ).data or []
    with_content = _generated_content([d["id"] for d in existing])

    fresh_by_key = {_match_key(d["title"]): d for d in domains}
    matched_keys: set[str] = set()
    updated = preserved = 0
    protected: list[str] = []

    deletable: list[str] = []
    to_update: list[tuple[dict[str, Any], dict[str, Any]]] = []
    to_preserve: list[dict[str, Any]] = []

    for row in existing:
        key = _match_key(row.get("title"))
        counts = with_content.get(row["id"])

        if counts and not force:
            fresh = fresh_by_key.get(key)
            if fresh:
                # Same domain, refreshed blueprint: update in place so the
                # learner's questions and lectures stay attached to it.
                to_update.append((row, fresh))
                matched_keys.add(key)
                updated += 1
            else:
                # Dropped from the new blueprint but not from the learner's
                # study history. Keep it, and say so loudly.
                to_preserve.append(row)
                preserved += 1
                logger.warning(
                    "Ingestion guard: keeping domain %s (%r) in module %s — the new "
                    "blueprint dropped it, but it holds %s that a cascade delete "
                    "would have destroyed. Re-run with force=true to remove it.",
                    row["id"], row.get("title"), module_id, _describe(counts),
                )
            protected.append(row.get("title") or row["id"])
            continue

        if counts and force:
            logger.warning(
                "Ingestion guard OVERRIDDEN: deleting domain %s (%r) in module %s "
                "and its %s, at the learner's explicit request.",
                row["id"], row.get("title"), module_id, _describe(counts),
            )
        deletable.append(row["id"])

    # `order_index` is uniquely indexed per module, so every surviving domain
    # has to vacate its slot before the incoming blueprint claims it. Park them
    # above everything currently in use, then place them properly at the end.
    survivors = [row for row, _ in to_update] + to_preserve
    if survivors:
        occupied = [
            r.get("order_index") or 0
            for r in (client.table("domains").select("order_index")
                      .eq("module_id", module_id).execute().data or [])
        ]
        park = max([*occupied, len(domains)]) + 1
        for offset, row in enumerate(survivors):
            client.table("domains").update(
                {"order_index": park + offset}
            ).eq("id", row["id"]).execute()

    if deletable:
        client.table("domains").delete().in_("id", deletable).execute()

    for row, fresh in to_update:
        client.table("domains").update({
            "description": fresh.get("description") or "",
            "order_index": fresh["order_index"],
            "weight_pct": fresh["weight_pct"],
        }).eq("id", row["id"]).execute()

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
        if _match_key(domain["title"]) not in matched_keys
    ]
    created = 0
    if rows:
        inserted = client.table("domains").insert(rows).execute()
        created = len(inserted.data or rows)

    # Preserved domains sit after the blueprint: they're no longer part of it,
    # but the learner's work still lives there.
    if to_preserve:
        tail = max(
            [d["order_index"] for d in domains]
            + [
                r.get("order_index") or 0
                for r in (client.table("domains").select("order_index")
                          .eq("module_id", module_id).eq("source", "user").execute().data
                          or [])
            ]
        )
        for offset, row in enumerate(to_preserve, start=1):
            client.table("domains").update(
                {"order_index": tail + offset}
            ).eq("id", row["id"]).execute()

    if protected:
        logger.info(
            "Module %s: %d domain(s) with generated content survived ingestion (%s)",
            module_id, len(protected), ", ".join(protected[:6]),
        )

    return {
        "domain_count": created + updated + preserved,
        "created": created,
        "updated": updated,
        "preserved": preserved,
        "deleted": len(deletable),
        "protected_domains": protected,
    }


# --- steps 2-8 --------------------------------------------------------------
def process_module(
    module_id: str, user_id: str, *, force: bool = False,
) -> dict[str, Any]:
    """Run the full pipeline for one module. Safe to call in the background.

    ``force`` rebuilds the domain list outright, destroying generated content
    attached to domains that go away. Only pass it when the learner has
    explicitly confirmed — see ``write_domains``.
    """
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
            .select("title, course_context, course_context_source")
            .eq("id", module_id)
            .limit(1)
            .execute()
        ).data or [{}]
        user_context = (
            module[0].get("course_context")
            if module[0].get("course_context_source") == "user"
            else None
        )
        current_title = (module[0].get("title") or "").strip()
        if user_context:
            logger.info(
                "Module %s: applying %d chars of user course context",
                module_id, len(user_context),
            )

        result, sources = extract_domains(combined, user_context)

        # step 7
        written = write_domains(module_id, user_id, result["domains"], force=force)
        domain_count = written["domain_count"]

        # step 8
        extra: dict[str, Any] = {
            "progression_map": result,
            "source_summary": result.get("summary") or "",
            "detected_subject": result.get("subject"),
            "subject_confidence": result.get("subject_confidence"),
            "weighting_sources": sources,
            "processed_at": _now_iso(),
        }
        if written["preserved"]:
            logger.warning(
                "Module %s: ingestion preserved %d domain(s) whose study content "
                "would otherwise have been cascade-deleted: %s",
                module_id, written["preserved"], ", ".join(written["protected_domains"]),
            )
        # Auto-name the module from the detected subject — but only when it has
        # no title yet, so a name the learner set by hand is never clobbered.
        if not current_title:
            extra["title"] = (result.get("subject") or "Untitled module").strip()[:200]

        # Never overwrite a syllabus the learner supplied — Gemini's own
        # description of the course only fills an otherwise-empty field.
        if not user_context:
            extra["course_context"] = result.get("course_context") or ""
            extra["course_context_source"] = "ai"

        set_module_status(module_id, "ready", detail="complete", extra=extra)
        logger.info(
            "Pipeline complete for module %s: %s (%d domains: %d new, %d updated, "
            "%d preserved, %d replaced)",
            module_id, result.get("subject"), domain_count, written["created"],
            written["updated"], written["preserved"], written["deleted"],
        )
        return {
            "status": "ready",
            "subject": result.get("subject"),
            "domain_count": domain_count,
            "domains_created": written["created"],
            "domains_updated": written["updated"],
            "domains_preserved": written["preserved"],
            "protected_domains": written["protected_domains"],
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

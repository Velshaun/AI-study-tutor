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


def sat_exam_domains(domain_ids: list[str]) -> set[str]:
    """Domains whose questions appear in an exam the learner has already sat.

    These cannot be deleted, by force or otherwise. `practice_questions.domain_id`
    cascades, so removing the domain would take questions out of a paper that has
    already been graded — leaving the attempt row intact (it lives on
    `practice_exams`) while the paper it refers to loses questions. The score
    survives and the evidence for it does not, which is the one outcome worse
    than refusing the rebuild.

    Nulling the attribution instead was considered and rejected: it keeps the
    paper whole but silently detaches per-domain history, so a past attempt's
    breakdown stops adding up to its own total.
    """
    if not domain_ids:
        return set()
    client = get_supabase()
    try:
        questions = (
            client.table("practice_questions").select("domain_id, exam_id")
            .in_("domain_id", domain_ids).not_.is_("exam_id", "null").execute()
        ).data or []
        exam_ids = list({q["exam_id"] for q in questions if q.get("exam_id")})
        if not exam_ids:
            return set()

        sat = (
            client.table("exam_attempts").select("exam_id")
            .in_("exam_id", exam_ids).execute()
        ).data or []
        sat_ids = {a["exam_id"] for a in sat if a.get("exam_id")}
        return {
            q["domain_id"] for q in questions
            if q.get("exam_id") in sat_ids and q.get("domain_id")
        }
    except Exception as exc:  # noqa: BLE001
        # The table may not exist yet on a deployment without the migration.
        # Failing closed would block every rebuild; failing open only loses the
        # extra guard, and the content guard above still applies.
        logger.warning("Could not check sat exams while guarding domains: %s", exc)
        return set()


def _match_key(title: str) -> str:
    """Loose identity for a domain, so a re-run recognises its own work."""
    return " ".join((title or "").lower().split())


def write_domains(
    module_id: str, user_id: str, domains: list[dict[str, Any]],
    *, force: bool = False, settle_weights: bool = True,
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

    One thing force cannot override: a domain whose questions appear in an exam
    the learner has already sat. That paper has been graded, and the attempt is
    the record of it. Deleting the domain would leave the score standing with
    the questions behind it gone — see ``sat_exam_domains``. The rebuild carries
    on; the delete is refused, and the domain comes back in ``sat_exam`` so the
    caller can say which ones and why.

    User-authored domains (``source <> 'ai'``) are untouched either way.
    """
    client = get_supabase()

    existing = (
        client.table("domains").select("id, title, order_index")
        .eq("module_id", module_id).eq("source", "ai").execute()
    ).data or []
    with_content = _generated_content([d["id"] for d in existing])
    # Refused even under force. Computed once for the whole module.
    undeletable = sat_exam_domains([d["id"] for d in existing])

    fresh_by_key = {_match_key(d["title"]): d for d in domains}
    matched_keys: set[str] = set()
    updated = preserved = 0
    protected: list[str] = []
    sat_exam: list[str] = []

    deletable: list[str] = []
    to_update: list[tuple[dict[str, Any], dict[str, Any]]] = []
    to_preserve: list[dict[str, Any]] = []

    for row in existing:
        key = _match_key(row.get("title"))
        counts = with_content.get(row["id"])

        # A sat exam outranks force. Handled before the content guard so the
        # domain is kept and reported even when the learner asked for a wipe.
        if row["id"] in undeletable:
            fresh = fresh_by_key.get(key)
            if fresh:
                to_update.append((row, fresh))
                matched_keys.add(key)
                updated += 1
            else:
                to_preserve.append(row)
                preserved += 1
            sat_exam.append(row.get("title") or row["id"])
            protected.append(row.get("title") or row["id"])
            logger.warning(
                "Ingestion guard: domain %s (%r) in module %s cannot be deleted — "
                "its questions are in an exam that has already been sat. Kept "
                "regardless of force.",
                row["id"], row.get("title"), module_id,
            )
            continue

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

    # Deliberately does NOT write weight_pct. A weight is a property of the
    # exam, not of the material — and this line ran on every import, so adding
    # one source could re-derive the whole split. Two runs minutes apart over
    # the same six sources produced LPI's published figures once and a flat
    # 20/20/20/20/20 the next; both summed to 100, and `exam_profile` allocates
    # every practice paper by them. Weights are looked up once and frozen; see
    # `exam_weights`.
    for row, fresh in to_update:
        client.table("domains").update({
            "description": fresh.get("description") or "",
            "order_index": fresh["order_index"],
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

    # Skipped when the rebuild was triggered by material changing rather than
    # by material arriving. Deleting a video cannot change what a vendor
    # publishes, so there is nothing to look up — and the freeze is not the
    # right thing to lean on here: a provisional module would otherwise have its
    # even split recomputed over a different number of domains, which is a
    # weight change caused by a deletion. Exactly what must not happen.
    weights_note = _settle_weights(module_id) if settle_weights else {"status": "skipped"}

    return {
        "weights": weights_note,
        "domain_count": created + updated + preserved,
        "created": created,
        "updated": updated,
        "preserved": preserved,
        "deleted": len(deletable),
        "protected_domains": protected,
        # Refused even under force — their questions are in a graded paper.
        "sat_exam_domains": sat_exam,
    }


def _weight_inputs(module_id: str) -> tuple[str, str, str]:
    """The module's title, and the best study guide it holds.

    Fetched here rather than threaded through `write_domains`, which is called
    from several places and has no business carrying weight-lookup arguments.

    "Best" is the largest PDF: a vendor study guide is the biggest thing in a
    typical module by a wide margin, and a guide that prints its weightings
    prints them near the front, so size is a good enough proxy for the file most
    likely to contain a blueprint table.
    """
    client = get_supabase()
    rows = (
        client.table("modules").select("title").eq("id", module_id).limit(1).execute()
    ).data or []
    title = (rows[0].get("title") if rows else "") or ""

    files = (
        client.table("user_files")
        .select("filename, extracted_text, char_count, source_type")
        .eq("module_id", module_id).eq("source_type", "pdf")
        .order("char_count", desc=True).limit(1).execute()
    ).data or []
    if not files:
        return title, "", ""
    return title, (files[0].get("extracted_text") or ""), (files[0].get("filename") or "")


def _settle_weights(module_id: str) -> dict[str, Any]:
    """Look the exam's weights up once, then leave them alone forever.

    Runs after the blueprint so the domains exist to attach weights to. Does
    nothing at all once a module holds a published or study-guide set — that is
    the freeze, and it is checked here rather than trusted to callers, because
    every import path ends up in this function.

    A provisional set is *not* frozen: it exists precisely so that uploading a
    study guide later can supersede it.
    """
    from app.services import exam_weights

    if not exam_weights.available():
        return {"status": "unavailable"}

    existing = exam_weights.current_source(module_id)
    if existing not in exam_weights.REPLACEABLE:
        logger.info(
            "Module %s already holds %s weights; leaving them alone.",
            module_id, existing,
        )
        return {"status": "frozen", "source": existing}

    module_title, guide_text, guide_name = _weight_inputs(module_id)
    weights = exam_weights.resolve(
        certification=module_title,
        module_title=module_title,
        guide_text=guide_text,
        guide_name=guide_name,
    )

    rows = (
        get_supabase().table("domains")
        .select("id, title, weight_pct, status")
        .eq("module_id", module_id).execute()
    ).data or []

    if weights.domains:
        written = exam_weights.apply_to_domains(module_id, weights, rows)
    else:
        # Provisional. The blueprint model's split is discarded rather than
        # kept: it is a guess that looks like a measurement, which is worse than
        # an obvious placeholder.
        written = exam_weights.even_split(module_id, rows)

    exam_weights.record(module_id, weights)
    logger.info(
        "Module %s weights settled as %s (%d domain(s) written): %s",
        module_id, weights.source, written, weights.citation,
    )
    return {
        "status": "set",
        "source": weights.source,
        "citation": weights.citation,
        "domains_written": written,
    }


# --- steps 2-8 --------------------------------------------------------------
def process_module(
    module_id: str, user_id: str, *, force: bool = False,
    settle_weights: bool = True,
) -> dict[str, Any]:
    """Run the full pipeline for one module. Safe to call in the background.

    ``force`` rebuilds the domain list outright, destroying generated content
    attached to domains that go away. Only pass it when the learner has
    explicitly confirmed — see ``write_domains``.

    ``settle_weights=False`` leaves the exam weights entirely alone. Pass it for
    a rebuild caused by material being *removed*: the plan needs re-deriving,
    the weights do not, and they are a property of the exam rather than of the
    sources — see ``exam_weights``.
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
        written = write_domains(
            module_id, user_id, result["domains"],
            force=force, settle_weights=settle_weights,
        )
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

        # The blueprint has just been redrawn and the sources reparsed, so any
        # coverage map is now about a module that no longer exists in that
        # shape. Rebuilding it here — while we are already off the request
        # thread — is what keeps the tutor's assessment instant later.
        from app.services import coverage

        coverage.ensure(module_id, user_id, force=True)

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

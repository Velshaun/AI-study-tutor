"""Job handlers for importing material.

The worker owns the loop; this owns what one item of an import actually does.
Kept out of `worker.py` so the loop stays about claiming and checkpointing, and
so these can be exercised without starting a worker at all.

One item is one pasted blob. It parses, it stores, and it records what it became
— and it never rebuilds the module, because twenty pasted sources must produce
one rebuild rather than twenty. That belongs in the finaliser, which runs once
after the last item.
"""

from __future__ import annotations

import logging
from typing import Any

from app.database import get_supabase
from app.services import ingest, imports, jobs

logger = logging.getLogger(__name__)

PASTE_KIND = "import_paste"


def handle_paste_item(job: dict[str, Any], item: dict[str, Any]) -> dict[str, Any]:
    """Parse one pasted source and store whatever it honestly is."""
    payload = item.get("payload") or {}
    text = payload.get("text") or ""
    declared = payload.get("content_type")
    title = payload.get("title") or "Pasted material"

    module_id = job.get("module_id")
    user_id = job.get("user_id")
    batch_id = (job.get("payload") or {}).get("batch_id") or job["id"]

    if not text.strip():
        # Nothing to work with. Permanent by definition — retrying an empty
        # paste will always be empty.
        from worker import PermanentFailure

        raise PermanentFailure("There was nothing in that paste to import.")

    jobs.checkpoint_item(item["id"], {"stage": "parsing", "chars": len(text)})
    result = ingest.parse(text, declared)

    jobs.checkpoint_item(item["id"], {"stage": "storing", "as": result.kind})
    summary = imports.store(
        module_id=module_id, user_id=user_id, title=title,
        result=result, batch_id=batch_id,
    )

    logger.info(
        "Imported %r into module %s as %s (%s)",
        title, module_id, result.kind, summary.get("note"),
    )
    # `declared` is echoed back so the UI can show where a label and the
    # material disagreed — the label decided the filing, and the parser decided
    # what was actually possible.
    return {**summary, "title": title, "declared": declared}


def finalise_import(job: dict[str, Any], items: list[dict[str, Any]]) -> None:
    """Rebuild the module's study plan — once, for the whole batch.

    Only if something actually landed. A batch where every item failed has
    changed nothing about the material, so re-deriving the blueprint would spend
    a Gemini call to arrive back where it started.

    Non-destructive by default: `process_module` preserves domains holding
    generated content, and refuses outright to drop one whose questions are in
    an exam that has already been sat.
    """
    module_id = job.get("module_id")
    user_id = job.get("user_id")
    if not module_id or not user_id:
        return

    landed = [i for i in items if i.get("status") == "succeeded"]
    if not landed:
        logger.info("Nothing landed for job %s; skipping the rebuild.", job["id"])
        return

    # Reference text is the only kind that changes the blueprint — flashcard
    # decks are their own locked domain and questions are an exam, neither of
    # which the domain map is derived from.
    added_material = any(
        (i.get("result") or {}).get("kind") == "reference" for i in landed
    )
    if not added_material:
        logger.info(
            "Job %s added no new source text; the study plan is unchanged.",
            job["id"],
        )
        return

    from app.services.pipeline import process_module

    logger.info("Rebuilding module %s once, after %d imported source(s).",
                module_id, len(landed))
    process_module(module_id, user_id)


def enqueue_paste_import(
    *, module_id: str, user_id: str, items: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """Stage a batch of pasted sources as one job.

    One job, many items: a batch never rolls back, so each source succeeds or
    fails on its own and `Retry Failed` re-queues only the failures — without
    the learner pasting anything a second time.
    """
    from uuid import uuid4

    batch_id = str(uuid4())
    return jobs.enqueue(
        user_id=user_id,
        module_id=module_id,
        kind=PASTE_KIND,
        payload={"batch_id": batch_id, "source_count": len(items)},
        items=[
            {
                "kind": "paste",
                "payload": {
                    "title": (i.get("title") or f"Pasted source {n + 1}")[:200],
                    "content_type": i.get("content_type"),
                    "text": i.get("text") or "",
                },
            }
            for n, i in enumerate(items)
        ],
    )


def module_of(module_id: str, user_id: str) -> dict[str, Any] | None:
    rows = (
        get_supabase().table("modules").select("id, title")
        .eq("id", module_id).eq("user_id", user_id).limit(1).execute()
    ).data or []
    return rows[0] if rows else None

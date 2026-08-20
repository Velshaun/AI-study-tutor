"""Job handlers for importing material.

The worker owns the loop; this owns what one item of an import actually does.
Kept out of `worker.py` so the loop stays about claiming and checkpointing, and
so these can be exercised without starting a worker at all.

One item is one source: a pasted blob, or one video's transcript. It parses or
fetches, files the result, and records what it became — and it never rebuilds
the module, because two hundred videos must produce one rebuild rather than two
hundred. That belongs in the finaliser, which runs once after the last item.

A playlist is the exception to "one item, one source": its first item is the
*listing*, which appends a child item per video to the job it is already part
of. A playlist's length isn't knowable until it has been listed, and the queue
would rather grow than hold three hundred videos in memory to enqueue at once.
"""

from __future__ import annotations

import logging
from typing import Any

from app.database import get_supabase
from app.services import domain_assign, ingest, imports, jobs, youtube
from app.services.extraction import ExtractionError, extract_youtube

logger = logging.getLogger(__name__)

PASTE_KIND = "import_paste"
YOUTUBE_KIND = "import_youtube"

# Below this share of a playlist fetched, the module stays "buffering" and no
# study plan is built. A blueprint derived from the first three videos of a
# forty-video course would be wrong in a way that is expensive to undo.
USABLE_THRESHOLD = 0.25


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


# --- YouTube ----------------------------------------------------------------
def handle_youtube_item(job: dict[str, Any], item: dict[str, Any]) -> dict[str, Any]:
    """Fetch one video's transcript, file it under a domain, store it.

    The listing of a playlist happens in its own item — the first one — which
    then appends a child item per video to the running job. A playlist's length
    isn't known until it has been listed, and holding two hundred videos in
    memory to enqueue them at once is the shape this queue exists to avoid.
    """
    from worker import PermanentFailure

    payload = item.get("payload") or {}
    kind = payload.get("target_kind")
    module_id, user_id = job.get("module_id"), job.get("user_id")
    batch_id = (job.get("payload") or {}).get("batch_id") or job["id"]

    if kind == "playlist":
        return _expand_playlist(job, item, payload)

    video_id = payload.get("video_id")
    title = payload.get("title") or f"YouTube video {video_id}"
    if not video_id:
        raise PermanentFailure("That item had no video to fetch.")

    jobs.checkpoint_item(item["id"], {"stage": "fetching transcript"})
    try:
        transcript = extract_youtube(youtube.watch_url(video_id))
    except ExtractionError as exc:
        # A video with no captions will never have any. Retrying it forever
        # would bury the transient failures that are worth retrying.
        raise PermanentFailure(str(exc)) from exc

    jobs.checkpoint_item(item["id"], {"stage": "filing", "chars": len(transcript)})
    module = module_of(module_id, user_id) or {}
    assignment = domain_assign.assign(
        module_id=module_id, user_id=user_id, title=title, text=transcript,
        subject=module.get("title") or "this subject",
    )

    stored = imports.store_reference(
        module_id=module_id, user_id=user_id, title=title, text=transcript,
        source_type="youtube",
    )
    if stored.get("source_id"):
        domain_assign.apply_to_source(stored["source_id"], assignment)
        _tag_source(stored["source_id"], batch_id, payload.get("parent_source_id"))

    return {
        "kind": "reference", "video_id": video_id, "title": title,
        "chars": len(transcript), "source_id": stored.get("source_id"),
        "domain_id": assignment.get("domain_id"),
        "confidence": assignment.get("confidence"),
        # Recorded, never surfaced — a later pass revisits the shaky ones.
        "low_confidence": assignment.get("low_confidence"),
        "note": f"Read {len(transcript):,} characters of transcript.",
    }


def _expand_playlist(
    job: dict[str, Any], item: dict[str, Any], payload: dict[str, Any],
) -> dict[str, Any]:
    """Turn a playlist into one child item per video, appended to this job."""
    from worker import PermanentFailure

    playlist_id = payload.get("playlist_id")
    if not playlist_id:
        raise PermanentFailure("That link had no playlist in it.")

    jobs.checkpoint_item(item["id"], {"stage": "listing the playlist"})
    try:
        videos = youtube.list_playlist(playlist_id)
    except youtube.YouTubeError as exc:
        raise PermanentFailure(str(exc)) from exc

    if not videos:
        raise PermanentFailure("That playlist had no videos we can read.")

    jobs.add_items(job["id"], [
        {
            "kind": "video",
            "parent_item_id": item["id"],
            "payload": {
                "target_kind": "video",
                "video_id": v["video_id"],
                "title": v["title"],
            },
        }
        for v in videos
    ])
    logger.info("Playlist %s expanded to %d video(s)", playlist_id, len(videos))
    return {"kind": "playlist", "videos": len(videos),
            "note": f"Found {len(videos)} videos."}


def _tag_source(source_id: str, batch_id: str, parent_source_id: str | None) -> None:
    """Record which import a source came from, where the schema allows it."""
    if not domain_assign.available():
        return
    patch: dict[str, Any] = {"import_batch_id": batch_id}
    if parent_source_id:
        patch["parent_source_id"] = parent_source_id
    get_supabase().table("user_files").update(patch).eq("id", source_id).execute()


def enqueue_youtube_import(
    *, module_id: str, user_id: str, target: dict[str, str], title: str | None = None,
) -> dict[str, Any] | None:
    """Queue a video or a playlist. A playlist starts as one item and grows."""
    from uuid import uuid4

    batch_id = str(uuid4())
    if target["kind"] == "playlist":
        items = [{
            "kind": "playlist",
            "payload": {"target_kind": "playlist", "playlist_id": target["id"],
                        "title": title or "YouTube playlist"},
        }]
    else:
        items = [{
            "kind": "video",
            "payload": {"target_kind": "video", "video_id": target["id"],
                        "title": title or f"YouTube video {target['id']}"},
        }]

    return jobs.enqueue(
        user_id=user_id, module_id=module_id, kind=YOUTUBE_KIND,
        payload={"batch_id": batch_id, "target": target, "title": title},
        items=items,
    )


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

    # A playlist that mostly failed shouldn't redraw the blueprint. A study plan
    # built from three videos of a forty-video course would be confidently wrong
    # about what the course covers, and undoing that costs more than waiting.
    # The listing item doesn't count as material — it fetched no transcript.
    material = [i for i in items if (i.get("payload") or {}).get("target_kind") != "playlist"]
    if material:
        usable = sum(1 for i in material if i.get("status") == "succeeded")
        share = usable / len(material)
        if share < USABLE_THRESHOLD:
            logger.info(
                "Job %s landed %d of %d (%.0f%%) — below the %.0f%% threshold, so "
                "the study plan is left alone.",
                job["id"], usable, len(material), share * 100,
                USABLE_THRESHOLD * 100,
            )
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

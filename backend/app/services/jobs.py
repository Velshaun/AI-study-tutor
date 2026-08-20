"""The durable job queue.

Long work in this app has until now been a FastAPI ``BackgroundTask``: it runs
in the web process, it has no name, and it disappears the moment Railway
redeploys. That is survivable for a generation the learner is watching. It is
not survivable for importing a playlist, where the work outlives several deploys
and the learner is expected to close the tab.

The shape follows from two of the decisions behind it:

**Resume, not retry.** A job is a list of items, each with its own status and
its own checkpoint. An interrupted job is *reclaimed*, not restarted, and only
its unfinished items run again — a playlist that got 120 of 200 transcripts
carries on at 121.

**Never roll back a batch.** An item that fails records why, and whether the why
is worth retrying. Everything that succeeded stays. `retry_failed` re-queues the
failures alone, so the learner never re-pastes or re-searches anything.

Claiming is a database function rather than Python because the backend reaches
Postgres through PostgREST, which cannot express ``FOR UPDATE SKIP LOCKED``.
Only one worker runs today; the locking is there so that turning on a second one
is a config change rather than a rewrite.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from app.database import get_supabase
from app.services import schema_features

logger = logging.getLogger(__name__)

# How long a claimed job may go without a heartbeat before another worker may
# take it. Comfortably longer than the heartbeat interval, so a slow item never
# looks like a dead worker.
STALE_AFTER = "00:05:00"

TERMINAL = ("succeeded", "failed", "cancelled")


def _client():
    return get_supabase()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def available() -> bool:
    """False until the migration lands, so the API deploys ahead of it."""
    return schema_features.has_column("jobs", "id")


# --- creating ---------------------------------------------------------------
def enqueue(
    *, user_id: str, kind: str, module_id: str | None = None,
    items: list[dict[str, Any]] | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Create a job and its items. Returns the job row, or None if unavailable.

    Items are written in one insert and carry their own position, so the order
    the learner pasted or the playlist listed is the order they are worked.
    """
    if not available():
        logger.warning("Job queue unavailable; %s was not enqueued", kind)
        return None

    client = _client()
    rows = (
        client.table("jobs").insert({
            "user_id": user_id,
            "module_id": module_id,
            "kind": kind,
            "payload": payload or {},
            "total_items": len(items or []),
        }).execute()
    ).data or []
    if not rows:
        return None
    job = rows[0]

    if items:
        client.table("job_items").insert([
            {
                "job_id": job["id"],
                "position": i,
                "kind": item.get("kind") or "item",
                "payload": item.get("payload") or {},
                "parent_item_id": item.get("parent_item_id"),
            }
            for i, item in enumerate(items)
        ]).execute()
    return job


def add_items(job_id: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Append items to a running job.

    A playlist's length isn't known until it has been listed, which happens
    inside the job — so the job starts with one item and grows.
    """
    if not available() or not items:
        return []
    client = _client()
    existing = (
        client.table("job_items").select("position")
        .eq("job_id", job_id).order("position", desc=True).limit(1).execute()
    ).data or []
    start = (existing[0]["position"] + 1) if existing else 0

    added = (
        client.table("job_items").insert([
            {
                "job_id": job_id,
                "position": start + i,
                "kind": item.get("kind") or "item",
                "payload": item.get("payload") or {},
                "parent_item_id": item.get("parent_item_id"),
            }
            for i, item in enumerate(items)
        ]).execute()
    ).data or []
    _recount(job_id)
    return added


# --- claiming ---------------------------------------------------------------
def claim(worker: str) -> dict[str, Any] | None:
    """Take the next job, or reclaim one whose worker stopped heartbeating."""
    if not available():
        return None
    try:
        result = _client().rpc(
            "claim_job", {"p_worker": worker, "p_stale_after": STALE_AFTER},
        ).execute()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not claim a job: %s", exc)
        return None

    rows = result.data or []
    if not rows:
        return None
    job = rows[0]
    # A reclaimed job may have items that were mid-flight when its previous
    # worker died. They are pending again, not lost — this is the whole of what
    # "resume rather than restart" means in practice.
    released = release_stuck_items(job["id"])
    if released:
        logger.info("Reclaimed job %s and released %d stuck item(s)",
                    job["id"], released)
    return job


def claim_item(job_id: str) -> dict[str, Any] | None:
    """Take the next unfinished item of a job."""
    if not available():
        return None
    try:
        result = _client().rpc("claim_job_item", {"p_job_id": job_id}).execute()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not claim an item of job %s: %s", job_id, exc)
        return None
    rows = result.data or []
    return rows[0] if rows else None


def release_stuck_items(job_id: str) -> int:
    """Put items left 'running' by a dead worker back in the queue."""
    if not available():
        return 0
    rows = (
        _client().table("job_items").update(
            {"status": "pending", "updated_at": _now()}
        ).eq("job_id", job_id).eq("status", "running").execute()
    ).data or []
    return len(rows)


def heartbeat(job_id: str, worker: str) -> None:
    """Say the worker is still alive. Silence for STALE_AFTER hands the job on."""
    if not available():
        return
    _client().table("jobs").update(
        {"heartbeat_at": _now(), "claimed_by": worker, "updated_at": _now()}
    ).eq("id", job_id).execute()


# --- progress ---------------------------------------------------------------
def checkpoint_item(item_id: str, checkpoint: dict[str, Any]) -> None:
    """Record how far an item got, so an interruption resumes rather than redoes."""
    if not available():
        return
    _client().table("job_items").update(
        {"checkpoint": checkpoint, "updated_at": _now()}
    ).eq("id", item_id).execute()


def complete_item(item_id: str, result: dict[str, Any] | None = None) -> None:
    if not available():
        return
    row = (
        _client().table("job_items").update({
            "status": "succeeded", "result": result or {},
            "error": None, "failure_kind": None, "updated_at": _now(),
        }).eq("id", item_id).execute()
    ).data or []
    if row:
        _recount(row[0]["job_id"])


def fail_item(item_id: str, error: str, *, permanent: bool = False) -> None:
    """Record a failure and whether it is worth trying again.

    The distinction is the point: a video with no transcript will never have
    one, and re-queueing it forever is noise. A timeout is worth another go.
    """
    if not available():
        return
    row = (
        _client().table("job_items").update({
            "status": "failed",
            "error": (error or "")[:1000],
            "failure_kind": "permanent" if permanent else "transient",
            "updated_at": _now(),
        }).eq("id", item_id).execute()
    ).data or []
    if row:
        _recount(row[0]["job_id"])


def _recount(job_id: str) -> dict[str, int]:
    """Recompute a job's tallies from its items.

    Derived rather than incremented: a counter nudged on each item drifts the
    moment anything is retried, and this is the number the learner watches.

    One database call, not two. Doing the same derivation in Python meant
    selecting every item and then updating the job — measured at 278ms of the
    366ms each item cost in bookkeeping, and it grows with the length of the
    playlist. As a single statement the accuracy is identical and the cost is
    one round trip.
    """
    try:
        rows = _client().rpc("recount_job", {"p_job_id": job_id}).execute().data or []
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not recount job %s: %s", job_id, exc)
        return {"total_items": 0, "completed_items": 0, "failed_items": 0}

    row = rows[0] if rows else {}
    return {
        "total_items": row.get("total_items") or 0,
        "completed_items": row.get("completed_items") or 0,
        "failed_items": row.get("failed_items") or 0,
    }


def finish(job_id: str, *, error: str | None = None) -> dict[str, Any] | None:
    """Close a job, deriving its outcome from what its items actually did.

    A job with some failures still succeeded — partial import is the designed
    behaviour, not a degraded one. Only a job where nothing worked is a failure.
    """
    if not available():
        return None
    counts = _recount(job_id)
    if error:
        status = "failed"
    elif counts["total_items"] and counts["completed_items"] == 0:
        status = "failed"
    else:
        status = "succeeded"

    rows = (
        _client().table("jobs").update({
            "status": status,
            "error": (error or "")[:1000] or None,
            "finished_at": _now(),
            "updated_at": _now(),
        }).eq("id", job_id).execute()
    ).data or []
    return rows[0] if rows else None


def retry_failed(job_id: str, *, transient_only: bool = False) -> int:
    """Re-queue a job's failed items, and the job with them.

    Nothing the learner supplied is asked for again: the items still hold their
    payloads, so a retry is a status change rather than a re-import.
    """
    if not available():
        return 0
    client = _client()
    query = client.table("job_items").update({
        "status": "pending", "error": None, "failure_kind": None,
        "updated_at": _now(),
    }).eq("job_id", job_id).eq("status", "failed")
    if transient_only:
        query = query.eq("failure_kind", "transient")
    rows = query.execute().data or []

    if rows:
        client.table("jobs").update({
            "status": "queued", "finished_at": None, "error": None,
            "claimed_by": None, "claimed_at": None, "heartbeat_at": None,
            "updated_at": _now(),
        }).eq("id", job_id).execute()
        _recount(job_id)
    return len(rows)


# --- reading ----------------------------------------------------------------
def get(job_id: str, user_id: str) -> dict[str, Any] | None:
    if not available():
        return None
    rows = (
        _client().table("jobs").select("*")
        .eq("id", job_id).eq("user_id", user_id).limit(1).execute()
    ).data or []
    return rows[0] if rows else None


def items(job_id: str) -> list[dict[str, Any]]:
    if not available():
        return []
    return (
        _client().table("job_items").select("*")
        .eq("job_id", job_id).order("position").execute()
    ).data or []


def active_for_module(module_id: str, user_id: str) -> list[dict[str, Any]]:
    """Jobs still running or queued for a module — what "buffering" is derived
    from, rather than a status flag on the module that can go stale if a worker
    dies mid-job."""
    if not available():
        return []
    return (
        _client().table("jobs").select("*")
        .eq("module_id", module_id).eq("user_id", user_id)
        .in_("status", ["queued", "running"])
        .order("created_at").execute()
    ).data or []

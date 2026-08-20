"""Rebuilding a module's study plan, once, after the dust settles.

Removing a source changes what the plan was derived from, so the plan has to be
re-derived. Doing that per deletion is wrong twice over: deleting four videos
would spend four Gemini calls to arrive at one answer, and the three
intermediate blueprints would each briefly be the module's real study plan.

So a change doesn't trigger a rebuild, it sets a *deadline*. Every further
change pushes the deadline out, and the worker rebuilds whatever is due. The
debounce is a consequence of the shape rather than a mechanism of its own:
there is no timer to cancel, nothing is lost to a redeploy, and a learner
clearing out twenty videos gets one rebuild after they stop.

Weights are deliberately left alone. They are a property of the exam, not of the
material — `exam_weights` exists to say so — and deleting a video cannot change
what a vendor publishes. A rebuild triggered from here therefore skips the
weight lookup entirely rather than relying on the freeze to hold.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from app.database import get_supabase
from app.services import schema_features

logger = logging.getLogger(__name__)

# How long to wait after the last change. Long enough to cover someone working
# through a list of sources deleting several, short enough that the plan isn't
# stale by the time they look at it.
DEBOUNCE_SECS = 60


def available() -> bool:
    return schema_features.has_column("modules", "rebuild_after")


def schedule(module_id: str, *, reason: str = "") -> bool:
    """Mark a module as needing a rebuild, `DEBOUNCE_SECS` from now.

    Unconditional rather than "only if not already scheduled": pushing the
    deadline out on every change is exactly what makes this a debounce. A
    learner still deleting has not finished changing the material.
    """
    if not available():
        return False
    due = datetime.now(timezone.utc) + timedelta(seconds=DEBOUNCE_SECS)
    get_supabase().table("modules").update(
        {"rebuild_after": due.isoformat()}
    ).eq("id", module_id).execute()
    logger.info(
        "Module %s scheduled for rebuild in %ds%s",
        module_id, DEBOUNCE_SECS, f" ({reason})" if reason else "",
    )
    return True


def cancel(module_id: str) -> None:
    """Clear a pending rebuild — used once one has actually run."""
    if not available():
        return
    get_supabase().table("modules").update(
        {"rebuild_after": None}
    ).eq("id", module_id).execute()


def due(limit: int = 5) -> list[dict[str, Any]]:
    """Modules whose deadline has passed."""
    if not available():
        return []
    now = datetime.now(timezone.utc).isoformat()
    return (
        get_supabase().table("modules")
        .select("id, user_id, title, rebuild_after")
        .not_.is_("rebuild_after", "null")
        .lte("rebuild_after", now)
        .order("rebuild_after")
        .limit(limit)
        .execute()
    ).data or []


def run_due(limit: int = 5) -> int:
    """Rebuild every module that is due. Returns how many ran.

    The deadline is cleared *before* the rebuild rather than after, so a rebuild
    that crashes doesn't leave the module due forever and re-run on every poll.
    Losing one rebuild is recoverable — the next deletion schedules another, and
    the learner can force one — while a crash loop is not.
    """
    ran = 0
    for module in due(limit):
        module_id, user_id = module["id"], module.get("user_id")
        if not user_id:
            cancel(module_id)
            continue

        cancel(module_id)
        try:
            # Imported here: pipeline imports half the service layer, and the
            # worker's poll loop shouldn't pay for that on every tick.
            from app.services.pipeline import process_module

            logger.info("Rebuilding module %s (%s) — sources changed.",
                        module_id, module.get("title") or "untitled")
            process_module(module_id, user_id, settle_weights=False)
            ran += 1
        except Exception:  # noqa: BLE001 — one bad module must not stop the rest
            logger.exception("Scheduled rebuild failed for module %s", module_id)
    return ran

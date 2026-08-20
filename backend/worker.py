"""The background worker.

A second Railway process whose whole job is to take rows off the queue and do
what they say. It exists because a FastAPI ``BackgroundTask`` lives inside the
web process and dies with it, and importing a playlist has to outlive several
redeploys.

Three things shape the loop:

**It never stops polling.** Adaptive, not fixed: brisk while there is work,
dropping to a slow heartbeat once the queue has been quiet for a minute. Never
zero, because jobs are queued by things other than a user action and a failed
job needs picking up eventually.

**One job at a time, its items in parallel.** The item concurrency is a config
value rather than a constant — the ceiling that keeps an upstream API happy is
only discoverable in production, and lowering it should not need a deploy.

**Interruption is expected.** A redeploy mid-job is normal, not exceptional.
SIGTERM stops the loop taking new work and lets the current items finish; if the
process dies harder than that, the job's heartbeat goes stale and the next
worker reclaims it, re-running only the unfinished items.

Handlers register themselves in ``HANDLERS`` by job kind. Import handlers arrive
with the phases that need them; the only one here today is ``ping``, which is a
permanent production health check rather than scaffolding — see below.
"""

from __future__ import annotations

import logging
import os
import random
import signal
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from app.config import settings
from app.services import jobs

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("worker")

# One item of work. Returns a result dict on success; raising decides the
# failure. Raise `PermanentFailure` for something retrying will never fix.
ItemHandler = Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]

# {job kind: handler}. Import handlers register here as later phases add them.
HANDLERS: dict[str, ItemHandler] = {}


# --- permanent production health check --------------------------------------
# NOT test scaffolding. Do not delete.
#
# A queue you cannot exercise in production is one you find out about from a
# user. This job kind is the smallest thing that proves the whole chain is alive
# — that the worker is running, that it can reach Supabase, that it can claim a
# job and an item, checkpoint mid-flight, and close the job out — without
# touching a learner's data or spending anything at an upstream API.
#
# Enqueue one with `jobs.enqueue(kind="ping", items=[{"payload": {}}])` after a
# deploy, or on a schedule. It is deliberately dull: if it ever stops
# succeeding, something real is broken.
PING_KIND = "ping"
PING_MAX_SLEEP_SECS = 10.0


def handle_ping(job: dict[str, Any], item: dict[str, Any]) -> dict[str, Any]:
    """Sleep briefly, checkpointing on the way, and report what ran it.

    The sleep is what makes the checkpoint meaningful: it leaves a window in
    which the item is genuinely mid-flight, so killing the worker here is a real
    test of resume rather than a formality.
    """
    payload = item.get("payload") or {}
    seconds = max(0.0, min(float(payload.get("sleep_secs", 1.0)), PING_MAX_SLEEP_SECS))
    started = time.time()

    jobs.checkpoint_item(item["id"], {"stage": "sleeping", "for_secs": seconds})
    time.sleep(seconds)
    jobs.checkpoint_item(item["id"], {"stage": "done", "for_secs": seconds})

    return {
        "ok": True,
        "slept_secs": round(time.time() - started, 3),
        "worker": f"{socket.gethostname()}:{os.getpid()}",
    }


HANDLERS[PING_KIND] = handle_ping


class PermanentFailure(RuntimeError):
    """This item will never succeed — a video with no transcript, say.

    Separated from an ordinary exception so `Retry Failed` can re-queue the
    timeouts without also re-queueing the impossible.
    """


class Worker:
    def __init__(self) -> None:
        # Identifies the claim in the jobs table. The hostname is what Railway
        # shows, so a stuck job can be traced to the container that held it.
        self.name = f"{socket.gethostname()}:{os.getpid()}"
        self.stopping = threading.Event()
        self.last_work_at = 0.0

    # --- lifecycle ---------------------------------------------------------
    def stop(self, signum: int, _frame: Any) -> None:
        logger.info("Signal %s received — finishing the current job, then stopping.",
                    signum)
        self.stopping.set()

    def run(self) -> None:
        # Best-effort: `signal.signal` only works on the main thread, and this
        # raising there took the whole loop down before it polled once — with no
        # log, because it happened before the first one. Losing the graceful
        # stop costs a job being reclaimed instead of resumed cleanly; losing
        # the worker costs everything.
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                signal.signal(sig, self.stop)
            except (ValueError, OSError, AttributeError) as exc:
                logger.warning("Could not install a %s handler: %s", sig, exc)

        if not jobs.available():
            logger.error(
                "The jobs tables are not present in this database. The worker has "
                "nothing to poll; apply the queue migration and restart."
            )
            return

        logger.info(
            "Worker %s started. Item concurrency %d, polling %.0fs busy / %.0fs idle.",
            self.name, settings.worker_item_concurrency,
            settings.worker_poll_busy_secs, settings.worker_poll_idle_secs,
        )

        while not self.stopping.is_set():
            worked = False
            try:
                worked = self.tick()
            except Exception:  # noqa: BLE001 — the loop outlives any one failure
                logger.exception("Worker tick failed; continuing")

            if worked:
                self.last_work_at = time.monotonic()
            self.sleep(worked)

        logger.info("Worker %s stopped.", self.name)

    def sleep(self, worked: bool) -> None:
        """Adaptive wait. Jittered so several workers don't wake in lockstep."""
        quiet_for = time.monotonic() - self.last_work_at
        if worked or quiet_for < settings.worker_idle_after_secs:
            delay = settings.worker_poll_busy_secs
        else:
            delay = settings.worker_poll_idle_secs
        self.stopping.wait(delay * random.uniform(0.85, 1.15))

    # --- one pass ----------------------------------------------------------
    def tick(self) -> bool:
        """Claim a job and run it, or return False having found nothing."""
        self.housekeeping()

        job = jobs.claim(self.name)
        if not job:
            return False

        kind = job.get("kind") or ""
        logger.info("Claimed job %s (%s)", job["id"], kind)

        handler = HANDLERS.get(kind)
        if handler is None:
            # An unknown kind is a deploy problem, not a data problem: fail the
            # job loudly rather than leaving it to be reclaimed forever by every
            # worker that starts up.
            logger.error("No handler registered for job kind %r", kind)
            jobs.finish(job["id"], error=f"No handler for job kind '{kind}'.")
            return True

        self.run_job(job, handler)
        return True

    def run_job(self, job: dict[str, Any], handler: ItemHandler) -> None:
        job_id = job["id"]
        beat = self.start_heartbeat(job_id)
        try:
            with ThreadPoolExecutor(
                max_workers=max(1, settings.worker_item_concurrency)
            ) as pool:
                running: set[Any] = set()
                while not self.stopping.is_set():
                    # Top the pool up rather than batching: an item that lands
                    # early frees its slot immediately, so a slow transcript
                    # never holds four others behind it.
                    while len(running) < settings.worker_item_concurrency:
                        item = jobs.claim_item(job_id)
                        if not item:
                            break
                        running.add(pool.submit(self.run_item, job, item, handler))
                    if not running:
                        break
                    done = {f for f in running if f.done()}
                    if not done:
                        time.sleep(0.2)
                        continue
                    running -= done

            if self.stopping.is_set():
                # Leave the job claimed and unfinished. Its heartbeat will go
                # stale and the next worker resumes it from the first item that
                # never ran — which is the whole point of the design.
                logger.info("Stopping mid-job %s; it will be resumed.", job_id)
                return

            final = jobs.finish(job_id)
            logger.info(
                "Job %s finished as %s (%s/%s done, %s failed)",
                job_id, (final or {}).get("status"),
                (final or {}).get("completed_items"),
                (final or {}).get("total_items"),
                (final or {}).get("failed_items"),
            )
        finally:
            beat.set()

    def run_item(
        self, job: dict[str, Any], item: dict[str, Any], handler: ItemHandler,
    ) -> None:
        try:
            result = handler(job, item)
            jobs.complete_item(item["id"], result or {})
        except PermanentFailure as exc:
            logger.info("Item %s permanently failed: %s", item["id"], exc)
            jobs.fail_item(item["id"], str(exc), permanent=True)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Item %s failed: %s", item["id"], exc)
            jobs.fail_item(item["id"], str(exc), permanent=False)

    # --- heartbeat and housekeeping ----------------------------------------
    def start_heartbeat(self, job_id: str) -> threading.Event:
        """Say the job is alive until told to stop.

        A background thread rather than a beat between items: an item can take
        minutes, and silence for that long is indistinguishable from a dead
        container.
        """
        done = threading.Event()

        def beat() -> None:
            while not done.wait(settings.worker_heartbeat_secs):
                try:
                    jobs.heartbeat(job_id, self.name)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Heartbeat failed for job %s: %s", job_id, exc)

        threading.Thread(target=beat, daemon=True, name=f"beat:{job_id}").start()
        return done

    def housekeeping(self) -> None:
        """Periodic tidying that has no other home.

        The worker's tick is the only thing in this system that runs on a
        schedule, so timed cleanup lives here rather than in pg_cron. Empty
        until the staging table it will sweep exists.
        """
        return


if __name__ == "__main__":
    Worker().run()

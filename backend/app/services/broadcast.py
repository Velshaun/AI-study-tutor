"""In-process pub/sub so SSE clients see generation deltas in real time.

§4.4 streams lecture text to the frontend as Gemini produces it. Generation runs
in a background worker thread; the SSE endpoint runs in the event loop. This
module is the bridge: the worker publishes deltas, and any connected reader
receives them on an asyncio queue.

Deliberately in-process. It is a *live* channel only — every delta is also
persisted to ``lectures.transcript``, so a client that connects late or
reconnects after a drop replays from the database and then joins the live feed.
Nothing is lost if this layer misses an event.

The single-process limitation matters only if the backend is ever run with
multiple workers (``uvicorn --workers N``), where a reader may land on a
different process than the generator. The database replay keeps that correct,
just not instantaneous — the reader falls back to polling.
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from typing import Any

logger = logging.getLogger(__name__)

# Bounded so a stalled reader can't grow memory without limit; on overflow the
# oldest delta is dropped and the reader recovers via the persisted transcript.
QUEUE_MAXSIZE = 512

_subscribers: dict[str, set[asyncio.Queue]] = defaultdict(set)
_lock = asyncio.Lock()
_loop: asyncio.AbstractEventLoop | None = None


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Record the event loop that worker threads should publish into."""
    global _loop
    _loop = loop


async def subscribe(channel: str) -> asyncio.Queue:
    """Register a reader for a channel."""
    queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAXSIZE)
    async with _lock:
        _subscribers[channel].add(queue)
    return queue


async def unsubscribe(channel: str, queue: asyncio.Queue) -> None:
    """Drop a reader, cleaning up the channel when it empties."""
    async with _lock:
        _subscribers[channel].discard(queue)
        if not _subscribers[channel]:
            _subscribers.pop(channel, None)


def publish(channel: str, event: dict[str, Any]) -> None:
    """Publish an event from any thread.

    Safe to call from the generation worker: the put is marshalled onto the
    event loop. A no-op when nobody is listening.
    """
    loop = _loop
    if loop is None or loop.is_closed():
        return

    def _deliver() -> None:
        for queue in list(_subscribers.get(channel, ())):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                # Reader is behind; it will recover from the stored transcript.
                logger.debug("Dropping delta for %s — subscriber queue full", channel)

    try:
        loop.call_soon_threadsafe(_deliver)
    except RuntimeError:  # loop shutting down
        pass


def has_subscribers(channel: str) -> bool:
    return bool(_subscribers.get(channel))

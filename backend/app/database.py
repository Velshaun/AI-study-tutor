"""Supabase client access for the backend.

The backend talks to Supabase with the **service role key**, which bypasses
Row Level Security. Never expose this key to the frontend. User identity is
still verified per-request by validating the caller's JWT (see
``app.routers.auth.get_current_user``); the service-role client is then used to
read/write on their behalf after that check.
"""

from __future__ import annotations

import threading

from app.config import settings

# One client per thread rather than one per process.
#
# The supabase-py sync client wraps a single httpx.Client with its own
# connection pool. FastAPI runs sync endpoints and BackgroundTasks on a
# threadpool, so a process-wide singleton means the ingestion pipeline and a
# concurrent status poll share one pool — which races, surfacing on Windows as:
#
#     httpx.ReadError: [WinError 10035] A non-blocking socket operation
#                      could not be completed immediately
#
# Thread-local clients keep each thread's pool to itself. There are only a
# handful of worker threads, so the extra connections are cheap.
_local = threading.local()


def get_supabase():
    """Return this thread's service-role Supabase client, creating it if needed.

    Raises ``RuntimeError`` if the required environment variables are missing so
    callers can surface a clear 503 instead of a low-level import error.
    """
    if not settings.supabase_url or not settings.supabase_service_role_key:
        raise RuntimeError(
            "Supabase is not configured. Set SUPABASE_URL and "
            "SUPABASE_SERVICE_ROLE_KEY in your environment."
        )

    client = getattr(_local, "client", None)
    if client is None:
        # Imported lazily so the module loads even before the dependency is present.
        from supabase import Client, create_client

        client = create_client(
            settings.supabase_url,
            settings.supabase_service_role_key,
        )
        _local.client = client
    return client


def supabase():
    """Convenience accessor: ``from app.database import supabase``."""
    return get_supabase()

"""Is an optional column present in this deployment's schema?

New study features sometimes need a new column, and the API deploys before
anyone runs the migration. Writing a column that doesn't exist is a hard error
from PostgREST, which would take down flashcard and practice generation
entirely — a far worse outcome than the new feature simply lying dormant.

So optional columns are probed once per process and remembered. Callers strip
them from their payload when unsupported; readers use ``row.get(...)`` and get
an empty value either way. When the migration lands, a restart (or the next
cold start, which a deploy causes anyway) picks it up.
"""

from __future__ import annotations

import logging

from app.database import get_supabase

logger = logging.getLogger(__name__)

_cache: dict[tuple[str, str], bool] = {}


def has_column(table: str, column: str) -> bool:
    """True if ``table.column`` exists. Probed once, then cached."""
    key = (table, column)
    if key in _cache:
        return _cache[key]

    try:
        get_supabase().table(table).select(column).limit(1).execute()
        supported = True
    except Exception as exc:  # noqa: BLE001 — a missing column is the point
        supported = False
        logger.warning(
            "%s.%s is unavailable, so that feature stays dormant here: %s",
            table, column, exc,
        )
    _cache[key] = supported
    return supported


def strip_unsupported(table: str, rows: list[dict], *columns: str) -> list[dict]:
    """Drop optional columns this deployment's schema doesn't have yet."""
    missing = [c for c in columns if not has_column(table, c)]
    if not missing:
        return rows
    return [{k: v for k, v in row.items() if k not in missing} for row in rows]


def reset_cache() -> None:
    """Forget what was probed — for tests, and after a migration in-process."""
    _cache.clear()

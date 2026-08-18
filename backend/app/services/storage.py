"""Supabase Storage + ``user_files`` bookkeeping — spec §4.3 step 1.

Uploaded bytes go to the private ``sources`` bucket under ``<user_id>/<module_id>/``
so the storage RLS policies (which key off the first path segment) line up with
row ownership. Every source — uploaded file or pasted link — gets a ``user_files``
row, which is also where step 2 parks the parsed text.
"""

from __future__ import annotations

import mimetypes
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from app.config import settings
from app.database import get_supabase

# Extensions we can actually parse in step 2, owned by the extraction module.
# Uploads outside this set are rejected at the edge rather than failing later
# inside the background pipeline.
from app.services.extraction import (  # noqa: F401 - re-exported for callers
    AUDIO_EXTS,
    IMAGE_EXTS,
    PDF_EXTS,
    SUPPORTED_EXTS,
    TEXT_EXTS,
    VIDEO_EXTS,
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def safe_filename(name: str) -> str:
    """Reduce an arbitrary upload name to something safe for an object key.

    Storage keys are URL path segments, so non-ASCII and separators are stripped
    rather than escaped — the original name is kept in the ``filename`` column.
    """
    name = unicodedata.normalize("NFKD", name or "")
    name = name.encode("ascii", "ignore").decode("ascii")
    name = name.replace("\\", "/").rsplit("/", 1)[-1]
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._")
    return (name or "upload")[:120]


def detect_source_type(filename: str, content_type: str | None = None) -> str:
    """Classify an upload into the parser that should handle it.

    The extension decides first and the browser's content type is the fallback,
    because phones are inconsistent about what they report — a photo picked on
    iOS can arrive as ``application/octet-stream`` with a real extension, or as
    ``image/jpeg`` with no extension at all.
    """
    ext = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""
    mime = (content_type or "").lower()

    if ext in PDF_EXTS or mime.startswith("application/pdf"):
        return "pdf"
    if ext in IMAGE_EXTS or mime.startswith("image/"):
        return "image"
    # Video before audio: a screen recording carries its content on screen, and
    # the video path transcribes any narration as well, so nothing is lost.
    if ext in VIDEO_EXTS or mime.startswith("video/"):
        return "video"
    if ext in AUDIO_EXTS or mime.startswith("audio/"):
        return "audio"
    if ext in TEXT_EXTS or mime.startswith("text/"):
        return "text"
    return "unknown"


def upload_source_file(
    *,
    user_id: str,
    module_id: str,
    filename: str,
    data: bytes,
    content_type: str | None = None,
) -> dict[str, Any]:
    """Store bytes in the sources bucket and create the ``user_files`` row.

    Returns the inserted row. The object key is prefixed with a uuid so two
    uploads of the same filename don't collide.
    """
    client = get_supabase()
    clean = safe_filename(filename)
    key = f"{user_id}/{module_id}/{uuid4().hex}_{clean}"
    mime = content_type or mimetypes.guess_type(clean)[0] or "application/octet-stream"

    client.storage.from_(settings.storage_bucket).upload(
        path=key,
        file=data,
        # storage3 requires header-style string values here.
        file_options={"content-type": mime, "upsert": "false"},
    )

    row = {
        "user_id": user_id,
        "module_id": module_id,
        "filename": filename[:255],
        "storage_path": key,
        "mime_type": mime,
        "size_bytes": len(data),
        "source_type": detect_source_type(clean, content_type),
        "status": "pending",
    }
    inserted = client.table("user_files").insert(row).execute()
    return (inserted.data or [row])[0]


def record_link_source(
    *,
    user_id: str,
    module_id: str,
    url: str,
    source_type: str,
) -> dict[str, Any]:
    """Create a ``user_files`` row for a link source (no bytes in Storage)."""
    client = get_supabase()
    row = {
        "user_id": user_id,
        "module_id": module_id,
        "filename": url[:255],
        "storage_path": "",
        "source_type": source_type,
        "source_url": url,
        "status": "pending",
    }
    inserted = client.table("user_files").insert(row).execute()
    return (inserted.data or [row])[0]


def download_source_file(storage_path: str) -> bytes:
    """Pull an object's bytes back out of the bucket for parsing."""
    client = get_supabase()
    return client.storage.from_(settings.storage_bucket).download(storage_path)


def signed_url(storage_path: str, expires_in: int | None = None) -> str | None:
    """Mint a time-limited URL so the frontend can fetch a private object."""
    if not storage_path:
        return None
    client = get_supabase()
    result = client.storage.from_(settings.storage_bucket).create_signed_url(
        storage_path, expires_in or settings.signed_url_ttl_secs
    )
    if isinstance(result, dict):
        return result.get("signedURL") or result.get("signedUrl")
    return None


def mark_parsed(file_id: str, text: str) -> None:
    """Record step 2's output against the source row."""
    get_supabase().table("user_files").update(
        {
            "extracted_text": text,
            "char_count": len(text),
            "status": "parsed",
            "error_message": None,
            "parsed_at": _now().isoformat(),
        }
    ).eq("id", file_id).execute()


def mark_failed(file_id: str, message: str) -> None:
    """Record a parse failure without aborting the rest of the batch."""
    get_supabase().table("user_files").update(
        {"status": "failed", "error_message": message[:1000]}
    ).eq("id", file_id).execute()


def list_module_sources(module_id: str) -> list[dict[str, Any]]:
    """Every source row attached to a module, oldest first."""
    result = (
        get_supabase()
        .table("user_files")
        .select("*")
        .eq("module_id", module_id)
        .order("created_at")
        .execute()
    )
    return result.data or []


def delete_source(file_id: str) -> None:
    """Remove a source row and its stored object, if any."""
    client = get_supabase()
    existing = (
        client.table("user_files")
        .select("storage_path")
        .eq("id", file_id)
        .limit(1)
        .execute()
    )
    rows = existing.data or []
    path = rows[0].get("storage_path") if rows else None
    if path:
        try:
            client.storage.from_(settings.storage_bucket).remove([path])
        except Exception:  # noqa: BLE001 - orphaned object must not block delete
            pass
    client.table("user_files").delete().eq("id", file_id).execute()

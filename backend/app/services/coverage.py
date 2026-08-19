"""The source coverage map: what the uploaded material actually covers.

The tutor's assessment used to read a 60,000-character sample — 6,000 from each
source and then a hard stop. That is fine for a page of notes and dishonest for
a textbook: a domain taught thoroughly in chapter nine reads as missing, and the
learner is told to go and find material they already uploaded.

So the material is read in full instead, once, and the result is kept. Each
source is split into overlapping chunks; each chunk is judged against the exam
blueprint on its own; the per-chunk findings are aggregated into one map. The
tutor then answers from the map, which makes an assessment a single cheap call
however large the pack is, and makes it as accurate for a 2MB pack as for a
20KB one.

Two things are deliberately not left to the model. Whether a domain counts as
covered is decided here, from how many chunks reported it and how deeply — a
model shown one chunk cannot judge breadth across a pack it never saw. And a
pack larger than the reader's ceiling records that it was truncated, because a
cap that hides itself is worse than no cap.
"""

from __future__ import annotations

import hashlib
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

from app.config import settings
from app.database import get_supabase
from app.services import schema_features
from app.services.domains import _generate, quota_hint

logger = logging.getLogger(__name__)


class CoverageError(RuntimeError):
    """The coverage map could not be built."""


# A chunk is large enough that a domain's treatment usually sits inside one, and
# small enough to leave the model room to think about it.
CHUNK_CHARS = 50_000
# Carried into the next chunk so a sentence — or a heading and the paragraph
# under it — is never split across the boundary and lost to both sides.
CHUNK_OVERLAP = 500
# The ceiling on one recompute: 60 x 50k is roughly 3M characters, several
# textbooks' worth. Reaching it is recorded, not hidden — see `truncated`.
MAX_CHUNKS = 60
# Concurrent chunk passes. Kept low: Gemini's free tier limits requests per
# minute, and a burst that trips it costs more in backoff than it saves.
CHUNK_WORKERS = 4

COVERAGE_LEVELS = ("well_covered", "partial", "missing")
# Ordered weakest to strongest — the ordering is what the aggregation rule uses.
DEPTHS = ("none", "mention", "overview", "thorough")

CHUNK_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "domains": {
            "type": "array",
            "description": (
                "One entry per exam domain this passage genuinely covers. Omit "
                "domains the passage does not touch — an absent domain means "
                "'not in this passage', which is the common case."
            ),
            "items": {
                "type": "object",
                "properties": {
                    "index": {
                        "type": "integer",
                        "description": "The domain's number, as listed in the blueprint.",
                    },
                    "depth": {
                        "type": "string",
                        "description": (
                            "mention — named in passing, nothing taught. "
                            "overview — explained, but briefly or partially. "
                            "thorough — taught well enough to answer exam "
                            "questions from."
                        ),
                    },
                    "topics": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "The specific topics from this domain the passage "
                            "covers, named as the passage names them."
                        ),
                    },
                },
                "required": ["index", "depth", "topics"],
            },
        },
    },
    "required": ["domains"],
}


def _client():
    return get_supabase()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def available() -> bool:
    """False where the migration hasn't run, so the tutor falls back cleanly."""
    return schema_features.has_column("coverage_maps", "id")


# --- chunking ---------------------------------------------------------------
def chunk_text(
    text: str, *, size: int = CHUNK_CHARS, overlap: int = CHUNK_OVERLAP,
) -> list[str]:
    """Split into overlapping chunks, cutting at a boundary where there is one.

    The cut is nudged back to the nearest paragraph or sentence end within the
    overlap window, so a chunk rarely begins mid-sentence. The overlap is kept
    regardless: a heading and the paragraph it introduces belong together, and
    the cheapest way to guarantee that is to send both twice.
    """
    text = (text or "").strip()
    if not text:
        return []
    if len(text) <= size:
        return [text]

    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + size, len(text))
        if end < len(text):
            window_start = max(start, end - overlap)
            window = text[window_start:end]
            for marker in ("\n\n", ". ", "\n"):
                cut = window.rfind(marker)
                if cut != -1:
                    end = window_start + cut + len(marker)
                    break
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(text):
            break
        start = max(end - overlap, start + 1)
    return chunks


def _source_chunks(sources: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], bool]:
    """Every parsed source, chunked and tagged with the file it came from.

    Returns the chunks and whether the ceiling cut the pack short. Sources are
    taken largest first, so if the ceiling does bite it takes the tail of the
    biggest document rather than dropping smaller sources wholesale.
    """
    parsed = [
        s for s in sources
        if s.get("status") == "parsed" and (s.get("extracted_text") or "").strip()
    ]
    parsed.sort(key=lambda s: len(s.get("extracted_text") or ""), reverse=True)

    chunks: list[dict[str, Any]] = []
    truncated = False
    for source in parsed:
        filename = source.get("filename") or "untitled"
        for piece in chunk_text(source.get("extracted_text") or ""):
            if len(chunks) >= MAX_CHUNKS:
                truncated = True
                break
            chunks.append({"filename": filename, "text": piece})
        if truncated:
            break
    return chunks, truncated


# --- freshness --------------------------------------------------------------
def fingerprint(sources: list[dict[str, Any]], domains: list[dict[str, Any]]) -> str:
    """Identify the inputs a map was built from.

    Both halves matter. New or deleted sources obviously invalidate it, but so
    does a re-ingestion that redraws the blueprint: coverage of a domain that no
    longer exists is not coverage of anything.
    """
    parts = sorted(
        f"{s.get('id') or s.get('filename')}:{s.get('status')}:"
        f"{s.get('char_count') or len(s.get('extracted_text') or '')}"
        for s in sources
    )
    parts += sorted(
        f"{d.get('id')}:{d.get('title')}:{round(float(d.get('weight_pct') or 0), 2)}"
        for d in domains
    )
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def is_fresh(row: dict[str, Any] | None, expected: str) -> bool:
    """True when a stored map still describes the module as it stands now."""
    if not row or row.get("status") != "ready":
        return False
    stored = row.get("fingerprint") or ""
    return bool(stored) and stored == expected


# A read that has claimed to be running for longer than this isn't. Background
# tasks die with the process, and a redeploy mid-read would otherwise leave a
# row saying 'computing' that nothing ever finishes or replaces.
STALLED_AFTER_SECS = 1800


def is_stalled(row: dict[str, Any] | None) -> bool:
    """True for a 'computing' row whose reader is plainly gone."""
    if not row or row.get("status") != "computing":
        return False
    stamp = row.get("updated_at") or row.get("created_at")
    if not stamp:
        return True
    try:
        started = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return True
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - started).total_seconds() > STALLED_AFTER_SECS


# --- the per-chunk pass -----------------------------------------------------
def _blueprint(domains: list[dict[str, Any]]) -> str:
    return "\n".join(
        f"{i + 1}. {d.get('title')} "
        f"({round(float(d.get('weight_pct') or 0))}% of the exam)"
        + (f" — {d['description']}" if d.get("description") else "")
        for i, d in enumerate(domains)
    )


def _assess_chunk(
    subject: str, blueprint: str, domain_count: int, chunk: dict[str, Any],
) -> list[dict[str, Any]]:
    """Which blueprint domains this one passage covers, and how deeply."""
    from google.genai import types

    prompt = (
        f"You are indexing study material for {subject} against the official "
        "exam blueprint.\n\n"
        "Below is ONE PASSAGE from a larger set of uploaded material. Decide "
        "which blueprint domains this passage covers.\n\n"
        "- Judge only this passage. You are not seeing the whole pack, so do "
        "not guess at what the rest contains, and do not penalise this passage "
        "for what it leaves out.\n"
        "- Return an entry only for a domain the passage genuinely teaches or "
        "discusses. Omitting a domain is the normal outcome; most passages "
        "touch one or two.\n"
        "- depth is about this passage alone: 'mention' if the topic is only "
        "named, 'overview' if explained briefly or partially, 'thorough' if "
        "taught well enough to answer exam questions from.\n"
        "- topics must be specific, and drawn from the passage itself rather "
        "than from the blueprint's wording.\n"
        "- British spelling.\n\n"
        f"--- EXAM BLUEPRINT (domains 1-{domain_count}) ---\n{blueprint}\n\n"
        f"--- PASSAGE (from {chunk['filename']}) ---\n{chunk['text']}"
    )

    response = _generate(
        "coverage-chunk",
        model=settings.gemini_model,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=CHUNK_SCHEMA,
            temperature=0.1,
        ),
    )
    data = json.loads(response.text)

    found: list[dict[str, Any]] = []
    for item in data.get("domains") or []:
        try:
            index = int(item.get("index"))
        except (TypeError, ValueError):
            continue
        if not 1 <= index <= domain_count:
            continue
        depth = (item.get("depth") or "").strip().lower()
        if depth not in DEPTHS or depth == "none":
            depth = "mention"
        found.append({
            "index": index - 1,
            "depth": depth,
            "topics": [
                str(t).strip()[:120]
                for t in (item.get("topics") or []) if str(t).strip()
            ][:8],
            "filename": chunk["filename"],
        })
    return found


# --- aggregation ------------------------------------------------------------
def _aggregate(
    domains: list[dict[str, Any]], findings: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Turn per-chunk findings into one verdict per domain.

    The rule is deliberately mechanical rather than another model call. Breadth
    is evidence no single chunk can see: a domain explained at overview depth in
    one passage of a textbook is thinner than the same depth reached in five
    passages spread across it. And a bare mention is not coverage, however
    confidently a chunk reported it.
    """
    by_index: dict[int, list[dict[str, Any]]] = {}
    for finding in findings:
        by_index.setdefault(finding["index"], []).append(finding)

    aggregated: list[dict[str, Any]] = []
    for i, domain in enumerate(domains):
        entries = by_index.get(i, [])
        depth = "none"
        for entry in entries:
            if DEPTHS.index(entry["depth"]) > DEPTHS.index(depth):
                depth = entry["depth"]

        if not entries or depth == "none":
            coverage = "missing"
        elif depth == "thorough":
            coverage = "well_covered"
        elif depth == "overview":
            coverage = "well_covered" if len(entries) >= 2 else "partial"
        else:  # a mention, however many times
            coverage = "partial"

        seen: set[str] = set()
        topics: list[str] = []
        for entry in entries:
            for topic in entry["topics"]:
                key = topic.lower()
                if key not in seen:
                    seen.add(key)
                    topics.append(topic)

        aggregated.append({
            "title": domain.get("title") or "",
            "domain_id": domain.get("id"),
            "weight_pct": float(domain.get("weight_pct") or 0),
            "coverage": coverage,
            "depth": depth,
            "topics": topics[:12],
            "sources": sorted({e["filename"] for e in entries})[:6],
            "chunk_hits": len(entries),
        })
    return aggregated


# --- persistence ------------------------------------------------------------
def get_map(module_id: str, user_id: str) -> dict[str, Any] | None:
    """The stored map for a module, or None."""
    if not available():
        return None
    rows = (
        _client().table("coverage_maps").select("*")
        .eq("module_id", module_id).eq("user_id", user_id).limit(1).execute()
    ).data or []
    return rows[0] if rows else None


def _write(module_id: str, user_id: str, **fields: Any) -> None:
    if not available():
        return
    _client().table("coverage_maps").upsert(
        {
            "module_id": module_id,
            "user_id": user_id,
            "updated_at": _now_iso(),
            **fields,
        },
        on_conflict="module_id",
    ).execute()


def mark_stale(module_id: str, user_id: str) -> None:
    """Blank the fingerprint so the next read recomputes.

    Used where a source disappears: a map that outlives the material it
    describes tells the learner about text they no longer have.
    """
    if not available() or not get_map(module_id, user_id):
        return
    _write(module_id, user_id, fingerprint="")


# --- the computation --------------------------------------------------------
def compute(module_id: str, user_id: str) -> dict[str, Any]:
    """Read every source in full and rebuild the module's coverage map."""
    if not available():
        raise CoverageError("Coverage maps are not available in this deployment.")
    if not settings.gemini_api_key:
        raise CoverageError("GEMINI_API_KEY is not configured.")

    from app.services.tutor import module_context

    context = module_context(module_id, user_id)
    module, domains, sources = (
        context["module"], context["domains"], context["sources"],
    )
    if not domains:
        raise CoverageError(
            "This module has no study plan yet, so there's nothing to map the "
            "sources against."
        )

    expected = fingerprint(sources, domains)
    chunks, truncated = _source_chunks(sources)
    if not chunks:
        raise CoverageError(
            "No readable source material has been processed for this module yet."
        )

    _write(module_id, user_id, status="computing", error=None)

    subject = module.get("detected_subject") or module.get("title") or "this subject"
    blueprint = _blueprint(domains)
    logger.info(
        "Coverage map for module %s: reading %d chunk(s) across %d source(s)%s",
        module_id, len(chunks), len(sources),
        " — truncated at the ceiling" if truncated else "",
    )

    findings: list[dict[str, Any]] = []
    try:
        with ThreadPoolExecutor(max_workers=CHUNK_WORKERS) as pool:
            for result in pool.map(
                lambda chunk: _assess_chunk(subject, blueprint, len(domains), chunk),
                chunks,
            ):
                findings.extend(result)
    except Exception as exc:  # noqa: BLE001
        message = quota_hint(exc) or f"Reading your sources failed: {exc}"
        _write(module_id, user_id, status="failed", error=message[:500])
        raise CoverageError(message) from exc

    aggregated = _aggregate(domains, findings)
    chars = sum(len(c["text"]) for c in chunks)
    _write(
        module_id, user_id,
        status="ready",
        fingerprint=expected,
        domains=aggregated,
        chunk_count=len(chunks),
        chars_analysed=chars,
        source_count=len(sources),
        truncated=truncated,
        error=None,
        computed_at=_now_iso(),
    )
    logger.info(
        "Coverage map for module %s complete: %d of %d domain(s) covered, "
        "%d chars read",
        module_id,
        sum(1 for d in aggregated if d["coverage"] != "missing"),
        len(aggregated), chars,
    )
    return get_map(module_id, user_id) or {}


def ensure(
    module_id: str, user_id: str, *, force: bool = False,
) -> dict[str, Any] | None:
    """Rebuild the map if it is missing or stale. Safe to call in the background.

    Never raises: this runs off the back of ingestion and of source deletion,
    and neither should fail because the tutor's index could not be refreshed.
    """
    if not available():
        return None
    try:
        from app.services.tutor import module_context

        if not force:
            context = module_context(module_id, user_id)
            stored = get_map(module_id, user_id)
            if is_fresh(stored, fingerprint(context["sources"], context["domains"])):
                return stored
        return compute(module_id, user_id)
    except Exception as exc:  # noqa: BLE001 — a stale map beats a failed request
        logger.warning(
            "Coverage map for module %s could not be built: %s", module_id, exc,
        )
        # Record the failure. Without a row there is nothing to distinguish
        # "still reading" from "never started", and the tab would sit on a
        # spinner that resolves only when the learner gives up.
        try:
            _write(module_id, user_id, status="failed", error=str(exc)[:500])
        except Exception:  # noqa: BLE001
            logger.warning("Could not record the coverage failure for %s", module_id)
        return None

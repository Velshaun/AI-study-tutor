"""Filing a source under exactly one domain.

A playlist is forty videos in whatever order someone recorded them, and the
learner wants them sitting under the topics they're about. So as each transcript
lands it is matched against the module's blueprint and filed.

Three rules, and the reasoning behind each:

**Exactly one domain.** The primary. A lecture that touches four topics is
*about* one of them, and spreading it across all four would report coverage in
three domains it only mentions — which is precisely the mistake `coverage`'s
aggregator was written to avoid one level up.

**Never ask.** Where the match is weak the model still picks the best fit and
the confidence is recorded internally for a later pass to revisit. A wrong
assignment costs a video appearing under the wrong heading. Asking the learner
to file their own material costs the entire point of the feature.

**Ordering is a hint, not an authority.** Playlists are frequently out of order,
half-titled, or recorded before the syllabus settled — so the title, any chapter
markers and the transcript itself all count, and position counts for nothing.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from app.config import settings
from app.database import get_supabase
from app.services import schema_features
from app.services.domains import _generate, quota_hint

logger = logging.getLogger(__name__)

# Enough transcript to tell subnetting from storage arrays without paying to
# send an hour of speech. The title usually decides it; this settles the rest.
SAMPLE_CHARS = 6000
# Below this the assignment is kept but flagged for a later pass to revisit.
LOW_CONFIDENCE = 0.5

ASSIGN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "index": {
            "type": "integer",
            "description": (
                "The number of the single domain this material best belongs to. "
                "Always choose one, even when the fit is poor."
            ),
        },
        "confidence": {
            "type": "number",
            "description": (
                "0.0 to 1.0 — how well it fits. Be honest: a low number is "
                "useful, a falsely high one is not."
            ),
        },
        "reason": {
            "type": "string",
            "description": "One short sentence on what decided it.",
        },
    },
    "required": ["index", "confidence", "reason"],
}


def available() -> bool:
    return schema_features.has_column("user_files", "domain_id")


def _client():
    return get_supabase()


def domains_for(module_id: str, user_id: str) -> list[dict[str, Any]]:
    """The blueprint domains a source can be filed under.

    Imported decks are excluded: they are their own locked, zero-weight domain
    and nothing should be filed into them by a classifier.
    """
    rows = (
        _client().table("domains")
        .select("id, title, description, weight_pct, order_index, status")
        .eq("module_id", module_id).eq("user_id", user_id)
        .order("order_index").execute()
    ).data or []
    return [d for d in rows if (d.get("weight_pct") or 0) > 0 or d.get("status") != "locked"]


def assign(
    *, module_id: str, user_id: str, title: str, text: str,
    subject: str = "this subject",
) -> dict[str, Any]:
    """Pick the one domain this material belongs to.

    Returns ``{domain_id, confidence, reason, low_confidence}``. Never raises
    and never returns nothing: a source that cannot be classified is filed under
    the heaviest domain with a confidence of zero, which is a guess the later
    pass will find and revisit — unlike an unfiled source, which nothing looks
    for.
    """
    domains = domains_for(module_id, user_id)
    if not domains:
        return {"domain_id": None, "confidence": 0.0,
                "reason": "This module has no study plan yet.", "low_confidence": True}

    fallback = max(domains, key=lambda d: float(d.get("weight_pct") or 0))
    if not settings.gemini_api_key:
        return {"domain_id": fallback["id"], "confidence": 0.0,
                "reason": "No model configured; filed under the heaviest domain.",
                "low_confidence": True}

    listing = "\n".join(
        f"{i + 1}. {d.get('title')}"
        + (f" — {d['description']}" if d.get("description") else "")
        for i, d in enumerate(domains)
    )
    prompt = (
        f"You are filing one piece of study material for {subject} under the "
        "single exam domain it belongs to.\n\n"
        "- Choose exactly one domain. Material that touches several is still "
        "*about* one of them; pick that one.\n"
        "- The title is usually the strongest signal, then any chapter or "
        "section headings, then the content itself.\n"
        "- Where the material was in a playlist tells you nothing. Playlists are "
        "frequently out of order.\n"
        "- Always choose, even when nothing fits well — say so in the "
        "confidence instead.\n\n"
        f"--- EXAM DOMAINS (1-{len(domains)}) ---\n{listing}\n\n"
        f"--- MATERIAL ---\nTitle: {title}\n\n{(text or '')[:SAMPLE_CHARS]}"
    )

    try:
        from google.genai import types

        response = _generate(
            "domain-assign",
            model=settings.gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=ASSIGN_SCHEMA,
                temperature=0.1,
            ),
        )
        data = json.loads(response.text)
        index = int(data.get("index", 0)) - 1
        if not 0 <= index < len(domains):
            raise ValueError(f"domain {index + 1} is outside the blueprint")
        confidence = max(0.0, min(1.0, float(data.get("confidence") or 0)))
        chosen = domains[index]
        return {
            "domain_id": chosen["id"],
            "confidence": confidence,
            "reason": (data.get("reason") or "").strip()[:300],
            "low_confidence": confidence < LOW_CONFIDENCE,
        }
    except Exception as exc:  # noqa: BLE001 — an unfiled source is the worse outcome
        logger.warning(
            "Could not classify %r for module %s (%s); filing under %r",
            title, module_id, quota_hint(exc) or exc, fallback.get("title"),
        )
        return {"domain_id": fallback["id"], "confidence": 0.0,
                "reason": "Could not be classified; filed under the heaviest domain.",
                "low_confidence": True}


# Words that appear in half of all course titles and tell you nothing about
# which domain something belongs to.
_STOPWORDS = frozenset(
    "the a an and or of to in for with on at by from is are how what why "
    "part full course tutorial lesson video series complete guide intro "
    "introduction beginners beginner exam prep training crash your you".split()
)


def _words(text: str) -> set[str]:
    import re

    return {
        w for w in re.findall(r"[a-z0-9+#]{2,}", (text or "").lower())
        if w not in _STOPWORDS
    }


def suggest_from_title(
    title: str, choices: list[dict[str, str]], *, subject: str = "",
) -> dict[str, Any] | None:
    """The domain a title looks like it belongs to, before any text exists.

    Used by the import preview, which runs *before* anything is fetched — so
    there is no transcript to read and `assign` cannot help. This is word
    overlap and nothing cleverer, deliberately: the learner is looking at the
    answer and can change it, so a fast guess they correct beats a model call
    they wait for.

    Returns None rather than a coin flip when nothing overlaps. The preview then
    shows no pre-selection, which is the honest state — "we don't know, you
    pick" — rather than pointing at whichever domain happened to sort first.
    """
    if not choices:
        return None

    # The subject's own words are in every domain title of the module, so they
    # carry no signal about which one — "Linux" in a Linux course matches
    # everything.
    noise = _words(subject)
    target = _words(title) - noise
    if not target:
        return None

    best = None
    for choice in choices:
        words = _words(choice.get("title") or "") - noise
        if not words:
            continue
        overlap = len(target & words)
        if overlap and (best is None or overlap > best[0]):
            best = (overlap, choice)

    if not best:
        return None
    return {
        "domain_id": best[1]["id"],
        "title": best[1].get("title") or "",
        "overlap": best[0],
    }


def apply_to_source(source_id: str, assignment: dict[str, Any]) -> None:
    """Record the assignment on the source row, where the schema allows it."""
    if not available() or not assignment.get("domain_id"):
        return
    _client().table("user_files").update({
        "domain_id": assignment["domain_id"],
        "domain_confidence": assignment.get("confidence") or 0.0,
    }).eq("id", source_id).execute()


def low_confidence_sources(module_id: str, user_id: str) -> list[dict[str, Any]]:
    """Sources whose filing a later pass should revisit.

    Nothing consumes this yet. It is the point of recording the confidence at
    all, and it is cheaper to write here than to reconstruct later.
    """
    if not available():
        return []
    return (
        _client().table("user_files")
        .select("id, filename, domain_id, domain_confidence")
        .eq("module_id", module_id).eq("user_id", user_id)
        .lt("domain_confidence", LOW_CONFIDENCE).execute()
    ).data or []

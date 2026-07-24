"""Gemini domain extraction — spec §4.3 steps 3-6.

    step 3  send parsed text to Gemini with a domain-extraction prompt
    step 4  Gemini identifies the exact certification/subject
    step 5  Gemini uses Google Search to find official exam weightings
    step 6  Gemini returns structured JSON: titles, descriptions, weight %

Implemented as **two calls**, because the Gemini API rejects search grounding
and a JSON response schema in the same request:

    400 INVALID_ARGUMENT - "Tool use with a response mime type:
                            'application/json' is unsupported"

So call 1 identifies the subject and searches for official weightings as
free text (with citations), and call 2 folds that grounded evidence plus the
source material into the strict JSON contract. When no API key is configured,
``extract_domains`` falls back to a deterministic heuristic so the pipeline
still produces a usable progression map offline.
"""

from __future__ import annotations

import json
import logging
import random
import re
import time
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)

# Gemini returns 503 under load and 429 when a per-minute quota is hit. Both are
# transient, and without a retry a single blip fails the whole ingestion run —
# which on the free tier happens often enough to matter.
RETRY_STATUSES = ("503", "429", "500", "UNAVAILABLE", "RESOURCE_EXHAUSTED",
                  "INTERNAL", "overloaded", "high demand")
MAX_ATTEMPTS = 4
BASE_BACKOFF_SECS = 3.0

# Bounds on how many domains we accept back — certification blueprints are
# realistically 3-10 domains; anything outside that suggests a bad response.
MIN_DOMAINS = 2
MAX_DOMAINS = 12

DOMAIN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "subject": {
            "type": "string",
            "description": "Exact certification or course name, e.g. "
                           "'AWS Certified Solutions Architect - Associate (SAA-C03)'",
        },
        "subject_confidence": {
            "type": "number",
            "description": "0-1 confidence that the subject was identified correctly.",
        },
        "course_context": {
            "type": "string",
            "description": "One or two sentences on the level and audience.",
        },
        "summary": {
            "type": "string",
            "description": "A 2-3 sentence summary of the source material.",
        },
        "weights_are_official": {
            "type": "boolean",
            "description": "True only if weightings came from an official published "
                           "exam guide, false if inferred from the material.",
        },
        "domains": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "weight_pct": {"type": "number"},
                },
                "required": ["title", "description", "weight_pct"],
            },
        },
    },
    "required": [
        "subject", "subject_confidence", "course_context", "summary",
        "weights_are_official", "domains",
    ],
}


class DomainExtractionError(RuntimeError):
    """Gemini could not produce a usable domain map."""


def _client():
    """Build a Gemini client, or raise if the key is absent."""
    if not settings.gemini_api_key:
        raise DomainExtractionError("GEMINI_API_KEY is not configured.")
    from google import genai

    return genai.Client(api_key=settings.gemini_api_key)


def _is_transient(exc: Exception) -> bool:
    """Whether an exception is worth retrying rather than surfacing.

    A per-minute quota clears on its own, so retrying is right. A per-DAY quota
    does not — retrying just burns more of an already-exhausted allowance and
    delays the error the user needs to see.
    """
    text = str(exc)
    if "PerDay" in text or "per day" in text.lower():
        return False
    return any(marker in text for marker in RETRY_STATUSES)


def quota_hint(exc: Exception) -> str | None:
    """A short, actionable explanation for quota failures, if that's the cause."""
    text = str(exc)
    if "PerDay" in text:
        model = re.search(r"model:\s*([\w.-]+)", text)
        limit = re.search(r"limit:\s*(\d+)", text)
        return (
            "Gemini free-tier daily request limit reached"
            + (f" ({limit.group(1)}/day for {model.group(1)})" if limit and model else "")
            + ". It resets at midnight Pacific. Enable billing in Google AI "
              "Studio, or set GEMINI_MODEL to a model with remaining quota."
        )
    if "RESOURCE_EXHAUSTED" in text or "429" in text:
        return (
            "Gemini rate limit reached and retries were exhausted. "
            "Wait a minute and re-run processing for this module."
        )
    return None


def _retry_delay(exc: Exception, attempt: int) -> float:
    """Prefer the server's own retryDelay, else exponential backoff + jitter."""
    match = re.search(r"'retryDelay':\s*'(\d+(?:\.\d+)?)s'", str(exc))
    if match:
        return min(float(match.group(1)) + 1.0, 45.0)
    return min(BASE_BACKOFF_SECS * (2 ** attempt), 45.0) + random.uniform(0, 1.5)


def _generate(label: str, **kwargs) -> Any:
    """Call Gemini, retrying transient failures with backoff.

    Non-transient errors (bad key, invalid argument) raise immediately — there
    is nothing to wait for.
    """
    client = _client()
    last: Exception | None = None

    for attempt in range(MAX_ATTEMPTS):
        try:
            return client.models.generate_content(**kwargs)
        except Exception as exc:  # noqa: BLE001
            last = exc
            if not _is_transient(exc) or attempt == MAX_ATTEMPTS - 1:
                raise
            delay = _retry_delay(exc, attempt)
            logger.warning(
                "Gemini %s attempt %d/%d failed (%s); retrying in %.1fs",
                label, attempt + 1, MAX_ATTEMPTS, type(exc).__name__, delay,
            )
            time.sleep(delay)

    raise last  # unreachable, but keeps the type checker honest


def _sample(text: str, limit: int) -> str:
    """Keep a long document within the prompt budget.

    Course packs put the syllabus at the front and summaries at the back, so a
    head+tail sample preserves more signal than a plain truncation.
    """
    if len(text) <= limit:
        return text
    head = int(limit * 0.7)
    tail = limit - head
    return f"{text[:head]}\n\n[... middle omitted ...]\n\n{text[-tail:]}"


# --- step 4 + 5: identify the subject, then search for official weightings ---
def _context_block(course_context: str | None) -> str:
    """Render the learner's syllabus as a reference layer for the prompt.

    The syllabus is authoritative about *this* course — which topics are
    actually examined and how they're emphasised — so it is presented as
    evidence to validate the published weightings against, not as more source
    material to summarise.
    """
    if not (course_context or "").strip():
        return ""
    return (
        "\n--- COURSE CONTEXT (supplied by the learner: syllabus / course "
        "outline) ---\n"
        "Treat this as an authoritative reference layer describing what this "
        "particular course actually covers and examines.\n"
        f"{_sample(course_context.strip(), 20000)}\n"
    )


def identify_and_search(
    text: str, course_context: str | None = None
) -> tuple[str, list[dict[str, str]]]:
    """Return grounded findings plus the web sources that backed them.

    One call, with Google Search enabled. Gemini first names the exact
    certification (step 4) and then looks up its published exam guide (step 5).
    A supplied syllabus narrows the identification and is cross-checked against
    the published blueprint.
    """
    from google.genai import types

    client = _client()
    excerpt = _sample(text, min(settings.max_extract_chars, 30000))
    context_block = _context_block(course_context)

    prompt = (
        "You are analysing study material to build a certification study plan.\n\n"
        "1. Identify the EXACT certification, exam code, or course this material "
        "is for. Be specific — distinguish between similar credentials such as "
        "'AWS Certified Solutions Architect - Associate' vs 'AWS Certified Cloud "
        "Practitioner', or 'CompTIA Security+ SY0-701' vs 'CySA+'. If it is not a "
        "formal certification, name the subject and academic level instead.\n"
        + (
            "   The COURSE CONTEXT below is the strongest signal for this — "
            "prefer any exam code or course title it names over one inferred "
            "from the study material.\n"
            if context_block
            else ""
        )
        + "\n2. Then search the web for that exam's OFFICIAL exam guide and report "
        "its published domains and their exact weighting percentages. Prefer the "
        "vendor's own exam guide PDF. If no official weightings exist, say so "
        "explicitly rather than guessing.\n\n"
        + (
            "3. Cross-check the published blueprint against the COURSE CONTEXT. "
            "Report explicitly:\n"
            "   - which official domains the syllabus confirms are examined\n"
            "   - any topic the syllabus emphasises that the published "
            "weightings under-represent\n"
            "   - any official domain the syllabus indicates is out of scope "
            "for this course\n\n"
            if context_block
            else ""
        )
        + "Report the certification name, each official domain title, and each "
        "weighting percentage.\n"
        f"{context_block}\n"
        f"--- STUDY MATERIAL ---\n{excerpt}"
    )

    try:
        response = _generate(
            "search",
            model=settings.gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                tools=[types.Tool(google_search=types.GoogleSearch())],
                temperature=0.1,
            ),
        )
    except Exception as exc:  # noqa: BLE001
        raise DomainExtractionError(
            quota_hint(exc) or f"Gemini search step failed: {exc}"
        ) from exc

    findings = (response.text or "").strip()

    sources: list[dict[str, str]] = []
    try:
        metadata = response.candidates[0].grounding_metadata
        for chunk in (metadata.grounding_chunks or []) if metadata else []:
            if chunk.web and chunk.web.uri:
                sources.append(
                    {"title": chunk.web.title or "", "uri": chunk.web.uri}
                )
    except (AttributeError, IndexError):  # grounding is best-effort
        pass

    return findings, sources


# --- step 6: fold everything into the strict JSON contract ------------------
def structure_domains(
    text: str, findings: str, course_context: str | None = None
) -> dict[str, Any]:
    """Second call: emit the validated progression map as JSON.

    With a syllabus supplied, the official weightings are treated as the
    baseline and the syllabus as the layer that validates and re-prioritises
    them for this specific course.
    """
    from google.genai import types

    client = _client()
    excerpt = _sample(text, settings.max_extract_chars)
    context_block = _context_block(course_context)

    prompt = (
        "Build a study progression map as JSON.\n\n"
        "You are given (a) research about the official exam blueprint, gathered "
        "from the web, "
        + (
            "(b) the learner's COURSE CONTEXT (their syllabus or course "
            "outline), and (c) the learner's actual source material.\n\n"
            if context_block
            else "and (b) the learner's actual source material.\n\n"
        )
        + "Rules:\n"
        "- Prefer the OFFICIAL domain titles and weightings from the research. "
        "Set weights_are_official=true when you use them.\n"
        "- Only if the research found no official blueprint, derive domains from "
        "the source material itself and set weights_are_official=false.\n"
        + (
            "- Use the COURSE CONTEXT as a validation layer over those "
            "weightings:\n"
            "    * Keep official domain titles — do not rename them to match "
            "the syllabus's wording.\n"
            "    * Where the syllabus clearly emphasises a domain (more hours, "
            "more depth, flagged as assessed), adjust that domain's weight "
            "upward relative to the official baseline.\n"
            "    * Where the syllabus marks a domain as out of scope or "
            "optional, reduce its weight accordingly.\n"
            "    * Keep adjustments proportionate — the official blueprint is "
            "the baseline and the syllabus refines it. Move a domain by more "
            "than ~15 percentage points only when the syllabus gives explicit "
            "evidence (stated assessment weight, contact hours, or wording "
            "like 'core of this module').\n"
            "    * Set a domain to 0 ONLY when the syllabus explicitly places "
            "it out of scope or says it is not examined. Do not zero a domain "
            "merely because the syllabus covers it briefly — give it a small "
            "non-zero weight instead.\n"
            "    * Mention the syllabus-driven emphasis in that domain's "
            "description so the learner understands why it is prioritised.\n"
            "- Keep weights_are_official=true if the titles and ordering still "
            "come from the official guide, even after re-weighting.\n"
            if context_block
            else ""
        )
        + "- weight_pct values must sum to approximately 100.\n"
        "- Order domains as the official exam guide orders them.\n"
        "- Each description should be one sentence on what the domain covers.\n"
        f"{context_block}\n"
        f"--- RESEARCH (web-grounded) ---\n{findings}\n\n"
        f"--- SOURCE MATERIAL ---\n{excerpt}"
    )

    try:
        response = _generate(
            "structure",
            model=settings.gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=DOMAIN_SCHEMA,
                temperature=0.1,
            ),
        )
        data = json.loads(response.text)
    except json.JSONDecodeError as exc:
        raise DomainExtractionError(f"Gemini returned invalid JSON: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise DomainExtractionError(
            quota_hint(exc) or f"Gemini structuring step failed: {exc}"
        ) from exc

    return _validate(data)


def _validate(data: dict[str, Any]) -> dict[str, Any]:
    """Sanity-check and normalise the model's JSON before it hits the database."""
    domains = data.get("domains") or []
    if len(domains) < MIN_DOMAINS:
        raise DomainExtractionError(
            f"Only {len(domains)} domain(s) identified — too few to build a plan."
        )
    domains = domains[:MAX_DOMAINS]

    cleaned: list[dict[str, Any]] = []
    for index, domain in enumerate(domains):
        title = (domain.get("title") or "").strip()
        if not title:
            continue
        try:
            weight = float(domain.get("weight_pct") or 0)
        except (TypeError, ValueError):
            weight = 0.0
        cleaned.append(
            {
                "title": title[:200],
                "description": (domain.get("description") or "").strip()[:1000],
                "weight_pct": max(0.0, min(100.0, weight)),
                "order_index": index + 1,
            }
        )

    if len(cleaned) < MIN_DOMAINS:
        raise DomainExtractionError("No usable domains after validation.")

    # A syllabus can legitimately zero out a domain it places out of scope.
    # Those are split off rather than kept at 0%: a zero-weight domain would
    # otherwise get a row and go on to generate lectures and flashcards for
    # material the learner is never assessed on. They're still reported so the
    # UI can show what the syllabus excluded.
    excluded = [d for d in cleaned if d["weight_pct"] < 0.5]
    included = [d for d in cleaned if d["weight_pct"] >= 0.5]

    if len(included) >= MIN_DOMAINS:
        for position, domain in enumerate(included, start=1):
            domain["order_index"] = position
        data["excluded_domains"] = [
            {"title": d["title"], "description": d["description"]} for d in excluded
        ]
        cleaned = included
    else:
        # Too aggressive to act on — keep everything rather than gut the plan.
        data["excluded_domains"] = []

    # Re-normalise so the weights always total 100, even if the model's don't.
    total = sum(d["weight_pct"] for d in cleaned)
    if total <= 0:
        share = round(100 / len(cleaned), 2)
        for domain in cleaned:
            domain["weight_pct"] = share
    elif abs(total - 100) > 1.0:
        logger.info("Re-normalising domain weights from %.1f%% to 100%%", total)
        for domain in cleaned:
            domain["weight_pct"] = round(domain["weight_pct"] * 100 / total, 2)

    data["domains"] = cleaned
    data["subject"] = (data.get("subject") or "Unknown subject").strip()[:200]
    try:
        data["subject_confidence"] = max(
            0.0, min(1.0, float(data.get("subject_confidence") or 0))
        )
    except (TypeError, ValueError):
        data["subject_confidence"] = 0.0
    return data


# --- offline fallback -------------------------------------------------------
def heuristic_domains(text: str) -> dict[str, Any]:
    """Derive a rough domain map without an AI provider.

    Looks for heading-shaped lines so a key-less dev environment still produces
    a navigable module instead of an error.
    """
    candidates: list[str] = []
    for raw in text.split("\n"):
        line = raw.strip()
        if not (8 <= len(line) <= 90):
            continue
        if re.match(r"^(chapter|section|module|domain|unit|part|topic)\b", line, re.I) \
                or re.match(r"^\d+[.)]\s+\S", line) \
                or (line == line.title() and len(line.split()) <= 8):
            cleaned = re.sub(r"^(chapter|section|module|domain|unit|part|topic)\s*"
                             r"\d*[:.)-]?\s*", "", line, flags=re.I).strip()
            if len(cleaned) >= 4 and cleaned.lower() not in {c.lower() for c in candidates}:
                candidates.append(cleaned)

    titles = candidates[:8] or ["Core Concepts", "Applied Practice", "Review"]
    share = round(100 / len(titles), 2)
    return {
        "subject": "Unclassified study material",
        "subject_confidence": 0.0,
        "course_context": "Derived offline without AI analysis.",
        "summary": text[:400],
        "weights_are_official": False,
        "domains": [
            {
                "title": title[:200],
                "description": "Derived from the source material's structure.",
                "weight_pct": share,
                "order_index": index + 1,
            }
            for index, title in enumerate(titles)
        ],
    }


# --- orchestration ----------------------------------------------------------
def extract_domains(
    text: str, course_context: str | None = None
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """Run steps 3-6 and return ``(progression_map, grounding_sources)``.

    ``course_context`` is the learner's syllabus, used as a reference layer to
    validate weightings and prioritise examined topics. Falls back to the
    heuristic map when no key is configured. A *failed* API call is not
    swallowed — that's a real error the caller should surface.
    """
    if not settings.gemini_api_key:
        logger.warning("GEMINI_API_KEY unset — using heuristic domain extraction.")
        return heuristic_domains(text), []

    findings, sources = identify_and_search(text, course_context)
    result = structure_domains(text, findings, course_context)
    result["used_course_context"] = bool((course_context or "").strip())
    return result, sources

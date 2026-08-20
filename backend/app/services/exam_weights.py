"""Where a module's domain weights come from, and why they never change again.

A weight is a property of the exam, not of the material someone uploaded. The
old path derived them from the material on every rebuild, which meant adding a
single source could re-derive the whole blueprint: two runs minutes apart over
the same six sources gave LPI's published split once and a flat 20/20/20/20/20
the next. Both summed to 100, both looked reasonable, and `exam_profile`
allocates every practice paper by those numbers.

So weights are *looked up*, in this order, and then frozen:

1. `exam_catalog` — the vendor's published split, transcribed and checked in.
   Free, offline, and the same answer every time.
2. An uploaded study guide that states the weightings explicitly. Vendor
   material restating vendor figures.
3. The vendor's own objectives page, via grounded search.
4. Nothing found — recorded as *provisional*, which is the one state a later
   lookup is allowed to replace.

The rule underneath all of it: a model's guess must never overwrite a vendor's
published figures. That is why provenance is stored rather than just the value —
without knowing where a set came from, there is no way to express the rule.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from app.database import get_supabase
from app.services import exam_catalog, schema_features

logger = logging.getLogger(__name__)

PUBLISHED = "published"
STUDY_GUIDE = "study_guide"
PROVISIONAL = "provisional"

# Only these may be replaced by a later lookup.
REPLACEABLE = (PROVISIONAL, None)

# A published set should sum to 100. Vendors round their own figures, so this
# tolerates their rounding and nothing more — a set that misses by more than
# this was not transcribed from a published table.
SUM_TOLERANCE = 1.5


@dataclass(frozen=True)
class WeightSet:
    """Weights for one exam, and the record of where they came from."""

    domains: tuple[tuple[str, float], ...]
    source: str
    citation: str = ""
    sources: tuple[dict[str, str], ...] = field(default_factory=tuple)

    @property
    def total(self) -> float:
        return round(sum(w for _, w in self.domains), 2)

    @property
    def plausible(self) -> bool:
        return bool(self.domains) and abs(self.total - 100.0) <= SUM_TOLERANCE


def available() -> bool:
    """Whether the provenance columns exist yet."""
    return schema_features.has_column("modules", "weights_source")


# --- 1. the catalogue --------------------------------------------------------
def from_catalogue(*texts: str | None) -> WeightSet | None:
    """The vendor's split, as transcribed into `exam_catalog`."""
    spec = exam_catalog.find(*texts)
    if not spec or not spec.domains:
        return None
    return WeightSet(
        domains=tuple(spec.domains),
        source=PUBLISHED,
        citation=f"{spec.label} published exam objectives (exam_catalog)",
    )


# --- 2. an uploaded study guide ---------------------------------------------
# "Total", "Total Percentage", "Grand total", "Overall" — the last row of every
# vendor blueprint table, and not a domain.
_SUMMARY_ROW = re.compile(
    r"^(?:grand\s+)?(?:total|sum|overall|all\s+domains?)\b", re.IGNORECASE,
)

# "Mobile Devices .... 13%" / "1.0 Networking 23 %" / "Topic 3 ... weight: 9%"
_STATED = re.compile(
    r"^[\s\-•]*(?:(?:domain|topic)\s*)?(?:\d+(?:\.\d+)?\s*[.):]?\s*)?"
    r"(?P<title>[A-Za-z][A-Za-z0-9 ,/&'’\-+()]{4,70}?)"
    r"[\s.·:\-]{2,}"
    r"(?:weight\s*[:=]?\s*)?(?P<pct>\d{1,3}(?:\.\d+)?)\s*%",
    re.IGNORECASE | re.MULTILINE,
)


def from_study_guide(text: str, *, filename: str = "") -> WeightSet | None:
    """Weights a guide states outright, rather than ones inferred from it.

    Deliberately literal: it reads a table of "domain — percentage" lines and
    nothing else. If a guide does not print its weightings, the honest answer is
    that this source has none — inferring them from how many pages each topic
    gets is exactly the derivation this module exists to remove.
    """
    if not text:
        return None

    found: list[tuple[str, float]] = []
    seen: set[str] = set()
    for match_ in _STATED.finditer(text):
        title = " ".join(match_.group("title").split()).strip(" .-:")
        pct = float(match_.group("pct"))
        key = title.lower()
        # A percentage over 100 is a page number or a version string that
        # happened to sit next to a percent sign.
        if key in seen or not (0 < pct <= 100) or len(title) < 5:
            continue
        # Every vendor blueprint ends with a "Total ... 100%" row. Reading it as
        # a domain doubles the sum, and the whole table then gets thrown away
        # for not adding up.
        if _SUMMARY_ROW.match(key):
            continue
        seen.add(key)
        found.append((title, pct))

    # The same guard for a total row labelled something the pattern above
    # doesn't know: an entry equal to the sum of all the others is the total.
    if len(found) > 2:
        total = sum(pct for _, pct in found)
        found = [
            (title, pct) for title, pct in found
            if abs(pct - (total - pct)) > 0.51
        ]

    if len(found) < 3:
        # Two "N%" lines are a coincidence; an exam blueprint has several.
        return None

    candidate = WeightSet(
        domains=tuple(found),
        source=STUDY_GUIDE,
        citation=f"weightings stated in {filename}" if filename
        else "weightings stated in an uploaded study guide",
    )
    if not candidate.plausible:
        logger.info(
            "Ignoring stated weights from %s: they sum to %s, not 100.",
            filename or "an uploaded guide", candidate.total,
        )
        return None
    return candidate


# --- 3. the vendor's objectives, via grounded search -------------------------
def _model() -> str:
    from app.config import settings

    return settings.gemini_model


def from_vendor_search(certification: str) -> WeightSet | None:
    """Ask the vendor's own published objectives, with search grounding.

    Same two-call shape as `domains.derive`: a grounded call to read the
    objectives, then a strict-schema call to transcribe them. The transcription
    step is told it is copying, not judging — the whole point is that this
    returns what the vendor published or nothing at all.
    """
    if not certification.strip():
        return None
    try:
        from google.genai import types

        from app.services.domains import _generate
    except Exception:  # noqa: BLE001 — Gemini not configured on this deployment
        return None

    prompt = (
        "Find the official, currently published exam objectives for "
        f"{certification}.\n\n"
        "Report the exact domain (or topic) titles and the exact weighting the "
        "vendor publishes for each. Use only the vendor's own documentation — "
        "their objectives PDF or certification page. Ignore training providers "
        "and exam-dump sites, which paraphrase and go stale.\n\n"
        "If the vendor publishes integer weights against a total rather than "
        "percentages, report both the integers and the total, and do not "
        "convert them yourself.\n\n"
        "If you cannot find the vendor's own published weightings, say so "
        "plainly. Do not estimate them from the syllabus."
    )

    try:
        response = _generate(
            "weights-search",
            model=_model(),
            contents=prompt,
            config=types.GenerateContentConfig(
                tools=[types.Tool(google_search=types.GoogleSearch())],
                temperature=0.0,
            ),
        )
    except Exception as exc:  # noqa: BLE001
        logger.info("Weight lookup search failed for %s: %s", certification, exc)
        return None

    findings = (response.text or "").strip()
    if not findings:
        return None

    cites: list[dict[str, str]] = []
    try:
        metadata = response.candidates[0].grounding_metadata
        for chunk in (metadata.grounding_chunks or []) if metadata else []:
            if chunk.web and chunk.web.uri:
                cites.append({"title": chunk.web.title or "", "uri": chunk.web.uri})
    except (AttributeError, IndexError):  # grounding is best-effort
        pass

    structured = _transcribe(findings, certification)
    if not structured:
        return None

    weights = WeightSet(
        domains=structured,
        source=PUBLISHED,
        citation=(cites[0]["uri"] if cites else "vendor exam objectives (search)"),
        sources=tuple(cites),
    )
    if not weights.plausible:
        # A set that does not sum to 100 was inferred, not read.
        logger.info(
            "Discarding searched weights for %s: they sum to %s.",
            certification, weights.total,
        )
        return None
    return weights


def _transcribe(findings: str, certification: str) -> tuple[tuple[str, float], ...]:
    """Second call: turn the search prose into titles and percentages."""
    try:
        from google.genai import types

        from app.services.domains import _generate
    except Exception:  # noqa: BLE001
        return ()

    schema = {
        "type": "object",
        "properties": {
            "found": {"type": "boolean"},
            "domains": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "weight_pct": {"type": "number"},
                    },
                    "required": ["title", "weight_pct"],
                },
            },
        },
        "required": ["found", "domains"],
    }

    try:
        response = _generate(
            "weights-structure",
            model=_model(),
            contents=(
                "Transcribe the published weightings below into JSON. You are "
                "copying, not judging: do not adjust, round differently, or "
                "rebalance anything.\n\n"
                "Where the vendor publishes integer weights against a total, "
                "convert each to a percentage of that total.\n\n"
                "Set found=false with an empty list if the text does not "
                "contain the vendor's own published weightings.\n\n"
                f"--- CERTIFICATION ---\n{certification}\n\n"
                f"--- FINDINGS ---\n{findings}"
            ),
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=schema,
                temperature=0.0,
            ),
        )
    except Exception as exc:  # noqa: BLE001
        logger.info("Weight transcription failed for %s: %s", certification, exc)
        return ()

    try:
        data = json.loads(response.text or "{}")
    except (ValueError, TypeError):
        return ()

    if not data.get("found"):
        return ()
    out: list[tuple[str, float]] = []
    for row in data.get("domains") or []:
        title = str(row.get("title") or "").strip()
        try:
            pct = float(row.get("weight_pct"))
        except (TypeError, ValueError):
            continue
        if title and 0 < pct <= 100:
            out.append((title, pct))
    return tuple(out)


# --- resolution --------------------------------------------------------------
def resolve(
    *, certification: str = "", module_title: str = "", guide_text: str = "",
    guide_name: str = "", allow_search: bool = True,
) -> WeightSet:
    """The published weights for this exam, or an explicit provisional set.

    Never returns None: "we could not find them" is an answer that has to be
    recorded, because it is what makes a later study guide able to supersede
    them.
    """
    catalogued = from_catalogue(certification, module_title)
    if catalogued:
        logger.info("Weights for %r came from the catalogue.",
                    certification or module_title)
        return catalogued

    stated = from_study_guide(guide_text, filename=guide_name)
    if stated:
        logger.info("Weights for %r were stated in %s.",
                    certification or module_title, guide_name or "the guide")
        return stated

    if allow_search:
        searched = from_vendor_search(certification or module_title)
        if searched:
            logger.info("Weights for %r came from %s.",
                        certification or module_title, searched.citation)
            return searched

    logger.info(
        "No published weights found for %r; recording a provisional set.",
        certification or module_title,
    )
    return WeightSet(
        domains=(), source=PROVISIONAL,
        citation="no published weightings found; an even split is in use, and "
                 "a later study guide upload will supersede it",
    )


# --- storage -----------------------------------------------------------------
def current_source(module_id: str) -> str | None:
    """What kind of set this module already holds, if any."""
    if not available():
        return None
    rows = (
        get_supabase().table("modules").select("weights_source")
        .eq("id", module_id).limit(1).execute()
    ).data or []
    return (rows[0] or {}).get("weights_source") if rows else None


def frozen(module_id: str) -> bool:
    """Whether this module's weights may still be replaced.

    Published and study-guide sets are final. Provisional is not — that is the
    whole point of recording it.
    """
    return current_source(module_id) not in REPLACEABLE


def record(module_id: str, weights: WeightSet) -> None:
    """Store where a module's weights came from."""
    if not available():
        return
    get_supabase().table("modules").update({
        "weights_source": weights.source,
        "weights_set_at": datetime.now(timezone.utc).isoformat(),
        "weights_citation": weights.citation[:500],
    }).eq("id", module_id).execute()


# "Domain 5.0 -", "Topic 3:", "4.0", "Module 2 —" — numbering that the vendor
# and the blueprint each add in their own style, and neither is part of a name.
_PREFIX = re.compile(
    r"^\s*(?:domain|topic|module|section|unit|part|chapter)?\s*"
    r"\d+(?:\.\d+)*\s*[-–—:.)]*\s*",
    re.IGNORECASE,
)


def _key(text: str) -> str:
    text = (text or "").lower().replace("&", "and")
    text = _PREFIX.sub("", text)
    return re.sub(r"[^a-z0-9]+", "", text)


def match(domain_title: str, weights: WeightSet) -> float | None:
    """The published weight for a domain, matched on title.

    Titles come from two places that agree on meaning and not on punctuation:
    "Domain 5.0 - Hardware and Network Troubleshooting" against the vendor's
    "Hardware and Network Troubleshooting".

    Longest match wins, which is the rule `exam_catalog` already uses to
    identify a certification, and for the same reason. Taking the first
    containment match instead is actively wrong here: "Hardware" is a substring
    of "Hardware and Network Troubleshooting", so A+ domain 5 matched domain 3
    and would have been written 25% instead of 28%. A wrong weight that still
    sums to 100 is the exact failure this module exists to prevent, so the
    matcher must not reintroduce it.
    """
    target = _key(domain_title)
    if not target:
        return None

    for title, pct in weights.domains:
        if _key(title) == target:
            return pct

    best: tuple[int, float] | None = None
    for title, pct in weights.domains:
        key = _key(title)
        if not key:
            continue
        if key in target or target in key:
            overlap = min(len(key), len(target))
            if best is None or overlap > best[0]:
                best = (overlap, pct)
    return best[1] if best else None


def even_split(module_id: str, domains: list[dict[str, Any]]) -> int:
    """Give every examined domain an equal share, and mean it.

    What a provisional module gets. The alternative is keeping whatever the
    blueprint model produced, and that is the thing this module exists to stop:
    a derived split looks authoritative, sums to 100, and encodes nothing but
    the shape of whatever happened to be uploaded. An even split is visibly a
    placeholder, which is the honest representation of not knowing — and it is
    what the recorded citation says is in use.
    """
    graded = [
        d for d in domains
        if (d.get("weight_pct") or 0) or d.get("status") != "locked"
    ]
    if not graded:
        return 0
    share = round(100.0 / len(graded), 2)
    client = get_supabase()
    for domain in graded:
        client.table("domains").update({"weight_pct": share}).eq(
            "id", domain["id"]
        ).execute()
    return len(graded)


def apply_to_domains(
    module_id: str, weights: WeightSet, domains: list[dict[str, Any]],
) -> int:
    """Write published weights onto the module's domains.

    A domain the published set does not mention keeps whatever it has — it is
    either a flashcard deck (weight 0, deliberately) or something the blueprint
    added that the vendor does not examine, and inventing a share of the exam
    for it is the derivation this module exists to prevent.
    """
    if not weights.domains:
        return 0
    client = get_supabase()
    written = 0
    for domain in domains:
        # Decks are zero-weight on purpose and are not part of the exam.
        if not (domain.get("weight_pct") or 0) and domain.get("status") == "locked":
            continue
        pct = match(domain.get("title") or "", weights)
        if pct is None:
            continue
        client.table("domains").update({"weight_pct": pct}).eq(
            "id", domain["id"]
        ).execute()
        written += 1
    return written

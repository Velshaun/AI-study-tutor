"""The module tutor: answers about the material, and judges whether it's enough.

The question this exists for is "is what I've uploaded enough to pass?" — which
nothing could answer before, because the app knew what the exam covers (the
weighted domain blueprint) and what the learner uploaded (the parsed sources)
but never compared the two.

An assessment is that comparison, done per domain and weighted: a thin domain
worth 32% of the paper matters far more than a thin one worth 4%, and saying so
is the difference between a verdict and a list.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from app.config import settings
from app.database import get_supabase
from app.services.domains import _generate, quota_hint

logger = logging.getLogger(__name__)


class TutorError(RuntimeError):
    """The tutor could not answer."""


# How much of each source the model reads. Enough to judge coverage without
# sending an entire course pack for every question.
PER_SOURCE_CHARS = 6000
MAX_SOURCE_CHARS = 60000
# Turns of conversation carried into a follow-up.
HISTORY_TURNS = 8

COVERAGE_LEVELS = ("well_covered", "partial", "missing")

ASSESSMENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "verdict": {
            "type": "string",
            "description": (
                "Two or three sentences answering, plainly, whether the "
                "uploaded material is enough to prepare for this exam."
            ),
        },
        "readiness": {
            "type": "string",
            "description": "One of: ready, mostly_ready, significant_gaps.",
        },
        "domains": {
            "type": "array",
            "description": "One entry per exam domain, in the order given.",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "The domain's title."},
                    "coverage": {
                        "type": "string",
                        "description": (
                            "well_covered, partial or missing — how well the "
                            "uploaded sources cover this domain."
                        ),
                    },
                    "note": {
                        "type": "string",
                        "description": (
                            "One sentence on what is covered and what isn't, "
                            "naming specifics from the material."
                        ),
                    },
                },
                "required": ["title", "coverage", "note"],
            },
        },
        "gaps": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "The specific topics the sources don't cover, most important "
                "first. Empty if the material is genuinely complete."
            ),
        },
        "recommendations": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "What to do about it — what to upload, read or search for. "
                "Concrete and actionable, not 'study more'."
            ),
        },
    },
    "required": ["verdict", "readiness", "domains", "gaps", "recommendations"],
}


def _client():
    return get_supabase()


def module_context(module_id: str, user_id: str) -> dict[str, Any]:
    """What the tutor knows about a module: its blueprint and its sources."""
    client = _client()
    rows = (
        client.table("modules").select("*")
        .eq("id", module_id).eq("user_id", user_id).limit(1).execute()
    ).data or []
    if not rows:
        raise TutorError("Module not found.")
    module = rows[0]

    domains = (
        client.table("domains")
        .select("id, title, description, weight_pct, order_index")
        .eq("module_id", module_id).eq("user_id", user_id)
        .order("order_index").execute()
    ).data or []

    sources = (
        client.table("user_files")
        .select("filename, source_type, status, char_count, extracted_text")
        .eq("module_id", module_id).eq("user_id", user_id).execute()
    ).data or []

    return {"module": module, "domains": domains, "sources": sources}


def _source_digest(sources: list[dict[str, Any]]) -> str:
    """The uploaded material, trimmed to what the model needs to judge it."""
    parts: list[str] = []
    budget = MAX_SOURCE_CHARS
    for source in sources:
        if source.get("status") != "parsed":
            parts.append(
                f"[{source.get('filename')}] — {source.get('status')}, "
                "no text available"
            )
            continue
        text = (source.get("extracted_text") or "").strip()
        if not text:
            continue
        excerpt = text[: min(PER_SOURCE_CHARS, budget)]
        budget -= len(excerpt)
        parts.append(
            f"[{source.get('filename')} · {source.get('source_type')} · "
            f"{source.get('char_count') or len(text)} chars]\n{excerpt}"
        )
        if budget <= 0:
            break
    return "\n\n".join(parts)


def _blueprint(domains: list[dict[str, Any]]) -> str:
    return "\n".join(
        f"- {d.get('title')} ({round(float(d.get('weight_pct') or 0))}% of the exam)"
        f"{': ' + d['description'] if d.get('description') else ''}"
        for d in domains
    )


def assess_material(module_id: str, user_id: str) -> dict[str, Any]:
    """Judge how well the uploaded sources cover the exam this module is for."""
    if not settings.gemini_api_key:
        raise TutorError("GEMINI_API_KEY is not configured.")

    from google.genai import types

    context = module_context(module_id, user_id)
    module, domains, sources = (
        context["module"], context["domains"], context["sources"],
    )
    if not domains:
        raise TutorError(
            "This module has no study plan yet, so there's nothing to compare "
            "your sources against. Generate the plan first."
        )

    digest = _source_digest(sources)
    if not digest.strip():
        raise TutorError(
            "No readable source material has been processed for this module yet."
        )

    subject = module.get("detected_subject") or module.get("title") or "this subject"
    prompt = (
        f"You are a subject-matter tutor for {subject}. A learner wants to know "
        "whether the material they have uploaded is enough to prepare for the "
        "exam.\n\n"
        "Judge the SOURCES against the EXAM BLUEPRINT, domain by domain.\n\n"
        "- Weight your verdict: a thin domain worth 30% of the paper is a "
        "serious problem, a thin one worth 4% is barely worth mentioning.\n"
        "- Be specific and honest. Name what is actually in the sources and what "
        "is absent. Do not soften a real gap, and do not invent one to seem "
        "thorough.\n"
        "- Judge only what the sources contain. A domain the sources never "
        "touch is 'missing' however well the learner might already know it.\n"
        "- recommendations must be things the learner can act on: what to "
        "upload, which topic to find material for, what to search.\n"
        "- Return one domains entry per blueprint domain, in the same order.\n\n"
        f"--- EXAM BLUEPRINT ---\n{_blueprint(domains)}\n\n"
        f"--- SOURCES ({len(sources)} uploaded) ---\n{digest}"
    )

    try:
        response = _generate(
            "tutor-assess",
            model=settings.gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=ASSESSMENT_SCHEMA,
                temperature=0.2,
            ),
        )
        data = json.loads(response.text)
    except json.JSONDecodeError as exc:
        raise TutorError(f"Model returned invalid JSON: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise TutorError(quota_hint(exc) or f"Assessment failed: {exc}") from exc

    by_title = {(d.get("title") or "").lower(): d for d in domains}
    assessed = []
    for item in data.get("domains", []):
        title = (item.get("title") or "").strip()
        coverage = (item.get("coverage") or "").strip().lower()
        if coverage not in COVERAGE_LEVELS:
            coverage = "partial"
        source_domain = by_title.get(title.lower(), {})
        assessed.append({
            "title": title,
            "coverage": coverage,
            "note": (item.get("note") or "").strip()[:400],
            "weight_pct": float(source_domain.get("weight_pct") or 0),
        })

    readiness = (data.get("readiness") or "").strip().lower()
    if readiness not in ("ready", "mostly_ready", "significant_gaps"):
        readiness = "mostly_ready"

    return {
        "verdict": (data.get("verdict") or "").strip()[:1200],
        "readiness": readiness,
        # The share of the paper the sources genuinely cover — the number the
        # learner actually wants, and one the model shouldn't be trusted to add
        # up itself.
        "covered_pct": round(
            sum(d["weight_pct"] for d in assessed if d["coverage"] == "well_covered")
            + sum(d["weight_pct"] * 0.5 for d in assessed if d["coverage"] == "partial"),
            1,
        ),
        "domains": assessed,
        "gaps": [str(g).strip()[:300] for g in (data.get("gaps") or [])][:12],
        "recommendations": [
            str(r).strip()[:300] for r in (data.get("recommendations") or [])
        ][:8],
        "source_count": len(sources),
    }


ANSWER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "intent": {
            "type": "string",
            "description": (
                "'assessment' when the learner is asking whether their uploaded "
                "material is sufficient, or what is missing from it. "
                "'resources' when they want links, videos or reading to study "
                "from. 'question' for anything else."
            ),
        },
        "answer": {
            "type": "string",
            "description": (
                "The answer, grounded in the module's material. Empty when "
                "intent is 'assessment' or 'resources' — those are answered "
                "elsewhere."
            ),
        },
    },
    "required": ["intent", "answer"],
}


def answer_question(
    module_id: str, user_id: str, question: str, history: list[dict[str, Any]],
) -> dict[str, Any]:
    """Answer a tutor question, or say that it needs an assessment or a search.

    Classification and answering happen in one call: asking twice would double
    the wait for the common case, which is an ordinary question.
    """
    if not settings.gemini_api_key:
        raise TutorError("GEMINI_API_KEY is not configured.")

    from google.genai import types

    context = module_context(module_id, user_id)
    module, domains, sources = (
        context["module"], context["domains"], context["sources"],
    )
    subject = module.get("detected_subject") or module.get("title") or "this subject"

    recent = "\n".join(
        f"{m['role']}: {m['content'][:500]}" for m in history[-HISTORY_TURNS:]
    )
    prompt = (
        f"You are a subject-matter tutor for {subject}, attached to this "
        "learner's module. Answer their question.\n\n"
        "- Ground the answer in the module's material below. Where the material "
        "doesn't cover it, say so and answer from general knowledge, clearly "
        "flagged.\n"
        "- Be direct and concrete. Two or three short paragraphs at most, plain "
        "text, British spelling.\n"
        "- Set intent to 'assessment' if they are asking whether their uploaded "
        "material is sufficient or what is missing from it, and 'resources' if "
        "they want links or videos to study from. In those two cases leave "
        "answer empty — something else handles them.\n\n"
        f"--- EXAM BLUEPRINT ---\n{_blueprint(domains) or '(no study plan yet)'}\n\n"
        f"--- MODULE SUMMARY ---\n{module.get('source_summary') or '(none)'}\n\n"
        f"--- UPLOADED SOURCES ---\n{_source_digest(sources)[:20000] or '(none)'}\n\n"
        + (f"--- CONVERSATION SO FAR ---\n{recent}\n\n" if recent else "")
        + f"--- QUESTION ---\n{question}"
    )

    try:
        response = _generate(
            "tutor-answer",
            model=settings.gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=ANSWER_SCHEMA,
                temperature=0.4,
            ),
        )
        data = json.loads(response.text)
    except json.JSONDecodeError as exc:
        raise TutorError(f"Model returned invalid JSON: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise TutorError(quota_hint(exc) or f"The tutor could not answer: {exc}") from exc

    intent = (data.get("intent") or "question").strip().lower()
    if intent not in ("question", "assessment", "resources"):
        intent = "question"
    return {"intent": intent, "answer": (data.get("answer") or "").strip()[:4000]}

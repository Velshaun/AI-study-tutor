"""The module tutor: answers about the material, and judges whether it's enough.

The question this exists for is "is what I've uploaded enough to pass?" — which
nothing could answer before, because the app knew what the exam covers (the
weighted domain blueprint) and what the learner uploaded (the parsed sources)
but never compared the two.

An assessment is that comparison, done per domain and weighted: a thin domain
worth 32% of the paper matters far more than a thin one worth 4%, and saying so
is the difference between a verdict and a list.

What the sources contain is no longer worked out here. `coverage` reads every
source in full, in chunks, and keeps the result; this module reads that map and
writes the verdict. The split matters: coverage is slow and cacheable, a verdict
is fast and wanted on demand, and mixing them is what forced the old 60,000-
character sample in the first place.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from app.config import settings
from app.database import get_supabase
from app.services import coverage
from app.services.domains import _generate, quota_hint

logger = logging.getLogger(__name__)


class TutorError(RuntimeError):
    """The tutor could not answer."""


# How much of each source the model reads directly. This is the digest used for
# ordinary questions, and the fallback for assessment where the coverage map is
# unavailable — a deployment whose migration hasn't run yet. An assessment
# proper reads the map, which has seen everything.
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

# The map-based assessment asks for less, because it knows more. Per-domain
# coverage is already settled by evidence gathered chunk by chunk, so the model
# is not invited to restate it — and so cannot contradict it. It writes the
# prose: the verdict, what's missing, and what to do next.
MAP_ASSESSMENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        key: ASSESSMENT_SCHEMA["properties"][key]
        for key in ("verdict", "readiness", "gaps", "recommendations")
    },
    "required": ["verdict", "readiness", "gaps", "recommendations"],
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


def coverage_state(module_id: str, user_id: str) -> tuple[str, dict[str, Any] | None]:
    """Whether a map-based assessment can be answered right now.

    ``ready`` with a map, ``computing`` while one is being built, ``stale`` when
    the sources or the blueprint have moved since the last one, or
    ``unavailable`` where the table doesn't exist yet and the sampled fallback
    is all there is.
    """
    if not coverage.available():
        return "unavailable", None

    context = module_context(module_id, user_id)
    stored = coverage.get_map(module_id, user_id)
    expected = coverage.fingerprint(context["sources"], context["domains"])
    if coverage.is_fresh(stored, expected):
        return "ready", stored
    if stored and stored.get("status") == "computing":
        # A read whose process died leaves a row that says it's still running.
        # Treating that as stale is what lets the next request restart it.
        return ("stale" if coverage.is_stalled(stored) else "computing"), stored
    return "stale", stored


def _map_digest(coverage_map: dict[str, Any]) -> str:
    """The coverage map as the model sees it — evidence, not raw text."""
    lines: list[str] = []
    for entry in coverage_map.get("domains") or []:
        topics = ", ".join(entry.get("topics") or []) or "nothing found"
        sources = ", ".join(entry.get("sources") or []) or "no source"
        lines.append(
            f"- {entry.get('title')} "
            f"({round(float(entry.get('weight_pct') or 0))}% of the exam) — "
            f"{entry.get('coverage')}, taught at '{entry.get('depth')}' depth, "
            f"found in {entry.get('chunk_hits') or 0} passage(s) of {sources}\n"
            f"    topics present: {topics}"
        )
    return "\n".join(lines)


def _analysis(coverage_map: dict[str, Any] | None) -> dict[str, Any]:
    """How the material was read — shown to the learner, who deserves to know."""
    if not coverage_map:
        return {"mode": "sampled", "chars_analysed": MAX_SOURCE_CHARS}
    return {
        "mode": "full",
        "chunk_count": coverage_map.get("chunk_count") or 0,
        "chars_analysed": coverage_map.get("chars_analysed") or 0,
        "truncated": bool(coverage_map.get("truncated")),
        "computed_at": coverage_map.get("computed_at"),
    }


def _assess_from_map(
    module: dict[str, Any], domains: list[dict[str, Any]],
    coverage_map: dict[str, Any], source_count: int,
) -> dict[str, Any]:
    """Write the verdict from a coverage map built by reading everything."""
    from google.genai import types

    subject = module.get("detected_subject") or module.get("title") or "this subject"
    prompt = (
        f"You are a subject-matter tutor for {subject}. A learner wants to know "
        "whether the material they have uploaded is enough to prepare for the "
        "exam.\n\n"
        "Every source has already been read in full and indexed against the "
        "exam blueprint. The COVERAGE MAP below is the result: for each domain, "
        "how well it is covered, how deeply it is taught, which files it came "
        "from, and which topics were actually found.\n\n"
        "- Trust the map. It comes from reading the whole pack, not a sample. "
        "Do not second-guess a domain's coverage, and do not claim something is "
        "missing that the map lists as present.\n"
        "- Weight your verdict: a thin domain worth 30% of the paper is a "
        "serious problem, a thin one worth 4% is barely worth mentioning.\n"
        "- gaps must name the specific topics the material doesn't cover, drawn "
        "from the missing and thinly covered domains, most important first.\n"
        "- recommendations must be things the learner can act on: what to "
        "upload, which topic to find material for, what to search.\n"
        "- Be honest. Do not soften a real gap, and do not invent one.\n\n"
        f"--- COVERAGE MAP ({source_count} source(s), "
        f"{coverage_map.get('chars_analysed') or 0} characters read across "
        f"{coverage_map.get('chunk_count') or 0} passages) ---\n"
        f"{_map_digest(coverage_map)}"
        + (
            "\n\nNOTE: the pack was larger than could be read in one pass, so "
            "the tail of the largest source was not indexed. Say so plainly in "
            "the verdict."
            if coverage_map.get("truncated") else ""
        )
    )

    try:
        response = _generate(
            "tutor-assess-map",
            model=settings.gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=MAP_ASSESSMENT_SCHEMA,
                temperature=0.2,
            ),
        )
        data = json.loads(response.text)
    except json.JSONDecodeError as exc:
        raise TutorError(f"Model returned invalid JSON: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise TutorError(quota_hint(exc) or f"Assessment failed: {exc}") from exc

    by_title = {(d.get("title") or "").lower(): d for d in domains}
    assessed = [
        {
            "title": entry.get("title") or "",
            "coverage": (
                entry.get("coverage")
                if entry.get("coverage") in COVERAGE_LEVELS else "partial"
            ),
            "depth": entry.get("depth") or "none",
            "topics": entry.get("topics") or [],
            "sources": entry.get("sources") or [],
            "note": _note(entry),
            "weight_pct": float(
                by_title.get((entry.get("title") or "").lower(), {}).get("weight_pct")
                or entry.get("weight_pct") or 0
            ),
        }
        for entry in coverage_map.get("domains") or []
    ]
    return _verdict(data, assessed, source_count, _analysis(coverage_map))


def _note(entry: dict[str, Any]) -> str:
    """A domain's one-liner, written from evidence rather than asked for.

    The map already knows what was found and where; paying a model to phrase
    that would be paying for a chance to get it wrong.
    """
    topics = entry.get("topics") or []
    sources = entry.get("sources") or []
    hits = entry.get("chunk_hits") or 0
    if not hits:
        return "Nothing in your sources covers this."

    where = (
        f"{sources[0]}" if len(sources) == 1
        else f"{len(sources)} of your sources"
    )

    # "Partial" because the sources only ever ask questions about this needs a
    # different sentence from "partial" because a textbook skims it. The advice
    # differs too: one wants teaching material, the other wants more of it.
    if entry.get("assessment_led") or entry.get("assessment_only"):
        return (
            f"Practice questions on this appear across {hits} passage"
            f"{'s' if hits != 1 else ''} of {where}, "
            "but nothing in your sources teaches it — you can test yourself here "
            "and not learn it. Worth adding a study guide or some lecture notes."
        )
    passages_text = f"{hits} passage{'s' if hits != 1 else ''} of {where}"
    depth = {
        "thorough": "Covered in depth",
        "overview": "Explained",
        "mention": "Only mentioned",
    }.get(entry.get("depth") or "", "Covered")
    if not topics:
        return f"{depth} across {passages_text}."

    # Topics keep the case the material gave them: capitalising the list would
    # turn TCP/IP into Tcp/ip, which is worse than no capital at all.
    listed = ", ".join(topics[:4])
    more = f", and {len(topics) - 4} more" if len(topics) > 4 else ""
    return f"{depth} across {passages_text}: {listed}{more}."


def _verdict(
    data: dict[str, Any], assessed: list[dict[str, Any]],
    source_count: int, analysis: dict[str, Any],
) -> dict[str, Any]:
    """The shared tail of both assessment paths."""
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
        "source_count": source_count,
        "analysis": analysis,
    }


def assess_material(
    module_id: str, user_id: str, *, coverage_map: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Judge how well the uploaded sources cover the exam this module is for.

    Given a coverage map, the judgement rests on every character of every
    source. Without one — a deployment where the migration hasn't run — it falls
    back to the sampled digest, which is what this did before and is honest
    about its limits in ``analysis.mode``.
    """
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

    if coverage_map and (coverage_map.get("domains") or []):
        return _assess_from_map(module, domains, coverage_map, len(sources))

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

    return _verdict(data, assessed, len(sources), _analysis(None))


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


INTENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "is_action": {
            "type": "boolean",
            "description": (
                "True only when the learner is asking for something to be "
                "DONE — created or deleted. A question about the material, "
                "however imperative it sounds, is not an action."
            ),
        },
        "steps": {
            "type": "array",
            "description": "In the order the learner asked for them.",
            "items": {
                "type": "object",
                "properties": {
                    "verb": {
                        "type": "string",
                        "description": (
                            "One of: generate_exam, generate_quiz, "
                            "generate_flashcards, delete_exam, delete_quiz. "
                            "Use nothing else. If what they asked for is not "
                            "in this list, leave steps empty and let the reply "
                            "explain."
                        ),
                    },
                    "count": {
                        "type": "integer",
                        "description": "How many. 1 unless they said otherwise.",
                    },
                    "from_missed": {
                        "type": "boolean",
                        "description": (
                            "True when they asked for it to come from their "
                            "missed or flagged questions."
                        ),
                    },
                    "how_many": {
                        "type": "string",
                        "description": (
                            "Only with from_missed. How many of the pool to "
                            "use: 'all', 'half', or a number as a string like "
                            "'30'. Default 'all'."
                        ),
                    },
                    "which": {
                        "type": "string",
                        "description": (
                            "Only with from_missed. Which of the pool: "
                            "'recent', 'oldest' or 'random'. Default 'recent'."
                        ),
                    },
                },
                "required": ["verb"],
            },
        },
        "reply": {
            "type": "string",
            "description": (
                "What to say. For an action, a short sentence describing what "
                "is about to happen. For anything refused, why — plainly, "
                "without apologising twice."
            ),
        },
    },
    "required": ["is_action", "steps", "reply"],
}


def read_intent(message: str, context: str = "") -> dict[str, Any]:
    """Is this a request to do something, and if so what?

    A separate, strict-schema call rather than tool-calling on the answering
    model. Two reasons. The answer path is a long grounded conversation and
    giving it the ability to act would mean every ordinary reply carried that
    risk. And a schema whose `verb` enumerates the allowlist in its own
    description keeps the model's output inside the vocabulary that
    `tutor_actions` will accept anyway — so a refusal is a sentence rather than
    a mismatch.
    """
    from google.genai import types

    try:
        response = _generate(
            "tutor-intent",
            model=settings.gemini_model,
            contents=(
                "Decide whether this message asks for something to be done in "
                "a study app, and plan it.\n\n"
                "Only these are possible: generating a practice exam, a quiz "
                "or flashcards, and deleting a practice exam or a quiz. "
                "Anything else — deleting a module, changing a score, editing "
                "a lecture — is not possible: say so in `reply` and leave "
                "`steps` empty.\n\n"
                "When they say the material should come from what they got "
                "wrong, set from_missed, and carry any scope they gave: "
                "how_many ('all', 'half', or a number) and which ('recent', "
                "'oldest', 'random'). \"a quiz on the thirty oldest\" is "
                "how_many='30', which='oldest'.\n\n"
                "A question about the subject is not an action, even phrased "
                "as an instruction: \"explain TCP handshakes\" is a question.\n\n"
                f"--- MODULE ---\n{context}\n\n"
                f"--- MESSAGE ---\n{message}"
            ),
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=INTENT_SCHEMA,
                temperature=0.0,
                # A classification against a five-verb allowlist, sitting in
                # front of every chat message. Thinking costs a second here and
                # buys nothing — see the note in qa.answer_question.
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        )
    except Exception as exc:  # noqa: BLE001
        logger.info("Intent read failed: %s", exc)
        return {"is_action": False, "steps": [], "reply": ""}

    import json

    try:
        data = json.loads(response.text or "{}")
    except (ValueError, TypeError):
        return {"is_action": False, "steps": [], "reply": ""}

    steps = []
    for step in data.get("steps") or []:
        verb = (step.get("verb") or "").strip()
        if not verb:
            continue
        # "30" comes back as a string from the schema; the dials take either,
        # but keeping the int here means the plan's description reads "the 30
        # oldest" rather than "the '30' oldest".
        how_many = (step.get("how_many") or "all").strip() or "all"
        if how_many not in ("all", "half"):
            try:
                how_many = int(how_many)
            except (TypeError, ValueError):
                how_many = "all"
        which = (step.get("which") or "recent").strip()
        if which not in ("recent", "oldest", "random"):
            which = "recent"

        steps.append({
            "verb": verb,
            "args": {
                "count": step.get("count") or 1,
                "from_missed": bool(step.get("from_missed")),
                "how_many": how_many,
                "which": which,
            },
        })
    return {
        "is_action": bool(data.get("is_action")) and bool(steps),
        "steps": steps,
        "reply": (data.get("reply") or "").strip(),
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

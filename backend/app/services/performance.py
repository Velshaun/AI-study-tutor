"""How well a learner knows each domain, and what to do about it.

Readiness (`routers/stats.py`) answers "how far through the material am I" from
effort and averages. This answers a narrower, harder question: on the evidence
of everything they have actually been graded on, how strong is each domain, and
where should the next questions come from.

Two numbers, deliberately, because one number cannot do both jobs.

The **display** score is what the learner sees. It rises quickly and falls
slowly, and it never drops far below the best they have demonstrated. A single
bad session after a good run is a bad session, not the loss of everything they
knew last week, and a progress bar that says otherwise teaches people to stop
taking practice exams.

The **internal** score is what the app plans with. It reacts fully and
immediately to a regression, because the right response to one bad sitting is
more questions from that domain — quietly, in what gets generated next, without
announcing that they have gone backwards.

The gap between the two is the whole design. Encouraging the learner and being
honest with the generator are different requirements, and collapsing them into
one figure means failing at one of them.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from app.database import get_supabase
from app.services import schema_features

logger = logging.getLogger(__name__)

# How fast the shown score moves. Asymmetric on purpose: a good result is
# believed most of the way, a bad one is absorbed slowly.
RISE_RATE = 0.6
FALL_RATE = 0.2
# The shown score is never allowed below this share of the best performance the
# learner has actually demonstrated — "favours demonstrated peak".
PEAK_FLOOR = 0.9
# The planning score, which reacts to a regression at full strength in both
# directions.
INTERNAL_RATE = 0.6
# Evidence below this many questions moves either score proportionately less: a
# 2-question sample is a hint, not a verdict.
FULL_EVIDENCE = 8
# How far the planning score must sit below the shown one before the generator
# treats the domain as having slipped.
REGRESSION_GAP = 8.0

STRONG_AT = 75.0
DEVELOPING_AT = 50.0
# Red needs a pattern, never one bad morning.
WEAK_MIN_ATTEMPTS = 2


def _client():
    return get_supabase()


def available() -> bool:
    """False until the migration lands, so callers fall back rather than 500."""
    return schema_features.has_column("exam_attempts", "id")


# --- gathering the evidence -------------------------------------------------
def _attempt_series(module_id: str, user_id: str) -> dict[str, list[dict[str, Any]]]:
    """Per-domain graded results, oldest first.

    Exam attempts and quizzes both count: they are the two things the learner
    has been *scored* on. Lecture progress and questions answered are effort,
    which readiness already weighs — counting them again here would let someone
    look strong for having pressed play.
    """
    client = _client()
    series: dict[str, list[dict[str, Any]]] = {}

    if available():
        rows = (
            client.table("exam_attempts")
            .select("id, kind, domain_results, submitted_at")
            .eq("module_id", module_id).eq("user_id", user_id)
            .order("submitted_at").execute()
        ).data or []
        for row in rows:
            for entry in row.get("domain_results") or []:
                domain_id = entry.get("domain_id")
                total = int(entry.get("total") or 0)
                if not domain_id or total <= 0:
                    continue
                series.setdefault(domain_id, []).append({
                    "pct": float(entry.get("pct") or 0),
                    "questions": total,
                    "at": row.get("submitted_at"),
                    "source": row.get("kind") or "practice",
                })

    quiz_rows = (
        client.table("quizzes")
        .select("domain_id, score, question_count, created_at")
        .eq("module_id", module_id).eq("user_id", user_id)
        .not_.is_("score", "null").order("created_at").execute()
    ).data or []
    for row in quiz_rows:
        if not row.get("domain_id"):
            continue
        series.setdefault(row["domain_id"], []).append({
            "pct": float(row.get("score") or 0),
            "questions": int(row.get("question_count") or 0) or FULL_EVIDENCE,
            "at": row.get("created_at"),
            "source": "quiz",
        })

    for entries in series.values():
        entries.sort(key=lambda e: str(e.get("at") or ""))
    return series


# --- the model --------------------------------------------------------------
def _evidence_weight(questions: int) -> float:
    """How much one result is allowed to move a score."""
    return min(1.0, max(questions, 0) / FULL_EVIDENCE)


def score_domain(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """Turn one domain's graded history into the two scores and a verdict."""
    if not entries:
        return {
            "display": None, "internal": None, "peak": None, "session": None,
            "attempts": 0, "questions": 0, "status": "untouched",
            "trend": "none", "regressed": False,
        }

    display: float | None = None
    internal: float | None = None
    peak = 0.0

    for entry in entries:
        pct = max(0.0, min(100.0, entry["pct"]))
        weight = _evidence_weight(entry["questions"])
        peak = max(peak, pct)

        if display is None:
            display = pct
            internal = pct
            continue
        rate = RISE_RATE if pct > display else FALL_RATE
        display += (pct - display) * rate * weight
        internal += (pct - internal) * INTERNAL_RATE * weight

    # Never further below the best they have shown than PEAK_FLOOR allows. This
    # is what stops a strong history being wiped by one poor sitting.
    display = max(display or 0.0, peak * PEAK_FLOOR)
    display = round(min(100.0, display), 1)
    internal = round(max(0.0, min(100.0, internal or 0.0)), 1)

    session = round(entries[-1]["pct"], 1)
    previous = entries[-2]["pct"] if len(entries) > 1 else None
    trend = "none"
    if previous is not None:
        if session > previous + 2:
            trend = "up"
        elif session < previous - 2:
            trend = "down"
        else:
            trend = "steady"

    # Red is a pattern, not an event: it needs a low shown score, a low planning
    # score, and more than one sitting to have produced them.
    if display >= STRONG_AT:
        status = "strong"
    elif (
        display < DEVELOPING_AT
        and internal < DEVELOPING_AT
        and len(entries) >= WEAK_MIN_ATTEMPTS
    ):
        status = "weak"
    else:
        status = "developing"

    return {
        "display": display,
        "internal": internal,
        "peak": round(peak, 1),
        "session": session,
        "attempts": len(entries),
        "questions": sum(e["questions"] for e in entries),
        "status": status,
        "trend": trend,
        "regressed": internal < display - REGRESSION_GAP,
    }


def session_note(scored: dict[str, Any]) -> str:
    """What to say about today, without taking the week away from them.

    Every branch here is written to be true and to be survivable. "You slipped a
    little" is both; "dropped from 71% to 43%" is only the first.
    """
    session, display = scored.get("session"), scored.get("display")
    if session is None or display is None:
        return ""
    if scored["attempts"] == 1:
        return "First time through this one — that's your starting point."
    if session >= display + 5:
        return "Your best run here yet — that's real progress."
    if session >= display - 5:
        return "Holding steady, right about where you've been."
    # A wide band, on purpose. Losing two marks out of seven after a run of
    # fives is the ordinary shape of a bad evening, and the shown score has
    # barely moved for it — calling that anything heavier than a slip would
    # contradict the number sitting next to it.
    if session >= display - 30:
        return "You slipped a little here — keep at it."
    return "A tougher session than usual. One off day doesn't undo the rest."


def for_module(module_id: str, user_id: str) -> list[dict[str, Any]]:
    """Every domain of a module, scored, in blueprint order."""
    domains = (
        _client().table("domains")
        .select("id, title, weight_pct, order_index")
        .eq("module_id", module_id).eq("user_id", user_id)
        .order("order_index").execute()
    ).data or []
    if not domains:
        return []

    series = _attempt_series(module_id, user_id)
    out = []
    for domain in domains:
        scored = score_domain(series.get(domain["id"], []))
        out.append({
            "domain_id": domain["id"],
            "title": domain.get("title") or "",
            "weight_pct": float(domain.get("weight_pct") or 0),
            "note": session_note(scored),
            **scored,
        })
    return out


# --- what to generate next --------------------------------------------------
def need_multiplier(scored: dict[str, Any]) -> float:
    """How much extra attention this domain has earned.

    Weakness buys questions; strength gives them up. An untouched domain sits at
    1.0 — unknown is not the same as weak, and the exam's own weighting is
    already the right prior for something never tested.
    """
    internal = scored.get("internal")
    if internal is None:
        return 1.0
    if internal >= 80:
        multiplier = 0.5   # review, not study
    elif internal >= 60:
        multiplier = 1.0
    elif internal >= 40:
        multiplier = 1.5
    else:
        multiplier = 2.0
    if scored.get("regressed"):
        multiplier *= 1.25
    return multiplier


def adaptive_weights(module_id: str, user_id: str) -> dict[str, float]:
    """Per-domain generation weight: exam weight, bent towards what's weak.

    Returns {domain_id: weight}. Empty when there is no performance data at all,
    so callers fall straight back to the published exam weighting rather than
    inventing a preference from nothing.
    """
    scored = for_module(module_id, user_id)
    if not any(d["attempts"] for d in scored):
        return {}
    return {
        d["domain_id"]: max(0.0, d["weight_pct"] or 0.0) * need_multiplier(d)
        for d in scored
    }


def focus_hint(module_id: str, user_id: str, domain_id: str) -> str:
    """A line for a generator's prompt about where this domain is shaky.

    Empty when there is nothing to say, so a prompt never carries a sentence
    that means "we know nothing about you".
    """
    for entry in for_module(module_id, user_id):
        if entry["domain_id"] != domain_id or not entry["attempts"]:
            continue
        if entry["status"] == "strong" and not entry["regressed"]:
            return (
                "The learner is already strong here. Favour consolidation and "
                "the harder edges of the topic over the basics."
            )
        if entry["status"] == "weak" or entry["regressed"]:
            return (
                "The learner has been getting questions wrong in this domain. "
                "Cover its core ideas directly and plainly before anything "
                "exotic, and make sure the fundamentals are represented."
            )
        return (
            "The learner is part-way with this domain. Mix core recall with a "
            "few questions that need the ideas applied."
        )
    return ""


# --- attempts ---------------------------------------------------------------
def record_attempt(
    *, exam_id: str, module_id: str | None, user_id: str, kind: str,
    score: float, correct: int, total: int, pass_pct: float | None,
    passed: bool | None, domain_results: list[dict[str, Any]],
    summary: dict[str, Any],
) -> str | None:
    """Keep a sitting. Returns the attempt id, or None where it can't be kept."""
    if not available():
        return None
    try:
        row = (
            _client().table("exam_attempts").insert({
                "exam_id": exam_id,
                "module_id": module_id,
                "user_id": user_id,
                "kind": kind,
                "score": score,
                "correct": correct,
                "total": total,
                "pass_pct": pass_pct,
                "passed": passed,
                "domain_results": domain_results,
                "summary": summary,
                "submitted_at": datetime.now(timezone.utc).isoformat(),
            }).execute()
        ).data or []
        return row[0]["id"] if row else None
    except Exception as exc:  # noqa: BLE001 — a lost record must not lose the grade
        logger.warning("Could not record exam attempt for %s: %s", exam_id, exc)
        return None


SUMMARY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "verdict": {
            "type": "string",
            "description": (
                "Two or three sentences on how this attempt went, addressed to "
                "the learner. Honest about the result and about what it means "
                "for the real exam, without either flattering or scolding."
            ),
        },
        "strengths": {
            "type": "array", "items": {"type": "string"},
            "description": "Domains they did well in, and what that shows.",
        },
        "gaps": {
            "type": "array", "items": {"type": "string"},
            "description": (
                "Where the marks were lost, heaviest-weighted domain first."
            ),
        },
        "next_steps": {
            "type": "array", "items": {"type": "string"},
            "description": (
                "What to do next, concretely: which domain to study and which "
                "of lecture, flashcards or quiz to reach for. Three at most."
            ),
        },
    },
    "required": ["verdict", "strengths", "gaps", "next_steps"],
}


def _fallback_summary(
    domain_results: list[dict[str, Any]], score: float, passed: bool | None,
) -> dict[str, Any]:
    """A summary written from the numbers, for when the model can't be reached.

    A missing paragraph of prose is not a reason to show the learner nothing:
    the breakdown is the substance, and this says the obvious things about it.
    """
    ranked = sorted(
        [d for d in domain_results if d.get("total")],
        key=lambda d: (d.get("pct", 0), -(d.get("weight_pct") or 0)),
    )
    weak = [d for d in ranked if d.get("pct", 0) < 60]
    strong = [d for d in reversed(ranked) if d.get("pct", 0) >= 75]
    return {
        "verdict": (
            f"You scored {round(score)}%"
            + (
                " — a pass on this paper." if passed
                else " — not a pass yet on this paper." if passed is False
                else "."
            )
            + (
                f" The marks mostly went in {weak[0]['title']}." if weak else
                " The marks were spread fairly evenly."
            )
        ),
        "strengths": [
            f"{d['title']} — {d['correct']} of {d['total']}" for d in strong[:3]
        ],
        "gaps": [
            f"{d['title']} — {d['correct']} of {d['total']}, worth "
            f"{round(d.get('weight_pct') or 0)}% of the exam"
            for d in weak[:4]
        ],
        "next_steps": [
            f"Work through {d['title']} again — lecture first, then a quiz."
            for d in weak[:3]
        ],
        "written_by": "rules",
    }


def summarise_attempt(
    *, subject: str, score: float, correct: int, total: int,
    pass_pct: float | None, passed: bool | None,
    domain_results: list[dict[str, Any]], is_baseline: bool,
) -> dict[str, Any]:
    """The plain-language read on a sitting. Never raises."""
    from app.config import settings

    if not settings.gemini_api_key or not domain_results:
        return _fallback_summary(domain_results, score, passed)

    try:
        import json

        from google.genai import types

        from app.services.domains import _generate

        table = "\n".join(
            f"- {d['title']}: {d['correct']} of {d['total']} correct "
            f"({round(d.get('pct') or 0)}%), worth "
            f"{round(d.get('weight_pct') or 0)}% of the real exam"
            for d in domain_results if d.get("total")
        )
        prompt = (
            f"You are a tutor for {subject} reading a learner's "
            + ("baseline assessment, taken before they studied"
               if is_baseline else "practice exam")
            + ".\n\n"
            f"They scored {correct} of {total} ({round(score)}%)"
            + (f", against a pass mark of {round(pass_pct)}%" if pass_pct else "")
            + ".\n\n"
            "- Weight everything by the domain's share of the real exam. Losing "
            "marks in a domain worth 30% is the story; losing them in one worth "
            "4% is a footnote.\n"
            "- Be straight with them. Do not soften a failing result into a "
            "good one, and do not lecture them about a good one.\n"
            + (
                "- This is a starting point, taken before any studying. Frame "
                "it as a map of where to begin, never as a failure.\n"
                if is_baseline else
                "- Say plainly whether this is exam-ready standard yet.\n"
            )
            + "- next_steps must name a domain and a thing to do: a lecture, a "
            "flashcard deck, a quiz.\n"
            "- British spelling. Address them as 'you'.\n\n"
            f"--- PER-DOMAIN RESULT ---\n{table}"
        )
        response = _generate(
            "exam-summary",
            model=settings.gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=SUMMARY_SCHEMA,
                temperature=0.3,
            ),
        )
        data = json.loads(response.text)
        return {
            "verdict": (data.get("verdict") or "").strip()[:800],
            "strengths": [str(s).strip()[:220] for s in (data.get("strengths") or [])][:4],
            "gaps": [str(g).strip()[:220] for g in (data.get("gaps") or [])][:5],
            "next_steps": [
                str(n).strip()[:220] for n in (data.get("next_steps") or [])
            ][:3],
            "written_by": "ai",
        }
    except Exception as exc:  # noqa: BLE001 — the grade must land regardless
        logger.warning("Exam summary generation failed: %s", exc)
        return _fallback_summary(domain_results, score, passed)


def baseline(module_id: str, user_id: str) -> dict[str, Any] | None:
    """The pre-assessment this module was measured from, if one was taken."""
    if not available():
        return None
    rows = (
        _client().table("exam_attempts").select("*")
        .eq("module_id", module_id).eq("user_id", user_id)
        .eq("kind", "pre_assessment")
        .order("submitted_at").limit(1).execute()
    ).data or []
    return rows[0] if rows else None


def comparison(module_id: str, user_id: str) -> dict[str, Any] | None:
    """Where you started against where you are, overall and per domain.

    The baseline is the pre-assessment, which a module gets exactly one of — the
    database enforces that, because a second one would silently move the line
    the learner measures themselves against.

    The "now" side is the most recent *practice* sitting rather than the best
    one. A personal best is a nice thing to have and a bad thing to plan from;
    the useful question here is whether the work is paying off lately.

    Returns None when there is nothing to compare — no baseline, or a baseline
    and nothing since. A comparison of a thing against itself reads as no
    progress, which is not what "you have only sat this once" means.
    """
    if not available():
        return None

    start = baseline(module_id, user_id)
    if not start:
        return None

    later = (
        _client().table("exam_attempts").select("*")
        .eq("module_id", module_id).eq("user_id", user_id)
        .eq("kind", "practice")
        .order("submitted_at", desc=True).limit(1).execute()
    ).data or []
    if not later:
        return {"baseline": _side(start), "latest": None, "domains": [], "delta": None}

    now = later[0]
    by_domain: dict[str, dict[str, Any]] = {}
    for row in start.get("domain_results") or []:
        key = row.get("domain_id") or row.get("title")
        if key:
            by_domain[key] = {
                "domain_id": row.get("domain_id"),
                "title": row.get("title") or "",
                "then": _pct(row),
                "now": None,
            }
    for row in now.get("domain_results") or []:
        key = row.get("domain_id") or row.get("title")
        if not key:
            continue
        entry = by_domain.setdefault(key, {
            "domain_id": row.get("domain_id"),
            "title": row.get("title") or "",
            "then": None,
        })
        entry["now"] = _pct(row)

    domains = []
    for entry in by_domain.values():
        then, now_pct = entry.get("then"), entry.get("now")
        # A domain the baseline never covered has nothing to be measured
        # against, and showing it as a rise from zero would be an invention.
        entry["delta"] = (
            round(now_pct - then, 1)
            if then is not None and now_pct is not None else None
        )
        domains.append(entry)
    domains.sort(key=lambda d: (d["delta"] is None, -(d["delta"] or 0)))

    return {
        "baseline": _side(start),
        "latest": _side(now),
        "delta": round(float(now.get("score") or 0) - float(start.get("score") or 0), 1),
        "domains": domains,
    }


def _side(attempt: dict[str, Any]) -> dict[str, Any]:
    return {
        "score": float(attempt.get("score") or 0),
        "correct": attempt.get("correct") or 0,
        "total": attempt.get("total") or 0,
        "submitted_at": attempt.get("submitted_at"),
        "exam_id": attempt.get("exam_id"),
        # The per-question record, which `exam_attempts` never held — it stores
        # domain totals. `study_sessions` does, so the permanent baseline record
        # is a lookup rather than a schema change.
        "results": _session_results(attempt.get("exam_id")),
    }


def _session_results(exam_id: str | None) -> list[dict[str, Any]]:
    """The questions of a sitting, if a session was recorded for it.

    Empty for anything sat before sessions existed, which the baseline card
    handles by simply not offering to expand.
    """
    if not exam_id or not schema_features.has_column("study_sessions", "results"):
        return []
    rows = (
        _client().table("study_sessions").select("results")
        .eq("item_id", exam_id).order("created_at").limit(1).execute()
    ).data or []
    return (rows[0].get("results") if rows else []) or []


def _pct(row: dict[str, Any]) -> float | None:
    """A domain result's percentage, however that attempt recorded it."""
    if row.get("score") is not None:
        return round(float(row["score"]), 1)
    total = row.get("total") or 0
    if not total:
        return None
    return round((row.get("correct") or 0) / total * 100, 1)


def attempt_count(module_id: str, user_id: str) -> int:
    if not available():
        return 0
    result = (
        _client().table("exam_attempts").select("id", count="exact")
        .eq("module_id", module_id).eq("user_id", user_id).execute()
    )
    return result.count or len(result.data or [])

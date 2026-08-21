"""Letting the tutor do things, without letting it do anything.

The tutor could always answer questions about a module. This lets it act on one
— "make a practice exam from my missed questions", "delete the last two exams
and generate two new ones" — and that is a different kind of thing entirely: a
natural-language sentence becoming a mutation.

Three rules hold it together.

**Every action calls an existing endpoint handler.** Not the tables, and not a
parallel implementation. The handlers already refuse to delete a domain whose
questions are in a sat exam, already check that a module belongs to the person
asking, already cap exam length and freeze weights. Reaching past them to the
database would mean re-implementing each of those guards, correctly, forever.
Calling them means a guard added later applies here without anyone remembering
to.

**The verb list is an allowlist, not a filter.** Anything not named here cannot
be done, whatever the sentence said. A model that has learned to describe an
action it cannot name produces a refusal rather than an approximation.

**Nothing destructive runs before the learner has seen it named.** Planning and
executing are separate calls: the plan comes back describing exactly what would
happen, the chat asks, and only then does anything fire. The confirmation is not
a dialog the model can talk its way past, because the model is not involved in
the second call at all.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from app.database import get_supabase

logger = logging.getLogger(__name__)

# Verbs the tutor may use. Everything else is refused, including things the app
# can do — being able to do something is not the same as being safe to do from
# a sentence.
CREATE_VERBS = ("generate_exam", "generate_quiz", "generate_flashcards")
DESTRUCTIVE_VERBS = ("delete_exam", "delete_quiz")
VERBS = CREATE_VERBS + DESTRUCTIVE_VERBS


def is_destructive(verb: str) -> bool:
    return verb in DESTRUCTIVE_VERBS


@dataclass
class Action:
    """One thing to do, named in the learner's terms as well as the app's."""

    verb: str
    args: dict[str, Any] = field(default_factory=dict)
    # What the confirmation will say. Written when the plan is built, so the
    # sentence the learner approves is the sentence that was planned — not one
    # regenerated later from the same arguments.
    describe: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "verb": self.verb,
            "args": self.args,
            "describe": self.describe,
            "destructive": is_destructive(self.verb),
        }


def _client():
    return get_supabase()


# --- naming things the learner referred to ---------------------------------
def recent_exams(module_id: str, user_id: str, limit: int = 10) -> list[dict[str, Any]]:
    """The module's exams, newest first.

    "The last two practice exams" is a phrase about ordering, and resolving it
    has to happen here rather than in the model: a model asked to remember ids
    will occasionally produce one that does not exist, and deleting by a
    hallucinated id is the failure this whole module is arranged to prevent.
    """
    return (
        _client().table("practice_exams")
        .select("id, title, created_at, kind")
        .eq("module_id", module_id).eq("user_id", user_id)
        .order("created_at", desc=True).limit(limit).execute()
    ).data or []


def recent_quizzes(module_id: str, user_id: str, limit: int = 10) -> list[dict[str, Any]]:
    return (
        _client().table("quizzes")
        .select("id, title, created_at")
        .eq("module_id", module_id).eq("user_id", user_id)
        .order("created_at", desc=True).limit(limit).execute()
    ).data or []


def protected_exam_ids(module_id: str, user_id: str) -> set[str]:
    """Exams that have been sat, and so are somebody's record.

    Not a hard refusal — the delete endpoint decides that, and this module does
    not get to have its own opinion about what may be deleted. It is used to
    *say so in the confirmation*, because "delete the last two exams" meaning
    "delete the one you sat on Tuesday" is exactly the thing worth naming before
    it happens.
    """
    rows = (
        _client().table("exam_attempts").select("exam_id")
        .eq("module_id", module_id).eq("user_id", user_id).execute()
    ).data or []
    return {r["exam_id"] for r in rows if r.get("exam_id")}


# --- planning ---------------------------------------------------------------
def plan_from_intent(
    intent: dict[str, Any], *, module_id: str, user_id: str,
) -> tuple[list[Action], list[str]]:
    """Turn the model's structured intent into concrete, resolvable actions.

    Returns the actions and any refusals. A refusal is not an error: "I can't
    delete a lecture" is a perfectly good answer, and it is a much better one
    than a plausible-looking action that does something adjacent.
    """
    actions: list[Action] = []
    refusals: list[str] = []

    for step in intent.get("steps") or []:
        verb = (step.get("verb") or "").strip()
        args = step.get("args") or {}

        if verb not in VERBS:
            refusals.append(
                f"I can't do that ({verb or 'unrecognised'}) from here — "
                "try the buttons on the module screen."
            )
            continue

        if verb == "delete_exam":
            actions.extend(_plan_deletes(args, module_id, user_id, refusals))
        elif verb == "delete_quiz":
            actions.extend(_plan_quiz_deletes(args, module_id, user_id, refusals))
        else:
            actions.append(_plan_create(verb, args, module_id))

    return actions, refusals


def _plan_deletes(
    args: dict[str, Any], module_id: str, user_id: str, refusals: list[str],
) -> list[Action]:
    count = _as_count(args.get("count"), default=1)
    exams = recent_exams(module_id, user_id)
    # A baseline is the line every later sitting is measured against, and the
    # database already refuses a second one — so deleting it is not something a
    # sentence should be able to do by accident.
    candidates = [e for e in exams if e.get("kind") != "pre_assessment"]
    if not candidates:
        refusals.append("There are no practice exams here to delete.")
        return []

    protected = protected_exam_ids(module_id, user_id)
    chosen = candidates[:count]
    out = []
    for exam in chosen:
        sat = exam["id"] in protected
        out.append(Action(
            verb="delete_exam",
            args={"exam_id": exam["id"]},
            describe=(
                f"Delete “{exam.get('title') or 'Practice exam'}”"
                + (" — you have already sat this one" if sat else "")
            ),
        ))
    if len(chosen) < count:
        refusals.append(
            f"You asked for {count} but there {'is' if len(chosen) == 1 else 'are'} "
            f"only {len(chosen)}."
        )
    return out


def _plan_quiz_deletes(
    args: dict[str, Any], module_id: str, user_id: str, refusals: list[str],
) -> list[Action]:
    count = _as_count(args.get("count"), default=1)
    quizzes = recent_quizzes(module_id, user_id)[:count]
    if not quizzes:
        refusals.append("There are no quizzes here to delete.")
        return []
    return [
        Action(verb="delete_quiz", args={"quiz_id": q["id"]},
               describe=f"Delete “{q.get('title') or 'Quiz'}”")
        for q in quizzes
    ]


def _plan_create(verb: str, args: dict[str, Any], module_id: str) -> Action:
    from_container = bool(args.get("from_missed") or args.get("from_container"))
    label = {
        "generate_exam": "practice exam",
        "generate_quiz": "quiz",
        "generate_flashcards": "flashcards",
    }[verb]
    count = _as_count(args.get("count"), default=1, ceiling=5)
    return Action(
        verb=verb,
        args={
            "module_id": module_id,
            "domain_id": args.get("domain_id"),
            "count": count,
            "from_container": from_container,
            "how_many": args.get("how_many", "all"),
            "which": args.get("which", "recent"),
        },
        describe=(
            f"Generate {count} {label}{'s' if count != 1 else ''}"
            + (" from your missed questions" if from_container else "")
        ),
    )


def _as_count(value: Any, *, default: int = 1, ceiling: int = 10) -> int:
    """A count the learner asked for, clamped to something survivable.

    "Delete them all" and "make me twenty exams" are both sentences someone will
    type, and neither should be taken entirely literally by something acting on
    their behalf.
    """
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, min(n, ceiling))


# --- executing --------------------------------------------------------------
async def execute(
    actions: list[dict[str, Any]], *, user, module_id: str,
) -> list[dict[str, Any]]:
    """Run an approved plan, one action at a time.

    Each call goes through the endpoint handler that owns it, so every guard
    those handlers carry — ownership, sat-exam protection, exam sizing, frozen
    weights — applies without being restated here. That is the whole design:
    this module knows *which* things may be done, and nothing about whether any
    particular one is allowed.
    """
    from app.routers import flashcards as flashcards_router
    from app.routers import practice_exam as exam_router
    from app.routers import quizzes as quiz_router

    done: list[dict[str, Any]] = []
    for raw in actions:
        verb = raw.get("verb")
        args = raw.get("args") or {}
        if verb not in VERBS:
            done.append({"verb": verb, "ok": False,
                         "detail": "That isn't something I can do."})
            continue

        try:
            if verb == "delete_exam":
                await exam_router.delete_exam(args["exam_id"], user=user)
                detail = "Deleted."
            elif verb == "delete_quiz":
                await quiz_router.delete_quiz(args["quiz_id"], user=user)
                detail = "Deleted."
            elif verb == "generate_exam":
                detail = await _generate_exams(exam_router, args, user, module_id)
            elif verb == "generate_quiz":
                detail = await _generate_quizzes(quiz_router, args, user, module_id)
            else:
                detail = await _generate_cards(flashcards_router, args, user, module_id)
            done.append({"verb": verb, "ok": True, "detail": detail,
                         "describe": raw.get("describe", "")})
        except Exception as exc:  # noqa: BLE001
            # A refusal from a handler is information, not a crash: "that exam
            # has been sat" is exactly what the learner needs to read.
            detail = getattr(exc, "detail", None) or str(exc)
            logger.info("Tutor action %s refused: %s", verb, detail)
            done.append({"verb": verb, "ok": False, "detail": str(detail),
                         "describe": raw.get("describe", "")})
    return done


async def _generate_exams(router, args, user, module_id) -> str:
    made = 0
    for _ in range(args.get("count", 1)):
        payload = router.GenerateRequest(module_id=module_id)
        await router.generate_exam(payload, user=user)
        made += 1
    return f"Made {made} practice exam{'s' if made != 1 else ''}."


async def _generate_quizzes(router, args, user, module_id) -> str:
    domain_id = args.get("domain_id") or _first_domain(module_id, user.id)
    if not domain_id:
        return "There are no domains in this module to build a quiz from yet."
    made = 0
    for _ in range(args.get("count", 1)):
        await router.generate(router.GenerateRequest(domain_id=domain_id), user=user)
        made += 1
    return f"Made {made} quiz{'zes' if made != 1 else ''}."


async def _generate_cards(router, args, user, module_id) -> str:
    domain_id = args.get("domain_id") or _first_domain(module_id, user.id)
    if not domain_id:
        return "There are no domains in this module to build cards from yet."
    await router.generate_flashcards(
        router.GenerateRequest(domain_id=domain_id), user=user,
    )
    return "Made a set of flashcards."


def _first_domain(module_id: str, user_id: str) -> str | None:
    """Where to put something the learner didn't place.

    The first examined domain, not a random one: a module's domains are ordered
    by the blueprint, and the first is where a course starts.
    """
    rows = (
        _client().table("domains").select("id, weight_pct, status")
        .eq("module_id", module_id).eq("user_id", user_id)
        .order("order_index").execute()
    ).data or []
    for row in rows:
        if (row.get("weight_pct") or 0) or row.get("status") != "locked":
            return row["id"]
    return rows[0]["id"] if rows else None

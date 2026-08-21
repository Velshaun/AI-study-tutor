"""The two containers: what you got wrong, and what you asked about.

`missed` collects wrong answers and flags from exams, quizzes and flashcards.
`qa` collects questions put to the tutor during a lecture. They behave
identically, with one exception enforced in `can_generate`: Q&A cannot produce a
lecture, because it came from one.

Three rules shape everything here.

**Nothing enters the missed container silently.** Its entries are written only
by an explicit call from the end-of-session confirmation. A container that fills
itself is one nobody trusts, and one nobody prunes.

Q&A is the exception, and deliberately so: there is nothing to confirm, because
asking the question *was* the deliberate act. The missed container collects
things a learner would rather not have produced, so it asks first; this one
collects things they went out of their way to ask, so asking again would be
asking twice.

**Nothing leaves silently either.** Auto-graduation retires an entry after two
correct answers in a row, and records `graduated_at` rather than deleting — a
retired question is worth seeing as retired.

**The containers are opt-in and isolated.** Nothing in ordinary generation
reads this module. The only readers are the container screens and generation
explicitly scoped to a container, which is why every read here takes an explicit
`container` argument rather than defaulting to one.
"""

from __future__ import annotations

import logging
import random
from datetime import datetime, timezone
from typing import Any

from app.database import get_supabase
from app.services import schema_features

logger = logging.getLogger(__name__)

MISSED = "missed"
QA = "qa"
CONTAINERS = (MISSED, QA)

# Correct answers in a row before an entry retires itself.
GRADUATION_STREAK = 2

# What a generated set may contain. "Everything" respects this and says so —
# a 400-question exam is not a study session, it is a denial of service on an
# evening.
MAX_GENERATED = 100

# What each container may be turned into. Q&A came from a lecture, so making a
# lecture from it would be a circle.
GENERATABLE = {
    MISSED: ("practice_exam", "quiz", "flashcards"),
    QA: ("practice_exam", "quiz", "flashcards"),
}


def available() -> bool:
    return schema_features.has_column("question_bank", "container")


def can_generate(container: str, media: str) -> bool:
    return media in GENERATABLE.get(container, ())


def _client():
    return get_supabase()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# --- writing ----------------------------------------------------------------
def add_from_session(
    *, user_id: str, module_id: str, container: str, entries: list[dict[str, Any]],
) -> dict[str, int]:
    """Put a session's missed and flagged items into a container.

    Called from the confirmation prompt and nowhere else. Re-missing something
    already banked updates that entry rather than adding a second copy — and
    resets its streak, because getting it wrong again is exactly the evidence
    that it has not been learnt.
    """
    if not available() or not entries:
        return {"added": 0, "updated": 0}

    client = _client()
    added = updated = 0

    for entry in entries:
        source_id = entry.get("source_id")
        row = {
            "user_id": user_id,
            "module_id": module_id,
            "container": container,
            "source_kind": entry.get("source_kind") or "practice_question",
            "source_id": source_id,
            "domain_id": entry.get("domain_id"),
            "missed": bool(entry.get("missed")),
            "flagged": bool(entry.get("flagged")),
            "snapshot": entry.get("snapshot") or {},
            "updated_at": _now(),
        }

        existing = []
        if source_id:
            existing = (
                client.table("question_bank").select("id, missed, flagged")
                .eq("user_id", user_id).eq("module_id", module_id)
                .eq("container", container).eq("source_id", source_id)
                .limit(1).execute()
            ).data or []

        if existing:
            prior = existing[0]
            patch = {
                # Reasons accumulate: flagged last time and missed this time is
                # both, and forgetting either loses why it is here.
                "missed": bool(prior.get("missed")) or row["missed"],
                "flagged": bool(prior.get("flagged")) or row["flagged"],
                "snapshot": row["snapshot"] or None,
                "updated_at": row["updated_at"],
            }
            if row["missed"]:
                # Wrong again — the streak was not a streak.
                patch["correct_streak"] = 0
                patch["graduated_at"] = None
            patch = {k: v for k, v in patch.items() if v is not None}
            client.table("question_bank").update(patch).eq("id", prior["id"]).execute()
            updated += 1
        else:
            client.table("question_bank").insert(row).execute()
            added += 1

    logger.info(
        "Question bank (%s) for module %s: %d added, %d updated",
        container, module_id, added, updated,
    )
    return {"added": added, "updated": updated}


def mirror_lecture_qa(
    *, user_id: str, module_id: str | None, exchange_id: str,
    question: str, answer: str, domain_id: str | None = None,
) -> bool:
    """Put a lecture exchange into the Q&A container as it happens.

    The one container that fills without a confirmation prompt, and the reason
    is that there is nothing to confirm: asking the question *was* the deliberate
    act. The missed container collects things the learner would rather not have
    produced, so it asks first; this collects things they went out of their way
    to ask, so asking again would be asking twice.

    Best-effort. A lecture must not fail because a mirror write did — the
    exchange itself is already saved in `lecture_qa`, which stays the record of
    record.
    """
    if not available() or not module_id or not question.strip():
        return False
    try:
        _client().table("question_bank").insert({
            "user_id": user_id,
            "module_id": module_id,
            "container": QA,
            "source_kind": "lecture_qa",
            "source_id": exchange_id,
            "domain_id": domain_id,
            # Neither missed nor flagged: it is here because it was asked.
            "missed": False,
            "flagged": False,
            "snapshot": {
                "question": question[:2000],
                "answer": (answer or "")[:4000],
                # `prompt` as well, so everything downstream that reads a
                # question — the list, the flashcard writer, the dials — sees
                # one shape and does not need to know where an entry came from.
                "prompt": question[:2000],
            },
        }).execute()
        return True
    except Exception as exc:  # noqa: BLE001
        logger.info("Could not mirror exchange %s into the Q&A container: %s",
                    exchange_id, exc)
        return False


def record_answer(bank_entry_id: str, correct: bool) -> dict[str, Any] | None:
    """Update an entry's streak after it was answered again.

    The whole of auto-graduation. Called when a question carrying a
    `bank_entry_id` is answered, which only happens for questions generated
    *from* a container — an ordinary question has no entry to update.
    """
    if not available() or not bank_entry_id:
        return None

    rows = (
        _client().table("question_bank").select("id, correct_streak")
        .eq("id", bank_entry_id).limit(1).execute()
    ).data or []
    if not rows:
        return None

    streak = (rows[0].get("correct_streak") or 0) + 1 if correct else 0
    patch: dict[str, Any] = {"correct_streak": streak, "updated_at": _now()}
    if correct and streak >= GRADUATION_STREAK:
        patch["graduated_at"] = _now()
        logger.info("Bank entry %s graduated after %d correct in a row",
                    bank_entry_id, streak)
    elif not correct:
        # Coming back from retirement is the honest outcome of getting it wrong
        # again — it clearly wasn't learnt.
        patch["graduated_at"] = None

    _client().table("question_bank").update(patch).eq("id", bank_entry_id).execute()
    return {"streak": streak, "graduated": bool(patch.get("graduated_at"))}


def delete_entry(entry_id: str, user_id: str) -> bool:
    """Remove one entry outright — the manual delete inside a container."""
    if not available():
        return False
    result = (
        _client().table("question_bank").delete()
        .eq("id", entry_id).eq("user_id", user_id).execute()
    )
    return bool(result.data)


# --- reading ----------------------------------------------------------------
def list_entries(
    *, user_id: str, module_id: str, container: str,
    include_graduated: bool = False,
) -> list[dict[str, Any]]:
    """One container's entries, oldest first.

    Oldest first because that is the order the scoping dial's "oldest" wants,
    and reversing a list is cheaper than a second query.
    """
    if not available():
        return []
    query = (
        _client().table("question_bank").select("*")
        .eq("user_id", user_id).eq("module_id", module_id)
        .eq("container", container)
    )
    if not include_graduated:
        query = query.is_("graduated_at", "null")
    return (query.order("created_at").execute()).data or []


# --- the scoping dials ------------------------------------------------------
def resolve_count(how_many: str | int, available_count: int) -> int:
    """How many entries "everything", "half" or a typed number comes to.

    Clamped to what exists and to `MAX_GENERATED`, so the dials can never ask
    for a set that cannot be built. Returning the clamped number rather than
    raising lets the caller say "30 of your 91" instead of refusing.
    """
    if available_count <= 0:
        return 0
    if how_many == "all":
        wanted = available_count
    elif how_many == "half":
        # Round up: from three missed questions, "half" giving one is a worse
        # answer than two.
        wanted = -(-available_count // 2)
    else:
        try:
            wanted = int(how_many)
        except (TypeError, ValueError):
            wanted = available_count
    return max(1, min(wanted, available_count, MAX_GENERATED))


def scope(
    entries: list[dict[str, Any]], *, how_many: str | int = "all",
    which: str = "recent", seed: int | None = None,
) -> list[dict[str, Any]]:
    """Pick which entries a generation run should use.

    `entries` arrives oldest first. Pure, so the dial can be checked without a
    database — and it is the part a learner will notice being wrong, since
    "the thirty oldest" silently returning the thirty newest looks like it
    worked.
    """
    if not entries:
        return []
    count = resolve_count(how_many, len(entries))

    if which == "oldest":
        return entries[:count]
    if which == "random":
        # Seeded when asked, so a test can assert on the selection rather than
        # on its size alone.
        rng = random.Random(seed)
        return rng.sample(entries, count)
    # 'recent' — the default, and the most useful: what tripped you up lately.
    return list(reversed(entries))[:count]


def to_question(entry: dict[str, Any], position: int) -> dict[str, Any] | None:
    """One bank entry as a practice question row.

    Returns None for an entry that cannot be a question — a Q&A exchange with
    no options is reference material, not something with a right answer, and
    inventing options for it would be the `Question.usable` mistake in a new
    place.
    """
    snapshot = entry.get("snapshot") or {}
    options = snapshot.get("options") or []
    correct = snapshot.get("correct_index")
    if not snapshot.get("prompt") or len(options) < 2 or correct is None:
        return None
    return {
        "kind": "mcq",
        "prompt": snapshot["prompt"],
        "options": options,
        "correct_index": correct,
        "points": 1,
        "position": position,
        # The link that makes auto-graduation work: answering this updates the
        # entry it came from.
        "bank_entry_id": entry["id"],
    }

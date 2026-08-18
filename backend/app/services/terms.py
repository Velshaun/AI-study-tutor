"""Interactive terms: the tappable vocabulary and acronyms inside study text.

Every flashcard, quiz question, exam question and practice question is generated
with a short list of the terms that are genuinely pivotal to understanding it —
"kernel", "daemon", "GNU", "BIOS" — each carrying an expansion (for acronyms), a
phonetic pronunciation, a plain-language definition and the concept area it
belongs to. The client renders them as tappable text and opens the definition
with no round trip, which is the whole point of generating them up front.

This module owns the shared JSON-schema fragment, the prompt rules and the
validation. Validation matters more than it looks: the model will occasionally
"identify" a term that never appears in the text, and a term the reader can't
see is a term they can't tap, so those are dropped.
"""

from __future__ import annotations

import re
from typing import Any

TERM_TYPES = ("vocabulary", "acronym")

# Beyond a handful, underlining stops signalling "this one matters" and starts
# looking like a broken stylesheet.
MAX_TERMS_PER_ITEM = 5

# The schema fragment shared by every generator that produces study text.
TERM_SCHEMA: dict[str, Any] = {
    "type": "array",
    "description": (
        "The few terms in this text that a learner might not know. Only "
        "genuinely pivotal ones — not every technical word."
    ),
    "items": {
        "type": "object",
        "properties": {
            "term": {
                "type": "string",
                "description": "The term exactly as it appears in the text.",
            },
            "type": {
                "type": "string",
                "description": "'acronym' for abbreviations, otherwise 'vocabulary'.",
            },
            "expansion": {
                "type": "string",
                "description": (
                    "What the acronym stands for, e.g. 'Command Line Interface'. "
                    "Empty string for vocabulary terms."
                ),
            },
            "pronunciation": {
                "type": "string",
                "description": (
                    "Phonetic respelling with the stressed syllable in capitals, "
                    "e.g. 'guh-NOO', 'BY-oss', 'SOO-doo'."
                ),
            },
            "definition": {
                "type": "string",
                "description": "One or two sentences of plain language.",
            },
            "domain": {
                "type": "string",
                "description": (
                    "The concept area it belongs to, e.g. 'Open Source Concepts'."
                ),
            },
        },
        "required": ["term", "type", "expansion", "pronunciation", "definition",
                     "domain"],
    },
}

# Appended to every generation prompt that asks for terms.
TERM_PROMPT_RULES = (
    "- terms: the few words in the text above that a learner might not know, "
    "each with everything needed to explain it on tap. Include (a) key "
    "vocabulary — technical words or concepts essential to understanding the "
    "text, such as 'kernel' or 'daemon' — and (b) acronyms a learner might "
    "not know, such as GNU, CLI, FOSS, BIOS or SSH.\n"
    "- Only genuinely pivotal terms. Do NOT mark every technical word; "
    f"{MAX_TERMS_PER_ITEM} is the ceiling and two or three is typical, and none "
    "at all is correct for text that uses no specialist language.\n"
    "- Each term must appear VERBATIM in the text you wrote, spelled and cased "
    "identically, or it will be discarded.\n"
    "- type is 'acronym' for abbreviations (with expansion filled in, e.g. GNU "
    "-> \"GNU's Not Unix\") and 'vocabulary' for everything else (expansion "
    "empty).\n"
    "- pronunciation is a phonetic respelling a reader can say out loud, with "
    "the stressed syllable capitalised: 'guh-NOO', 'BY-oss', 'SOO-doo', "
    "'DEE-mun'.\n"
    "- definition is one or two plain sentences — no jargon that needs its own "
    "definition.\n"
    "- domain is the concept area, e.g. 'Open Source Concepts', 'Filesystems'.\n"
)


def _norm(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def clean_terms(raw: Any, *texts: str) -> list[dict[str, str]]:
    """Validate generated terms against the text they claim to appear in.

    Drops terms that aren't actually in the text (the reader can't tap what
    they can't see), de-duplicates case-insensitively, and caps the list.
    """
    haystack = " \n".join(t for t in texts if t)
    if not haystack or not isinstance(raw, list):
        return []
    lowered = haystack.lower()

    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        term = _norm(item.get("term"), 80)
        definition = _norm(item.get("definition"), 400)
        if not term or not definition:
            continue

        key = term.lower()
        if key in seen or key not in lowered:
            continue
        # A term must sit on word boundaries, so "cat" doesn't light up inside
        # "concatenate" and leave the learner tapping a fragment.
        if not re.search(rf"(?<!\w){re.escape(term)}(?!\w)", haystack, re.IGNORECASE):
            continue
        seen.add(key)

        kind = _norm(item.get("type"), 20).lower()
        if kind not in TERM_TYPES:
            # An all-caps short token is an acronym whatever the model called it.
            kind = "acronym" if term.isupper() and len(term) <= 8 else "vocabulary"

        expansion = _norm(item.get("expansion"), 200)
        out.append({
            "term": term,
            "type": kind,
            # Only acronyms carry an expansion; a vocabulary term expanding to
            # itself would render as "kernel (kernel)".
            "expansion": expansion if kind == "acronym" else "",
            "pronunciation": _norm(item.get("pronunciation"), 120),
            "definition": definition,
            "domain": _norm(item.get("domain"), 80),
        })
        if len(out) >= MAX_TERMS_PER_ITEM:
            break
    return out

"""Published exam specs for recognised certifications.

A practice exam is only realistic if it matches the real paper, so the app
recommends the *published* question count and time limit for the certification a
module is about — 90 questions in 90 minutes for Security+, 40 in 60 for Linux
Essentials — rather than a house default. Anything unrecognised (a college
course, a personal study module) falls back to a generic recommendation.

Matching is deliberately conservative: an exam code in the title is proof, a
distinctive product name is good evidence, and everything else is left generic.
A wrong match would silently mistime a learner's revision, which is worse than
no recommendation at all.

Counts marked ``published=False`` are widely reported but not stated by the
vendor (Cisco and Microsoft publish a duration but not a question count); the
UI can still recommend them, and the learner can always choose Custom.

Verified against the vendors' own exam pages, August 2026:
  CompTIA A+ / Network+ / Security+   comptia.org/en-us/certifications/...
  LPI Linux Essentials               lpi.org/our-certifications/linux-essentials-overview
  AWS SAA-C03 / CLF-C02              docs.aws.amazon.com/aws-certification
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# Used when a module isn't a recognised certification — a college course, say.
# The count matches exam_profile.DEFAULT_QUESTION_COUNT so the app only ever has
# one house default, and the hour is the brief's stated generic timer.
GENERIC_QUESTION_COUNT = 20
GENERIC_DURATION_MINUTES = 60
GENERIC_LABEL = "Standard practice exam"


@dataclass(frozen=True)
class ExamSpec:
    """One certification's published sitting."""

    label: str
    question_count: int
    duration_minutes: int
    # Exam codes are proof of identity — "220-1201" means exactly one exam.
    codes: tuple[str, ...] = ()
    # Distinctive product names. Matched on word boundaries, lower-cased, after
    # "plus" is folded to "+", so "Security Plus" finds Security+.
    names: tuple[str, ...] = ()
    # False when the vendor publishes a duration but not a question count.
    published: bool = True


CATALOGUE: tuple[ExamSpec, ...] = (
    # --- CompTIA ------------------------------------------------------------
    ExamSpec("CompTIA A+ Core 1", 90, 90, ("220-1201", "220-1101"),
             ("a+ core 1", "comptia a+ core 1")),
    ExamSpec("CompTIA A+ Core 2", 90, 90, ("220-1202", "220-1102"),
             ("a+ core 2", "comptia a+ core 2")),
    ExamSpec("CompTIA A+", 90, 90, (), ("comptia a+",)),
    ExamSpec("CompTIA Network+", 90, 90, ("n10-009", "n10-008"),
             ("network+", "comptia network+")),
    ExamSpec("CompTIA Security+", 90, 90, ("sy0-701", "sy0-601"),
             ("security+", "comptia security+")),
    ExamSpec("CompTIA Linux+", 90, 90, ("xk0-005", "xk0-006"),
             ("linux+", "comptia linux+")),
    ExamSpec("CompTIA CySA+", 85, 165, ("cs0-003", "cs0-004"),
             ("cysa+", "cybersecurity analyst+")),
    ExamSpec("CompTIA PenTest+", 90, 165, ("pt0-003", "pt0-002"), ("pentest+",)),
    ExamSpec("CompTIA SecurityX (CASP+)", 90, 165, ("cas-005", "cas-004"),
             ("securityx", "casp+")),
    ExamSpec("CompTIA Cloud+", 90, 90, ("cv0-004", "cv0-003"), ("cloud+",)),
    ExamSpec("CompTIA Server+", 90, 90, ("sk0-005",), ("server+",)),
    ExamSpec("CompTIA Data+", 90, 90, ("da0-001", "da0-002"), ("data+",)),
    ExamSpec("CompTIA Project+", 90, 90, ("pk0-005",), ("project+",)),
    ExamSpec("CompTIA Cloud Essentials+", 75, 60, ("clo-002",),
             ("cloud essentials+",)),
    ExamSpec("CompTIA ITF+", 75, 60, ("fc0-u71", "fc0-u61"),
             ("itf+", "it fundamentals+")),
    # --- Linux Professional Institute ---------------------------------------
    ExamSpec("LPI Linux Essentials", 40, 60, ("010-160",), ("linux essentials",)),
    ExamSpec("LPIC-1", 60, 90, ("101-500", "102-500"), ("lpic-1", "lpic 1")),
    ExamSpec("LPIC-2", 60, 90, ("201-450", "202-450"), ("lpic-2", "lpic 2")),
    # --- Cloud --------------------------------------------------------------
    ExamSpec("AWS Certified Cloud Practitioner", 65, 90, ("clf-c02", "clf-c01"),
             ("cloud practitioner",)),
    ExamSpec("AWS Certified Solutions Architect - Associate", 65, 130,
             ("saa-c03", "saa-c02"), ("solutions architect associate",)),
    ExamSpec("AWS Certified Developer - Associate", 65, 130, ("dva-c02",),
             ("aws developer associate",)),
    ExamSpec("AWS Certified SysOps Administrator - Associate", 65, 130,
             ("soa-c02",), ("sysops administrator associate",)),
    ExamSpec("Microsoft Azure Fundamentals", 50, 45, ("az-900",),
             ("azure fundamentals",), published=False),
    ExamSpec("Microsoft Azure Administrator", 50, 120, ("az-104",),
             ("azure administrator",), published=False),
    ExamSpec("Google Associate Cloud Engineer", 50, 120, (),
             ("associate cloud engineer",), published=False),
    # --- Networking / security ----------------------------------------------
    ExamSpec("Cisco CCNA", 100, 120, ("200-301",), ("ccna",), published=False),
    ExamSpec("Cisco CCNP ENCOR", 100, 120, ("350-401",), ("encor",),
             published=False),
    ExamSpec("(ISC)² CISSP", 150, 180, (), ("cissp",)),
    ExamSpec("(ISC)² SSCP", 125, 180, (), ("sscp",)),
    ExamSpec("(ISC)² Certified in Cybersecurity", 100, 120, (),
             ("certified in cybersecurity",)),
    ExamSpec("EC-Council CEH", 125, 240, (),
             ("ceh", "certified ethical hacker")),
    ExamSpec("ISACA CISA", 150, 240, (), ("cisa",)),
    ExamSpec("ISACA CISM", 150, 240, (), ("cism",)),
    # --- Service management / project ---------------------------------------
    ExamSpec("ITIL 4 Foundation", 40, 60, (), ("itil 4 foundation", "itil foundation")),
    ExamSpec("PMP", 180, 230, (), ("pmp", "project management professional")),
    ExamSpec("CAPM", 150, 180, (), ("capm",)),
    # --- Admissions tests ---------------------------------------------------
    ExamSpec("LSAT", 76, 140, (), ("lsat",), published=False),
    ExamSpec("GMAT Focus", 64, 135, (), ("gmat",), published=False),
)


def _normalise(text: str) -> str:
    """Lower-case, fold 'plus' to '+', and squash punctuation to spaces.

    "CompTIA Security Plus (SY0-701)" -> "comptia security+ sy0-701", so a
    learner's spelling doesn't decide whether their exam is recognised.
    """
    out = (text or "").lower()
    out = re.sub(r"\bplus\b", "+", out)
    out = re.sub(r"\s*\+", "+", out)          # "security +" -> "security+"
    out = re.sub(r"[^a-z0-9+\-]+", " ", out)  # keep '+' and '-' (exam codes)
    return f" {out.strip()} "


def _contains(haystack: str, needle: str) -> bool:
    """Whole-token containment. Both sides are normalised and space-padded."""
    return f" {needle} " in haystack


def find(*texts: str | None) -> ExamSpec | None:
    """The certification these texts describe, if it's one we know.

    Exam codes win over names — a title carrying "220-1201" is unambiguous,
    while "a+" could turn up inside prose. Among names the longest match wins,
    so "A+ Core 1" doesn't settle for the broader "CompTIA A+" entry.
    """
    hay = _normalise(" ".join(t for t in texts if t))
    if not hay.strip():
        return None

    for spec in CATALOGUE:
        if any(_contains(hay, code) for code in spec.codes):
            return spec

    best: ExamSpec | None = None
    best_len = 0
    for spec in CATALOGUE:
        for name in spec.names:
            if _contains(hay, name) and len(name) > best_len:
                best, best_len = spec, len(name)
    return best


def recommend(*texts: str | None) -> dict[str, object]:
    """The recommended sitting for a module, matched or generic."""
    spec = find(*texts)
    if spec is None:
        return {
            "label": GENERIC_LABEL,
            "question_count": GENERIC_QUESTION_COUNT,
            "duration_minutes": GENERIC_DURATION_MINUTES,
            "matched": False,
            "published": False,
        }
    return {
        "label": spec.label,
        "question_count": spec.question_count,
        "duration_minutes": spec.duration_minutes,
        "matched": True,
        "published": spec.published,
    }

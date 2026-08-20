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
# The house pass mark, used where a vendor publishes none.
GENERIC_PASS_PCT = 70.0


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
    # The percentage correct treated as a pass.
    #
    # An approximation, deliberately. Most vendors publish a *scaled* threshold
    # — CompTIA's 675 of 900, LPI's 500 of 800 — and scaling is not a linear
    # function of questions answered correctly, so no percentage can reproduce
    # their grade. What this is for is a study target on a practice paper: the
    # scaled threshold expressed as the share of questions a learner should be
    # getting right to be in range. Erring high is the safe direction.
    pass_pct: float = GENERIC_PASS_PCT

    # The vendor's published domain split: ((title, percentage), ...).
    #
    # Unlike pass_pct this is NOT an approximation — it is a transcription, and
    # an entry is left empty rather than estimated. A plausible-looking guess is
    # exactly the failure this table exists to stop: weights that look right,
    # sum to 100, and quietly misallocate every practice paper. Empty means
    # "look elsewhere", which is a useful answer; a guess is not.
    #
    # Percentages are stored as the vendor states them. Where a vendor publishes
    # integer weights out of a total rather than percentages (LPI does), the
    # conversion is written out in the entry so it can be checked.
    domains: tuple[tuple[str, float], ...] = ()


CATALOGUE: tuple[ExamSpec, ...] = (
    # --- CompTIA ------------------------------------------------------------
    ExamSpec("CompTIA A+ Core 1", 90, 90, ("220-1201", "220-1101"),
             ("a+ core 1", "comptia a+ core 1"), pass_pct=75.0,
             # 220-1201 exam objectives, checked 20 Aug 2026.
             domains=(
                 ("Mobile Devices", 13.0),
                 ("Networking", 23.0),
                 ("Hardware", 25.0),
                 ("Virtualization and Cloud Computing", 11.0),
                 ("Hardware and Network Troubleshooting", 28.0),
             )),
    ExamSpec("CompTIA A+ Core 2", 90, 90, ("220-1202", "220-1102"),
             ("a+ core 2", "comptia a+ core 2"), pass_pct=78.0,
             # 220-1202 exam objectives, checked 20 Aug 2026.
             domains=(
                 ("Operating Systems", 28.0),
                 ("Security", 28.0),
                 ("Software Troubleshooting", 23.0),
                 ("Operational Procedures", 21.0),
             )),
    ExamSpec("CompTIA A+", 90, 90, (), ("comptia a+",), pass_pct=75.0),
    ExamSpec("CompTIA Network+", 90, 90, ("n10-009", "n10-008"),
             ("network+", "comptia network+"), pass_pct=80.0,
             # N10-009 exam objectives, checked 20 Aug 2026.
             domains=(
                 ("Networking Concepts", 23.0),
                 ("Network Implementation", 20.0),
                 ("Network Operations", 19.0),
                 ("Network Security", 14.0),
                 ("Network Troubleshooting", 24.0),
             )),
    ExamSpec("CompTIA Security+", 90, 90, ("sy0-701", "sy0-601"),
             ("security+", "comptia security+"), pass_pct=83.0,
             # SY0-701 exam objectives, checked 20 Aug 2026.
             domains=(
                 ("General Security Concepts", 12.0),
                 ("Threats, Vulnerabilities, and Mitigations", 22.0),
                 ("Security Architecture", 18.0),
                 ("Security Operations", 28.0),
                 ("Security Program Management and Oversight", 20.0),
             )),
    ExamSpec("CompTIA Linux+", 90, 90, ("xk0-005", "xk0-006"),
             ("linux+", "comptia linux+"),
             # XK0-005 exam objectives, checked 20 Aug 2026.
             domains=(
                 ("System Management", 32.0),
                 ("Security", 21.0),
                 ("Scripting, Containers, and Automation", 19.0),
                 ("Troubleshooting", 28.0),
             )),
    ExamSpec("CompTIA CySA+", 85, 165, ("cs0-003", "cs0-004"),
             ("cysa+", "cybersecurity analyst+"),
             # CS0-003 exam objectives, checked 20 Aug 2026.
             domains=(
                 ("Security Operations", 33.0),
                 ("Vulnerability Management", 30.0),
                 ("Incident Response and Management", 20.0),
                 ("Reporting and Communication", 17.0),
             )),
    ExamSpec("CompTIA PenTest+", 90, 165, ("pt0-003", "pt0-002"), ("pentest+",),
             # PT0-003 exam objectives, checked 20 Aug 2026.
             domains=(
                 ("Engagement Management", 13.0),
                 ("Reconnaissance and Enumeration", 21.0),
                 ("Vulnerability Discovery and Analysis", 17.0),
                 ("Attacks and Exploits", 35.0),
                 ("Post-exploitation and Lateral Movement", 14.0),
             )),
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
    ExamSpec("LPI Linux Essentials", 40, 60, ("010-160",), ("linux essentials",),
             pass_pct=62.5,
             # Exam 010 objectives, checked 20 Aug 2026. LPI publishes integer
             # weights per topic totalling 40, not percentages: 7, 9, 9, 8, 7.
             # Divided by 40 these land on exact halves, which is a useful
             # check — a derived set produced 17.95/23.08/23.08/20.51/15.38,
             # i.e. the same shape computed out of 39 with topic 5 given 6.
             # Plausible, close, and wrong.
             domains=(
                 ("The Linux Community and a Career in Open Source", 17.5),
                 ("Finding Your Way on a Linux System", 22.5),
                 ("The Power of the Command Line", 22.5),
                 ("The Linux Operating System", 20.0),
                 ("Security and File Permissions", 17.5),
             )),
    ExamSpec("LPIC-1", 60, 90, ("101-500", "102-500"), ("lpic-1", "lpic 1")),
    ExamSpec("LPIC-2", 60, 90, ("201-450", "202-450"), ("lpic-2", "lpic 2")),
    # --- Cloud --------------------------------------------------------------
    ExamSpec("AWS Certified Cloud Practitioner", 65, 90, ("clf-c02", "clf-c01"),
             ("cloud practitioner",),
             # CLF-C02 exam guide, checked 20 Aug 2026.
             domains=(
                 ("Cloud Concepts", 24.0),
                 ("Security and Compliance", 30.0),
                 ("Cloud Technology and Services", 34.0),
                 ("Billing, Pricing, and Support", 12.0),
             )),
    ExamSpec("AWS Certified Solutions Architect - Associate", 65, 130,
             ("saa-c03", "saa-c02"), ("solutions architect associate",),
             # SAA-C03 exam guide, checked 20 Aug 2026.
             domains=(
                 ("Design Secure Architectures", 30.0),
                 ("Design Resilient Architectures", 26.0),
                 ("Design High-Performing Architectures", 24.0),
                 ("Design Cost-Optimized Architectures", 20.0),
             )),
    ExamSpec("AWS Certified Developer - Associate", 65, 130, ("dva-c02",),
             ("aws developer associate",)),
    ExamSpec("AWS Certified SysOps Administrator - Associate", 65, 130,
             ("soa-c02",), ("sysops administrator associate",)),
    ExamSpec("Microsoft Azure Fundamentals", 50, 45, ("az-900",),
             ("azure fundamentals",), published=False, pass_pct=70.0),
    ExamSpec("Microsoft Azure Administrator", 50, 120, ("az-104",),
             ("azure administrator",), published=False),
    ExamSpec("Google Associate Cloud Engineer", 50, 120, (),
             ("associate cloud engineer",), published=False),
    # --- Networking / security ----------------------------------------------
    ExamSpec("Cisco CCNA", 100, 120, ("200-301",), ("ccna",), published=False,
             # 200-301 v1.1 exam topics, checked 20 Aug 2026.
             domains=(
                 ("Network Fundamentals", 20.0),
                 ("Network Access", 20.0),
                 ("IP Connectivity", 25.0),
                 ("IP Services", 10.0),
                 ("Security Fundamentals", 15.0),
                 ("Automation and Programmability", 10.0),
             )),
    ExamSpec("Cisco CCNP ENCOR", 100, 120, ("350-401",), ("encor",),
             published=False),
    ExamSpec("(ISC)² CISSP", 150, 180, (), ("cissp",),
             # CISSP exam outline effective 15 April 2024, checked 20 Aug 2026.
             domains=(
                 ("Security and Risk Management", 16.0),
                 ("Asset Security", 10.0),
                 ("Security Architecture and Engineering", 13.0),
                 ("Communication and Network Security", 13.0),
                 ("Identity and Access Management (IAM)", 13.0),
                 ("Security Assessment and Testing", 12.0),
                 ("Security Operations", 13.0),
                 ("Software Development Security", 10.0),
             )),
    ExamSpec("(ISC)² SSCP", 125, 180, (), ("sscp",)),
    ExamSpec("(ISC)² Certified in Cybersecurity", 100, 120, (),
             ("certified in cybersecurity",)),
    ExamSpec("EC-Council CEH", 125, 240, (),
             ("ceh", "certified ethical hacker")),
    ExamSpec("ISACA CISA", 150, 240, (), ("cisa",)),
    ExamSpec("ISACA CISM", 150, 240, (), ("cism",)),
    # --- Service management / project ---------------------------------------
    ExamSpec("ITIL 4 Foundation", 40, 60, (), ("itil 4 foundation", "itil foundation"),
             pass_pct=65.0),
    ExamSpec("PMP", 180, 230, (), ("pmp", "project management professional"),
             # PMP Examination Content Outline as rebalanced 9 July 2026,
             # checked 20 Aug 2026. The long-standing split was 42/50/8, so a
             # stale copy here would be badly wrong rather than slightly wrong.
             domains=(
                 ("People", 33.0),
                 ("Process", 41.0),
                 ("Business Environment", 26.0),
             )),
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
            "pass_pct": GENERIC_PASS_PCT,
        }
    return {
        "label": spec.label,
        "question_count": spec.question_count,
        "duration_minutes": spec.duration_minutes,
        "matched": True,
        "published": spec.published,
        "pass_pct": spec.pass_pct,
    }


def pass_pct(*texts: str | None) -> float:
    """The share of questions that counts as a pass for this module's exam."""
    spec = find(*texts)
    return spec.pass_pct if spec else GENERIC_PASS_PCT

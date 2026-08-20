"""Does this material belong with that module?

One comparison, asked at two moments and from two directions:

*Creating a module.* Material arrives with no home. If it plainly belongs to a
certification the learner already has a module for, that is worth a question —
CompTIA A+ Core 2 material landing while a Core 1 module exists is far more
likely to be the next half of a course than a second copy of the same one, and
guessing either way is worse than asking. If it resembles nothing, no question
is asked and a new module is created exactly as before.

*Adding to a module.* The same comparison, run against one module instead of
all of them. Security+ material dropped into an A+ module is almost certainly a
mis-drop, and the cost of finding out after ingestion is a rebuilt blueprint and
a domain map describing two exams at once.

**It only speaks when it has evidence.** The signal is `exam_catalog`, which
identifies a certification from an exam code or a distinctive product name and
stays generic otherwise — the same conservatism that keeps it from mistiming
someone's revision. Material it cannot place produces `UNKNOWN`, and `UNKNOWN`
never interrupts anyone. A prompt that fires on a hunch trains people to dismiss
prompts, which costs more than the mis-drop it was guarding against.

No model call, deliberately. This runs before every upload and every create, and
a check that adds a Gemini round trip to both would be paid for constantly to
change the outcome rarely.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from app.services import exam_catalog

logger = logging.getLogger(__name__)

# The verdicts. Only two of them ever interrupt.
SAME = "same"            # the same exam — belongs here, no question
SIBLING = "sibling"      # same certification family, different exam — ask
DIFFERENT = "different"  # a different certification altogether — flag
UNKNOWN = "unknown"      # not identifiable — say nothing

# Trailing parts that distinguish exams *within* one certification rather than
# naming a different certification: "Core 1", "Part 2", "Level II", "101".
_SUBDIVISION = re.compile(
    r"\s*[-–—:]?\s*\b(?:core|part|level|paper|exam|volume|vol)\b\s*"
    r"(?:\d+|[ivx]+)\s*$",
    re.IGNORECASE,
)


# Which direction the question is being asked from. The relation alone does not
# decide whether to interrupt, because the same relation means opposite things
# depending on where the material was headed.
CREATING = "creating"
ADDING = "adding"

# Creating: material that *is* the exam a module already covers is the strongest
# evidence of ambiguity there is — almost certainly meant for that module — and
# a sibling is the 1101/1102 case. Adding: the same exam is simply correct and
# must stay silent; it is a different one that wants flagging.
_ASK = {
    CREATING: (SAME, SIBLING),
    ADDING: (SIBLING, DIFFERENT),
}


@dataclass(frozen=True)
class Verdict:
    """What the comparison found, and enough to say it in a sentence."""

    relation: str
    direction: str = CREATING
    material_label: str = ""
    module_label: str = ""
    module_id: str = ""
    module_title: str = ""

    @property
    def should_ask(self) -> bool:
        """Whether this is worth interrupting someone for."""
        # Keyed on having *identified* a module, not on it having a title. A
        # module the pipeline hasn't named yet is still identifiable from the
        # material already in it, and it is the one most likely to be mis-dropped
        # into — it is new.
        if not (self.module_label or self.module_title):
            return False
        return self.relation in _ASK.get(self.direction, ())

    @property
    def identified(self) -> bool:
        return self.relation != UNKNOWN


def family(label: str) -> str:
    """The certification a spec belongs to, ignoring which paper it is.

    "CompTIA A+ Core 1" and "CompTIA A+ Core 2" are two exams of one
    certification, and that distinction is the whole point of the sibling
    verdict: they are related enough that the learner may well have meant either
    one, which is exactly when asking beats guessing.
    """
    return _SUBDIVISION.sub("", (label or "").strip()).strip()


def identify(*texts: str | None) -> str:
    """The certification this text is about, or "" if it can't be placed.

    Delegated to `exam_catalog` rather than re-implemented: it already treats an
    exam code as proof, a distinctive product name as good evidence with the
    longest match winning, and everything else as generic.
    """
    spec = exam_catalog.find(*texts)
    return spec.label if spec else ""


def compare(material_label: str, module_label: str) -> str:
    """How two identified certifications relate."""
    if not material_label or not module_label:
        return UNKNOWN
    if material_label == module_label:
        return SAME
    if family(material_label) == family(module_label):
        return SIBLING
    return DIFFERENT


def against_module(
    *, material_texts: list[str | None], module_id: str, module_title: str,
    module_texts: list[str | None] | None = None,
) -> Verdict:
    """Adding direction: does this material belong in *this* module?

    The module is identified from its own title first and its existing material
    second — a module named "CompTIA A+ Core 1 (220-1201)" says what it is, and
    an untitled one has to be read from what is already in it.
    """
    material_label = identify(*material_texts)
    module_label = identify(module_title, *(module_texts or []))
    relation = compare(material_label, module_label)
    return Verdict(
        relation=relation,
        direction=ADDING,
        material_label=material_label,
        module_label=module_label,
        module_id=module_id,
        module_title=module_title,
    )


def against_modules(
    *, material_texts: list[str | None], modules: list[dict],
) -> Verdict:
    """Creating direction: does this material belong to a module that exists?

    Returns the single most relevant verdict, because the question this feeds is
    "did you mean this one?" and a list of maybes is not a question anyone can
    answer. An exact match outranks a sibling: material that *is* Core 1 landing
    while a Core 1 module exists is a duplicate upload, which is a more specific
    thing to say than "you have something similar".

    `DIFFERENT` is never returned here. Every module a learner owns is different
    from most material they will ever upload; that is not evidence of anything,
    and saying so on every create would be noise.
    """
    material_label = identify(*material_texts)
    if not material_label:
        return Verdict(relation=UNKNOWN)

    best: Verdict | None = None
    for module in modules:
        title = module.get("title") or ""
        module_label = identify(title)
        relation = compare(material_label, module_label)
        if relation not in (SAME, SIBLING):
            continue
        candidate = Verdict(
            relation=relation,
            material_label=material_label,
            module_label=module_label,
            module_id=module.get("id") or "",
            module_title=title,
        )
        if relation == SAME:
            return candidate
        if best is None:
            best = candidate

    return best or Verdict(relation=UNKNOWN, material_label=material_label)


def question(verdict: Verdict) -> str:
    """The prompt, in the learner's words rather than the catalogue's.

    Written here so both callers ask the same way, and so the phrasing is
    testable without a browser.
    """
    if verdict.relation == SIBLING and verdict.module_label:
        return (
            f"This looks like {verdict.material_label} material, and you already "
            f"have a module for {verdict.module_label}. They're different papers "
            "of the same certification — start a new module, or add this to the "
            "one you have?"
        )
    if verdict.relation == SAME and verdict.module_label:
        return (
            f"You already have a module for {verdict.material_label}. Add this "
            "material to it, or start a separate one?"
        )
    if verdict.relation == DIFFERENT:
        return (
            f"This looks like {verdict.material_label} material, but this module "
            f"is {verdict.module_label}. Adding it will fold it into this "
            "module's study plan. Add it anyway?"
        )
    return ""

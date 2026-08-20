"""WebVTT and SRT captions to readable transcript text.

The point of the whole import feature is that nobody has to watch hours of
video, so a caption file is study material rather than a media artefact. What
arrives is timing data with words threaded through it; what's wanted is the
words.

Captions never become questions. They are prose, and prose is reference
material — a parser that tried to invent an answer key from a lecture
transcript would be generating, not converting.
"""

from __future__ import annotations

import re

from app.services.ingest.canonical import ParseResult, as_reference

# 00:00:12.480 --> 00:00:15.200  (WebVTT), or with a comma (SRT). Trailing
# cue settings like "align:start position:0%" are common in YouTube exports.
TIMING = re.compile(
    r"^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*"
    r"(?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}.*$"
)
CUE_NUMBER = re.compile(r"^\s*\d+\s*$")
# <c>, <00:00:01.000>, <v Speaker> — inline karaoke and voice spans.
INLINE_TAG = re.compile(r"</?[cv][^>]*>|<\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}>")
HEADER = re.compile(r"^\s*(WEBVTT|Kind:|Language:|NOTE\b|STYLE\b|REGION\b)", re.I)


def looks_like_captions(text: str) -> bool:
    """Cheap enough to run on anything pasted, to pre-select the type pill.

    Line by line, because `TIMING` is anchored to the start and end of a line.
    Searching the whole blob with it only ever matched at the very start of the
    string, so a WebVTT file was detected by its header and an SRT file — which
    has no header — was never detected at all.
    """
    lines = (text or "").splitlines()[:80]
    if any(TIMING.match(line) for line in lines):
        return True
    return "\n".join(lines).strip().upper().startswith("WEBVTT")


def parse(text: str) -> ParseResult:
    """Strip the timing scaffolding and give back the words."""
    lines = (text or "").splitlines()
    kept: list[str] = []

    for raw in lines:
        line = raw.strip()
        if not line or HEADER.match(line) or TIMING.match(line) or CUE_NUMBER.match(line):
            continue
        line = INLINE_TAG.sub("", line).strip()
        if not line:
            continue
        # YouTube's auto-captions repeat the previous cue's tail as the next
        # cue's head, so a naive join says everything twice.
        if kept and kept[-1] == line:
            continue
        kept.append(line)

    body = " ".join(kept)
    # Collapse the whitespace that cue-per-line formatting leaves behind.
    body = re.sub(r"\s+", " ", body).strip()

    if len(body) < 40:
        return as_reference(
            text or "",
            "That caption file had almost no readable text in it.",
            detected="reference",
        )

    return as_reference(
        body,
        f"Read {len(body):,} characters of transcript from the captions.",
        detected="reference",
    )

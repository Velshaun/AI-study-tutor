"""Source parsing — spec §4.3 step 2.

Turns each source type into plain text:

    pdf      -> pypdf
    youtube  -> youtube-transcript-api
    web      -> httpx + a tag-stripping HTML parser (stdlib, no bs4 dependency)
    audio    -> OpenAI Whisper
    text     -> decoded as-is

Every extractor raises ``ExtractionError`` on failure so the pipeline can mark
one source failed and carry on with the rest of the batch.
"""

from __future__ import annotations

import hashlib
import io
import logging
import mimetypes
import re
from html.parser import HTMLParser

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

# Whisper's upload ceiling. Larger files need chunking, which we don't do yet.
WHISPER_MAX_BYTES = 25 * 1024 * 1024

# Canonical format sets — this module decides what can be parsed, and storage
# imports these to classify uploads.
PDF_EXTS = {".pdf"}
# Formats Whisper accepts (§4.3a names mp3/wav/m4a explicitly).
AUDIO_EXTS = {".mp3", ".m4a", ".wav", ".mpga", ".mpeg", ".ogg", ".flac"}
TEXT_EXTS = {".txt", ".md", ".markdown", ".rst", ".csv"}
# Photos of notes, textbook pages and whiteboards — read with Gemini vision.
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".gif", ".bmp"}
# Screen recordings. These carry their content on screen rather than in the
# audio, so they are sampled as frames and read, with any narration transcribed
# alongside. Container formats that can hold either (mp4, webm) land here: the
# video extractor falls back to transcription when there is nothing to see.
VIDEO_EXTS = {".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv"}
SUPPORTED_EXTS = PDF_EXTS | AUDIO_EXTS | TEXT_EXTS | IMAGE_EXTS | VIDEO_EXTS

# Vision sampling. A screen recording repeats itself for seconds at a time, so
# a handful of well-spaced frames carries almost all of its text.
VIDEO_MAX_FRAMES = 12
VIDEO_MIN_FRAME_GAP_SECS = 2.0
# Frames are downscaled before they go to the model: text stays legible far
# below native resolution, and the request stays small.
FRAME_MAX_EDGE = 1280

YOUTUBE_PATTERNS = (
    r"(?:v=|/embed/|/shorts/|/live/|youtu\.be/)([A-Za-z0-9_-]{11})",
    r"^([A-Za-z0-9_-]{11})$",
)


class ExtractionError(RuntimeError):
    """A source could not be parsed into text."""


# --- helpers ----------------------------------------------------------------
def parse_youtube_id(url: str) -> str | None:
    """Pull the 11-character video id out of any common YouTube URL shape."""
    for pattern in YOUTUBE_PATTERNS:
        match = re.search(pattern, url or "")
        if match:
            return match.group(1)
    return None


def classify_url(url: str) -> str:
    """Decide whether a pasted link is a YouTube video or a generic page."""
    return "youtube" if parse_youtube_id(url) else "web"


def normalise(text: str) -> str:
    """Collapse the ragged whitespace that PDF and HTML extraction produce."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


class _TextExtractor(HTMLParser):
    """Collect visible text, dropping script/style/nav chrome."""

    SKIP = {"script", "style", "noscript", "svg", "head", "nav", "footer", "form"}
    BLOCK = {"p", "div", "section", "article", "br", "li", "tr",
             "h1", "h2", "h3", "h4", "h5", "h6"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: ANN001
        if tag in self.SKIP:
            self._skip_depth += 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP and self._skip_depth:
            self._skip_depth -= 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skip_depth and data.strip():
            self.parts.append(data)

    def text(self) -> str:
        return normalise("".join(self.parts))


# --- extractors -------------------------------------------------------------
def extract_pdf(data: bytes) -> str:
    """Extract text from a PDF.

    Scanned PDFs contain no text layer and yield an empty string; that's
    reported as a failure rather than silently feeding Gemini nothing.
    """
    try:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data))
        pages = [(page.extract_text() or "") for page in reader.pages]
    except Exception as exc:  # noqa: BLE001
        raise ExtractionError(f"Could not read PDF: {exc}") from exc

    text = normalise("\n\n".join(pages))
    if not text:
        raise ExtractionError(
            "No text layer found in this PDF — it may be a scan. "
            "OCR it, or upload the source as audio/text instead."
        )
    return text


def extract_text_file(data: bytes) -> str:
    """Decode a plain-text upload, tolerating unknown encodings."""
    for encoding in ("utf-8", "utf-16", "latin-1"):
        try:
            return normalise(data.decode(encoding))
        except UnicodeDecodeError:
            continue
    raise ExtractionError("Could not decode this file as text.")


def extract_youtube(url: str) -> str:
    """Fetch a video's transcript as plain text."""
    video_id = parse_youtube_id(url)
    if not video_id:
        raise ExtractionError("Could not parse a YouTube video id from that URL.")

    try:
        from youtube_transcript_api import YouTubeTranscriptApi

        # The 1.x API is instance-based; 0.x exposed a classmethod. Support both
        # so a dependency bump doesn't silently break ingestion.
        if hasattr(YouTubeTranscriptApi, "get_transcript"):
            entries = YouTubeTranscriptApi.get_transcript(video_id)
            snippets = [e["text"] for e in entries]
        else:
            fetched = YouTubeTranscriptApi().fetch(video_id)
            snippets = [s.text for s in fetched]
    except Exception as exc:  # noqa: BLE001
        raise ExtractionError(
            f"No transcript available for this video: {exc}"
        ) from exc

    text = normalise(" ".join(snippets))
    if not text:
        raise ExtractionError("That video's transcript was empty.")
    return text


def extract_web(url: str) -> str:
    """Download a page and reduce it to readable text."""
    try:
        with httpx.Client(
            timeout=30,
            follow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 (compatible; AIStudyTutor/1.0)"},
        ) as client:
            response = client.get(url)
            response.raise_for_status()
    except Exception as exc:  # noqa: BLE001
        raise ExtractionError(f"Could not fetch that URL: {exc}") from exc

    content_type = response.headers.get("content-type", "")
    if "application/pdf" in content_type:
        return extract_pdf(response.content)
    if content_type.startswith("text/plain"):
        return normalise(response.text)

    parser = _TextExtractor()
    parser.feed(response.text)
    text = parser.text()
    if len(text) < 50:
        raise ExtractionError(
            "That page had almost no readable text — it may be JavaScript-rendered."
        )
    return text


def _transcription_error(exc: Exception) -> str:
    """Turn an OpenAI SDK exception into something a user can act on.

    The raw errors are multi-line JSON blobs; surfaced verbatim they end up in
    ``user_files.error_message`` and then in the UI. Billing and auth problems
    in particular are worth naming explicitly, since they look identical to a
    transient failure otherwise.
    """
    text = str(exc)
    name = type(exc).__name__

    if "insufficient_quota" in text or "exceeded your current quota" in text:
        return (
            "OpenAI account has no remaining quota, so audio could not be "
            "transcribed. Add billing credit at platform.openai.com/settings/"
            "organization/billing, then re-run processing for this module."
        )
    if name == "AuthenticationError" or "invalid_api_key" in text or "Incorrect API key" in text:
        return "OPENAI_API_KEY was rejected by OpenAI. Check the key is current."
    if name == "RateLimitError":
        return "OpenAI rate limit hit. Wait a moment and re-run processing."
    if "Invalid file format" in text or "unsupported" in text.lower():
        return (
            f"Whisper rejected this audio format. Supported: "
            f"{', '.join(sorted(e.lstrip('.') for e in AUDIO_EXTS))}."
        )
    if name in ("APIConnectionError", "APITimeoutError"):
        return "Could not reach OpenAI to transcribe the audio. Check connectivity."
    return f"Transcription failed ({name}): {text[:300]}"


def extract_audio(data: bytes, filename: str = "audio.mp3") -> str:
    """Transcribe audio with Whisper."""
    if not settings.openai_api_key:
        raise ExtractionError(
            "Audio transcription needs OPENAI_API_KEY to be configured."
        )
    if len(data) > WHISPER_MAX_BYTES:
        raise ExtractionError(
            f"Audio is {len(data) // 1_048_576} MB; Whisper accepts up to 25 MB. "
            "Split the recording and upload the parts separately."
        )

    try:
        from openai import OpenAI

        client = OpenAI(api_key=settings.openai_api_key)
        buffer = io.BytesIO(data)
        buffer.name = filename  # the SDK infers format from the name
        result = client.audio.transcriptions.create(
            model=settings.whisper_model,
            file=buffer,
        )
    except Exception as exc:  # noqa: BLE001
        raise ExtractionError(_transcription_error(exc)) from exc

    text = normalise(getattr(result, "text", "") or "")
    if not text:
        raise ExtractionError("Transcription returned no speech.")
    return text


# --- images -----------------------------------------------------------------
OCR_PROMPT = (
    "Transcribe every piece of text visible in this image, in reading order.\n\n"
    "- This is study material: a photo of handwritten notes, a textbook page, a "
    "whiteboard, a slide or a screenshot.\n"
    "- Preserve headings, bullet points, numbering and the order things appear "
    "in. Keep code, commands and symbols exactly as written.\n"
    "- Where the image is a diagram or table, describe its structure in plain "
    "text so the content is usable.\n"
    "- Transcribe only what is there. Do not summarise, correct or invent.\n"
    "- If there is no legible text, reply with exactly: NO_TEXT"
)

# Frames arrive as a batch, so the instruction has to be about the set rather
# than "this image" — asked the single-image way, the model transcribes the
# first frame and stops.
VIDEO_OCR_PROMPT = (
    "These are still frames sampled in order from a screen recording of study "
    "material. Transcribe the text from ALL of them, in order, as one set of "
    "notes.\n\n"
    "- Cover every distinct screen or slide. Where consecutive frames show the "
    "same thing, transcribe it once rather than repeating it.\n"
    "- Preserve headings, bullet points, numbering and order. Keep code, "
    "commands and symbols exactly as written.\n"
    "- Describe diagrams and tables structurally, in plain text.\n"
    "- Transcribe only what is on screen. Do not summarise or invent.\n"
    "- If no frame has legible text, reply with exactly: NO_TEXT"
)

# What the model tells us when a photo has nothing readable in it.
NO_TEXT_MARKER = "NO_TEXT"


def _vision_mime(filename: str, fallback: str = "image/jpeg") -> str:
    guessed = mimetypes.guess_type(filename or "")[0]
    return guessed if (guessed or "").startswith("image/") else fallback


def _read_images(
    parts: list[tuple[bytes, str]], *, label: str, prompt: str = OCR_PROMPT,
) -> str:
    """Send image bytes to Gemini vision and return the transcribed text."""
    if not settings.gemini_api_key:
        raise ExtractionError(
            "Reading images needs GEMINI_API_KEY to be configured."
        )
    if not parts:
        raise ExtractionError("There was nothing to read in that file.")

    from google.genai import types

    from app.services.domains import _generate, quota_hint

    contents = [
        types.Part.from_bytes(data=data, mime_type=mime) for data, mime in parts
    ]
    contents.append(prompt)

    try:
        response = _generate(
            label,
            model=settings.gemini_model,
            contents=contents,
            config=types.GenerateContentConfig(temperature=0.0),
        )
    except Exception as exc:  # noqa: BLE001
        raise ExtractionError(
            quota_hint(exc) or f"Could not read that image: {exc}"
        ) from exc

    text = normalise(response.text or "")
    if not text or text.strip().upper().startswith(NO_TEXT_MARKER):
        return ""
    return text


def extract_image(data: bytes, filename: str = "image.jpg") -> str:
    """Read the text out of a photo of notes, a slide or a screenshot."""
    text = _read_images([(data, _vision_mime(filename))], label="ocr-image")
    if not text:
        raise ExtractionError(
            "No readable text was found in that image. A sharper, better-lit "
            "photo usually fixes it."
        )
    return text


# --- video ------------------------------------------------------------------
def _sample_frames(data: bytes) -> list[tuple[bytes, str]]:
    """Grab well-spaced, visually distinct frames from a video.

    Screen recordings hold still for long stretches, so frames are taken at
    intervals and near-identical ones are dropped — twelve good frames beat a
    thousand of the same slide.
    """
    try:
        import av
    except ImportError as exc:  # pragma: no cover - dependency is pinned
        raise ExtractionError(
            "Reading video needs the 'av' package to be installed."
        ) from exc

    frames: list[tuple[bytes, str]] = []
    last_at = None
    last_digest = None

    try:
        with av.open(io.BytesIO(data)) as container:
            streams = [s for s in container.streams if s.type == "video"]
            if not streams:
                return []
            stream = streams[0]
            stream.thread_type = "AUTO"

            for frame in container.decode(stream):
                at = float(frame.time or 0)
                if last_at is not None and at - last_at < VIDEO_MIN_FRAME_GAP_SECS:
                    continue

                image = frame.to_image()
                image.thumbnail((FRAME_MAX_EDGE, FRAME_MAX_EDGE))
                buffer = io.BytesIO()
                image.convert("RGB").save(buffer, format="JPEG", quality=80)
                payload = buffer.getvalue()

                # Skip a frame that looks like the one before it — a still
                # screen shouldn't spend the budget.
                digest = hashlib.blake2b(payload, digest_size=8).hexdigest()
                if digest == last_digest:
                    continue

                last_at, last_digest = at, digest
                frames.append((payload, "image/jpeg"))
                if len(frames) >= VIDEO_MAX_FRAMES:
                    break
    except ExtractionError:
        raise
    except Exception as exc:  # noqa: BLE001 — a corrupt upload isn't a crash
        logger.warning("Could not decode video frames: %s", exc)
        return []

    return frames


def extract_video(data: bytes, filename: str = "video.mp4") -> str:
    """Read a screen recording: what's on screen, plus anything said over it.

    A screen recording carries its substance visually, so frames are sampled and
    transcribed. Narration is transcribed too where there's an audio track and
    the file is inside Whisper's limit, and both are returned together — a
    lecture capture is worth more with its commentary than without.
    """
    frames = _sample_frames(data)
    on_screen = ""
    if frames:
        on_screen = _read_images(
            frames, label="ocr-video", prompt=VIDEO_OCR_PROMPT,
        )

    spoken = ""
    if len(data) <= WHISPER_MAX_BYTES:
        try:
            spoken = extract_audio(data, filename)
        except ExtractionError as exc:
            # Silent screen recordings are the norm, not an error.
            logger.info("No usable audio in %s: %s", filename, exc)

    parts = []
    if on_screen:
        parts.append(f"On screen:\n{on_screen}")
    if spoken:
        parts.append(f"Narration:\n{spoken}")

    if not parts:
        raise ExtractionError(
            "Nothing readable was found in that video — no on-screen text and "
            "no speech. A screen recording with visible text works best."
        )
    return "\n\n".join(parts)


def extract_source(
    *,
    source_type: str,
    data: bytes | None = None,
    url: str | None = None,
    filename: str = "source",
) -> str:
    """Dispatch to the right extractor for a ``user_files`` row."""
    if source_type == "pdf":
        return extract_pdf(_require(data, "PDF"))
    if source_type == "text":
        return extract_text_file(_require(data, "text file"))
    if source_type == "audio":
        return extract_audio(_require(data, "audio"), filename)
    if source_type == "image":
        return extract_image(_require(data, "image"), filename)
    if source_type == "video":
        return extract_video(_require(data, "video"), filename)
    if source_type == "youtube":
        return extract_youtube(_require(url, "YouTube URL"))
    if source_type == "web":
        return extract_web(_require(url, "web URL"))
    raise ExtractionError(f"Unsupported source type: {source_type!r}")


def _require(value, label: str):  # noqa: ANN001, ANN201
    if not value:
        raise ExtractionError(f"Missing {label} content.")
    return value

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

import io
import re
from html.parser import HTMLParser

import httpx

from app.config import settings

# Whisper's upload ceiling. Larger files need chunking, which we don't do yet.
WHISPER_MAX_BYTES = 25 * 1024 * 1024

# Canonical format sets — this module decides what can be parsed, and storage
# imports these to classify uploads.
PDF_EXTS = {".pdf"}
# Formats Whisper accepts (§4.3a names mp3/wav/m4a explicitly).
AUDIO_EXTS = {".mp3", ".mp4", ".m4a", ".wav", ".webm", ".mpga", ".mpeg", ".ogg", ".flac"}
TEXT_EXTS = {".txt", ".md", ".markdown", ".rst", ".csv"}
SUPPORTED_EXTS = PDF_EXTS | AUDIO_EXTS | TEXT_EXTS

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
    if source_type == "youtube":
        return extract_youtube(_require(url, "YouTube URL"))
    if source_type == "web":
        return extract_web(_require(url, "web URL"))
    raise ExtractionError(f"Unsupported source type: {source_type!r}")


def _require(value, label: str):  # noqa: ANN001, ANN201
    if not value:
        raise ExtractionError(f"Missing {label} content.")
    return value

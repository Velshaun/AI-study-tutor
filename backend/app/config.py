"""Application configuration.

Loads environment variables from a local ``.env`` file (via python-dotenv) and
exposes them through a single cached ``Settings`` instance. Import ``settings``
anywhere in the app instead of reading ``os.environ`` directly.
"""

from __future__ import annotations

import os
from functools import lru_cache

from dotenv import load_dotenv

# Load variables from a .env file located next to the backend root, if present.
load_dotenv()


def _get_bool(key: str, default: bool = False) -> bool:
    raw = os.getenv(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _get_list(key: str, default: list[str] | None = None) -> list[str]:
    raw = os.getenv(key)
    if not raw:
        return default or []
    return [item.strip() for item in raw.split(",") if item.strip()]


class Settings:
    """Strongly-typed view over the process environment."""

    def __init__(self) -> None:
        # --- App -----------------------------------------------------------
        self.app_name: str = os.getenv("APP_NAME", "ConverseAI Tutor")
        self.environment: str = os.getenv("ENVIRONMENT", "development")
        self.debug: bool = _get_bool("DEBUG", self.environment != "production")
        self.host: str = os.getenv("HOST", "0.0.0.0")
        self.port: int = int(os.getenv("PORT", "8000"))

        # --- CORS ----------------------------------------------------------
        # Comma-separated list, e.g. "http://localhost:5173,https://app.example.com"
        self.cors_origins: list[str] = _get_list(
            "CORS_ORIGINS",
            [
                "http://localhost:3000", "http://127.0.0.1:3000",
                "http://localhost:5173", "http://127.0.0.1:5173",
            ],
        )
        # An origin is allowed if it's in CORS_ORIGINS above OR matches this
        # regex. The default clears any Vercel deployment (production + preview
        # URLs) and any localhost port, so the deployed frontend works without
        # pinning its exact origin — a missing origin here is what turns a POST's
        # CORS preflight into a 405.
        self.cors_origin_regex: str = os.getenv(
            "CORS_ORIGIN_REGEX",
            r"https://.*\.vercel\.app|http://localhost:\d+|http://127\.0\.0\.1:\d+",
        )

        # --- Supabase ------------------------------------------------------
        self.supabase_url: str = os.getenv("SUPABASE_URL", "")
        self.supabase_key: str = os.getenv("SUPABASE_KEY", "")
        self.supabase_service_role_key: str = os.getenv(
            "SUPABASE_SERVICE_ROLE_KEY", ""
        )
        self.supabase_jwt_secret: str = os.getenv("SUPABASE_JWT_SECRET", "")

        # --- AI providers --------------------------------------------------
        self.gemini_api_key: str = os.getenv("GEMINI_API_KEY", "")
        # gemini-1.5-* are retired; 2.5-flash is the cheapest tier that supports
        # both Google Search grounding and response_schema, which §4.3 needs.
        self.gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
        # Per-call deadline for generation requests. There was no timeout at
        # all, so a stalled connection held its caller — and, until the
        # endpoints moved off the event loop, the whole API — forever. Normal
        # question-generation calls answer in 10-15s; anything past this is a
        # hang, not a slow success.
        self.gemini_timeout_secs: float = float(os.getenv("GEMINI_TIMEOUT_SECS", "30"))
        self.openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
        self.openai_model: str = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        # Whisper, for audio sources (§4.3 step 2).
        self.whisper_model: str = os.getenv("WHISPER_MODEL", "whisper-1")
        # TTS HD narrates generated lectures (§4.4).
        self.openai_tts_model: str = os.getenv("OPENAI_TTS_MODEL", "tts-1-hd")
        # Voice Q&A answers use the faster (non-HD) model — latency matters more
        # than fidelity in a live back-and-forth. Lectures keep the HD model.
        self.openai_tts_model_qa: str = os.getenv("OPENAI_TTS_MODEL_QA", "tts-1")
        self.openai_voice_marcus: str = os.getenv("OPENAI_TTS_VOICE_MARCUS", "onyx")
        self.openai_voice_sophia: str = os.getenv("OPENAI_TTS_VOICE_SOPHIA", "nova")

        # --- YouTube -------------------------------------------------------
        # Only the *search* door needs this. Pasting a video link works without
        # it, which is why paste is the primary path: the free tier allows about
        # a hundred searches a day across every learner, and the app has to stay
        # usable when that runs out.
        self.youtube_api_key: str = os.getenv("YOUTUBE_API_KEY", "")

        # --- Background worker ---------------------------------------------
        # How many items of one job run at once. Transcript fetches are the
        # reason this is configurable: the ceiling that keeps YouTube happy is
        # only discoverable in production, and lowering it should be an env
        # change rather than a deploy.
        self.worker_item_concurrency: int = int(
            os.getenv("WORKER_ITEM_CONCURRENCY", "5")
        )
        # Which job kinds this worker may claim. Empty means all of them, which
        # is what a single-worker deployment wants and what this was before.
        #
        # It exists because YouTube refuses transcript requests from datacentre
        # IPs, so those items are fetched by a worker on a residential machine
        # while everything else stays on Railway. Two workers, one queue, and
        # the split is expressed here rather than in the handler registry: a
        # worker that claims a job it cannot handle *fails* it rather than
        # putting it back, so "not my kind" has to mean "never claimed".
        self.worker_kinds: list[str] = [
            k.strip() for k in os.getenv("WORKER_KINDS", "").split(",") if k.strip()
        ]
        # Minimum gap between YouTube transcript requests, process-wide.
        #
        # Not a guess: 42 fetches in 62 seconds got a residential IP blocked,
        # and the block outlasted the import. Two seconds is ~30/minute, well
        # under the rate that tripped it, and a 97-video playlist still finishes
        # in about three minutes — which is nothing next to an import that fails
        # entirely and leaves the IP unusable for hours.
        self.youtube_min_interval_secs: float = float(
            os.getenv("YOUTUBE_MIN_INTERVAL_SECS", "2.0")
        )
        # Polling is adaptive: brisk while there is work, a slow heartbeat once
        # the queue has been quiet. Never zero — jobs are queued by things other
        # than a user action, and a failed job needs picking up eventually.
        self.worker_poll_busy_secs: float = float(
            os.getenv("WORKER_POLL_BUSY_SECS", "2")
        )
        self.worker_poll_idle_secs: float = float(
            os.getenv("WORKER_POLL_IDLE_SECS", "45")
        )
        # How long the queue must stay empty before dropping to the slow rate.
        self.worker_idle_after_secs: float = float(
            os.getenv("WORKER_IDLE_AFTER_SECS", "60")
        )
        # How often a running job says it is still alive. Must stay comfortably
        # under jobs.STALE_AFTER or a slow item looks like a dead worker.
        self.worker_heartbeat_secs: float = float(
            os.getenv("WORKER_HEARTBEAT_SECS", "20")
        )

        # --- Storage / uploads --------------------------------------------
        self.upload_dir: str = os.getenv("UPLOAD_DIR", "./uploads")
        self.max_upload_mb: int = int(os.getenv("MAX_UPLOAD_MB", "50"))
        self.storage_bucket: str = os.getenv("STORAGE_BUCKET", "sources")
        self.lecture_audio_bucket: str = os.getenv(
            "LECTURE_AUDIO_BUCKET", "lecture-audio"
        )
        # Signed-URL lifetime for playing back / re-downloading a stored source.
        self.signed_url_ttl_secs: int = int(os.getenv("SIGNED_URL_TTL_SECS", "3600"))

        # --- Ingestion pipeline (§4.3) --------------------------------------
        # Upper bound on characters sent to Gemini for domain extraction; long
        # course packs are sampled head+tail rather than truncated blindly.
        self.max_extract_chars: int = int(os.getenv("MAX_EXTRACT_CHARS", "120000"))

    @property
    def is_production(self) -> bool:
        return self.environment.lower() == "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return a process-wide cached ``Settings`` instance."""
    return Settings()


# Convenience singleton for direct imports: ``from app.config import settings``
settings = get_settings()

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
        self.app_name: str = os.getenv("APP_NAME", "AI Study Tutor")
        self.environment: str = os.getenv("ENVIRONMENT", "development")
        self.debug: bool = _get_bool("DEBUG", self.environment != "production")
        self.host: str = os.getenv("HOST", "0.0.0.0")
        self.port: int = int(os.getenv("PORT", "8000"))

        # --- CORS ----------------------------------------------------------
        # Comma-separated list, e.g. "http://localhost:5173,https://app.example.com"
        self.cors_origins: list[str] = _get_list(
            "CORS_ORIGINS",
            ["http://localhost:5173", "http://127.0.0.1:5173"],
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
        self.openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
        self.openai_model: str = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        # Whisper, for audio sources (§4.3 step 2).
        self.whisper_model: str = os.getenv("WHISPER_MODEL", "whisper-1")
        # TTS HD narrates generated lectures (§4.4).
        self.openai_tts_model: str = os.getenv("OPENAI_TTS_MODEL", "tts-1-hd")
        self.openai_voice_marcus: str = os.getenv("OPENAI_TTS_VOICE_MARCUS", "onyx")
        self.openai_voice_sophia: str = os.getenv("OPENAI_TTS_VOICE_SOPHIA", "nova")

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

"""App settings, loaded from environment / .env file.

Relative paths (the .env file, a relative sqlite URL, upload and Gmail
download folders) are anchored to the backend directory, never to the
process cwd: starting uvicorn from another folder used to silently create a
second, empty helix.db and uploads/ next to wherever it was launched.
"""
import logging
import re
from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)

# backend/app/config.py -> backend/
BACKEND_DIR = Path(__file__).resolve().parents[1]

# The static frontend (scripts/run.sh) is served on :5500 and the API on
# :8000; the API's own /docs page is same-origin with the backend.
DEFAULT_ALLOWED_ORIGINS = (
    "http://localhost:5500,http://127.0.0.1:5500,"
    "http://localhost:8000,http://127.0.0.1:8000"
)

_SQLITE_URL_RE = re.compile(r"^(sqlite(?:\+\w+)?:///)(.*)$")


def resolve_backend_path(value: str | Path) -> Path:
    """Absolute path for a configured/stored path; relative means backend dir."""
    path = Path(value).expanduser()
    return path if path.is_absolute() else BACKEND_DIR / path


def to_storage_path(value: str | Path) -> str:
    """Path string to persist: relative to the backend dir when inside it."""
    path = Path(value).expanduser()
    if not path.is_absolute():
        return str(path)
    try:
        return str(path.resolve().relative_to(BACKEND_DIR))
    except ValueError:
        return str(path)


def _anchor_sqlite_url(url: str) -> str:
    match = _SQLITE_URL_RE.match(url or "")
    if not match:
        return url
    prefix, path = match.groups()
    if not path or path == ":memory:" or path.startswith("file:"):
        return url
    if Path(path).is_absolute():
        return url
    return f"{prefix}{resolve_backend_path(path)}"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    # AI
    ai_provider: str = "hermes"
    hermes_api_url: str = "http://127.0.0.1:8642"
    hermes_api_key: str = ""
    hermes_model: str = "mlx-community/gemma-4-26B-A4B-it-OptiQ-4bit"
    hermes_timeout_seconds: float = 300.0
    ollama_api_url: str = "http://127.0.0.1:11434"
    ollama_ocr_model: str = "gemma4:12b"
    ollama_timeout_seconds: float = 60.0
    ollama_ocr_num_ctx: int = 4096
    enable_automatic_ocr_label_review: bool = True
    automatic_ocr_label_limit: int = 150
    sync_advertised_host: str = ""
    obsidian_vault_path: str = ""
    obsidian_label_library_path: str = "Financial Analyze/Label Library"
    obsidian_line_catalog_path: str = "Financial Analyze/Line Catalog"
    anthropic_api_key: str = ""
    enable_cloud_ai: bool = False
    allow_unverified_filing_ai: bool = False

    # DB
    database_url: str = f"sqlite:///{BACKEND_DIR / 'helix.db'}"

    # Cache (blank disables Redis)
    redis_url: str = ""

    # Screener (rules funnel)
    screener_provider: str = "vnstock"   # vnstock | fixture (tests/dev)
    enable_screener_refresh: bool = True

    # News
    searxng_url: str = "http://127.0.0.1:8888"
    vault_news_dir: str = "/Users/dien/Obsidian/Projects/Financial_Automation/News"

    # News watch + oversold alerts
    newswatch_config_path: str = str(BACKEND_DIR / "newswatch.json")
    newswatch_rsi_oversold: float = 30.0
    newswatch_rsi_reset: float = 40.0
    newswatch_drop_pct: float = 10.0
    newswatch_drop_sessions: int = 5
    newswatch_news_days: int = 7
    newswatch_max_holding_alerts: int = 3
    newswatch_vnindex_drop_pct: float = 2.0

    # Browser origins allowed to call the API (comma-separated). Requests
    # carrying any other Origin header are rejected; "*" is not honoured.
    allowed_origins: str = DEFAULT_ALLOWED_ORIGINS

    # Storage
    upload_dir: str = str(BACKEND_DIR / "uploads")
    # Gmail import (app password lives in macOS Keychain, not here)
    gmail_download_dir: str = str(BACKEND_DIR / "data" / "gmail_reports")
    enable_gmail_poller: bool = True
    max_upload_mb: int = 50

    @field_validator("database_url")
    @classmethod
    def _anchor_database_url(cls, value: str) -> str:
        return _anchor_sqlite_url(value)

    @field_validator("upload_dir", "gmail_download_dir")
    @classmethod
    def _anchor_dir(cls, value: str) -> str:
        return str(resolve_backend_path(value))

    @property
    def origins_list(self) -> list[str]:
        origins = [
            o.strip().rstrip("/")
            for o in (self.allowed_origins or "").split(",")
            if o.strip()
        ]
        if not origins or "*" in origins:
            if "*" in origins:
                logger.warning(
                    "ALLOWED_ORIGINS='*' is no longer supported (any web page could "
                    "drive this API); using the local frontend origins instead"
                )
            origins = [o for o in DEFAULT_ALLOWED_ORIGINS.split(",")]
        return origins


@lru_cache
def get_settings() -> Settings:
    return Settings()

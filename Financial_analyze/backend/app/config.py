"""App settings, loaded from environment / .env file."""
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

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
    anthropic_api_key: str = ""
    enable_cloud_ai: bool = False
    allow_unverified_filing_ai: bool = False

    # DB
    database_url: str = "sqlite:///./helix.db"

    # Cache
    redis_url: str = ""

    # Market data
    market_data_provider: str = "yfinance"
    polygon_api_key: str = ""
    alpaca_api_key: str = ""
    alpaca_secret_key: str = ""

    # Scheduler (daily VN market scan)
    # Full VN scans take hours on the guest API tier. Run explicitly until the
    # scanner moves to a single-instance background worker with a fixed schedule.
    enable_scheduler: bool = False

    # CORS
    allowed_origins: str = "*"

    # Storage
    upload_dir: str = "./uploads"
    max_upload_mb: int = 50

    # Auth
    jwt_secret: str = "change-me"
    jwt_alg: str = "HS256"
    jwt_expire_min: int = 60

    @property
    def origins_list(self) -> list[str]:
        if self.allowed_origins.strip() == "*":
            return ["*"]
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()

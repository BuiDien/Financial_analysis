"""App settings, loaded from environment / .env file."""
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # AI
    anthropic_api_key: str = ""

    # DB
    database_url: str = "sqlite:///./helix.db"

    # Cache
    redis_url: str = ""

    # Market data
    market_data_provider: str = "yfinance"
    polygon_api_key: str = ""
    alpaca_api_key: str = ""
    alpaca_secret_key: str = ""

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

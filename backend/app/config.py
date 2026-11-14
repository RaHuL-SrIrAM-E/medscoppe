from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All configuration comes from environment variables (or a local .env)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    gemini_api_key: str = ""
    gemini_model: str = ""
    cors_origins: str = "https://localhost:8081"

    # Consultation extraction. "auto" = Gemini when a key and model are configured, otherwise the
    # clearly labelled recorded-replay fallback. Every response says which one ran.
    extraction_provider: Literal["auto", "gemini", "replay"] = "auto"
    gemini_timeout_s: float = 20.0
    gemini_max_invalid_attempts: int = 2
    replay_fixture_path: str = ""
    # Synthetic data only. The API refuses any other data_classification unless this is explicitly set.
    allow_real_data: bool = False

    @property
    def gemini_configured(self) -> bool:
        return bool(self.gemini_api_key and self.gemini_model)

    @property
    def resolved_extraction_provider(self) -> Literal["gemini", "replay"]:
        if self.extraction_provider == "gemini":
            return "gemini"
        if self.extraction_provider == "replay":
            return "replay"
        return "gemini" if self.gemini_configured else "replay"

    @property
    def replay_fixture(self) -> Path:
        if self.replay_fixture_path:
            return Path(self.replay_fixture_path)
        repo_root = Path(__file__).resolve().parents[2]
        return repo_root / "contracts" / "fixtures" / "synthetic-respiratory" / "replay.json"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    cqa_api_url: str = ""
    cqa_db_path: str = "cqa.db"
    cqa_batch_concurrency: int = 4
    llm_provider: str = "anthropic"
    llm_api_key: str = ""
    llm_base_url: str = "https://api.anthropic.com"
    llm_model: str = "claude-opus-5-5"
    llm_effort: str = "medium"
    llm_structured_outputs: bool = True
    llm_max_tokens: int = 8192
    llm_price_input: float = 4.0
    llm_price_output: float = 20.0
    llm_price_cache_read: float = 0.2
    llm_price_cache_write: float = 5.0
    appeal_filing_roles: str = "operator,qa"
    appeal_window_workdays: int = 5
    appeal_window_enforced: bool = False
    appeal_aging_hours: int = 72
    aws_region: str = "us-east-1"
    aws_access_key_id: str = ""
    aws_secret_access_key: str = ""
    aws_session_token: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()

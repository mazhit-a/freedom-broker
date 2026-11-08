from functools import lru_cache

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

OPENAI_EFFORTS = ("low", "medium", "high", "xhigh", "max")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    cqa_api_url: str = ""
    cqa_db_path: str = "cqa.db"
    cqa_batch_concurrency: int = 8
    llm_provider: str = "openai"
    llm_api_key: str = ""
    llm_base_url: str = "https://api.anthropic.com"
    llm_model: str = "gpt-6.1-sol"
    llm_label: str = "GPT-6.1 Sol"
    llm_effort: str = "medium"
    llm_structured_outputs: bool = True
    llm_max_tokens: int = 8192
    llm_price_input: float = 4.0
    llm_price_output: float = 20.0
    llm_price_cache_read: float = 0.2
    llm_price_cache_write: float = 5.0
    llm_prompt_version: str = "v2"
    llm_fallback_model: str = ""
    llm_estimate_tokens_input: int = 5000
    llm_estimate_tokens_output: int = 800
    llm_estimate_latency_s: float = 40.0
    appeal_filing_roles: str = "operator,qa"
    appeal_window_workdays: int = 5
    appeal_window_enforced: bool = False
    appeal_aging_hours: int = 72
    openai_api_key: str = ""
    openai_max_output_tokens: int = 32000
    openai_call_ceiling_s: float = 180.0
    openai_max_attempts: int = 5
    openai_max_inflight: int = 12
    aws_region: str = "us-east-1"
    aws_access_key_id: str = ""
    aws_secret_access_key: str = ""
    aws_session_token: str = ""

    @model_validator(mode="after")
    def _check_openai_effort(self) -> "Settings":
        if self.llm_provider == "openai" and self.llm_effort not in OPENAI_EFFORTS:
            raise ValueError(f"llm_effort must be one of {', '.join(OPENAI_EFFORTS)} for provider openai")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()

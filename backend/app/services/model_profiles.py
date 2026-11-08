from dataclasses import dataclass, replace

from backend.app.core.config import Settings


@dataclass(frozen=True)
class ModelProfile:
    model: str
    provider: str = "anthropic"
    effort: str | None = None
    thinking_budget: int | None = None
    max_tokens: int = 8192
    price_input: float = 0.0
    price_output: float = 0.0
    price_cache_read: float = 0.0
    price_cache_write: float = 0.0
    supports_effort: bool = True

    def with_overrides(self, **changes) -> "ModelProfile":
        return replace(self, **changes)


PROFILES: dict[str, ModelProfile] = {
    "claude-opus-5-5": ModelProfile(
        model="claude-opus-5-5",
        effort="medium",
        price_input=4.0,
        price_output=20.0,
        price_cache_read=0.2,
        price_cache_write=5.0,
        supports_effort=True,
    ),
    "claude-sonnet-5-5": ModelProfile(
        model="claude-sonnet-5-5",
        effort="medium",
        price_input=2.0,
        price_output=10.0,
        price_cache_read=0.2,
        price_cache_write=2.5,
        supports_effort=True,
    ),
    "claude-haiku-5-5": ModelProfile(
        model="claude-haiku-5-5",
        effort="medium",
        price_input=0.10,
        price_output=0.50,
        price_cache_read=0.01,
        price_cache_write=0.125,
        supports_effort=True,
    ),
    "claude-haiku-4-5": ModelProfile(
        model="claude-haiku-4-5",
        effort=None,
        thinking_budget=None,
        price_input=1.0,
        price_output=5.0,
        price_cache_read=0.1,
        price_cache_write=1.25,
        supports_effort=False,
    ),
}


def get_profile(name: str) -> ModelProfile:
    try:
        return PROFILES[name]
    except KeyError:
        raise KeyError(f"unknown model profile {name!r}, known: {sorted(PROFILES)}") from None


def profile_from_settings(settings: Settings) -> ModelProfile:
    return ModelProfile(
        model=settings.llm_model,
        provider=settings.llm_provider,
        effort=settings.llm_effort,
        thinking_budget=None,
        max_tokens=settings.llm_max_tokens,
        price_input=settings.llm_price_input,
        price_output=settings.llm_price_output,
        price_cache_read=settings.llm_price_cache_read,
        price_cache_write=settings.llm_price_cache_write,
        supports_effort=True,
    )


def profile_cost(profile: ModelProfile, input_tokens: int, output_tokens: int, cache_read: int, cache_write: int) -> float:
    total = (
        input_tokens * profile.price_input
        + output_tokens * profile.price_output
        + cache_read * profile.price_cache_read
        + cache_write * profile.price_cache_write
    )
    return round(total / 1_000_000, 6)

from backend.app.core.config import get_settings
from backend.app.services.llm_client import LLMClient
from backend.app.services.model_profiles import PROFILES, profile_from_settings


def primary_ids(primary) -> set[str]:
    ids = {profile_from_settings(get_settings()).model}
    model = getattr(primary, "model", None)
    if isinstance(model, str):
        ids.add(model)
    return ids


def client_for(model_id: str | None, primary):
    if model_id is None or model_id in primary_ids(primary):
        return primary
    profile = PROFILES.get(model_id)
    if profile is None:
        raise KeyError(f"unknown model {model_id!r}")
    settings = get_settings()
    if profile.provider == "openai":
        from backend.app.services.openai_client import OpenAIClient

        return OpenAIClient(settings=settings, profile=profile)
    return LLMClient(settings=settings, profile=profile)

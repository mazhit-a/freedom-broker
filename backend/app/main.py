import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from backend.app.api.v1.router import router as v1_router
from backend.app.core.config import Settings, get_settings
from backend.app.core.database import connect, init_db
from backend.app.core.errors import install as install_errors
from backend.app.services.checklist import seed_default
from backend.app.services.model_profiles import profile_from_settings

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"
logger = logging.getLogger("uvicorn.error")


def llm_ready(settings: Settings) -> bool:
    if settings.llm_provider == "openai":
        return bool(settings.openai_api_key)
    if settings.llm_provider == "bedrock":
        return bool(settings.aws_region)
    return bool(settings.llm_api_key)


def llm_status(settings: Settings) -> dict:
    return {
        "provider": settings.llm_provider,
        "model": profile_from_settings(settings).model,
        "ready": llm_ready(settings),
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    settings = get_settings()
    status = llm_status(settings)
    logger.info(
        "llm provider=%s model=%s effort=%s prompt_version=%s key_present=%s",
        status["provider"],
        status["model"],
        settings.llm_effort,
        settings.llm_prompt_version,
        status["ready"],
    )
    conn = connect()
    try:
        seed_default(conn)
    finally:
        conn.close()
    yield


app = FastAPI(title="CQA", lifespan=lifespan)
install_errors(app)


@app.get("/health")
def health():
    return {"status": "ok", "llm": llm_status(get_settings())}


app.include_router(v1_router, prefix="/api/v1")

FRONTEND_DIR.mkdir(exist_ok=True)
app.mount("/app", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

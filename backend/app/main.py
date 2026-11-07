from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from backend.app.api.v1.router import router as v1_router
from backend.app.core.database import init_db

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="CQA", lifespan=lifespan)


@app.get("/health")
def health():
    return {"status": "ok"}


app.include_router(v1_router, prefix="/api/v1")

FRONTEND_DIR.mkdir(exist_ok=True)
app.mount("/app", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

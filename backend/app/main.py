from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from backend.app.api.v1.router import router as v1_router
from backend.app.core.database import connect, init_db
from backend.app.core.errors import install as install_errors
from backend.app.services.checklist import seed_default

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
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
    return {"status": "ok"}


app.include_router(v1_router, prefix="/api/v1")

FRONTEND_DIR.mkdir(exist_ok=True)
app.mount("/app", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

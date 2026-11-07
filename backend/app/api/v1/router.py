from fastapi import APIRouter

from backend.app.api.v1 import batches, conversations, datasets, evaluations

from backend.app.api.v1.appeals import router as appeals_router
from backend.app.api.v1.audio import router as audio_router
from backend.app.api.v1.checklists import router as checklists_router
from backend.app.api.v1.runs import router as runs_router
from backend.app.api.v1.runs import models_router
from backend.app.api.v1.stats import router as stats_router

router = APIRouter()
router.include_router(checklists_router)
router.include_router(datasets.router)
router.include_router(conversations.router)
router.include_router(evaluations.router)
router.include_router(audio_router)
router.include_router(batches.router)
router.include_router(appeals_router)
router.include_router(stats_router)
router.include_router(runs_router)
router.include_router(models_router)

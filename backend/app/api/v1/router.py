from fastapi import APIRouter

from backend.app.api.v1 import batches, conversations, datasets, evaluations

from backend.app.api.v1.audio import router as audio_router
from backend.app.api.v1.checklists import router as checklists_router

router = APIRouter()
router.include_router(checklists_router)
router.include_router(datasets.router)
router.include_router(conversations.router)
router.include_router(evaluations.router)
router.include_router(audio_router)
router.include_router(batches.router)

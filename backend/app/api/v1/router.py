from fastapi import APIRouter

from backend.app.api.v1 import conversations, datasets

from backend.app.api.v1.checklists import router as checklists_router

router = APIRouter()
router.include_router(checklists_router)
router.include_router(datasets.router)
router.include_router(conversations.router)

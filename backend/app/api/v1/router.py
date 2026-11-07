from fastapi import APIRouter

from backend.app.api.v1.checklists import router as checklists_router

router = APIRouter()
router.include_router(checklists_router)

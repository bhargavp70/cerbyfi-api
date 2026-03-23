"""Admin-only endpoints."""
from fastapi import APIRouter, Depends
from app.db import score_db
from app.user_auth import require_admin

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/stats")
def admin_stats(user_id: str = Depends(require_admin)):
    return {
        "user_count": score_db.count_users(),
        "total_analyses": score_db.total_analyses(),
    }

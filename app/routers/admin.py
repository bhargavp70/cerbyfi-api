"""Admin-only endpoints."""
from fastapi import APIRouter, Depends, HTTPException
from app.db import score_db
from app.config import settings
from app.user_auth import require_admin

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/stats")
def admin_stats(user_id: str = Depends(require_admin)):
    return {
        "user_count": score_db.count_users(),
        "total_analyses": score_db.total_analyses(),
    }


@router.get("/users")
def list_users(user_id: str = Depends(require_admin)):
    users = score_db.list_users()
    return [
        {
            "id": u["id"],
            "name": u["name"],
            "email": u["email"],
            "is_admin": bool(u["is_admin"]),
            "is_protected": u["email"] in settings.admin_email_set,
        }
        for u in users
    ]


@router.patch("/users/{target_id}")
def set_user_admin(target_id: str, body: dict, user_id: str = Depends(require_admin)):
    if "is_admin" not in body:
        raise HTTPException(status_code=422, detail="is_admin field required.")

    target = score_db.get_user_by_id(target_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found.")

    # Prevent demoting a config-protected admin
    if not body["is_admin"] and target["email"] in settings.admin_email_set:
        raise HTTPException(
            status_code=403,
            detail="Cannot remove admin from a protected admin account."
        )

    # Prevent self-demotion
    if not body["is_admin"] and target_id == user_id:
        raise HTTPException(status_code=403, detail="Cannot remove your own admin access.")

    score_db.set_admin(target_id, bool(body["is_admin"]))
    return {"ok": True}

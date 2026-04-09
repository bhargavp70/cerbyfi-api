"""Admin-only endpoints."""
import json
import secrets
import time
from fastapi import APIRouter, Depends, HTTPException, Request
from app.db import score_db
from app.config import settings
from app.user_auth import require_admin, optional_user

FEEDBACK_MAX_TOTAL = 300
FEEDBACK_MAX_WORDS = 200

_ALLOWED_SETTINGS = {"ai_monthly_limit"}

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/stats")
def admin_stats(user_id: str = Depends(require_admin)):
    return {
        "user_count": score_db.count_users(),
        "total_analyses": score_db.total_analyses(),
        "ai_reports_cached": score_db.count_ai_cache(),
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
            "is_premium": bool(u["is_premium"]),
            "can_refresh_ai": bool(u["can_refresh_ai"]),
            "is_protected": u["email"] in settings.admin_email_set,
        }
        for u in users
    ]


@router.patch("/users/{target_id}")
def update_user(target_id: str, body: dict, user_id: str = Depends(require_admin)):
    target = score_db.get_user_by_id(target_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found.")

    if "is_admin" in body:
        if not body["is_admin"] and target["email"] in settings.admin_email_set:
            raise HTTPException(status_code=403, detail="Cannot remove admin from a protected admin account.")
        if not body["is_admin"] and target_id == user_id:
            raise HTTPException(status_code=403, detail="Cannot remove your own admin access.")
        score_db.set_admin(target_id, bool(body["is_admin"]))

    if "is_premium" in body:
        score_db.set_premium(target_id, bool(body["is_premium"]))

    if "can_refresh_ai" in body:
        score_db.set_can_refresh_ai(target_id, bool(body["can_refresh_ai"]))

    return {"ok": True}


@router.delete("/users/{target_id}")
def eject_user(target_id: str, user_id: str = Depends(require_admin)):
    target = score_db.get_user_by_id(target_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found.")
    if target["email"] in settings.admin_email_set:
        raise HTTPException(status_code=403, detail="Cannot eject a protected admin account.")
    if target_id == user_id:
        raise HTTPException(status_code=403, detail="Cannot eject yourself.")
    score_db.delete_user(target_id)
    return {"ok": True}


@router.delete("/ai-cache/{ticker}")
def delete_ai_cache(ticker: str, user_id: str = Depends(require_admin)):
    score_db.delete_ai_analysis(ticker.upper())
    return {"ok": True}


@router.get("/settings")
def get_settings(user_id: str = Depends(require_admin)):
    limit = score_db.get_setting("ai_monthly_limit", "")
    return {
        "ai_monthly_limit": int(limit) if limit else settings.ai_monthly_limit,
    }


@router.patch("/settings")
def update_settings(body: dict, user_id: str = Depends(require_admin)):
    for key, value in body.items():
        if key not in _ALLOWED_SETTINGS:
            raise HTTPException(status_code=400, detail=f"Unknown setting: {key}")
        if key == "ai_monthly_limit":
            try:
                v = int(value)
                if v < 0:
                    raise ValueError
            except (ValueError, TypeError):
                raise HTTPException(status_code=422, detail="ai_monthly_limit must be a non-negative integer.")
            score_db.set_setting(key, str(v))
    return {"ok": True}


# ── Feedback ──────────────────────────────────────────────────

@router.post("/feedback", dependencies=[])
def submit_feedback(body: dict, user_id: str = Depends(optional_user)):
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=422, detail="Feedback text is required.")
    words = len(text.split())
    if words > FEEDBACK_MAX_WORDS:
        raise HTTPException(status_code=422, detail=f"Feedback must be {FEEDBACK_MAX_WORDS} words or fewer.")
    if score_db.count_feedback() >= FEEDBACK_MAX_TOTAL:
        raise HTTPException(status_code=429, detail="Feedback limit reached. Thank you for your interest!")

    user_name = None
    if user_id:
        u = score_db.get_user_by_id(user_id)
        user_name = u["name"] if u else None

    score_db.add_feedback(
        id=secrets.token_urlsafe(12),
        user_id=user_id,
        user_name=user_name,
        text=text,
    )
    return {"ok": True}


@router.get("/feedback")
def get_feedback(user_id: str = Depends(require_admin)):
    rows = score_db.list_feedback()
    return [
        {
            "id": r["id"],
            "user_name": r["user_name"] or "Anonymous",
            "text": r["text"],
            "created_at": r["created_at"],
        }
        for r in rows
    ]


@router.delete("/feedback/{feedback_id}")
def delete_feedback(feedback_id: str, user_id: str = Depends(require_admin)):
    score_db.delete_feedback(feedback_id)
    return {"ok": True}


# ── About Us ──────────────────────────────────────────────────

_DEFAULT_ABOUT = {
    "title": "About CerbyFi",
    "tagline": "Smarter stock & ETF analysis for every investor",
    "body": "CerbyFi scores every US-listed stock and ETF on a 100-point framework across valuation, profitability, growth, financial health, and momentum. Our goal is to make institutional-quality fundamental analysis accessible to retail investors — no Bloomberg terminal required.",
    "highlights": [
        {"icon": "📊", "title": "100-Point Scoring", "text": "Every stock scored across multiple categories with full metric breakdowns and a clear rating scale."},
        {"icon": "🤖", "title": "AI Analysis", "text": "Premium AI reports powered by Claude with live web research — news, analyst sentiment, and opportunities."},
        {"icon": "💼", "title": "Portfolio Tools", "text": "Build, optimize, and track your portfolio with real money tracking, dividends, and risk metrics."}
    ],
}


@router.get("/about", dependencies=[])
def get_about():
    """Public — returns the About Us content."""
    raw = score_db.get_setting("about_content", "")
    if raw:
        try:
            return json.loads(raw)
        except Exception:
            pass
    return _DEFAULT_ABOUT


@router.patch("/about")
def update_about(body: dict, user_id: str = Depends(require_admin)):
    """Admin — update About Us content."""
    allowed = {"title", "tagline", "body", "highlights"}
    data = {k: v for k, v in body.items() if k in allowed}

    # Validate highlights structure
    if "highlights" in data:
        highlights = data["highlights"]
        if not isinstance(highlights, list) or len(highlights) > 4:
            raise HTTPException(status_code=422, detail="highlights must be a list of up to 4 items.")
        for h in highlights:
            if not isinstance(h, dict) or not h.get("title") or not h.get("text"):
                raise HTTPException(status_code=422, detail="Each highlight needs title and text.")
            h["icon"] = str(h.get("icon", ""))[:4]
            h["title"] = str(h["title"])[:80]
            h["text"] = str(h["text"])[:200]

    if "title" in data:
        data["title"] = str(data["title"])[:120]
    if "tagline" in data:
        data["tagline"] = str(data["tagline"])[:200]
    if "body" in data:
        data["body"] = str(data["body"])[:1000]

    # Merge with existing so partial updates work
    existing_raw = score_db.get_setting("about_content", "")
    existing = json.loads(existing_raw) if existing_raw else dict(_DEFAULT_ABOUT)
    existing.update(data)
    score_db.set_setting("about_content", json.dumps(existing))
    return {"ok": True, "about": existing}

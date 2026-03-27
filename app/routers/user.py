"""User registration, login, and profile endpoints."""
import re
import secrets
import time
import uuid
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, field_validator
from app.db import score_db
from app.config import settings
from app.user_auth import hash_password, verify_password, create_token, require_user
from app.email_utils import send_verification_email


router = APIRouter(prefix="/api/auth", tags=["auth"])

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class RegisterIn(BaseModel):
    email: str
    name: str
    password: str

    @field_validator("email")
    @classmethod
    def valid_email(cls, v):
        if not _EMAIL_RE.match(v.strip()):
            raise ValueError("Invalid email address.")
        return v.strip().lower()

    @field_validator("name")
    @classmethod
    def valid_name(cls, v):
        v = v.strip()
        if len(v) < 1:
            raise ValueError("Name is required.")
        return v

    @field_validator("password")
    @classmethod
    def valid_password(cls, v):
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters.")
        if not re.search(r"\d", v):
            raise ValueError("Password must contain at least one number.")
        if not re.search(r"[!@#$%^&*()_+\-=\[\]{};':\"\\|,.<>/?`~]", v):
            raise ValueError("Password must contain at least one special character.")
        return v


class LoginIn(BaseModel):
    email: str
    password: str


@router.post("/register")
def register(body: RegisterIn):
    if score_db.get_user_by_email(body.email):
        raise HTTPException(status_code=409, detail="An account with this email already exists.")
    user_id = str(uuid.uuid4())
    is_admin = body.email in settings.admin_email_set
    score_db.create_user(user_id, body.email, body.name, hash_password(body.password), is_admin=is_admin)

    # Send verification email (best-effort — don't fail registration if SMTP is down)
    verify_token = secrets.token_urlsafe(32)
    score_db.create_verification_token(verify_token, user_id, time.time() + 86400)  # 24h
    verify_url = f"{settings.app_base_url}/api/auth/verify/{verify_token}"
    send_verification_email(body.email, body.name, verify_url)

    token = create_token(user_id)
    return {
        "token": token,
        "email_sent": bool(settings.smtp_host),
        "user": {
            "id": user_id, "email": body.email, "name": body.name,
            "is_admin": is_admin, "is_premium": False,
            "can_refresh_ai": False, "email_verified": is_admin,  # admins pre-verified
        },
    }


@router.get("/verify/{token}", response_class=HTMLResponse)
def verify_email(token: str):
    user_id = score_db.consume_verification_token(token)
    if not user_id:
        return HTMLResponse(_verify_page("❌ Invalid or Expired Link",
            "This verification link has expired or already been used. "
            "Please register again or contact support.", success=False), status_code=400)
    score_db.verify_email(user_id)
    return HTMLResponse(_verify_page("✅ Email Verified!",
        "Your email address has been verified. You can now sign in to CerbyFi.", success=True))


def _verify_page(title: str, msg: str, success: bool) -> str:
    color = "#4f8ef7" if success else "#ff4d6a"
    return f"""<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>{title} — CerbyFi</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{{background:#0a0a14;color:#f0f0fa;font-family:-apple-system,sans-serif;
    display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}}
    .box{{text-align:center;padding:48px 32px;max-width:420px;}}
    .brand{{font-size:1.6rem;font-weight:900;margin-bottom:32px;}}
    .brand span{{color:#4f8ef7;}} h1{{font-size:1.4rem;color:{color};margin-bottom:16px;}}
    p{{color:#9999bb;line-height:1.6;margin-bottom:28px;}}
    a{{display:inline-block;padding:11px 28px;background:#4f8ef7;color:#fff;
    border-radius:8px;text-decoration:none;font-weight:700;}}</style></head>
    <body><div class="box"><div class="brand">Cerby<span>Fi</span></div>
    <h1>{title}</h1><p>{msg}</p><a href="/">Go to CerbyFi</a></div></body></html>"""


@router.post("/login")
def login(body: LoginIn):
    user = score_db.get_user_by_email(body.email.strip().lower())
    if not user or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Incorrect email or password.")
    token = create_token(user["id"])
    return {"token": token, "user": {"id": user["id"], "email": user["email"], "name": user["name"], "is_admin": bool(user.get("is_admin")), "is_premium": bool(user.get("is_premium")), "can_refresh_ai": bool(user.get("can_refresh_ai"))}}


@router.get("/me")
def me(user_id: str = Depends(require_user)):
    user = score_db.get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    return {**user, "is_admin": bool(user.get("is_admin")), "is_premium": bool(user.get("is_premium")), "can_refresh_ai": bool(user.get("can_refresh_ai"))}

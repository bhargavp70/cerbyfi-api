"""User registration, login, and profile endpoints."""
import re
import uuid
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, field_validator
from app.db import score_db
from app.config import settings
from app.user_auth import hash_password, verify_password, create_token, require_user

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
        if len(v) < 6:
            raise ValueError("Password must be at least 6 characters.")
        return v


class LoginIn(BaseModel):
    email: str
    password: str


@router.post("/register")
def register(body: RegisterIn):
    if score_db.get_user_by_email(body.email):
        raise HTTPException(status_code=409, detail="An account with this email already exists.")
    user_id = str(uuid.uuid4())
    score_db.create_user(user_id, body.email, body.name, hash_password(body.password))
    token = create_token(user_id)
    is_admin = body.email in settings.admin_email_set
    return {"token": token, "user": {"id": user_id, "email": body.email, "name": body.name, "is_admin": is_admin}}


@router.post("/login")
def login(body: LoginIn):
    user = score_db.get_user_by_email(body.email.strip().lower())
    if not user or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Incorrect email or password.")
    token = create_token(user["id"])
    is_admin = user["email"] in settings.admin_email_set
    return {"token": token, "user": {"id": user["id"], "email": user["email"], "name": user["name"], "is_admin": is_admin}}


@router.get("/me")
def me(user_id: str = Depends(require_user)):
    user = score_db.get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    return {**user, "is_admin": user["email"] in settings.admin_email_set}

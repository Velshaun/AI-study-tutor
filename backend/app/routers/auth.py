"""Authentication & profile routes.

OAuth (Google/GitHub) and email sign-in happen client-side via the Supabase JS
SDK. The backend's job is to (a) verify the caller's access token and (b) serve
and mutate their ``profiles`` row using the service-role client.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, EmailStr, Field

from app.database import get_supabase

router = APIRouter(prefix="/auth", tags=["auth"])


# --- Schemas --------------------------------------------------------------
class AuthUser(BaseModel):
    """Identity resolved from a verified JWT."""

    id: str
    email: EmailStr | None = None


class Profile(BaseModel):
    id: str
    email: EmailStr | None = None
    name: str | None = None
    avatar_url: str | None = None
    preferences: dict[str, Any] = Field(default_factory=dict)


class PreferencesUpdate(BaseModel):
    preferences: dict[str, Any]


# --- Auth dependency ------------------------------------------------------
def _supabase():
    try:
        return get_supabase()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc


async def get_current_user(
    authorization: str = Header(..., description="Bearer <supabase_access_token>"),
) -> AuthUser:
    """Validate a Supabase JWT and return the caller's identity."""
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed Authorization header.",
        )
    token = authorization.split(" ", 1)[1].strip()
    client = _supabase()
    try:
        result = client.auth.get_user(token)
    except Exception as exc:  # noqa: BLE001 - normalise SDK errors to 401
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token.",
        ) from exc
    if not result or not result.user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token.",
        )
    return AuthUser(id=result.user.id, email=result.user.email)


# --- Routes ---------------------------------------------------------------
@router.get("/me", response_model=Profile)
async def me(user: AuthUser = Depends(get_current_user)) -> Profile:
    """Return the current user's profile, creating it on first access."""
    client = _supabase()
    query = (
        client.table("profiles").select("*").eq("id", user.id).limit(1).execute()
    )
    rows = query.data or []

    if rows:
        row = rows[0]
    else:
        # First login (e.g. the DB trigger hasn't populated it yet) — upsert.
        payload = {"id": user.id, "email": user.email}
        inserted = (
            client.table("profiles")
            .upsert(payload, on_conflict="id")
            .execute()
        )
        row = (inserted.data or [payload])[0]

    return Profile(
        id=row["id"],
        email=row.get("email"),
        name=row.get("name"),
        avatar_url=row.get("avatar_url"),
        preferences=row.get("preferences") or {},
    )


@router.post("/preferences", response_model=Profile)
async def update_preferences(
    payload: PreferencesUpdate,
    user: AuthUser = Depends(get_current_user),
) -> Profile:
    """Merge new preference keys into the user's stored preferences."""
    client = _supabase()

    existing = (
        client.table("profiles")
        .select("preferences")
        .eq("id", user.id)
        .limit(1)
        .execute()
    )
    current: dict[str, Any] = {}
    if existing.data:
        current = existing.data[0].get("preferences") or {}

    merged = {**current, **payload.preferences}

    updated = (
        client.table("profiles")
        .update({"preferences": merged})
        .eq("id", user.id)
        .execute()
    )
    if not updated.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Profile not found."
        )
    row = updated.data[0]
    return Profile(
        id=row["id"],
        email=row.get("email"),
        name=row.get("name"),
        avatar_url=row.get("avatar_url"),
        preferences=row.get("preferences") or {},
    )

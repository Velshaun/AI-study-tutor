"""Study groups & sharing — spec Prompt 8.

    POST   /groups                                create a group
    POST   /groups/join                           join by invite code
    GET    /groups                                groups I'm in
    GET    /groups/{id}                           detail: members + shared domains
    POST   /groups/{id}/share                     owner shares a domain
    PATCH  /groups/{id}/share/{domain_id}         owner toggles lecture/Q&A
    PATCH  /groups/{id}/domains/{domain_id}/view  invitee toggles their own Q&A view
    GET    /groups/{id}/shared-content            content visible to me, read-only
    DELETE /groups/{id}/members/{user_id}         owner removes, or member leaves

Sharing rules:
- A domain's lecture is visible to members when ``share_lecture`` is on.
- A domain's Q&A is visible to a member only when BOTH the owner's ``share_qa``
  and that member's own ``view_qa`` are true.
- Everything shared is read-only for invitees — they see the owner's already-
  generated content, so viewing a shared module makes no AI calls at all.

The backend uses the service-role key (bypassing RLS), so every route enforces
membership/ownership explicitly.
"""

from __future__ import annotations

import logging
import secrets
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.database import get_supabase
from app.routers.auth import AuthUser, get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/groups", tags=["groups"])

INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no ambiguous 0/O/1/I


# --- Schemas ----------------------------------------------------------------
class GroupCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    description: str = ""


class JoinRequest(BaseModel):
    invite_code: str = Field(..., min_length=4, max_length=16)


class Member(BaseModel):
    user_id: str
    name: str | None = None
    role: str = "member"
    joined_at: datetime | None = None


class SharedDomain(BaseModel):
    domain_id: str
    title: str | None = None
    module_title: str | None = None
    share_lecture: bool = True
    share_qa: bool = False
    # The requesting member's own toggle, and the resolved visibility.
    view_qa: bool = True
    qa_visible: bool = False
    shared_by: str | None = None


class Group(BaseModel):
    id: str
    name: str
    description: str = ""
    invite_code: str | None = None  # only exposed to members
    owner_id: str | None = None
    is_owner: bool = False
    member_count: int = 0
    created_at: datetime | None = None


class GroupDetail(Group):
    members: list[Member] = Field(default_factory=list)
    shared_domains: list[SharedDomain] = Field(default_factory=list)


class ShareRequest(BaseModel):
    domain_id: str
    share_lecture: bool = True
    share_qa: bool = False


class ShareUpdate(BaseModel):
    share_lecture: bool | None = None
    share_qa: bool | None = None


class ViewUpdate(BaseModel):
    view_qa: bool


# --- Helpers ----------------------------------------------------------------
def _client():
    try:
        return get_supabase()
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _group(group_id: str) -> dict[str, Any]:
    rows = (
        _client().table("groups").select("*").eq("id", group_id).limit(1).execute()
    ).data or []
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Group not found.")
    return rows[0]


def _membership(group_id: str, user_id: str) -> dict[str, Any] | None:
    rows = (
        _client().table("group_members").select("*")
        .eq("group_id", group_id).eq("user_id", user_id).limit(1).execute()
    ).data or []
    return rows[0] if rows else None


def _require_member(group_id: str, user_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return (group, membership), or 404 if the caller isn't a member.

    404 rather than 403 so a non-member can't confirm the group even exists.
    """
    group = _group(group_id)
    member = _membership(group_id, user_id)
    if not member:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Group not found.")
    return group, member


def _require_owner(group_id: str, user_id: str) -> dict[str, Any]:
    group = _group(group_id)
    if group.get("owner_id") != user_id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Only the group owner can do that."
        )
    return group


def _member_count(group_id: str) -> int:
    result = (
        _client().table("group_members").select("id", count="exact")
        .eq("group_id", group_id).execute()
    )
    return result.count or len(result.data or [])


def _unique_invite_code() -> str:
    client = _client()
    for _ in range(10):
        code = "".join(secrets.choice(INVITE_ALPHABET) for _ in range(8))
        exists = (
            client.table("groups").select("id").eq("invite_code", code)
            .limit(1).execute()
        ).data
        if not exists:
            return code
    return "".join(secrets.choice(INVITE_ALPHABET) for _ in range(12))


def _to_group(row: dict[str, Any], user_id: str, *, count: int | None = None) -> Group:
    return Group(
        id=row["id"],
        name=row.get("name") or "",
        description=row.get("description") or "",
        invite_code=row.get("invite_code"),
        owner_id=row.get("owner_id"),
        is_owner=row.get("owner_id") == user_id,
        member_count=count if count is not None else _member_count(row["id"]),
        created_at=row.get("created_at"),
    )


def _names_for(user_ids: list[str]) -> dict[str, str]:
    if not user_ids:
        return {}
    rows = (
        _client().table("profiles").select("id, name, email")
        .in_("id", user_ids).execute()
    ).data or []
    return {
        r["id"]: (r.get("name") or (r.get("email") or "").split("@")[0])
        for r in rows
    }


def _shared_domains(group_id: str, user_id: str) -> list[SharedDomain]:
    """Shared domains with the caller's resolved Q&A visibility."""
    client = _client()
    shared = (
        client.table("group_shared_domains").select("*")
        .eq("group_id", group_id).execute()
    ).data or []
    if not shared:
        return []

    domain_ids = [s["domain_id"] for s in shared]
    domains = {
        d["id"]: d for d in (
            client.table("domains").select("id, title, module_id")
            .in_("id", domain_ids).execute()
        ).data or []
    }
    module_ids = [d["module_id"] for d in domains.values() if d.get("module_id")]
    modules = {
        m["id"]: m for m in (
            client.table("modules").select("id, title").in_("id", module_ids).execute()
        ).data or []
    } if module_ids else {}

    views = {
        v["domain_id"]: v for v in (
            client.table("group_domain_views").select("domain_id, view_qa")
            .eq("group_id", group_id).eq("user_id", user_id).execute()
        ).data or []
    }

    out: list[SharedDomain] = []
    for s in shared:
        domain = domains.get(s["domain_id"], {})
        module = modules.get(domain.get("module_id"), {})
        view_qa = views.get(s["domain_id"], {}).get("view_qa", True)  # default true
        share_qa = bool(s.get("share_qa"))
        out.append(SharedDomain(
            domain_id=s["domain_id"],
            title=domain.get("title"),
            module_title=module.get("title"),
            share_lecture=bool(s.get("share_lecture", True)),
            share_qa=share_qa,
            view_qa=view_qa,
            qa_visible=share_qa and view_qa,
            shared_by=s.get("shared_by"),
        ))
    return out


# --- Create / join / list ---------------------------------------------------
@router.post("", response_model=Group, status_code=status.HTTP_201_CREATED)
async def create_group(
    payload: GroupCreate,
    user: AuthUser = Depends(get_current_user),
) -> Group:
    """Create a group; the caller becomes its owner and first member."""
    client = _client()
    inserted = client.table("groups").insert({
        "owner_id": user.id,
        "name": payload.name,
        "description": payload.description,
        "invite_code": _unique_invite_code(),
    }).execute()
    if not inserted.data:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Could not create the group.")
    group = inserted.data[0]

    client.table("group_members").insert({
        "group_id": group["id"], "user_id": user.id, "role": "owner",
    }).execute()
    return _to_group(group, user.id, count=1)


@router.post("/join", response_model=Group)
async def join_group(
    payload: JoinRequest,
    user: AuthUser = Depends(get_current_user),
) -> Group:
    """Join a group by its invite code."""
    client = _client()
    code = payload.invite_code.strip().upper()
    rows = (
        client.table("groups").select("*").eq("invite_code", code).limit(1).execute()
    ).data or []
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No group with that invite code.")
    group = rows[0]

    if not _membership(group["id"], user.id):
        client.table("group_members").insert({
            "group_id": group["id"], "user_id": user.id, "role": "member",
        }).execute()
    return _to_group(group, user.id)


@router.get("", response_model=list[Group])
async def list_groups(user: AuthUser = Depends(get_current_user)) -> list[Group]:
    """Every group the caller belongs to, with member counts."""
    client = _client()
    memberships = (
        client.table("group_members").select("group_id")
        .eq("user_id", user.id).execute()
    ).data or []
    group_ids = [m["group_id"] for m in memberships]
    if not group_ids:
        return []

    groups = (
        client.table("groups").select("*").in_("id", group_ids)
        .order("created_at", desc=True).execute()
    ).data or []

    counts_rows = (
        client.table("group_members").select("group_id")
        .in_("group_id", group_ids).execute()
    ).data or []
    counts: dict[str, int] = {}
    for r in counts_rows:
        counts[r["group_id"]] = counts.get(r["group_id"], 0) + 1

    return [_to_group(g, user.id, count=counts.get(g["id"], 0)) for g in groups]


# --- Detail -----------------------------------------------------------------
@router.get("/{group_id}", response_model=GroupDetail)
async def group_detail(
    group_id: str,
    user: AuthUser = Depends(get_current_user),
) -> GroupDetail:
    """Members and shared domains, from the caller's perspective."""
    group, _ = _require_member(group_id, user.id)
    client = _client()

    member_rows = (
        client.table("group_members").select("*")
        .eq("group_id", group_id).order("joined_at").execute()
    ).data or []
    names = _names_for([m["user_id"] for m in member_rows])
    members = [
        Member(
            user_id=m["user_id"],
            name=names.get(m["user_id"]),
            role=m.get("role") or "member",
            joined_at=m.get("joined_at"),
        )
        for m in member_rows
    ]

    base = _to_group(group, user.id, count=len(member_rows))
    return GroupDetail(
        **base.model_dump(),
        members=members,
        shared_domains=_shared_domains(group_id, user.id),
    )


# --- Sharing (owner) --------------------------------------------------------
@router.post("/{group_id}/share", response_model=SharedDomain,
             status_code=status.HTTP_201_CREATED)
async def share_domain(
    group_id: str,
    payload: ShareRequest,
    user: AuthUser = Depends(get_current_user),
) -> SharedDomain:
    """Owner shares one of their own domains into the group."""
    _require_owner(group_id, user.id)
    client = _client()

    owns = (
        client.table("domains").select("id")
        .eq("id", payload.domain_id).eq("user_id", user.id).limit(1).execute()
    ).data
    if not owns:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "You can only share a domain you own."
        )

    client.table("group_shared_domains").upsert({
        "group_id": group_id,
        "domain_id": payload.domain_id,
        "shared_by": user.id,
        "share_lecture": payload.share_lecture,
        "share_qa": payload.share_qa,
    }, on_conflict="group_id,domain_id").execute()

    for d in _shared_domains(group_id, user.id):
        if d.domain_id == payload.domain_id:
            return d
    raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Could not share the domain.")


@router.patch("/{group_id}/share/{domain_id}", response_model=SharedDomain)
async def update_share(
    group_id: str,
    domain_id: str,
    payload: ShareUpdate,
    user: AuthUser = Depends(get_current_user),
) -> SharedDomain:
    """Owner toggles the lecture and/or Q&A sharing for a shared domain."""
    _require_owner(group_id, user.id)
    client = _client()

    existing = (
        client.table("group_shared_domains").select("*")
        .eq("group_id", group_id).eq("domain_id", domain_id).limit(1).execute()
    ).data or []
    if not existing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That domain isn't shared here.")

    updates: dict[str, Any] = {}
    if payload.share_lecture is not None:
        updates["share_lecture"] = payload.share_lecture
    if payload.share_qa is not None:
        updates["share_qa"] = payload.share_qa
    if updates:
        client.table("group_shared_domains").update(updates).eq(
            "group_id", group_id
        ).eq("domain_id", domain_id).execute()

    for d in _shared_domains(group_id, user.id):
        if d.domain_id == domain_id:
            return d
    raise HTTPException(status.HTTP_404_NOT_FOUND, "That domain isn't shared here.")


@router.delete("/{group_id}/share/{domain_id}",
               status_code=status.HTTP_204_NO_CONTENT)
async def unshare_domain(
    group_id: str,
    domain_id: str,
    user: AuthUser = Depends(get_current_user),
) -> None:
    """Owner stops sharing a domain."""
    _require_owner(group_id, user.id)
    _client().table("group_shared_domains").delete().eq(
        "group_id", group_id
    ).eq("domain_id", domain_id).execute()


# --- View preference (invitee) ----------------------------------------------
@router.patch("/{group_id}/domains/{domain_id}/view", response_model=SharedDomain)
async def set_view_qa(
    group_id: str,
    domain_id: str,
    payload: ViewUpdate,
    user: AuthUser = Depends(get_current_user),
) -> SharedDomain:
    """A member sets their own 'show Q&A' preference for a shared domain.

    Only affects what this member sees, and only takes effect where the owner
    has enabled Q&A sharing.
    """
    _require_member(group_id, user.id)
    client = _client()

    shared = (
        client.table("group_shared_domains").select("domain_id")
        .eq("group_id", group_id).eq("domain_id", domain_id).limit(1).execute()
    ).data
    if not shared:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That domain isn't shared here.")

    client.table("group_domain_views").upsert({
        "group_id": group_id,
        "domain_id": domain_id,
        "user_id": user.id,
        "view_qa": payload.view_qa,
        "updated_at": _now_iso(),
    }, on_conflict="group_id,domain_id,user_id").execute()

    for d in _shared_domains(group_id, user.id):
        if d.domain_id == domain_id:
            return d
    raise HTTPException(status.HTTP_404_NOT_FOUND, "That domain isn't shared here.")


# --- Shared content (read-only) ---------------------------------------------
@router.get("/{group_id}/shared-content")
async def shared_content(
    group_id: str,
    user: AuthUser = Depends(get_current_user),
) -> dict[str, Any]:
    """The content visible to the caller across the group's shared domains.

    Read-only: this returns the owner's already-generated lectures and Q&A —
    nothing is regenerated, so viewing shared content costs no AI calls.
    """
    _require_member(group_id, user.id)
    client = _client()
    shared = _shared_domains(group_id, user.id)

    result: list[dict[str, Any]] = []
    for d in shared:
        entry: dict[str, Any] = {
            "domain_id": d.domain_id,
            "title": d.title,
            "module_title": d.module_title,
            "lectures": [],
            "qa_sessions": [],
            "qa_visible": d.qa_visible,
        }

        if d.share_lecture:
            entry["lectures"] = (
                client.table("lectures")
                .select("id, title, tutor_voice, duration_secs, length_preference")
                .eq("domain_id", d.domain_id).eq("status", "ready").execute()
            ).data or []

        if d.qa_visible:
            entry["qa_sessions"] = (
                client.table("qa_sessions")
                .select("id, session_title, question_count, started_at")
                .eq("domain_id", d.domain_id)
                .gt("question_count", 0)
                .order("started_at", desc=True).execute()
            ).data or []

        result.append(entry)

    return {"group_id": group_id, "domains": result}


# --- Membership -------------------------------------------------------------
@router.delete("/{group_id}/members/{user_id}",
               status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(
    group_id: str,
    user_id: str,
    user: AuthUser = Depends(get_current_user),
) -> None:
    """Remove a member: the owner can remove anyone; a member can remove self.

    The owner can't be removed — deleting the group is a separate action.
    """
    group = _group(group_id)
    is_owner = group.get("owner_id") == user.id
    is_self = user_id == user.id

    if not (is_owner or is_self):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only the owner can remove other members.",
        )
    if user_id == group.get("owner_id"):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "The owner can't leave — delete the group instead.",
        )

    _client().table("group_members").delete().eq(
        "group_id", group_id
    ).eq("user_id", user_id).execute()
    _client().table("group_domain_views").delete().eq(
        "group_id", group_id
    ).eq("user_id", user_id).execute()


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_group(
    group_id: str,
    user: AuthUser = Depends(get_current_user),
) -> None:
    """Owner deletes the group; members, shares and views cascade."""
    _require_owner(group_id, user.id)
    _client().table("groups").delete().eq("id", group_id).eq(
        "owner_id", user.id
    ).execute()

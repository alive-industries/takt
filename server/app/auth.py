"""FastAPI auth dependencies.

Every protected endpoint depends on `get_caller`, which:
  1. Extracts the bearer token from `Authorization`
  2. Resolves it to a GitHub user (cached)
  3. Loads the corresponding member row from PostgreSQL; if missing, falls back to
     org-membership check and auto-admits org members
  4. Blocks revoked / unknown users with 403
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from fastapi import Depends, Header

from app.errors import AdminRequired, InvalidPAT, NotAuthorised
from app.models import GitHubUser, Member
from app.services import store
from app.services.github import GitHubClient, get_github_client

log = logging.getLogger(__name__)


@dataclass
class Caller:
    """Resolved per-request identity passed to handlers."""

    pat: str
    user: GitHubUser
    member: Member

    @property
    def is_admin(self) -> bool:
        return self.member.role == "admin" and self.member.status == "active"


async def _extract_pat(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise InvalidPAT("Missing Authorization: Bearer <github-pat> header.")
    return authorization.split(" ", 1)[1].strip()


async def get_caller(
    authorization: str | None = Header(default=None),
    gh: GitHubClient = Depends(get_github_client),
) -> Caller:
    pat = await _extract_pat(authorization)
    user = await gh.resolve_user(pat)

    member = store.get_member(user.login, user.id)
    if member is None:
        # Auto-admit if user is in the GitHub org (requires read:org scope on PAT)
        if await gh.is_org_member(pat, user):
            member = Member(
                github_login=user.login,
                github_user_id=user.id,
                role="member",
                status="active",
                source="org",
                added_by="auto",
            )
            member = store.upsert_member(member)
        else:
            raise NotAuthorised("You are not approved to use Takt. Ask an admin to add you.")

    if member.status == "revoked":
        raise NotAuthorised("Your access has been revoked.")
    if member.status == "pending":
        raise NotAuthorised("Your access is pending admin approval.")

    return Caller(pat=pat, user=user, member=member)


async def require_admin(caller: Caller = Depends(get_caller)) -> Caller:
    if not caller.is_admin:
        raise AdminRequired()
    return caller

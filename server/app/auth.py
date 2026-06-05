"""FastAPI auth dependencies.

Every protected endpoint depends on `get_caller`, which:
  1. Extracts the bearer token from `Authorization`
  2. Resolves it to a GitHub user (cached)
  3. Loads the corresponding member row from BQ; if missing, falls back to
     org-membership check and auto-admits org members
  4. Blocks revoked / unknown users with 403
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime

from fastapi import Depends, Header

from app.errors import AdminRequired, InvalidPAT, NotAuthorised
from app.models import GitHubUser, Member
from app.services import bq
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

    # The caller's live GitHub org role: "admin" (org owner), "member", or None
    # (not an active member / undeterminable — e.g. PAT lacks read:org).
    org_role = await gh.get_org_role(pat, user)

    member = bq.get_member(user.login)
    if member is None:
        # Auto-admit GitHub org members. Org owners are seeded as Takt admins,
        # which bootstraps the admin UI without a pre-existing admin.
        if org_role is not None:
            member = Member(
                github_login=user.login,
                github_user_id=user.id,
                role="admin" if org_role == "admin" else "member",
                status="active",
                source="org",
                added_by="auto",
            )
            bq.upsert_member(member)
        else:
            raise NotAuthorised(
                "You are not approved to use Takt. Ask an admin to add you."
            )
    elif member.source == "org" and org_role in ("admin", "member"):
        # Keep org-sourced roles in sync with GitHub ownership (promote on
        # gaining ownership, demote on losing it). Manual rows (source="manual")
        # are left untouched, and an inconclusive org_role (None) never demotes.
        desired = "admin" if org_role == "admin" else "member"
        if member.role != desired:
            member.role = desired
            member.updated_at = datetime.now(UTC)
            bq.upsert_member(member)

    if member.status == "revoked":
        raise NotAuthorised("Your access has been revoked.")
    if member.status == "pending":
        raise NotAuthorised("Your access is pending admin approval.")

    return Caller(pat=pat, user=user, member=member)


async def require_admin(caller: Caller = Depends(get_caller)) -> Caller:
    if not caller.is_admin:
        raise AdminRequired()
    return caller

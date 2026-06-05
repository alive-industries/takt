"""Admin-only endpoints: members management and org config writes."""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends

from app.auth import Caller, get_caller, require_admin
from app.models import Member, MemberUpdate, OrgConfig, OrgConfigUpdate
from app.services import bq

router = APIRouter(prefix="/v1", tags=["admin"])


# --- Org config: read open to all members, write admin-only ---


@router.get("/config", response_model=OrgConfig)
def get_config(caller: Caller = Depends(get_caller)) -> OrgConfig:
    return bq.get_org_config()


@router.put("/config", response_model=OrgConfig)
def put_config(update: OrgConfigUpdate, caller: Caller = Depends(require_admin)) -> OrgConfig:
    return bq.update_org_config(update, updated_by=caller.user.login)


# --- Members: admin-only ---


@router.get("/members", response_model=list[Member], dependencies=[Depends(require_admin)])
def list_members() -> list[Member]:
    return bq.list_members()


@router.post("/members", response_model=Member)
def upsert_member(update: MemberUpdate, caller: Caller = Depends(require_admin)) -> Member:
    existing = bq.get_member(update.github_login)
    member = Member(
        github_login=update.github_login,
        github_user_id=existing.github_user_id if existing else None,
        role=update.role or (existing.role if existing else "member"),
        status=update.status or (existing.status if existing else "active"),
        # A manual edit always marks the row "manual" so get_caller's live
        # org-role sync leaves it alone — otherwise the next login would clobber
        # an admin's promotion/demotion of an org-sourced member.
        source="manual",
        added_by=existing.added_by if existing else caller.user.login,
        added_at=existing.added_at if existing else datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )
    bq.upsert_member(member)
    return member

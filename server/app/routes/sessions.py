from datetime import datetime

from fastapi import APIRouter, Depends, Query, status

from app.auth import Caller, get_caller
from app.errors import AdminRequired, BadRequest, NotFound
from app.models import GitHubUser, SessionIn, SessionOut, SessionUpdate
from app.services import bq
from app.services.github import GitHubClient, get_github_client

router = APIRouter(prefix="/v1/sessions", tags=["sessions"])


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_session(
    payload: SessionIn,
    caller: Caller = Depends(get_caller),
    gh: GitHubClient = Depends(get_github_client),
) -> dict:
    """Insert one session. Idempotent on session_id.

    Admins may set `on_behalf_of` to log time for another member (used by
    Sanne & Jack to enter hours for the team). The row is written under the
    target's identity so their My Time and all totals attribute correctly.
    """
    user = caller.user
    target = payload.on_behalf_of
    if target and target != caller.user.login:
        if not caller.is_admin:
            raise AdminRequired("Only admins can log time on behalf of others.")
        member = bq.get_member(target)
        if member is None or member.status == "revoked":
            raise BadRequest(f"'{target}' is not an active Takt member.")
        if member.github_user_id is not None:
            user_id = member.github_user_id
        else:
            # Member row predates id capture — resolve via GitHub.
            resolved = await gh.get_user_by_login(caller.pat, target)
            if resolved is None:
                raise BadRequest(f"GitHub user '{target}' not found.")
            user_id = resolved.id
        user = GitHubUser(login=member.github_login, id=user_id)

    bq.insert_session(payload, github_user=user.login, github_user_id=user.id)
    return {"ok": True, "session_id": payload.session_id}


@router.get("", response_model=list[SessionOut])
def get_sessions(
    caller: Caller = Depends(get_caller),
    user: str | None = Query(default=None, description="Admin-only filter."),
    repo: str | None = None,
    from_ts: datetime | None = Query(default=None, alias="from"),
    to_ts: datetime | None = Query(default=None, alias="to"),
    limit: int = Query(default=500, le=5000),
) -> list[SessionOut]:
    """List sessions. Non-admins always see their own; admins can pass ?user=."""
    return bq.list_sessions(
        caller_login=caller.user.login,
        is_admin=caller.is_admin,
        user_filter=user,
        repo=repo,
        from_ts=from_ts,
        to_ts=to_ts,
        limit=limit,
    )


@router.get("/totals")
def get_session_totals(
    repo: str,
    issue: int,
    caller: Caller = Depends(get_caller),
) -> dict:
    """Total non-deleted duration_hours across all users for repo+issue.

    Used by the extension after every create/update/delete to overwrite
    (not increment) the linked GitHub Project Number field.
    """
    hours = bq.total_hours_for_issue(repo, issue)
    return {"repo": repo, "issue_number": issue, "total_hours": hours}


@router.put("/{session_id}", response_model=SessionOut)
def update_session(
    session_id: str,
    update: SessionUpdate,
    caller: Caller = Depends(get_caller),
) -> SessionOut:
    """Patch an existing session. Owner or admin only.

    Mainly used to correct forgotten timers (set `duration_ms` to a smaller
    value). The server recomputes `started_at` and `duration_hours` from
    the new duration to keep the row coherent.
    """
    updated = bq.update_session(
        session_id, update,
        caller_login=caller.user.login, is_admin=caller.is_admin,
    )
    if updated is None:
        raise NotFound("Session not found or you do not have permission to edit it.")
    return updated


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_session(session_id: str, caller: Caller = Depends(get_caller)) -> None:
    deleted = bq.soft_delete_session(
        session_id, caller_login=caller.user.login, is_admin=caller.is_admin
    )
    if not deleted:
        raise NotFound("Session not found or you do not have permission to delete it.")

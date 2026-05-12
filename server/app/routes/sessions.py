from datetime import datetime

from fastapi import APIRouter, Depends, Query, status

from app.auth import Caller, get_caller
from app.errors import NotFound
from app.models import SessionIn, SessionOut, SessionUpdate
from app.services import bq

router = APIRouter(prefix="/v1/sessions", tags=["sessions"])


@router.post("", status_code=status.HTTP_201_CREATED)
def create_session(payload: SessionIn, caller: Caller = Depends(get_caller)) -> dict:
    """Insert one session. Idempotent on session_id."""
    bq.insert_session(payload, github_user=caller.user.login, github_user_id=caller.user.id)
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

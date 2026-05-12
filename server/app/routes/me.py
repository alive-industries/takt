from fastapi import APIRouter, Depends

from app.auth import Caller, get_caller
from app.models import Me
from app.services.github import GitHubClient, get_github_client

router = APIRouter(tags=["me"])


@router.get("/v1/me", response_model=Me)
async def me(
    caller: Caller = Depends(get_caller),
    gh: GitHubClient = Depends(get_github_client),
) -> Me:
    """Return the caller's identity and authorisation state.

    Extension calls this on startup to gate UI: if 403, show the 'request
    access' screen; if ok, show normal UI; if role=admin, show admin link.
    """
    org_member = await gh.is_org_member(caller.pat, caller.user)
    return Me(
        login=caller.user.login,
        id=caller.user.id,
        role=caller.member.role,
        status=caller.member.status,
        org_member=org_member,
    )

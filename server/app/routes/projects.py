"""Project lookup table endpoints."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.auth import Caller, get_caller
from app.models import Project
from app.services import bq

router = APIRouter(prefix="/v1/projects", tags=["projects"])


class ProjectSyncIn(BaseModel):
    """Batch upsert payload for the projects lookup table."""

    projects: list[Project] = Field(
        description="Projects to upsert by project_id."
    )


@router.get("", response_model=list[Project])
def get_projects(caller: Caller = Depends(get_caller)) -> list[Project]:
    """List all known projects (current titles from the lookup table)."""
    return bq.list_projects()


@router.post("/sync", response_model=dict)
def sync_projects(
    payload: ProjectSyncIn, caller: Caller = Depends(get_caller)
) -> dict:
    """Batch upsert projects into the lookup table.

    The extension calls this on STOP (with the projects it just synced to)
    and can also be called manually to refresh titles after a rename.
    A rename is just a title change for an existing project_id — every
    session referencing that id instantly reflects the new name.
    """
    bq.upsert_projects(payload.projects)
    return {"ok": True, "upserted": len(payload.projects)}

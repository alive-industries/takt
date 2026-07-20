from fastapi import APIRouter, Depends, status

from app.auth import Caller, get_caller, require_admin
from app.models import (
    Client,
    ClientCreate,
    ClientProjectUpdate,
    Project,
    ProjectRepositoryUpdate,
)
from app.services import store

router = APIRouter(prefix="/v1/clients", tags=["clients"])


@router.get("", response_model=list[Client])
def get_clients(caller: Caller = Depends(get_caller)) -> list[Client]:
    return store.list_clients()


@router.post("", response_model=Client, status_code=status.HTTP_201_CREATED)
def create_client(payload: ClientCreate, caller: Caller = Depends(require_admin)) -> Client:
    return store.create_client(payload.name, actor=caller.user.login)


@router.post("/{client_id}/projects", response_model=Client)
def map_project(
    client_id: int,
    payload: ClientProjectUpdate,
    caller: Caller = Depends(require_admin),
) -> Client:
    return store.map_client_project(
        client_id,
        Project(project_id=payload.project_id, title=payload.title, org=payload.org),
        actor=caller.user.login,
    )


@router.post("/{client_id}/projects/{project_id}/repositories", response_model=Client)
def map_project_repository(
    client_id: int,
    project_id: str,
    payload: ProjectRepositoryUpdate,
    caller: Caller = Depends(require_admin),
) -> Client:
    return store.map_project_repository(
        client_id,
        project_id,
        payload.repo,
        actor=caller.user.login,
    )

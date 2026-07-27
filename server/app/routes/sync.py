from fastapi import APIRouter, Depends

from app.auth import Caller, get_caller, require_admin
from app.exporter import export_pending
from app.models import BigQuerySyncResult, BigQuerySyncStatus
from app.services import store

router = APIRouter(prefix="/v1/sync", tags=["sync"])


@router.get("/bigquery", response_model=BigQuerySyncStatus)
def get_bigquery_status(caller: Caller = Depends(get_caller)) -> BigQuerySyncStatus:
    return store.get_bigquery_sync_status()


@router.post("/bigquery", response_model=BigQuerySyncResult)
def push_bigquery(caller: Caller = Depends(require_admin)) -> BigQuerySyncResult:
    exported = export_pending()
    status = store.get_bigquery_sync_status()
    return BigQuerySyncResult(**status.model_dump(), exported=exported)

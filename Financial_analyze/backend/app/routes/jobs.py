"""Background jobs (Activity view): list, inspect, request cancellation."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..services import jobs as svc

router = APIRouter(prefix="/jobs")


@router.get("")
def list_jobs(
    status: str | None = None,
    kind: str | None = None,
    limit: int = Query(svc.DEFAULT_LIMIT, ge=1, le=svc.MAX_LIMIT),
    db: Session = Depends(get_db),
):
    return svc.list_jobs(db, status=status, kind=kind, limit=limit)


@router.get("/{job_id}")
def get_job(job_id: int, db: Session = Depends(get_db)):
    return svc.get_job(db, job_id)


@router.post("/{job_id}/cancel")
def cancel_job(job_id: int, db: Session = Depends(get_db)):
    return svc.cancel_job(db, job_id)

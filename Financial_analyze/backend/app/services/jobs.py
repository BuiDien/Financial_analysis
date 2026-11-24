"""Read/cancel access to the generic ``jobs`` table (Activity view)."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..jobs import CancelOutcome, runner
from ..models.jobs import JOB_STATUSES, Job
from .errors import ServiceError

DEFAULT_LIMIT = 50
MAX_LIMIT = 500


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:  # SQLite hands datetimes back naive; they are UTC
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def serialize(job: Job) -> dict:
    return {
        "id": job.id,
        "kind": job.kind,
        "status": job.status,
        "progress": job.progress,
        "message": job.message,
        "payload": job.payload,
        "result": job.result,
        "error": job.error,
        "cancel_requested": bool(job.cancel_requested),
        "cancellable": runner.can_cancel(job),
        "created_at": _iso(job.created_at),
        "started_at": _iso(job.started_at),
        "finished_at": _iso(job.finished_at),
    }


def list_jobs(db: Session, status: str | None = None, kind: str | None = None,
              limit: int = DEFAULT_LIMIT) -> dict:
    if status and status not in JOB_STATUSES:
        raise ServiceError(422, f"status must be one of {', '.join(JOB_STATUSES)}")
    q = db.query(Job)
    if status:
        q = q.filter(Job.status == status)
    if kind:
        q = q.filter(Job.kind == kind)
    rows = q.order_by(Job.id.desc()).limit(max(1, min(limit, MAX_LIMIT))).all()
    return {"items": [serialize(j) for j in rows]}


def get_job(db: Session, job_id: int) -> dict:
    job = db.get(Job, job_id)
    if job is None:
        raise ServiceError(404, "Job not found")
    return serialize(job)


def cancel_job(db: Session, job_id: int) -> dict:
    """Apply the job kind's cancel policy: queued + cancellable → cancelled;
    running → flag only for kinds that poll it; anything else → 409."""
    outcome = runner.cancel_in_session(db, job_id)
    if outcome == CancelOutcome.NOT_FOUND:
        raise ServiceError(404, "Job not found")
    if outcome == CancelOutcome.FINISHED:
        status = db.get(Job, job_id).status
        raise ServiceError(409, f"Job is already {status}")
    if outcome == CancelOutcome.NOT_CANCELLABLE:
        raise ServiceError(409, "This kind of job cannot be cancelled")
    if outcome == CancelOutcome.RUNNING:
        raise ServiceError(409, "Job is running and cannot be cancelled")
    db.expire_all()
    return get_job(db, job_id)

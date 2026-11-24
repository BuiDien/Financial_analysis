"""Generic background job record (app.jobs.JobRunner). Domain job tables such
as ``portfolio_jobs`` stay the source of truth for their own UI; a ``jobs`` row
links to them through ``payload``/``result`` so /api/jobs lists all work."""
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, Column, DateTime, Integer, String, Text

from ..db import Base

JOB_STATUSES = ("queued", "running", "done", "failed", "cancelled")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Job(Base):
    __tablename__ = "jobs"
    id = Column(Integer, primary_key=True)
    kind = Column(String(64), nullable=False, index=True)
    status = Column(String(16), nullable=False, default="queued", index=True)
    progress = Column(Integer, nullable=False, default=0)
    message = Column(Text, nullable=True)
    payload = Column(JSON, nullable=True)
    result = Column(JSON, nullable=True)
    error = Column(Text, nullable=True)
    cancel_requested = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    started_at = Column(DateTime(timezone=True), nullable=True)
    finished_at = Column(DateTime(timezone=True), nullable=True)

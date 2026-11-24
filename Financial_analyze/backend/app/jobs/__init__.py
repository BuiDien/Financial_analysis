"""Unified background work: ``runner`` executes submitted jobs (tracked in the
``jobs`` table, listed by /api/jobs); ``scheduler`` owns the periodic loops.
Both are started/stopped from the app lifespan via ``app.jobs.lifecycle``."""

from ..config import get_settings
from ..db import SessionLocal
from .runner import CancelOutcome, JobCancelled, JobContext, JobFailed, JobHandle, JobRunner
from .scheduler import Scheduler

_settings = get_settings()
# Lanes: "default" (portfolio import/rebuild, SSI) and "ocr" (Ollama label
# reviews, up to ~20 min each; one local Ollama serialises requests anyway).
runner = JobRunner(SessionLocal, max_workers=_settings.job_workers,
                   lanes={"ocr": _settings.job_ocr_workers})
scheduler = Scheduler()

__all__ = ["CancelOutcome", "JobCancelled", "JobContext", "JobFailed", "JobHandle", "JobRunner",
           "Scheduler",
           "runner", "scheduler"]

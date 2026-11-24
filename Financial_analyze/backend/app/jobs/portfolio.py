"""Portfolio work on the JobRunner. ``portfolio_jobs`` rows stay the record
the UI polls (/api/portfolio/jobs/{id}); the generic job wraps their execution
and links to them through ``payload.portfolio_job_id``."""

from __future__ import annotations

from . import JobContext, JobHandle, runner

IMPORT_KIND = "portfolio.import"
REBUILD_KIND = "portfolio.rebuild"


def _run(ctx: JobContext) -> dict:
    from ..models.portfolio import PortfolioJob
    from ..services import portfolio_engine, portfolio_imports

    job_id = ctx.payload["portfolio_job_id"]
    if ctx.kind == IMPORT_KIND:
        portfolio_imports.run_import_job(ctx.db_factory, job_id)
    else:
        portfolio_engine.run_job(ctx.db_factory, job_id)
    with ctx.session() as db:
        job = db.get(PortfolioJob, job_id)
        status, error = (job.status, job.error) if job else (None, None)
    if status == "failed":
        raise RuntimeError(error or "portfolio job failed")
    return {"portfolio_job_id": job_id, "status": status}


CANCELLED_ERROR = "cancelled before start"


def _on_cancel(db, job) -> None:
    """A queued portfolio job was cancelled from /api/jobs: close its domain
    row the way a failure would, so the UI poll of /api/portfolio/jobs/{id}
    ends and recover_jobs() (queued/running/interrupted only) never resubmits
    it. Runs in the cancel's transaction; the caller commits."""
    from datetime import datetime, timezone

    from ..models.portfolio import Portfolio, PortfolioJob

    domain = db.get(PortfolioJob, (job.payload or {}).get("portfolio_job_id"))
    if domain is None or domain.status not in {"queued", "interrupted"}:
        return
    domain.status, domain.error = "failed", CANCELLED_ERROR
    domain.completed_at = datetime.now(timezone.utc)
    # Mirror the failure paths: a rebuild that never ran (or an import whose
    # ledger is already written, progress >= 60) leaves the projection stale.
    if domain.type != "import" or (domain.progress or 0) >= 60:
        portfolio = db.get(Portfolio, domain.portfolio_id)
        if portfolio is not None:
            portfolio.projection_status = "failed"


# Queued → cancellable (domain row closed by _on_cancel). Running → not: the
# domain functions never poll is_cancelled(), so the API answers 409.
runner.register(IMPORT_KIND, _run, cancellable=True, on_cancel=_on_cancel)
runner.register(REBUILD_KIND, _run, cancellable=True, on_cancel=_on_cancel)


def submit_portfolio_job(db_factory, job_id: str, job_type: str) -> JobHandle:
    """Run a ``portfolio_jobs`` row (import → run_import_job, anything else →
    portfolio_engine.run_job) on ``db_factory``'s database."""
    kind = IMPORT_KIND if job_type == "import" else REBUILD_KIND
    return runner.submit(kind, {"portfolio_job_id": job_id, "portfolio_job_type": job_type},
                         db_factory=db_factory)


def run_portfolio_job(db_factory, job_id: str, job_type: str) -> str:
    """Submit and wait. For FastAPI BackgroundTasks: the job starts after the
    response (as before) and the task ends when the job does. Never call it
    from inside a job function: nested waits deadlock once every worker waits."""
    return submit_portfolio_job(db_factory, job_id, job_type).wait()

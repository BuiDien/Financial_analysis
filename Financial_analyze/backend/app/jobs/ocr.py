"""OCR work on the JobRunner. ``ocr_label_review_runs`` rows stay the record
the UI polls (/api/ocr-inbox/reviews/.../label-review-runs/{id}); the generic
job wraps their execution and links to them through ``payload.run_id``."""

from __future__ import annotations

from sqlalchemy.orm import sessionmaker

from . import JobContext, JobFailed, JobHandle, runner

LABEL_REVIEW_KIND = "ocr_label_review"


def _run_label_review(ctx: JobContext) -> dict:
    from ..models.ocr import OCRLabelReviewRun
    from ..services import ocr_label_review

    run_id = ctx.payload["run_id"]
    with ctx.session() as db:
        bind = db.get_bind()
    ocr_label_review.run_label_review(bind, run_id)
    with ctx.session() as db:
        run = db.get(OCRLabelReviewRun, run_id)
        status, error = (run.status, run.error) if run else (None, None)
    if status == "failed":
        # Expected outcome (Ollama timeout, page changed): the run row has the
        # reason; JobFailed logs one line instead of a traceback.
        raise JobFailed(error or "label review failed")
    return {"run_id": run_id, "status": status}


LANE = "ocr"

# Not cancellable: run_label_review has no stop check, and a queued job cancelled
# here would leave its run row "queued" for the UI to poll forever. Own lane: a
# run can take ~20 min and must not starve portfolio jobs on the default lane.
runner.register(LABEL_REVIEW_KIND, _run_label_review, lane=LANE)


def submit_label_review(bind, run_id: int) -> JobHandle:
    """Run an ``ocr_label_review_runs`` row on ``bind``'s database."""
    return runner.submit(LABEL_REVIEW_KIND, {"run_id": run_id},
                         db_factory=sessionmaker(bind=bind))


def run_label_review_job(bind, run_id: int) -> str:
    """Submit and wait. For FastAPI BackgroundTasks: the job starts after the
    response (as before) and the task ends when the job does. Never call it
    from inside a job function (no job may wait on another job)."""
    return submit_label_review(bind, run_id).wait()

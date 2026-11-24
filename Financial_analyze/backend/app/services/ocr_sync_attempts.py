"""Durable OCR attempt state for the sync coordinator (blocking SQLAlchemy work).

Every function here runs in a worker thread (``run_db`` / ``asyncio.to_thread``)
so the coordinator's event loop never blocks on the database.
"""

import asyncio
import logging
import secrets
import time
from datetime import datetime, timezone

from sqlalchemy import inspect
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models.ocr import OCRAttempt, OCRInboxItem

logger = logging.getLogger(__name__)


def session_call(bind, fn):
    """Run fn(session) with a session owned by the calling thread."""
    with Session(bind=bind) as db:
        return fn(db)


def _log_orphaned_failure(work: asyncio.Future) -> None:
    if not work.cancelled() and work.exception() is not None:
        logger.error("OCR DB write failed after its caller was cancelled",
                     exc_info=work.exception())


async def run_shielded(fn, *args):
    """Run blocking ``fn(*args)`` on the default executor; cancelling the caller
    does not cancel the work.

    A plain ``await asyncio.to_thread(...)`` that is cancelled (server
    shutdown; the test client cancels socket handlers right after a disconnect)
    cancels its executor future, and if no thread has picked the work up yet it
    never runs: a DB write the in-memory state already assumes is silently
    dropped. Every write here is terminal-guarded or idempotent, so finishing
    it after the cancel is always right. ``work`` is a bare future, not a Task:
    loop shutdown does not cancel it and closing the loop waits for the
    executor. A failure after the cancel is logged (shield would hide it)."""
    work = asyncio.get_running_loop().run_in_executor(None, fn, *args)
    try:
        return await asyncio.shield(work)
    except asyncio.CancelledError:
        work.add_done_callback(_log_orphaned_failure)
        raise


async def run_db(bind, fn):
    """Blocking SQLAlchemy work off the event loop, one session per call.
    Shielded: see ``run_shielded``."""
    return await run_shielded(session_call, bind, fn)


def load_attempt(db: Session, attempt_id: int) -> OCRAttempt | None:
    return db.query(OCRAttempt).filter_by(id=attempt_id).first()


def resolve_control(db: Session, attempt: OCRAttempt, action: str) -> None:
    """Persist a hold/stop that the worker confirmed (or can no longer refuse)."""
    if attempt.status in {"failed", "done", "held", "canceled"}:
        return
    attempt.status = "held" if action == "hold" else "canceled"
    attempt.finished_at = datetime.now(timezone.utc)
    attempt.inbox_item.status = "held" if action == "hold" else "uploaded"
    attempt.inbox_item.error = None
    if action == "stop":
        attempt.progress = 0


def fail_attempt(
    db: Session,
    attempt: OCRAttempt,
    item: OCRInboxItem,
    error: str,
    *,
    retryable: bool = True,
):
    if attempt.status in {"failed", "done", "held", "canceled"}:
        return
    attempt.status = "failed"
    attempt.error = error[:4000]
    attempt.finished_at = datetime.now(timezone.utc)
    item.error = attempt.error
    if retryable and not attempt.automatic:
        retry = OCRAttempt(
            inbox_item=item,
            parent_attempt=attempt,
            status="queued",
            automatic=1,
        )
        db.add(retry)
        item.status = "queued"
    else:
        item.status = "failed"


def fail_attempt_by_id(
    db: Session, attempt_id: int, error: str, *, retryable: bool = True,
) -> None:
    attempt = load_attempt(db, attempt_id)
    if attempt:
        fail_attempt(db, attempt, attempt.inbox_item, error, retryable=retryable)
        db.commit()


def recover_interrupted_attempts(*, bind=None):
    """Make durable OCR work safe after a coordinator process restart."""
    db = Session(bind=bind) if bind is not None else SessionLocal()
    with db:
        if not inspect(db.get_bind()).has_table("ocr_attempts"):
            return
        interrupted = (
            db.query(OCRAttempt)
            .filter(OCRAttempt.status.in_({
                "sent", "processing", "receiving_pages", "assembling",
            }))
            .all()
        )
        for attempt in interrupted:
            fail_attempt(
                db, attempt, attempt.inbox_item, "coordinator restarted during OCR"
            )
        if interrupted:
            db.commit()


def claim_next_attempt(worker: dict, bind) -> tuple[dict, str, dict] | None:
    """Mark the oldest queued attempt as sent to `worker` (runs in a thread)."""
    db = Session(bind=bind) if bind is not None else SessionLocal()
    try:
        # During isolated legacy coordinator tests the application's default
        # database may not be initialized; there cannot be durable work in it.
        if not inspect(db.get_bind()).has_table("ocr_attempts"):
            return None
        attempt = (
            db.query(OCRAttempt)
            .filter(OCRAttempt.status == "queued")
            .order_by(OCRAttempt.id.asc())
            .first()
        )
        if not attempt:
            return None
        item = attempt.inbox_item
        job_id = "job_" + secrets.token_hex(5)
        attempt.job_id = job_id
        attempt.worker_id = worker["id"]
        attempt.worker_name = worker["name"]
        attempt.status = "sent"
        attempt.started_at = datetime.now(timezone.utc)
        attempt.result_format = worker["selectedResultFormat"]
        attempt.expected_pages = item.pages
        attempt.received_pages = 0
        item.status = "processing"
        item.error = None
        job = {
            "id": job_id,
            "inboxItemId": item.id,
            "attemptId": attempt.id,
            "filename": item.filename,
            "ticker": item.ticker or "",
            "worker": worker["name"],
            "workerId": worker["id"],
            "status": "sent",
            "progress": 0,
            "rows": None,
            "sentAt": time.time(),
            "kind": "inbox",
            "resultFormat": worker["selectedResultFormat"],
            "pageCount": item.pages,
            "receivedPages": 0,
            "db_bind": db.get_bind(),
        }
        storage_path = item.storage_path
        header = {"inboxItemId": item.id, "filename": item.filename}
        db.commit()
        return job, storage_path, header
    finally:
        db.close()


def persist_released_jobs(entries: list[tuple]) -> None:
    """Disconnect cleanup. Each entry is independent: one failing attempt must
    not leave the worker's other jobs "processing"."""
    for bind, attempt_id, action in entries:
        try:
            with Session(bind=bind) as db:
                if action is None:
                    fail_attempt_by_id(db, attempt_id, "worker disconnected")
                    continue
                attempt = load_attempt(db, attempt_id)
                if attempt:
                    resolve_control(db, attempt, action)
                    db.commit()
        except Exception:
            logger.exception("Could not release OCR attempt %s (action=%s)",
                             attempt_id, action)

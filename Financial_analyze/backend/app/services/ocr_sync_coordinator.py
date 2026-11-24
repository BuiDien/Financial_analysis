"""In-memory OCR sync coordinator: workers, jobs, dispatch and PDF streaming.

Single-process asyncio state; durable attempt state lives in
``ocr_sync_attempts`` and is touched only from worker threads.
"""

import asyncio
import logging
import os
import secrets
import time

from sqlalchemy.orm import Session

from ..config import resolve_backend_path
from ..models.filing import Filing
from .errors import ServiceError
from .ocr_sync_attempts import (
    claim_next_attempt,
    fail_attempt_by_id,
    persist_released_jobs,
    run_db,
    run_shielded,
)
from .ocr_sync_protocol import (
    ACTIVE_JOB_STATUSES,
    CHUNK_SIZE,
    CONTROL_PENDING_STATUSES,
    FINISHED_JOB_STATUSES,
    MAX_FINISHED_JOBS,
    OCR_PAGE_RESULT_FORMAT,
    OCR_PAGE_SCHEMA_VERSION,
    OCR_PROTOCOL_VERSION,
    OCR_REQUIRED_CAPABILITIES,
    OCR_RESULT_SCHEMA_VERSION,
    PAGE_REQUIRED_CAPABILITIES,
    STRUCTURED_RESULT_FORMAT,
)
from . import ocr_sync_network as network

logger = logging.getLogger(__name__)


def gen_code() -> str:
    alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    s = "".join(secrets.choice(alpha) for _ in range(6))
    return f"{s[:3]}-{s[3:]}"


def public_job(job: dict) -> dict:
    return {k: v for k, v in job.items() if k != "db_bind"}


class Coordinator:
    """In-memory state for the sync session. Single-process; fine for a LAN tool."""

    def __init__(self):
        self.pair_code = gen_code()
        self.workers: dict[str, dict] = {}  # worker_id -> {name, ip, status, done, ws}
        self.jobs: dict[
            str, dict
        ] = {}  # job_id -> {filingId, filename, ticker, status, rows, worker}
        self._dispatch_lock = asyncio.Lock()
        self.background_tasks: set[asyncio.Task] = set()

    def public_workers(self):
        return [
            {k: v for k, v in w.items() if k != "ws"} for w in self.workers.values()
        ]

    def public_jobs(self):
        return [public_job(job) for job in self.jobs.values()]

    def add_job(self, job: dict) -> None:
        self.jobs[job["id"]] = job
        self.prune_jobs()

    def prune_jobs(self, keep: int = MAX_FINISHED_JOBS) -> None:
        """Drop the oldest finished jobs (and their rows) beyond `keep`."""
        finished = [
            job for job in self.jobs.values()
            if job.get("status") in FINISHED_JOB_STATUSES
        ]
        excess = len(finished) - keep
        if excess <= 0:
            return
        finished.sort(key=lambda job: job.get("completedAt") or job.get("sentAt") or 0)
        for job in finished[:excess]:
            self.jobs.pop(job["id"], None)

    def spawn(self, coro) -> asyncio.Task:
        """create_task that keeps a reference and logs a failure."""
        task = asyncio.create_task(coro)
        self.background_tasks.add(task)
        task.add_done_callback(_background_task_done)
        return task


def _background_task_done(task: asyncio.Task) -> None:
    coordinator.background_tasks.discard(task)
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.error("OCR background task failed", exc_info=exc)


coordinator = Coordinator()


async def stream_job(worker: dict, job_id: str, path: str, header: dict):
    try:
        fp = await asyncio.to_thread(open, resolve_backend_path(path), "rb")
    except OSError as exc:
        raise RuntimeError("PDF file missing on disk") from exc
    try:
        size = os.fstat(fp.fileno()).st_size
        worker["status"] = "busy"
        ws = worker["ws"]
        result_format = worker.get("selectedResultFormat", STRUCTURED_RESULT_FORMAT)
        if result_format == OCR_PAGE_RESULT_FORMAT:
            schema_version = OCR_PAGE_SCHEMA_VERSION
            required_capabilities = PAGE_REQUIRED_CAPABILITIES
        else:
            schema_version = OCR_RESULT_SCHEMA_VERSION
            required_capabilities = OCR_REQUIRED_CAPABILITIES
        await ws.send_json({
            "type": "job",
            "jobId": job_id,
            "bytes": size,
            "protocolVersion": OCR_PROTOCOL_VERSION,
            "resultFormat": result_format,
            "resultSchemaVersion": schema_version,
            "requiredCapabilities": sorted(required_capabilities),
            **header,
        })
        while chunk := await asyncio.to_thread(fp.read, CHUNK_SIZE):
            await ws.send_bytes(chunk)
        await ws.send_json({"type": "job_end", "jobId": job_id})
    finally:
        fp.close()


async def dispatch_next_queued(*, preferred_worker_id: str | None = None, bind=None):
    """Assign the oldest persistent inbox attempt to an idle worker.

    The lock only covers choosing a worker and claiming the attempt; the PDF
    is streamed after releasing it so one slow upload never blocks others.
    """
    async with coordinator._dispatch_lock:
        worker = (
            coordinator.workers.get(preferred_worker_id)
            if preferred_worker_id
            else None
        )
        if not worker or worker.get("status") != "idle":
            worker = next(
                (w for w in coordinator.workers.values() if w["status"] == "idle"), None
            )
        if not worker:
            return None
        # Shielded so a cancel cannot drop the claim mid-flight. A claim that
        # commits after the cancel stays "sent" with no in-memory job; restart
        # recovery (recover_interrupted_attempts) fails + requeues it.
        claimed = await run_shielded(claim_next_attempt, worker, bind)
        if not claimed:
            return None
        job, storage_path, header = claimed
        worker["status"] = "busy"
        coordinator.add_job(job)
    job_id = job["id"]
    try:
        await stream_job(worker, job_id, storage_path, header)
    except Exception as exc:
        error = str(exc) or type(exc).__name__
        logger.warning("Could not stream OCR job %s: %s", job_id, error)
        job["status"] = "failed"
        job["error"] = error
        job["completedAt"] = time.time()
        await run_db(
            job["db_bind"],
            lambda db: fail_attempt_by_id(db, job["attemptId"], error),
        )
        if coordinator.workers.get(worker["id"]) is worker:
            worker["status"] = "idle"
        return None
    return job_id


def free_worker(worker_id: str, *, completed: bool = False) -> None:
    w = coordinator.workers.get(worker_id)
    if w:
        w["status"] = "idle"
        if completed:
            w["done"] += 1


def finish_job(job: dict, status: str, **fields) -> None:
    job["status"] = status
    job["completedAt"] = time.time()
    job.update(fields)


async def release_worker_jobs(worker_id: str) -> None:
    """Disconnect cleanup: fail running work, settle pending hold/stop.

    In-memory state is settled first and all DB work is submitted in one
    thread call, so a cancelled handler cannot leave a job half-released.
    The handler often *is* cancelled here (server shutdown; the test client
    cancels it right after the disconnect), so the write goes through
    ``run_shielded``: otherwise the cancel could drop it and the DB would keep
    saying "processing" while memory says held/stopped.
    """
    entries = []
    for job in list(coordinator.jobs.values()):
        status = job.get("status")
        if job.get("workerId") != worker_id or status not in (
            ACTIVE_JOB_STATUSES | CONTROL_PENDING_STATUSES | {"assembling"}
        ):
            continue
        if status in CONTROL_PENDING_STATUSES:
            # The user already asked to hold/stop; a vanished worker cannot
            # continue anyway, so honour the request instead of failing.
            action = "hold" if status == "holding" else "stop"
            finish_job(job, "held" if action == "hold" else "stopped")
        else:
            action = None
            finish_job(job, "failed", error="worker disconnected")
        if job.get("kind") == "inbox":
            entries.append((job["db_bind"], job["attemptId"], action))
    if entries:
        await run_shielded(persist_released_jobs, entries)


# ── Operations behind the HTTP control surface ─────────────────


def status() -> dict:
    return {
        "pair_code": coordinator.pair_code,
        "host": network.lan_ip(),
        "workers": coordinator.public_workers(),
        "jobs": coordinator.public_jobs(),
    }


def regenerate_pair_code() -> dict:
    coordinator.pair_code = gen_code()
    return {"pair_code": coordinator.pair_code}


async def control_job(job_id: str, action: str) -> dict:
    job = coordinator.jobs.get(job_id)
    if not job:
        raise ServiceError(404, "Job not found")
    if job.get("status") not in ACTIVE_JOB_STATUSES:
        raise ServiceError(
            409, f"Cannot {action} a job while it is {job.get('status')}"
        )
    worker = coordinator.workers.get(job.get("workerId"))
    if not worker:
        raise ServiceError(409, "Worker is no longer connected")
    previous_status = job["status"]
    job["status"] = "holding" if action == "hold" else "stopping"
    try:
        await worker["ws"].send_json(
            {
                "type": "job_control",
                "jobId": job_id,
                "action": action,
            }
        )
    except Exception as exc:
        job["status"] = previous_status
        raise ServiceError(500, "Could not send control command to worker") from exc
    return {"jobId": job_id, "status": job["status"], "action": action}


async def dispatch_filing(db: Session, filing_id: int) -> dict:
    """Legacy path: stream a Filing PDF to an idle structured-rows worker."""
    f = db.query(Filing).filter_by(id=filing_id).first()
    if not f:
        raise ServiceError(404, "Filing not found")
    # Pick an idle worker
    worker = next(
        (
            w for w in coordinator.workers.values()
            if w["status"] == "idle"
            and w.get("selectedResultFormat") == STRUCTURED_RESULT_FORMAT
        ),
        None,
    )
    if not worker:
        raise ServiceError(409, "No idle worker connected")

    job_id = "job_" + secrets.token_hex(5)
    coordinator.add_job({
        "id": job_id,
        "filingId": f.id,
        "filename": f.filename,
        "ticker": f.ticker,
        "worker": worker["name"],
        "workerId": worker["id"],
        "status": "sent",
        "progress": 0,
        "rows": None,
        "sentAt": time.time(),
        "kind": "filing",
        "resultFormat": STRUCTURED_RESULT_FORMAT,
    })
    worker["status"] = "busy"
    try:
        await stream_job(
            worker,
            job_id,
            f.storage_path,
            {
                "filingId": f.id,
                "filename": f.filename,
            },
        )
    except Exception as exc:
        # Any send failure (missing file, closed socket) must free the worker;
        # only RuntimeError used to be caught, leaving it busy forever.
        coordinator.jobs.pop(job_id, None)
        if coordinator.workers.get(worker["id"]) is worker:
            worker["status"] = "idle"
        raise ServiceError(500, str(exc) or "Could not send the PDF to the worker") from exc
    return {"jobId": job_id}


def get_result(job_id: str) -> dict:
    job = coordinator.jobs.get(job_id)
    if not job:
        raise ServiceError(404, "Job not found")
    return public_job(job)

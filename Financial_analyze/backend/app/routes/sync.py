"""Distributed OCR sync — WebSocket coordinator.

This machine (the coordinator) opens a WebSocket endpoint and waits. A worker
laptop connects, authenticates with a pairing code, then receives PDF filings
to OCR-parse locally and returns structured statement rows.

Frame protocol (JSON over the socket) — two-step pairing, code sent AFTER
the coordinator hands back a pairId (worker doesn't need the code up front):

  worker → server : {"type": "hello", "name": "Dien's MacBook"}
  server → worker : {"type": "pair_required", "pairId": "a1b2c3d4"}
  worker → server : {"type": "pair", "pairId": "a1b2c3d4", "code": "ABC-23"}
  server → worker : {"type": "welcome", "workerId": "..."}    (or {"type":"deny"}, retry "pair")
  server → worker : {"type": "job", "jobId": "...", "filingId": 12,
                     "filename": "NVDA 10-K.pdf", "bytes": 2118144}
  server → worker : <binary frame> ... <binary frame>     (the PDF, chunked)
  server → worker : {"type": "job_end", "jobId": "..."}   (all chunks sent)
  worker → server : {"type": "progress", "jobId": "...", "pct": 60}
  worker → server : {"type": "result", "jobId": "...",
                     "rows": [{"id","section","metric","curr","prev","page","confidence"}, ...]}
  worker → server : {"type": "error", "jobId": "...", "error": "..."}   (on failure)

The PDF travels as binary WebSocket frames, never base64-in-JSON (b64 bloats
a multi-MB scan ~33% and forces the whole file into one giant text frame) —
see docs/design/OCR_PROTOCOL.md. The worker reassembles chunks in arrival
order and checks the total against the announced "bytes".

The HTTP side lets the UI drive the coordinator:
  GET  /api/sync/status                 → pairing code, this machine's LAN host, workers, jobs
  POST /api/sync/pair-code              → regenerate the pairing code
  POST /api/sync/dispatch/{filing_id}   → queue a filing for the next idle worker
  GET  /api/sync/result/{job_id}        → fetch returned rows (poll) and apply
"""
import asyncio
import logging
import os
import secrets
import socket
import time
from datetime import datetime, timezone
from typing import Literal
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy import inspect
from sqlalchemy.orm import Session

from ..db import SessionLocal, get_db
from ..models.filing import Filing
from ..models.ocr import OCRAttempt, OCRInboxItem
from ..services.ocr_review import create_review_from_result

router = APIRouter()
logger = logging.getLogger(__name__)

# Binary chunk size for streaming a PDF to a worker. 512 KiB keeps frames
# comfortably small for any WS stack while a multi-MB scan still ships in a
# handful of frames.
CHUNK_SIZE = 512 * 1024


def _gen_code() -> str:
    alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    s = "".join(secrets.choice(alpha) for _ in range(6))
    return f"{s[:3]}-{s[3:]}"


def _lan_ip() -> str:
    """This machine's LAN IP — what a worker laptop must dial (not localhost)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # no packet sent; just picks the outbound interface
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


class Coordinator:
    """In-memory state for the sync session. Single-process; fine for a LAN tool."""
    def __init__(self):
        self.pair_code = _gen_code()
        self.workers: dict[str, dict] = {}      # worker_id -> {name, ip, status, done, ws}
        self.jobs: dict[str, dict] = {}          # job_id -> {filingId, filename, ticker, status, rows, worker}
        self._dispatch_lock = asyncio.Lock()

    def public_workers(self):
        return [{k: v for k, v in w.items() if k != "ws"} for w in self.workers.values()]

    def public_jobs(self):
        return [{k: v for k, v in job.items() if k != "db_bind"}
                for job in self.jobs.values()]


coordinator = Coordinator()


MAX_PAIR_ATTEMPTS = 5


async def _stream_job(worker: dict, job_id: str, path: str, header: dict):
    try:
        fp = open(path, "rb")
    except OSError as exc:
        raise RuntimeError("PDF file missing on disk") from exc
    with fp:
        size = os.fstat(fp.fileno()).st_size
        worker["status"] = "busy"
        ws = worker["ws"]
        await ws.send_json({"type": "job", "jobId": job_id, "bytes": size, **header})
        while chunk := fp.read(CHUNK_SIZE):
            await ws.send_bytes(chunk)
        await ws.send_json({"type": "job_end", "jobId": job_id})


def _fail_attempt(db: Session, attempt: OCRAttempt, item: OCRInboxItem, error: str):
    attempt.status = "failed"
    attempt.error = error[:4000]
    attempt.finished_at = datetime.now(timezone.utc)
    item.error = attempt.error
    if not attempt.automatic:
        retry = OCRAttempt(
            inbox_item=item, parent_attempt=attempt, status="queued", automatic=1,
        )
        db.add(retry)
        item.status = "queued"
    else:
        item.status = "failed"


def recover_interrupted_attempts(*, bind=None):
    """Make durable OCR work safe after a coordinator process restart."""
    db = Session(bind=bind) if bind is not None else SessionLocal()
    with db:
        if not inspect(db.get_bind()).has_table("ocr_attempts"):
            return
        interrupted = (db.query(OCRAttempt)
                       .filter(OCRAttempt.status.in_({"sent", "processing"})).all())
        for attempt in interrupted:
            _fail_attempt(db, attempt, attempt.inbox_item, "coordinator restarted during OCR")
        if interrupted:
            db.commit()


async def dispatch_next_queued(*, preferred_worker_id: str | None = None, bind=None):
    """Assign the oldest persistent inbox attempt to an idle worker."""
    async with coordinator._dispatch_lock:
        worker = coordinator.workers.get(preferred_worker_id) if preferred_worker_id else None
        if not worker or worker.get("status") != "idle":
            worker = next((w for w in coordinator.workers.values() if w["status"] == "idle"), None)
        if not worker:
            return None
        db = Session(bind=bind) if bind is not None else SessionLocal()
        try:
            # During isolated legacy coordinator tests the application's default
            # database may not be initialized; there cannot be durable work in it.
            if not inspect(db.get_bind()).has_table("ocr_attempts"):
                return None
            attempt = (db.query(OCRAttempt)
                       .filter(OCRAttempt.status == "queued")
                       .order_by(OCRAttempt.id.asc()).first())
            if not attempt:
                return None
            item = attempt.inbox_item
            job_id = "job_" + secrets.token_hex(5)
            attempt.job_id = job_id
            attempt.worker_id = worker["id"]
            attempt.worker_name = worker["name"]
            attempt.status = "sent"
            attempt.started_at = datetime.now(timezone.utc)
            item.status = "processing"
            item.error = None
            coordinator.jobs[job_id] = {
                "id": job_id, "inboxItemId": item.id, "attemptId": attempt.id,
                "filename": item.filename, "ticker": item.ticker or "",
                "worker": worker["name"], "workerId": worker["id"],
                "status": "sent", "progress": 0, "rows": None,
                "sentAt": time.time(), "kind": "inbox", "db_bind": db.get_bind(),
            }
            db.commit()
            try:
                await _stream_job(worker, job_id, item.storage_path, {
                    "inboxItemId": item.id, "filename": item.filename,
                })
            except Exception as exc:
                db.rollback()
                attempt = db.query(OCRAttempt).filter_by(id=attempt.id).one()
                item = attempt.inbox_item
                _fail_attempt(db, attempt, item, str(exc))
                db.commit()
                coordinator.jobs[job_id]["status"] = "failed"
                coordinator.jobs[job_id]["error"] = str(exc)
                worker["status"] = "idle"
                return None
            return job_id
        finally:
            db.close()


@router.websocket("/ws/ocr")
async def ocr_worker(ws: WebSocket):
    await ws.accept()
    worker_id = None
    peer = ws.client.host if ws.client else "?"
    logger.info("OCR worker socket accepted from %s", peer)
    try:
        # Two-step pairing: the worker connects with just a name (no code
        # needed up front), the coordinator hands back a pairId and shows
        # the code on the Sync page, then the worker submits the code the
        # human read off screen. Friendlier than requiring the code before
        # the worker even dials in.
        hello = await ws.receive_json()
        if hello.get("type") != "hello":
            logger.warning("OCR worker %s sent invalid first frame", peer)
            await ws.send_json({"type": "deny", "reason": "expected hello"})
            await ws.close()
            return
        if "code" in hello:
            logger.warning("OCR worker %s uses the obsolete one-step handshake", peer)
            await ws.send_json({
                "type": "deny",
                "reason": "outdated worker; update scripts/ocr_worker.py for the two-step handshake",
                "attemptsLeft": 0,
            })
            await ws.close()
            return

        pair_id = secrets.token_hex(4)
        await ws.send_json({"type": "pair_required", "pairId": pair_id})

        worker_name = hello.get("name", "Worker")
        for attempt in range(MAX_PAIR_ATTEMPTS):
            reply = await ws.receive_json()
            if (
                reply.get("type") == "pair"
                and reply.get("pairId") == pair_id
                and reply.get("code") == coordinator.pair_code
            ):
                break
            remaining = MAX_PAIR_ATTEMPTS - attempt - 1
            logger.warning("OCR worker %s supplied a bad pairing code (%s attempts left)", peer, remaining)
            await ws.send_json({"type": "deny", "reason": "bad pairing code", "attemptsLeft": remaining})
            if remaining <= 0:
                await ws.close()
                return

        worker_id = secrets.token_hex(4)
        coordinator.workers[worker_id] = {
            "id": worker_id,
            "name": worker_name,
            "ip": ws.client.host if ws.client else "?",
            "status": "idle",
            "done": 0,
            "ws": ws,
        }
        await ws.send_json({"type": "welcome", "workerId": worker_id})
        logger.info("OCR worker %s paired as %s (%s)", peer, worker_name, worker_id)
        await dispatch_next_queued(preferred_worker_id=worker_id)

        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")
            if mtype == "progress":
                job = coordinator.jobs.get(msg.get("jobId"))
                if job:
                    job["progress"] = msg.get("pct", 0)
                    job["status"] = "parsing"
                    if job.get("kind") == "inbox":
                        with Session(bind=job["db_bind"]) as db:
                            attempt = db.query(OCRAttempt).filter_by(id=job["attemptId"]).first()
                            if attempt:
                                attempt.progress = max(0, min(100, int(job["progress"])))
                                attempt.status = "processing"
                                db.commit()
            elif mtype == "result":
                job = coordinator.jobs.get(msg.get("jobId"))
                if job:
                    if job.get("kind") == "inbox":
                        with Session(bind=job["db_bind"]) as db:
                            attempt = db.query(OCRAttempt).filter_by(id=job["attemptId"]).first()
                            try:
                                if not attempt:
                                    raise ValueError("OCR attempt no longer exists")
                                create_review_from_result(db, attempt, attempt.inbox_item, msg)
                                db.commit()
                                job["rows"] = msg.get("rows", [])
                                job["status"] = "done"
                                job["progress"] = 100
                            except Exception as exc:
                                db.rollback()
                                attempt = db.query(OCRAttempt).filter_by(id=job["attemptId"]).first()
                                if attempt:
                                    _fail_attempt(db, attempt, attempt.inbox_item, str(exc))
                                    db.commit()
                                job["status"] = "failed"
                                job["error"] = str(exc)
                                await ws.send_json({
                                    "type": "result_rejected", "jobId": job["id"],
                                    "error": str(exc),
                                })
                    else:
                        job["rows"] = msg.get("rows", [])
                        job["status"] = "done"
                        job["progress"] = 100
                w = coordinator.workers.get(worker_id)
                if w:
                    w["status"] = "idle"
                    if job and job.get("status") == "done":
                        w["done"] += 1
                if job:
                    await dispatch_next_queued(preferred_worker_id=worker_id,
                                               bind=job.get("db_bind"))
            elif mtype == "error":
                job = coordinator.jobs.get(msg.get("jobId"))
                if job:
                    job["status"] = "failed"
                    job["error"] = msg.get("error", "worker error")
                    if job.get("kind") == "inbox":
                        with Session(bind=job["db_bind"]) as db:
                            attempt = db.query(OCRAttempt).filter_by(id=job["attemptId"]).first()
                            if attempt:
                                _fail_attempt(db, attempt, attempt.inbox_item, job["error"])
                                db.commit()
                w = coordinator.workers.get(worker_id)
                if w:
                    w["status"] = "idle"
                if job:
                    await dispatch_next_queued(preferred_worker_id=worker_id,
                                               bind=job.get("db_bind"))
            elif mtype == "control_ack":
                job = coordinator.jobs.get(msg.get("jobId"))
                action = msg.get("action")
                expected = "holding" if action == "hold" else "stopping"
                if not job or job.get("status") != expected:
                    continue
                if job.get("kind") == "inbox":
                    with Session(bind=job["db_bind"]) as db:
                        attempt = db.query(OCRAttempt).filter_by(id=job["attemptId"]).first()
                        if attempt:
                            attempt.status = "held" if action == "hold" else "canceled"
                            attempt.finished_at = datetime.now(timezone.utc)
                            attempt.inbox_item.status = "held" if action == "hold" else "uploaded"
                            attempt.inbox_item.error = None
                            if action == "stop":
                                attempt.progress = 0
                            db.commit()
                job["status"] = "held" if action == "hold" else "stopped"
                w = coordinator.workers.get(worker_id)
                if w:
                    w["status"] = "idle"
                await dispatch_next_queued(preferred_worker_id=worker_id,
                                           bind=job.get("db_bind"))
    except WebSocketDisconnect as e:
        logger.info("OCR worker %s disconnected (code=%s)", peer, e.code)
    except Exception:
        logger.exception("OCR worker %s protocol failure", peer)
    finally:
        if worker_id:
            active_jobs = [job for job in coordinator.jobs.values()
                           if job.get("workerId") == worker_id
                           and job.get("kind") == "inbox"
                           and job.get("status") in {"sent", "parsing"}]
            for job in active_jobs:
                with Session(bind=job["db_bind"]) as db:
                    attempt = db.query(OCRAttempt).filter_by(id=job["attemptId"]).first()
                    if attempt:
                        _fail_attempt(db, attempt, attempt.inbox_item, "worker disconnected")
                        db.commit()
                job["status"] = "failed"
                job["error"] = "worker disconnected"
            coordinator.workers.pop(worker_id, None)


# ── HTTP control surface for the UI ────────────────────────────


class JobControl(BaseModel):
    action: Literal["hold", "stop"]

@router.get("/api/sync/status")
def sync_status():
    return {
        "pair_code": coordinator.pair_code,
        "host": _lan_ip(),
        "workers": coordinator.public_workers(),
        "jobs": coordinator.public_jobs(),
    }


@router.post("/api/sync/pair-code")
def regenerate_code():
    coordinator.pair_code = _gen_code()
    return {"pair_code": coordinator.pair_code}


@router.post("/api/sync/jobs/{job_id}/control")
async def control_job(job_id: str, control: JobControl):
    job = coordinator.jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.get("status") not in {"sent", "parsing"}:
        raise HTTPException(409, f"Cannot {control.action} a job while it is {job.get('status')}")
    worker = coordinator.workers.get(job.get("workerId"))
    if not worker:
        raise HTTPException(409, "Worker is no longer connected")
    job["status"] = "holding" if control.action == "hold" else "stopping"
    try:
        await worker["ws"].send_json({
            "type": "job_control", "jobId": job_id, "action": control.action,
        })
    except Exception as exc:
        job["status"] = "parsing"
        raise HTTPException(500, "Could not send control command to worker") from exc
    return {"jobId": job_id, "status": job["status"], "action": control.action}


@router.post("/api/sync/dispatch/{filing_id}")
async def dispatch(filing_id: int, db: Session = Depends(get_db)):
    f = db.query(Filing).filter_by(id=filing_id).first()
    if not f:
        raise HTTPException(404, "Filing not found")
    # Pick an idle worker
    worker = next((w for w in coordinator.workers.values() if w["status"] == "idle"), None)
    if not worker:
        raise HTTPException(409, "No idle worker connected")

    job_id = "job_" + secrets.token_hex(5)
    coordinator.jobs[job_id] = {
        "id": job_id, "filingId": f.id, "filename": f.filename, "ticker": f.ticker,
        "worker": worker["name"], "workerId": worker["id"], "status": "sent",
        "progress": 0, "rows": None, "sentAt": time.time(), "kind": "filing",
    }
    try:
        await _stream_job(worker, job_id, f.storage_path, {
            "filingId": f.id, "filename": f.filename,
        })
    except RuntimeError as exc:
        coordinator.jobs.pop(job_id, None)
        worker["status"] = "idle"
        raise HTTPException(500, str(exc)) from exc
    return {"jobId": job_id}


@router.get("/api/sync/result/{job_id}")
def get_result(job_id: str):
    job = coordinator.jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job

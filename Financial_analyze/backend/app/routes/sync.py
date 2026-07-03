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
import os
import secrets
import socket
import time
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException, Depends
from sqlalchemy.orm import Session

from ..db import get_db
from ..models.filing import Filing

router = APIRouter()

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
        self._queue: asyncio.Queue = asyncio.Queue()

    def public_workers(self):
        return [{k: v for k, v in w.items() if k != "ws"} for w in self.workers.values()]

    def public_jobs(self):
        return list(self.jobs.values())


coordinator = Coordinator()


MAX_PAIR_ATTEMPTS = 5


@router.websocket("/ws/ocr")
async def ocr_worker(ws: WebSocket):
    await ws.accept()
    worker_id = None
    try:
        # Two-step pairing: the worker connects with just a name (no code
        # needed up front), the coordinator hands back a pairId and shows
        # the code on the Sync page, then the worker submits the code the
        # human read off screen. Friendlier than requiring the code before
        # the worker even dials in.
        hello = await ws.receive_json()
        if hello.get("type") != "hello":
            await ws.send_json({"type": "deny", "reason": "expected hello"})
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

        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")
            if mtype == "progress":
                job = coordinator.jobs.get(msg.get("jobId"))
                if job:
                    job["progress"] = msg.get("pct", 0)
                    job["status"] = "parsing"
            elif mtype == "result":
                job = coordinator.jobs.get(msg.get("jobId"))
                if job:
                    job["rows"] = msg.get("rows", [])
                    job["status"] = "done"
                    job["progress"] = 100
                w = coordinator.workers.get(worker_id)
                if w:
                    w["status"] = "idle"
                    w["done"] += 1
            elif mtype == "error":
                job = coordinator.jobs.get(msg.get("jobId"))
                if job:
                    job["status"] = "failed"
                    job["error"] = msg.get("error", "worker error")
                w = coordinator.workers.get(worker_id)
                if w:
                    w["status"] = "idle"
    except WebSocketDisconnect:
        pass
    finally:
        if worker_id:
            coordinator.workers.pop(worker_id, None)


# ── HTTP control surface for the UI ────────────────────────────

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
    try:
        fp = open(f.storage_path, "rb")
    except OSError:
        raise HTTPException(500, "Filing file missing on disk")

    with fp:
        size = os.fstat(fp.fileno()).st_size
        coordinator.jobs[job_id] = {
            "id": job_id, "filingId": f.id, "filename": f.filename, "ticker": f.ticker,
            "worker": worker["name"], "status": "sent", "progress": 0, "rows": None,
            "sentAt": time.time(),
        }
        # Busy before the first await — a concurrent dispatch must not pick
        # this worker and interleave a second job's binary chunks.
        worker["status"] = "busy"
        ws = worker["ws"]
        await ws.send_json({
            "type": "job", "jobId": job_id, "filingId": f.id,
            "filename": f.filename, "bytes": size,
        })
        while chunk := fp.read(CHUNK_SIZE):
            await ws.send_bytes(chunk)
        await ws.send_json({"type": "job_end", "jobId": job_id})
    return {"jobId": job_id}


@router.get("/api/sync/result/{job_id}")
def get_result(job_id: str):
    job = coordinator.jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job

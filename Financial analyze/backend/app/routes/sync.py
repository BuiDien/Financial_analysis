"""Distributed OCR sync — WebSocket coordinator.

This machine (the coordinator) opens a WebSocket endpoint and waits. A worker
laptop connects, authenticates with a pairing code, then receives PDF filings
to OCR-parse locally and returns structured statement rows.

Frame protocol (JSON over the socket):

  worker → server : {"type": "hello", "code": "ABC-23", "name": "Dien's MacBook"}
  server → worker : {"type": "welcome"}                       (or {"type":"deny"})
  server → worker : {"type": "job", "jobId": "...", "filingId": 12,
                     "filename": "NVDA 10-K.pdf", "pdf_b64": "<base64 pdf>"}
  worker → server : {"type": "progress", "jobId": "...", "pct": 60}
  worker → server : {"type": "result", "jobId": "...",
                     "rows": [{"id","section","metric","curr","prev","page","confidence"}, ...]}

The HTTP side lets the UI drive the coordinator:
  GET  /api/sync/status                 → listening flag, pairing code, workers, jobs
  POST /api/sync/pair-code              → regenerate the pairing code
  POST /api/sync/dispatch/{filing_id}   → queue a filing for the next idle worker
  GET  /api/sync/result/{job_id}        → fetch returned rows (poll) and apply
"""
import asyncio
import base64
import os
import secrets
import time
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException, Depends
from sqlalchemy.orm import Session

from ..db import get_db
from ..models.filing import Filing

router = APIRouter()


def _gen_code() -> str:
    alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    s = "".join(secrets.choice(alpha) for _ in range(6))
    return f"{s[:3]}-{s[3:]}"


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


@router.websocket("/ws/ocr")
async def ocr_worker(ws: WebSocket):
    await ws.accept()
    worker_id = None
    try:
        hello = await ws.receive_json()
        if hello.get("type") != "hello" or hello.get("code") != coordinator.pair_code:
            await ws.send_json({"type": "deny", "reason": "bad pairing code"})
            await ws.close()
            return
        worker_id = secrets.token_hex(4)
        coordinator.workers[worker_id] = {
            "id": worker_id,
            "name": hello.get("name", "Worker"),
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
        with open(f.storage_path, "rb") as fp:
            pdf_b64 = base64.b64encode(fp.read()).decode()
    except OSError:
        raise HTTPException(500, "Filing file missing on disk")

    coordinator.jobs[job_id] = {
        "id": job_id, "filingId": f.id, "filename": f.filename, "ticker": f.ticker,
        "worker": worker["name"], "status": "sent", "progress": 0, "rows": None,
        "sentAt": time.time(),
    }
    worker["status"] = "busy"
    await worker["ws"].send_json({
        "type": "job", "jobId": job_id, "filingId": f.id,
        "filename": f.filename, "pdf_b64": pdf_b64,
    })
    return {"jobId": job_id}


@router.get("/api/sync/result/{job_id}")
def get_result(job_id: str):
    job = coordinator.jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job

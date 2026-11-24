"""Distributed OCR sync — WebSocket coordinator.

This machine (the coordinator) opens a WebSocket endpoint and waits. A worker
laptop connects, authenticates with a pairing code, then receives PDF filings
to OCR-parse locally and returns either page Markdown or legacy structured rows.

Frame protocol (JSON over the socket) — two-step pairing, code sent AFTER
the coordinator hands back a pairId (worker doesn't need the code up front):

  worker → server : {"type": "hello", "name": "Dien's MacBook"}
  server → worker : {"type": "pair_required", "pairId": "a1b2c3d4"}
  worker → server : {"type": "pair", "pairId": "a1b2c3d4", "code": "ABC-23"}
  server → worker : {"type": "welcome", "workerId": "..."}    (or {"type":"deny"}, retry "pair")

A worker connecting from loopback (same machine) skips pair_required/pair:
Core replies to hello with welcome directly.
  server → worker : {"type": "job", "jobId": "...", "filingId": 12,
                     "filename": "NVDA 10-K.pdf", "bytes": 2118144}
  server → worker : <binary frame> ... <binary frame>     (the PDF, chunked)
  server → worker : {"type": "job_end", "jobId": "..."}   (all chunks sent)
  worker → server : {"type": "progress", "jobId": "...", "pct": 60}
  worker → server : {"type":"page_result","jobId":"...","page":1,
                     "pageCount":57,"markdown":"..."}
  server → worker : {"type":"page_ack","jobId":"...","page":1,"status":"stored"}
  worker → server : {"type":"result_end","jobId":"...","pageCount":57}
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

Implementation lives in app/services/ocr_sync_*.py:
  ocr_sync_protocol     constants, job states, result-format negotiation
  ocr_sync_network      LAN host detection, loopback check
  ocr_sync_attempts     durable OCRAttempt state (runs in threads)
  ocr_sync_coordinator  in-memory workers/jobs, dispatch, PDF streaming
  ocr_sync_worker       the /ws/ocr session: pairing + frame handlers
"""

from typing import Literal

from fastapi import APIRouter, Depends, WebSocket
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..services import ocr_sync_coordinator as sync_service
from ..services import ocr_sync_worker

router = APIRouter()


@router.websocket("/ws/ocr")
async def ocr_worker(ws: WebSocket):
    await ocr_sync_worker.serve(ws)


# ── HTTP control surface for the UI ────────────────────────────


class JobControl(BaseModel):
    action: Literal["hold", "stop"]


@router.get("/api/sync/status")
def sync_status():
    return sync_service.status()


@router.post("/api/sync/pair-code")
def regenerate_code():
    return sync_service.regenerate_pair_code()


@router.post("/api/sync/jobs/{job_id}/control")
async def control_job(job_id: str, control: JobControl):
    return await sync_service.control_job(job_id, control.action)


@router.post("/api/sync/dispatch/{filing_id}")
async def dispatch(filing_id: int, db: Session = Depends(get_db)):
    return await sync_service.dispatch_filing(db, filing_id)


@router.get("/api/sync/result/{job_id}")
def get_result(job_id: str):
    return sync_service.get_result(job_id)

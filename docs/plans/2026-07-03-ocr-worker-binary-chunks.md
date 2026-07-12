# Plan — Update OCR worker to binary-chunked PDF transfer

**Status:** complete (2026-07-09; covered by `tests/test_ocr_worker_protocol.py`)
**Context:** The coordinator (`backend/app/routes/sync.py`) now streams PDFs as binary WebSocket
frames — `{"type":"job", …, "bytes":N}` → binary chunks → `{"type":"job_end"}` — instead of
`pdf_b64` in the job frame (implemented + tested 2026-07-03, `tests/test_sync_dispatch.py`).
The worker script `Financial_analyze/scripts/ocr_worker.py` now verifies and reassembles those chunks.
Wire reference:
`docs/design/SYNC_WORKER_GUIDE.md` (updated, incl. a runnable reference worker).

## Protocol the worker must speak

1. Pairing unchanged (two-step `hello` → `pair_required` → `pair` → `welcome`/`deny`).
2. Job arrival is now three parts, all on the same socket, in order:
   - text `{"type":"job","jobId","filingId","filename","bytes"}` — start a fresh `bytearray`.
   - N binary frames — append each to the buffer in arrival order. No interleaving is possible:
     the coordinator marks a worker busy before streaming and sends one job at a time per worker.
   - text `{"type":"job_end","jobId"}` — transfer complete.
3. On `job_end`: check `len(buffer) == job["bytes"]`. Mismatch → send
   `{"type":"error","jobId","error":"size mismatch: …"}`, discard, wait for next job.
4. Run OCR on the raw bytes (no base64 decode step anymore) → `progress`/`result`/`error` frames
   exactly as before. The coordinator now handles `error` (marks the job failed, frees the worker) —
   send it on any OCR exception instead of dying silently.

## Implemented Changes to `Financial_analyze/scripts/ocr_worker.py`

1. **Drop base64** — remove the `import base64` and `base64.b64decode(msg["pdf_b64"])` line.
2. **Rework the receive loop** (`run_worker`, the `async for raw in ws:` block):
   ```python
   job, buf = None, bytearray()
   async for raw in ws:
       if isinstance(raw, bytes):          # binary frame = PDF chunk
           buf.extend(raw)
           continue
       msg = json.loads(raw)
       if msg.get("type") == "job":
           job, buf = msg, bytearray()
       elif msg.get("type") == "job_end" and job:
           # size check → error frame on mismatch, else run_ocr(bytes(buf), ...)
           # then progress/result/error exactly as today; finally job = None
   ```
   (`websockets` yields `bytes` for binary frames and `str` for text frames; `max_size=None` is
   already set on the connect call, keep it.)
3. **Docstring** — delete the "Wire protocol otherwise matches the CURRENT backend … base64-in-JSON"
   paragraph (lines ~18–22); the gap is closed. Point at `SYNC_WORKER_GUIDE.md` instead.
4. **Keep** `run_ocr()` as-is (still the PaddleOCR-VL stub — real extraction is separate work,
   PLAN.md Stage 8).

## Verify (one machine, no GPU needed)

1. Mac: `./scripts/run.sh` (backend on :8000), Sync page → note the pairing code.
2. Same machine: `python Financial_analyze/scripts/ocr_worker.py --connect ws://localhost:8000/ws/ocr
   --code <CODE>` — vLLM not running is fine: the worker should now send an `error` frame
   ("vLLM server unreachable"), and the Sync page must show the job **failed** and the worker back
   to **idle** (not stuck busy — this exercises the new error path).
3. Optionally stub `run_ocr` to return the placeholder row without vLLM and confirm the full
   job → chunks → result → "done" loop, with the received byte count matching the uploaded PDF.

## Out of scope

- Real PaddleOCR-VL row extraction (PLAN.md Stage 8).
- Switching result rows from tracker `id` to Mã số `code` (tracked in `OCR_PROTOCOL.md` UI notes).
- Job TTL / retry on the coordinator.

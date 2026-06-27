# OCR Worker Protocol — Core ↔ External OCR System

The **2nd contract** (separate from `API_CONTRACT.md`). Defines how the **Core** (Mac) and the
**OCR system** (a separate machine — GPU laptop with RTX 4070) exchange work over the network.

```
Presentation ──HelixAPI──► Core (Mac) ──[THIS PROTOCOL]──► OCR worker (laptop, external)
                            ▲ SERVER / coordinator           ▲ CLIENT / worker
                            │ listens, hands out jobs         │ dials in, runs PP-DocLayout + PaddleOCR-VL
                            └─────────── WebSocket ───────────┘
```

## Direction (decided 2026-06-26 — reconciled with the `page-sync` UI)
**The laptop dials the Mac.** The Mac/Core is the **coordinator/server**; the laptop worker is the
**client that connects out** with a pairing code. *(This inverts an earlier draft where the Mac called
the laptop's port.)* Chosen because it networks better in the real world: the worker needs no stable
reachable address/port, it works through NAT, and the pairing-code handshake is a friendlier, safer UX
than exposing a server on the laptop. The `page-sync.jsx` control panel is the UI for this.

- The OCR worker is a **black box**: receives a document, returns structured rows. Core never trusts it
  (reconciliation on the Mac catches its errors — the machine boundary is the trust boundary).
- **Asynchronous**: the Core enqueues a job and awaits the worker's result over the live channel; it never
  blocks while the GPU grinds.
- **Mock now**: an in-process stub (`backend/app/services/ocr_stub.py`) stands in for a connected worker and
  returns canned VNM rows. A real worker drops in later with **zero change to the Core's orchestration** —
  the `ocr_client.submit/poll` interface is unchanged (see "Core side").

---

## Connection & pairing
- The Core listens at **`ws://<mac-host>:8000/ws/ocr`** (served by `backend/app/routes/sync.py`).
  Addressed by hostname (e.g. `mac.local`), not a hardcoded IP.
- The worker connects out and **pairs** with a short code shown in the Sync page (e.g. `ABC-DEF`):
  ```
  python -m worker --connect ws://<mac-host>:8000/ws/ocr --code ABC-DEF
  ```
- **Auth = the pairing code.** It is single-use per session and rotatable (the UI can regenerate it).
  A wrong/absent code → the Core rejects and closes the socket. This replaces the earlier
  `X-OCR-Secret` header — the pairing handshake is the auth, scoped to one worker session.
- Multiple workers may pair; the Core dispatches each job to an idle worker.

---

## Frames (JSON over the WebSocket)
Text frames are JSON `{type, ...}`. The PDF itself is sent as **chunked binary frames**, never
base64-in-JSON (base64 bloats a multi-MB scan ~33%).

### Handshake
```
worker → server : {"type":"hello","code":"ABC-DEF","worker":"Dien's Laptop","gpu":"RTX 4070"}
server → worker : {"type":"paired","session":"s-9f2"}          # or {"type":"reject","reason":"bad code"}
```

### Dispatch a job (server → worker), then stream the PDF as binary
```
server → worker : {"type":"job","jobId":"job_7","docId":12,"filename":"vnm-q4.pdf","bytes":2118144}
server → worker : <binary frame> <binary frame> ...            # the PDF, chunked
server → worker : {"type":"job_end","jobId":"job_7"}           # all chunks sent
```
(Worker reassembles the binary chunks in arrival order into the PDF.)

### Progress (worker → server)
```
worker → server : {"type":"progress","jobId":"job_7","status":"triaging","progress":20}
worker → server : {"type":"progress","jobId":"job_7","status":"extracting","progress":62}
```
`status` ∈ `queued | triaging | extracting | done | failed`.

### Result (worker → server)
```
worker → server : {"type":"result","jobId":"job_7","pages":8,
  "statements":[
    {"kind":"CDKT","period":"Q4 2024","unit":"triệu đồng"},
    {"kind":"KQKD","period":"Q4 2024","unit":"triệu đồng"},
    {"kind":"LCTT","period":"Q4 2024","unit":"triệu đồng"}
  ],
  "rows":[
    {"code":"270","section":"balance","metric":"TỔNG CỘNG TÀI SẢN",
     "curr":"52800000","prev":"51000000","page":3,"confidence":73}
  ]}
```
On failure:
```
worker → server : {"type":"error","jobId":"job_7","error":"no tables found"}
```

### Result `rows` — canonical shape
Same row shape as `API_CONTRACT.md` §2 and the OCR workflow spec, so the Core passes them straight into
placement: `{code (Mã số), section (income|balance|cashflow), metric, curr, prev, page, confidence}`.
- `code` = **Mã số** (TT200) — required; the Core places rows into statements by it. (The UI's tracker
  `id` like `rev`/`gp` is a presentation concept; the **wire uses `code`**.)
- `curr`/`prev`: strings, raw digits, may be `-`-prefixed. No thousands separators.
- `confidence`: 0–100, per value.
- **The worker does NOT set line-item `status`** — that is assigned by the Core's reconciliation step. The
  worker only reads.

---

## What happens inside the OCR worker (informational — Core doesn't care)
1. **Triage** — PP-DocLayout runs on every page, detects table regions (biased to keep pages).
2. **Crop** — only detected table regions passed onward.
3. **Extract** — PaddleOCR-VL reads cropped regions, returns rows with Mã số + confidence.
4. Sends the `result`. (On the laptop the GPU is the worker's; the Mac's Qwen brain runs on the Mac —
   different machines, so OCR and analysis run in parallel, not time-shared.)

---

## Core side (this repo)
- `backend/app/routes/sync.py` — the WebSocket coordinator: accepts worker connections, validates the
  pairing code, tracks connected/idle/busy workers, dispatches jobs, receives progress + results, exposes
  worker/job state to the Sync page (and `/api/sync/*` for the dashboard).
- `backend/app/services/ocr_client.py` — **unchanged interface** for the rest of the Core:
  `submit(doc_path, doc_id) -> job_id`, `poll(job_id) -> {status, progress, result}`. Internally it either
  enqueues the job to a connected worker via the coordinator, or (no worker / `ocr_worker_url`-style mock
  flag) uses the in-process stub. The ingest workflow (`services/ingest.py`) is written against this
  interface and does not change when the transport changes.
- `backend/app/services/ocr_stub.py` — mock worker returning the VNM fixture (incl. the planted Mã số 270
  error + low-conf rows) after a short fake delay.
- Core orchestration: upload → `submit` → await/poll result → place rows (TT200) → write
  `statements` + `line_items` → run reconciliation. (See the OCR document workflow spec/plan.)

## Timeouts / retries
- Job TTL ~10 min; if no idle worker, the job queues until one pairs (or the Core falls back to the stub
  in dev). On `error` or timeout → `document.status=failed` with `fail_reason`, surfaced to the UI; the
  Core retries the submit **once** (per the OCR workflow spec).

## Mock → real swap
With no worker paired, the Core uses the in-process stub (dev/offline/test). Pair a real worker laptop via
the Sync page → live jobs flow over the WebSocket. No change to the Core's orchestration code.

---

## UI alignment notes (changes needed in the design artifact)
`page-sync.jsx` matches this design on direction (Mac listens), transport (WS `ws://…/ws/ocr`), pairing
code, and the worker run command. Two adjustments to make **in the artifact** (per `design-source-of-truth`):
1. **Rows must carry `code`** (Mã số), not just the tracker `id` — the doc comment's frame example and
   `WORKER_RESULT_ROWS` should include `code` so the wire matches this protocol + reconciliation.
2. **PDF transfer = binary chunks, not `pdf_b64`** — the doc-comment frame `{type:"job", …, pdf_b64}` should
   become a `{type:"job"}` text frame followed by binary chunk frames + `{type:"job_end"}`.
The current UI mock data is US-flavored (Revenue/NVIDIA) — fixed in the VN reskin, not here.

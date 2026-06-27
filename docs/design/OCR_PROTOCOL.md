# OCR Worker Protocol — Core ↔ External OCR System

The **2nd contract** (separate from `API_CONTRACT.md`). Defines how the **Core** (Mac) talks to the
**OCR system** (a separate machine — GPU laptop with RTX 4070) over the network port.

```
Presentation ──HelixAPI──► Core ──[THIS PROTOCOL, over a port]──► OCR system (external)
                                                                   PP-DocLayout + PaddleOCR-VL
```

- The OCR system is a **black box**: takes a document, returns structured line items.
- **Asynchronous**: core submits a job, gets a `job_id` immediately, then polls (or receives a push).
  Core never blocks while the GPU grinds.
- **Mock now**: an in-process stub (`backend/app/services/ocr_stub.py`) implements this protocol and
  returns canned VNM rows. Real GPU worker drops in later with **zero core change** — same protocol.

---

## Connection
- Base URL: `http://<ocr-host>:<port>` — addressed by **hostname** (e.g. `http://gpu-laptop.local:9000`),
  not a hardcoded IP, so a changing IP doesn't break the link. Configured via `ocr_worker_url`
  (empty → core uses the in-process stub).
- **Auth:** every request carries header `X-OCR-Secret: <shared-secret>` (`ocr_shared_secret`).
  Requests without it → `401`. Keeps stray devices on the LAN out.
- Documents sent as **multipart file upload**, never embedded in JSON.

---

## Endpoints (on the OCR system)

### GET /health
```json
{"status":"ok","gpu":"RTX 4070","models":["PP-DocLayout","PaddleOCR-VL"]}
```

### POST /ocr/jobs   (multipart)
fields: `file` (the PDF/image), `doc_id` (core's document id, for correlation)
→ `202 Accepted`
```json
{"job_id":"a1b2c3","status":"queued"}
```

### GET /ocr/jobs/{job_id}
```json
{"job_id":"a1b2c3","status":"extracting","progress":62,"result":null}
```
When done:
```json
{"job_id":"a1b2c3","status":"done","progress":100,
 "result":{
   "pages":8,
   "statements":[
     {"kind":"CDKT","period":"Q4 2024","unit":"triệu đồng"},
     {"kind":"KQKD","period":"Q4 2024","unit":"triệu đồng"},
     {"kind":"LCTT","period":"Q4 2024","unit":"triệu đồng"}
   ],
   "rows":[
     {"code":"270","section":"balance","metric":"TỔNG CỘNG TÀI SẢN",
      "curr":"52800000","prev":"51000000","page":3,"confidence":73}
   ]
 }}
```
`status` ∈ queued | triaging | extracting | done | failed.
On failure: `{"status":"failed","error":"..."}`.

### Result `rows` — canonical shape
Same row shape as `API_CONTRACT.md` §2 (so core passes them through to the review table):
`{code(Mã số), section(income|balance|cashflow), metric, curr, prev, page, confidence}`.
- `curr`/`prev`: strings, raw digits, may be `-`-prefixed. No thousands separators.
- `confidence`: 0–100, per value.
- **OCR does NOT set `status`** — that's assigned by the core's reconciliation step. OCR only reads.

---

## Push (optional, later)
Polling is primary. Optionally the OCR system pushes progress to the core:
- WS `/ocr/ws` emitting `{job_id, status, progress}`, **or**
- a callback: core passes `callback_url` on submit; OCR POSTs the result there on completion.
Decide when the real worker is built; not required for mock.

---

## What happens inside the OCR system (informational — core doesn't care)
1. **Triage** — PP-DocLayout runs on every page, detects table regions (biased to keep pages).
2. **Crop** — only detected table regions passed onward.
3. **Extract** — PaddleOCR-VL reads cropped regions, returns rows with Mã số + confidence.
4. Returns `result`. (GPU is time-shared with the analysis LLM — sequential, not concurrent.)

---

## Core side (this repo)
- `backend/app/services/ocr_client.py` — interface: `submit(doc_path, doc_id) -> job_id`,
  `poll(job_id) -> {status, progress, result}`. Picks stub vs real by `ocr_worker_url`.
- `backend/app/services/ocr_stub.py` — mock impl returning the VNM fixture (incl. the planted
  Mã số 270 error + low-conf rows) after a short fake delay.
- Core orchestration: on upload → `submit` → poll → write `statements` + `line_items` → run recon.

## Timeouts / retries
- Submit timeout 10s; poll interval 1–2s; job TTL on the worker ~10 min.
- On `failed` or timeout → document.status=`failed`, surfaced to UI; core may retry once.

## Mock → real swap
Set `ocr_worker_url` to the real host. No core code change; stub stays as offline/test fallback.

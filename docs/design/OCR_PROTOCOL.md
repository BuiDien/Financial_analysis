# OCR Worker Protocol — Server ↔ Worker

Status: server implemented for dual-format migration (2026-07-18)

The Mac/Core is the WebSocket coordinator. A worker connects to
`ws://<server>:8000/ws/ocr`, pairs, receives a PDF as binary chunks, performs OCR, and returns a
result.

Transport protocol version 1 supports two result formats:

| Result format | Schema | Purpose | Status |
|---|---:|---|---|
| `page_markdown_v2` | 2 | Raw OCR, one Markdown payload per PDF page | Preferred |
| `structured_rows_v1` | 1 | Legacy financial rows with code/id and bbox | Compatibility |

Page Markdown is not passed through the structured financial-row validator. `code`, `id`, `bbox`,
`section`, and values are not required in the page format.

## Pairing and result negotiation

Preferred worker hello:

```json
{
  "type": "hello",
  "name": "Dien WSL (vLLM)",
  "protocolVersion": 1,
  "resultFormats": ["page_markdown_v2"],
  "capabilities": ["page_ack"]
}
```

Handshake:

```text
worker -> server  hello
server -> worker  {"type":"pair_required","pairId":"a1b2c3d4"}
worker -> server  {"type":"pair","pairId":"a1b2c3d4","code":"ABC-DEF"}
server -> worker  welcome
```

Preferred welcome:

```json
{
  "type": "welcome",
  "workerId": "58023ec0",
  "protocolVersion": 1,
  "selectedResultFormat": "page_markdown_v2",
  "resultSchemaVersion": 2,
  "requiredCapabilities": ["page_ack"]
}
```

The worker must use `selectedResultFormat`. An incompatible worker is denied before pairing, so an
expensive OCR run cannot finish with a predictable schema mismatch.

Legacy hello remains accepted during migration:

```json
{
  "type": "hello",
  "name": "Legacy Worker",
  "protocolVersion": 1,
  "resultSchemaVersions": [1],
  "capabilities": ["bbox"]
}
```

## Job transfer

For a page worker, the job header is:

```json
{
  "type": "job",
  "jobId": "job_2831b0eaed",
  "inboxItemId": 42,
  "filename": "statement.pdf",
  "bytes": 2118144,
  "protocolVersion": 1,
  "resultFormat": "page_markdown_v2",
  "resultSchemaVersion": 2,
  "requiredCapabilities": ["page_ack"]
}
```

The server then sends raw PDF binary frames of at most 512 KiB, followed by:

```json
{"type":"job_end","jobId":"job_2831b0eaed"}
```

The worker must verify that the received byte count equals the header’s `bytes` value.

## Progress

```json
{"type":"progress","jobId":"job_2831b0eaed","pct":60}
```

`pct` is clamped to 0–100 by the server.

## Page Markdown result

The worker finishes OCR locally, then sends one page at a time:

```json
{
  "type": "page_result",
  "jobId": "job_2831b0eaed",
  "schemaVersion": 2,
  "page": 1,
  "pageCount": 57,
  "markdown": "# Page 1\n\nOCR content..."
}
```

Required fields:

- `jobId` must match the active server-issued job.
- `page` is 1-based and cannot exceed `pageCount`.
- `pageCount` must match the server-known PDF page count.
- `markdown` is a UTF-8 JSON string. Empty Markdown is allowed for a blank page.
- A page is limited to 1 MiB and a completed document to 20 MiB.

The server prints every post-pairing worker JSON message between
`OCR WORKER MESSAGE BEGIN/END` markers before validation. Vietnamese characters are preserved.

## Commit-backed page acknowledgement

After the page is committed:

```json
{
  "type": "page_ack",
  "jobId": "job_2831b0eaed",
  "page": 1,
  "status": "stored",
  "receivedPages": 1,
  "pageCount": 57
}
```

The worker waits for this acknowledgement before advancing. An identical retry receives
`status: "already_stored"`. The server identifies a page by `(attempt_id, page_number)` and compares
server-computed SHA-256 checksums.

A different retry for an already stored page is terminal:

```json
{
  "type": "page_rejected",
  "jobId": "job_2831b0eaed",
  "page": 1,
  "errorCode": "page_conflict",
  "error": "Page 1 was already stored with different content",
  "retryable": false
}
```

Database failures return `page_persistence_failed` with `retryable: true`; the server does not claim
that the page was stored.

## End and assembly

After all pages are acknowledged:

```json
{
  "type": "result_end",
  "jobId": "job_2831b0eaed",
  "schemaVersion": 2,
  "pageCount": 57
}
```

If pages are missing:

```json
{
  "type": "result_incomplete",
  "jobId": "job_2831b0eaed",
  "errorCode": "missing_pages",
  "missingPages": [17, 31],
  "retryable": true
}
```

The worker resends only those pages and sends `result_end` again.

When complete, the server sorts pages numerically, creates a deterministic merged Markdown document,
creates the page review, and responds:

```json
{
  "type": "result_ack",
  "jobId": "job_2831b0eaed",
  "status": "ready_for_review",
  "pageCount": 57,
  "reviewId": 19,
  "inboxItemId": 42
}
```

Only then may the worker release its page buffer and report completion.

Merged Markdown uses stable page markers:

```md
<!-- PAGE:1 -->

Page-one Markdown

---

<!-- PAGE:2 -->

Page-two Markdown
```

Original page Markdown is immutable. Reviewer corrections are stored separately.

## Review server APIs

- `GET /api/ocr-inbox/reviews/{review_id}` — format, counts, page metadata, audit events.
- `GET /api/ocr-inbox/reviews/{review_id}/pages/{page}` — raw, corrected, and effective Markdown.
- `POST /api/ocr-inbox/reviews/{review_id}/pages/{page}/approve` — approve raw page.
- `POST /api/ocr-inbox/reviews/{review_id}/pages/{page}/correct` — save corrected Markdown.
- `POST /api/ocr-inbox/reviews/{review_id}/pages/{page}/restore` — return page to pending.
- `GET /api/ocr-inbox/reviews/{review_id}/markdown?source=raw|effective` — merged Markdown.
- `POST /api/ocr-inbox/reviews/{review_id}/verify` — allowed after every page is resolved.

Every mutation includes the current `revision`. A stale revision receives HTTP 409.

Verified page Markdown cannot be published as structured financial statements. A later structured
extraction stage must create validated financial rows first.

## Legacy structured result

`structured_rows_v1` remains supported for existing workers. It uses a single `result` message with
schema version 1. Inbox rows require a financial identity (`code` or legacy `id`), a label/metric,
page, confidence, and normalized bbox. Its accepted response remains `result_ack` with `rowCount`.

The page and row handlers are separate. A `result` message sent for a page-format job is rejected with
`invalid_result_format`; it is never sent through page ingestion.

## Failure and restart behavior

- Identical page retries are idempotent.
- Conflicting pages and deterministic contract failures fail the attempt without automatic retry.
- Missing pages keep the same attempt open for repair.
- A disconnect or coordinator restart during receipt fails the interrupted attempt and may create the
  existing one-time automatic retry attempt.
- A database write is acknowledged only after commit.
- Acked pages remain stored for diagnosis if a later stage fails.

## Server implementation

- Contract: `backend/app/ocr_page_contract.py`
- Persistence/assembly: `backend/app/services/ocr_page_results.py`
- Models: `backend/app/models/ocr.py`
- WebSocket: `backend/app/routes/sync.py`
- Review API: `backend/app/routes/ocr_inbox.py`

The worker update is deployed only after this dual-format server version.

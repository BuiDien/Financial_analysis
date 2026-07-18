# OCR Page-Markdown Protocol — Server and Worker Implementation Plan

Date: 2026-07-18  
Status: Proposed  
Scope: OCR worker transport, server persistence/assembly, and page review UI

## 1. Outcome

Replace the new-worker result path that sends hundreds of financial `rows` with a page-oriented path:

1. The worker finishes OCR for the PDF locally.
2. The worker sends one Markdown result per PDF page.
3. The server durably stores and acknowledges every page.
4. The worker sends an end-of-result message.
5. The server verifies that every page is present, merges the pages in order, and creates a review job.
6. The review UI shows the PDF page beside the Markdown for the same page.

The page-ingestion contract will not require `code`, `id`, `section`, `metric`, `curr`, `prev`,
`confidence`, or `bbox`. Those fields belong to a later structured-extraction stage, not the raw OCR
transport.

The existing structured-row protocol remains temporarily available for legacy workers and existing
reviews. It must not be used to validate a page-Markdown result.

## 2. Why the current result fails

The worker message is valid JSON and contains OCR content, but the server validates it as a financial
row result. The current row model applies business rules such as “each row requires `code` or `id`.”
Most OCR lines do not have either identifier, so one valid page can produce hundreds of validation
errors.

This is a contract mismatch:

| Layer | What it should know | What it should not require |
|---|---|---|
| OCR transport | Job, page number, page count, Markdown | Financial statement identifiers |
| Human review | Source page, original Markdown, corrected Markdown | A code for every visible line |
| Structured extraction | Section, code, metric, values, provenance | Raw transport responsibilities |

The fix is to separate those layers rather than weaken the existing row validator until arbitrary
rows pass.

## 3. Scope and non-goals

### In scope

- Versioned WebSocket messages for page Markdown.
- Durable page-by-page storage and acknowledgements.
- Duplicate, missing, conflicting, and out-of-order page handling.
- Ordered document assembly.
- Page-oriented human review.
- Exact diagnostic logging of worker messages with safe size controls.
- Backward-compatible rollout from structured result schema 1.
- Automated server and reference-worker tests.

### Not in scope

- Automatically assigning financial statement codes to OCR lines.
- Publishing unstructured Markdown into the structured filing tracker.
- Replacing the PDF binary-chunk job dispatch protocol.
- Making OCR text perfect. Corrections happen in review or a later extraction stage.
- Deleting the legacy row protocol during the first release.

## 4. Target end-to-end flow

```text
Server                         Worker                         Database/UI
  |--- job header + PDF -------->|                                |
  |                              | OCR all PDF pages              |
  |<-- progress -----------------|                                |
  |<-- page_result(page=1) ------|                                |
  |--- persist page 1 ------------------------------------------->|
  |--- page_ack(page=1) -------->|                                |
  |<-- page_result(page=2) ------|                                |
  |--- persist page 2 ------------------------------------------->|
  |--- page_ack(page=2) -------->|                                |
  |              ...             |                                |
  |<-- result_end(pageCount=N) --|                                |
  |--- verify pages 1..N ---------------------------------------->|
  |--- assemble ordered Markdown + create review --------------->|
  |--- result_ack(ready_for_review) -->|                          |
  |                                                               |
  |                         Reviewer opens PDF page K + Markdown K |
```

An acknowledgement means that the page has been committed to the database, not merely received by
the WebSocket process.

## 5. Protocol design

### 5.1 Negotiation

Keep the transport `protocolVersion` at `1` because the handshake, PDF header, and binary chunking do
not change. Negotiate the result representation separately.

New worker hello:

```json
{
  "type": "hello",
  "name": "Dien WSL (vLLM)",
  "protocolVersion": 1,
  "resultFormats": ["page_markdown_v2"],
  "capabilities": ["page_ack"]
}
```

Server welcome:

```json
{
  "type": "welcome",
  "workerId": "58023ec0",
  "protocolVersion": 1,
  "selectedResultFormat": "page_markdown_v2"
}
```

The dispatched job header must repeat `resultFormat: "page_markdown_v2"`. The worker must reject a
job if that format was not negotiated.

During migration, the server accepts both:

- `structured_rows_v1` with the current `bbox` and row requirements.
- `page_markdown_v2` with page acknowledgements and no row requirements.

Do not continue using `capabilities: ["bbox"]` as the universal connection requirement. Capabilities
must be evaluated against the selected result format.

### 5.2 Required page message

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

| Field | Rule |
|---|---|
| `type` | Exactly `page_result` |
| `jobId` | Must match the active dispatched job |
| `schemaVersion` | Exactly `2` for this format |
| `page` | Integer from `1` through `pageCount` |
| `pageCount` | Positive integer matching the dispatched PDF page count when known |
| `markdown` | UTF-8 JSON string; an empty string is allowed for a genuinely blank page |

The server computes the UTF-8 byte size and SHA-256 checksum. Keeping those values server-owned
keeps the worker message simple and prevents a false sense that a client-supplied checksum was
verified.

### 5.3 Page acknowledgement

Newly stored page:

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

Identical retry:

```json
{
  "type": "page_ack",
  "jobId": "job_2831b0eaed",
  "page": 1,
  "status": "already_stored",
  "receivedPages": 1,
  "pageCount": 57
}
```

Conflicting retry:

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

The unique identity is `(attempt_id, page_number)`. An identical duplicate is idempotent. A duplicate
with a different checksum is rejected so a silent retry cannot overwrite source evidence.

### 5.4 End message

```json
{
  "type": "result_end",
  "jobId": "job_2831b0eaed",
  "schemaVersion": 2,
  "pageCount": 57
}
```

Successful response:

```json
{
  "type": "result_ack",
  "jobId": "job_2831b0eaed",
  "status": "ready_for_review",
  "pageCount": 57
}
```

Incomplete response:

```json
{
  "type": "result_incomplete",
  "jobId": "job_2831b0eaed",
  "errorCode": "missing_pages",
  "missingPages": [17, 31],
  "retryable": true
}
```

`result_incomplete` is not a terminal attempt failure. The worker resends the listed pages and sends
`result_end` again. Only an explicit worker error, a non-retryable contract error, disconnect policy,
or exhausted retry budget ends the attempt as failed.

### 5.5 Ordering and limits

- The normal worker sends pages sequentially and waits for each acknowledgement.
- The server accepts pages out of order and always assembles by page number.
- Maximum page number must not exceed the expected PDF page count.
- Initial limits: 1 MiB of Markdown per page and 20 MiB per document.
- JSON message limits must allow one full page plus envelope overhead.
- A limit violation returns a concise `page_rejected` response; it must not place megabytes of input
  in an exception message.

### 5.6 Merged Markdown

Store every original page independently. Also build a derived, deterministic document:

```md
<!-- PAGE:1 -->

# Page 1

OCR content...

---

<!-- PAGE:2 -->

# Page 2

OCR content...
```

The merged document is convenient for download and later processing, but page records remain the
source of truth. Reassembly must produce the same bytes from the same page records.

## 6. Server data model

### 6.1 Extend `OCRAttempt`

Add:

- `result_format`: `structured_rows_v1` or `page_markdown_v2`.
- `expected_pages`: nullable integer until dispatch knows the PDF count.
- `received_pages`: integer, default `0`.
- `merged_markdown`: nullable text.
- `result_sha256`: nullable 64-character string.

Add the status `receiving_pages` between `processing` and `done`. The recommended state sequence is:

```text
queued -> sent -> processing -> receiving_pages -> assembling -> done
                                                     |             |
                                                     +----------> failed
```

The inbox item becomes `ready_for_review` only after assembly and review creation succeed in the same
transactional operation. Do not mark an attempt done before the review can be opened.

### 6.2 Add `OCRPageResult`

Fields:

- `id`
- `attempt_id`, foreign key to `ocr_attempts`, indexed, cascade delete
- `page_number`, integer
- `raw_markdown`, text, immutable after insert
- `reviewed_markdown`, nullable text
- `review_status`: `pending`, `approved`, or `corrected`
- `content_sha256`, 64-character string
- `byte_size`, integer
- `created_at`, `updated_at`

Constraints:

- Unique `(attempt_id, page_number)`.
- `page_number >= 1`.
- `byte_size >= 0`.

`raw_markdown` is never overwritten by reviewer corrections. The effective page is
`reviewed_markdown` when present, otherwise `raw_markdown`.

### 6.3 Extend `OCRReviewJob`

Add `result_format`, defaulting existing rows to `structured_rows_v1`. A Markdown review references
the completed attempt and obtains its pages through that attempt. The existing `OCRReviewRow` table
stays unchanged for legacy reviews.

This avoids copying large Markdown strings into a second table while preserving both the immutable
source and reviewed version.

### 6.4 Migration behavior

- Create the new page table before accepting a new-format worker.
- Backfill existing attempts and reviews with `structured_rows_v1`.
- Keep new columns nullable where historical data has no meaningful value.
- Additive migration must be safe to run more than once in local SQLite development.
- Production migration and application deployment must finish before a page worker is allowed to
  negotiate the new result format.

## 7. Server implementation plan

### Task S1 — Isolate and test the page contract

Files:

- Create `backend/app/ocr_page_contract.py`.
- Create `backend/tests/test_ocr_page_contract.py`.

Implement small Pydantic models for `PageResult` and `ResultEnd`. Test valid blank pages, Unicode
Vietnamese text, wrong job, invalid numbers, oversized content, and unexpected fields. These models
must not import or run the financial-row validators.

Exit condition: a page containing only prose with no `code` or `id` validates successfully.

### Task S2 — Add persistence and migration

Files:

- Modify `backend/app/models/ocr.py`.
- Modify the project’s database initialization/migration path in `backend/app/db.py` as required.
- Modify `backend/tests/test_ocr_models.py`.

Add the model and constraints described above. Test insertion, ordered retrieval, duplicate-page
protection, raw-content immutability by service policy, and cascade behavior.

Exit condition: page 1 survives a new database session and can be retrieved byte-for-byte.

### Task S3 — Add a page-ingestion service

Files:

- Create `backend/app/services/ocr_page_results.py` or the equivalent existing service location.
- Create `backend/tests/test_ocr_page_results.py`.

Responsibilities:

- Confirm job and attempt identity.
- Confirm page count against the dispatched document.
- Compute UTF-8 byte size and SHA-256.
- Insert a new page and update `received_pages` transactionally.
- Acknowledge an identical duplicate without incrementing the count.
- Reject a conflicting duplicate without changing stored data.
- Calculate missing pages.
- Assemble pages in numeric order.
- Create the page-format review job and finalize statuses atomically.

Keep database rules out of the WebSocket loop so they can be tested without a live socket.

### Task S4 — Extend the Sync coordinator

Files:

- Modify `backend/app/routes/sync.py`.
- Modify `backend/tests/test_sync_dispatch.py`.
- Add `backend/tests/test_ocr_markdown_protocol.py` if separating the test improves readability.

Changes:

- Negotiate result format independently from transport version.
- Select only a compatible worker for a page-Markdown job.
- Route `page_result` to the page-ingestion service.
- Send `page_ack` only after commit.
- Route `result_end` to completeness checking and assembly.
- Keep `progress`, `error`, and control-message handling working while receiving pages.
- Retain the legacy `result` handler for `structured_rows_v1` only.
- Never fall through from `page_markdown_v2` into `OCRWorkerResult` row validation.

Refactor the coordinator into named message handlers rather than adding another large conditional body
inside the existing receive loop.

Exit condition: a test worker sends three Markdown pages with `code: null` nowhere in the envelope,
receives three acknowledgements, and the attempt becomes ready for review.

### Task S5 — Make diagnostic logging verifiable

Files:

- Modify the message logging helper in `backend/app/routes/sync.py`.
- Add focused log-capture tests.

For development diagnostics, print every worker-to-server JSON envelope between clear BEGIN/END
markers, preserving `ensure_ascii=False`. Include worker ID, worker name, job ID, message type, page,
and UTF-8 byte size.

Operational safeguards:

- A configuration flag controls full Markdown body logging.
- Default production logging records metadata and checksum, not full financial content.
- Never log authentication tokens, WebSocket query secrets, or PDF binary chunks.
- Contract errors log the rejected page and reason without echoing the entire document.

This gives a reproducible audit during rollout without permanently leaking every report into normal
production logs.

### Task S6 — Add review APIs

Files:

- Modify `backend/app/routes/ocr_inbox.py`.
- Modify `backend/tests/test_ocr_inbox.py` or add `backend/tests/test_ocr_markdown_review.py`.

Add page-format responses and endpoints:

- `GET /api/ocr-inbox/reviews/{review_id}` returns `resultFormat`, revision, page counts, and summary.
- `GET /api/ocr-inbox/reviews/{review_id}/pages/{page}` returns raw, reviewed, effective Markdown,
  page status, and neighboring page availability.
- `POST /api/ocr-inbox/reviews/{review_id}/pages/{page}/approve` approves the exact raw page.
- `POST /api/ocr-inbox/reviews/{review_id}/pages/{page}/correct` saves corrected Markdown with the
  current review revision.
- The existing verify endpoint accepts a page review only when all pages are approved or corrected.

Use optimistic revision checks so two browser sessions cannot silently overwrite review edits.

Do not allow the existing structured “publish” action to treat page Markdown as financial rows. The
page result can be marked OCR-verified; structured extraction/publishing is a separate future action.

### Task S7 — Update the review UI

Files:

- Modify `src/page-ocr-inbox.jsx`.
- Add or modify frontend tests if the repository’s current setup supports them.

For `resultFormat: page_markdown_v2`:

- Keep the PDF on the left.
- Show the selected page’s exact Markdown on the right.
- Synchronize page navigation on both sides.
- Provide Approve Page, Edit/Save Correction, previous/next page, and review progress.
- Preserve unsaved-edit warnings when changing pages.
- Disable final verification until all pages are resolved.
- Clearly label raw Markdown versus corrected Markdown.

The first safe renderer should display Markdown source in a text area or `<pre>` element. If a rendered
preview is added, sanitize generated HTML and retain a source view. Never place untrusted OCR Markdown
directly into `dangerouslySetInnerHTML`.

Legacy structured-row reviews continue to use the existing bbox/row interface.

### Task S8 — Update documentation and observability

Files:

- Update `docs/design/OCR_PROTOCOL.md`.
- Update `docs/design/SYNC_WORKER_GUIDE.md`.
- Mark relevant portions of `docs/design/OCR_WORKER_V1_UPGRADE.md` as legacy.
- Update `docs/README.md`.

Add metrics/log fields for pages received, duplicate retries, conflicts, missing pages, assembly time,
and result byte size. Document exact server/worker deployment order and rollback behavior.

## 8. Worker implementation plan

### Task W1 — Produce one deterministic result per PDF page

Primary reference file:

- Modify `scripts/ocr_worker.py` and the corresponding real WSL worker implementation.
- Modify `backend/tests/test_ocr_worker_protocol.py` or add worker-side tests beside the real worker.

The OCR engine returns a list like:

```python
pages = [
    {"page": 1, "markdown": "..."},
    {"page": 2, "markdown": "..."},
]
```

Before sending anything, validate locally:

- `pageCount` equals the PDF page count.
- Every integer page from 1 through `pageCount` appears exactly once.
- Markdown is a string and is UTF-8 encodable.
- Per-page and total sizes remain within negotiated limits.

Blank Markdown is allowed for a blank page; the page entry must still be sent.

### Task W2 — Replace the single large result send with an acknowledged loop

After all OCR processing completes:

```python
for page in pages:
    send(page_result(page))
    wait_for_matching_page_ack(page)

send(result_end(page_count))
wait_for_result_ack()
```

Use `json.dumps(message, ensure_ascii=False)` so Vietnamese text stays readable in diagnostics. Do not
construct the payload from the old row schema and do not insert fake codes merely to satisfy the old
server.

### Task W3 — Use one WebSocket receiver/state machine

Avoid two coroutines calling `recv()` on the same WebSocket. One receive loop must route:

- `page_ack` and `page_rejected` to the active page sender.
- `result_ack` and `result_incomplete` to finalization.
- `job_control` to cancel/pause handling.
- Connection close and protocol errors to job failure/retry logic.

This matters because page acknowledgements and control messages can arrive while results are being
uploaded.

### Task W4 — Implement bounded retries

- Wait for a matching acknowledgement by job and page.
- On timeout, resend the identical page up to three times with exponential backoff.
- Treat `already_stored` as success.
- Stop on `page_conflict` or another non-retryable rejection.
- On `result_incomplete`, resend only the listed pages and send `result_end` again.
- Keep the in-memory/local page buffer until final `result_ack`; only then release it.

The worker must never advance to the next page merely because `send()` returned successfully.

### Task W5 — Improve worker diagnostics

For each outbound page, log:

```text
job=job_... page=7/57 bytes=18422 sha256=... send_attempt=1
```

For each acknowledgement, log status and round-trip time. Add an opt-in flag to print the complete
outbound JSON for joint verification with server logs. Redact connection secrets.

### Task W6 — Worker acceptance tests

Use a fake WebSocket server to verify:

- A three-page document produces three page messages and one end message.
- The worker waits for each acknowledgement.
- An acknowledgement timeout causes an identical retry.
- `already_stored` advances normally.
- `result_incomplete` resends only missing pages.
- A page conflict stops the job.
- Unicode Markdown is preserved exactly.
- A cancel message is honored while pages are uploading.

## 9. Review and downstream structure

The correct separation after this change is:

```text
PDF -> OCR page Markdown -> human OCR verification -> optional structured extraction
                                               -> financial row validation
                                               -> reconciliation
                                               -> publication
```

The later structured extractor may use a page’s Markdown and emit rows with `code`, `metric`, and
values. At that point, the existing row validator is valuable. A structured row should also carry
page provenance so reviewers can trace it back to the verified Markdown.

Until that stage exists, a verified Markdown review means “the OCR text was checked,” not “the
financial statements were mapped and published.”

## 10. Failure behavior

| Failure | Server behavior | Worker behavior |
|---|---|---|
| Wrong job ID | Reject message; do not mutate attempt | Stop and report protocol error |
| Invalid page number | `page_rejected`, non-retryable | Stop job |
| Identical duplicate | `page_ack: already_stored` | Continue |
| Conflicting duplicate | Preserve first page; reject conflict | Stop and retain diagnostics |
| Missing page at end | `result_incomplete` with page list | Resend listed pages |
| Oversized page | Reject without storing | Stop or split only after a future protocol version |
| Database failure | No ack before rollback | Retry identical page after timeout |
| Disconnect during upload | Persist acked pages; apply retry policy | Reconnect/retry job without discarding buffered pages |
| Assembly failure | Keep pages, mark attempt failed/retryable | Report final failure; do not claim completion |
| Review creation failure | Roll back finalization | Receive rejection/failure, not success |

For the initial release, reconnect may restart a fresh attempt and resend all pages. Persisted pages
still protect the interrupted attempt for diagnosis. Resuming the same attempt across a new socket can
be added later with an explicit resume token; it should not be improvised from worker name or IP.

## 11. Security and integrity

- Authenticate the worker as today; never rely on LAN IP as identity.
- Bind every result message to the active server-issued job ID and attempt.
- Enforce page/document size and page-count limits before large database writes.
- Store original page Markdown exactly and compute server-side checksums.
- Escape or sanitize OCR content before browser rendering.
- Keep full-payload logging opt-in and disabled by default in production.
- Record audit events for receipt completion, page correction, approval, verification, and conflicts.
- Do not allow Markdown content to alter server paths, commands, SQL, or template evaluation.

## 12. Test strategy

### Server contract tests

- Minimal page succeeds without financial fields.
- Incorrect schema version fails once with a concise error.
- All Vietnamese characters round-trip exactly.
- Page limits and count rules are enforced.

### Server integration tests

- Happy path with pages 1..N.
- Out-of-order arrival and ordered assembly.
- Identical duplicate and conflicting duplicate.
- Missing-page recovery.
- Commit-before-ack behavior.
- Legacy structured result still works for a legacy worker.
- Page result never invokes `OCRWorkerResult` validation.

### Review tests

- Page review returns matching PDF page number and Markdown.
- Correction preserves raw Markdown.
- Stale revision is rejected.
- Final verification requires every page resolved.
- Page review cannot call structured publish.

### Full verification commands

Run focused tests during each task, then:

```bash
cd Financial_analyze/backend
pytest -q
```

Run the project’s frontend build/test command, then perform one real 3-page smoke test before trying a
large financial report. Finally repeat the previously failing MBB report and compare worker/server
checksums and page counts.

## 13. Rollout sequence

### Phase 0 — Freeze and observe

- Preserve one failing payload and validation log as a regression fixture with sensitive content
  removed.
- Record current worker and server Git revisions.
- Do not change the row validator to accept missing identifiers.

### Phase 1 — Deploy server compatibility

- Deploy database changes, page contract, dual-format negotiation, storage, and review API/UI.
- Keep selecting legacy format for existing workers.
- Confirm the server accepts a test `page_markdown_v2` worker without requiring `bbox`.

### Phase 2 — Deploy one canary worker

- Update the reference worker and one WSL worker.
- Advertise only `page_markdown_v2` from the canary.
- Process a 3-page fixture, then a medium report.
- Compare sent pages, stored pages, checksums, merged markers, and review display.

### Phase 3 — Process the failing report

- Retry the MBB PDF.
- Require `receivedPages == expectedPages`.
- Inspect selected pages in the side-by-side review.
- Confirm that no `code or id` validation appears anywhere in the page path.

### Phase 4 — Broaden rollout

- Upgrade remaining workers.
- Monitor page conflicts, missing-page retries, database size, and assembly time.
- Keep legacy support for an agreed observation window.

### Phase 5 — Retire legacy ingestion separately

- Remove `structured_rows_v1` from worker negotiation only after no active worker needs it and existing
  row reviews remain readable.
- Legacy removal is a separate migration with separate tests; it is not part of the first fix.

## 14. Rollback

If the new flow fails after server deployment:

- Disable `page_markdown_v2` negotiation with a feature flag.
- Existing structured workers continue using the old handler.
- Keep new tables and nullable columns; an application rollback must not require destructive schema
  rollback.
- Retain stored page attempts for diagnosis but prevent incomplete reviews from being published.

If only the worker fails, roll back the canary worker revision while leaving the dual-format server in
place.

## 15. Definition of done

The work is complete only when all of the following are true:

- The worker sends exactly one page result for every PDF page after OCR completes.
- The server acknowledges each page only after durable storage.
- Missing pages are explicitly reported and can be resent.
- Identical retries do not duplicate data; conflicting retries do not overwrite data.
- The server merges pages deterministically in page order.
- The raw page contract has no `code`, `id`, `bbox`, or financial-row requirement.
- The review UI shows PDF page N and Markdown page N together.
- Reviewer corrections preserve the immutable raw OCR text.
- Page Markdown cannot be accidentally published as structured financial rows.
- Full worker/server tests pass, followed by a real canary report.
- Protocol and worker documentation match the deployed messages.

## 16. Recommended implementation order

Implement in this order to keep the system deployable at every step:

1. S1 page contract tests and models.
2. S2 persistence/migration.
3. S3 ingestion/assembly service.
4. S4 coordinator dual-format support.
5. S5 diagnostic logging.
6. S6 review API.
7. S7 review UI.
8. W1–W6 worker changes and fake-server tests.
9. S8 documentation/metrics.
10. Canary rollout and the MBB regression test.

Do not deploy the new worker before server Phase 1 is complete. The server should be backward
compatible first; the worker can then move forward without a synchronized outage.

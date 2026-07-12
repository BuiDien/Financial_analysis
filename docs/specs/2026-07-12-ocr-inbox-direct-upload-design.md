# OCR Inbox Direct Upload — Design Spec

**Date:** 2026-07-12  
**Status:** Implemented as a working prototype (2026-07-12)  
**Related:** `docs/specs/2026-07-12-ocr-human-verification-design.md`

## Purpose

Allow an internal user to upload a PDF directly to an OCR Inbox and send it to a paired OCR worker
without first creating a filing, financial statement, company, or tracker record. The PDF remains
untrusted inbox material until its OCR output has passed source-backed human review, received the required
financial labels, and been explicitly published.

This removes the current coupling in which `/api/sync/dispatch/{filing_id}` can dispatch only an existing
`Filing`, while preserving the established trust rule that OCR output cannot enter trusted financial data
before review.

## Understanding Summary

- Build a dedicated OCR Inbox for PDFs that are not yet filings or financial statements.
- Upload requires only a valid PDF; company, ticker, statement type, period, currency, and unit are optional
  until publication.
- OCR starts only through an explicit **Run OCR** action.
- The inbox supports small queued batches of approximately 20 PDFs and one active job per worker.
- Results enter the approved row-level, source-backed human review workflow.
- Verification may finish while the PDF remains unlabeled, but publication is blocked until labels exist.
- Publication promotes the verified item into financial records while retaining one source PDF and the full
  OCR/review audit history.

## Assumptions and Non-Goals

### Assumptions

- PDFs and review data stay within the existing local coordinator/worker boundary.
- Existing configured per-file upload limits remain in force.
- Inbox files remain stored until explicitly deleted.
- A failed attempt retries automatically once; a second failure requires manual retry.
- One internal user owns upload, review, labeling, publication, and cleanup.
- Median OCR time should remain at or below two minutes per PDF, with a five-minute 95th percentile target
  on the intended worker.
- The approved OCR review models and behavior are implemented or planned alongside this design.
- The original PDF is the durable source artifact and remains available after publication.

### Non-goals for the first version

- Hundreds of queued files, advanced scheduling, worker priorities, or bulk publication.
- Automatic dispatch immediately after upload.
- Automatic company/period/type labeling.
- Automatic overwrite or merge of existing financial statements.
- Cloud storage or external document sharing.
- Guaranteed interruption of already-running GPU work when a user requests cancellation.

## Chosen Approach

Create a separate persistent `OCRInboxItem` rather than using a nullable draft `Filing` or attaching a
temporary file directly to an in-memory sync job.

This keeps untrusted, unlabeled source material outside the filing domain; supports queues, retries,
restart recovery, retained PDFs, and review history; and represents the lifecycle honestly. A filing is
created only during explicit publication.

## Architecture and Lifecycle

```text
Upload PDF
   -> OCR Inbox item: uploaded
   -> explicit Run OCR
   -> queued -> dispatching -> processing
   -> worker result
   -> ready_for_review -> reviewing -> verified
   -> add company / type / period / currency / unit
   -> ready_to_publish
   -> explicit transactional Publish
   -> published -> linked Filing + financial records
```

### OCR inbox item

`OCRInboxItem` owns the PDF before publication. It stores:

- Original and sanitized filename
- Storage path, byte size, page count, and SHA-256 checksum
- Lifecycle state and timestamps
- Optional publication labels
- Current attempt and review references
- Published filing/statement references when applicable

Financial labels remain nullable until publication.

### OCR attempt

Every execution creates an append-only `OCRAttempt` linked to the inbox item. It records worker identity,
protocol and result-schema versions, state, progress, timing, errors, retry relationship, and successful
review reference. Retries never overwrite earlier attempt evidence.

### Review relationship

The approved `OCRReviewJob`, row records, and audit events link to the inbox item and successful attempt
instead of requiring a filing ID. Human verification is independent from financial labeling.

### Publication

Publication runs in one transaction:

1. Confirm that the selected review revision is verified.
2. Validate company/ticker, statement type, period, currency, unit, and collision rules.
3. Create the filing and downstream financial records.
4. Reference the inbox item's existing source PDF rather than copying it.
5. Link the filing, source inbox item, OCR attempt, review revision, and audit history.
6. Mark the inbox item published.

Publication is idempotent. Failure rolls back every created financial record and leaves the item verified
but unpublished.

## OCR Inbox Experience

The page contains a multi-PDF upload area and persistent item list. A single batch accepts roughly 20 PDFs,
subject to the configured per-file limit.

Each item shows filename, size, pages, upload time, state, progress, worker, attempt count, review progress,
optional labels, and failure details.

State-dependent actions:

- `uploaded`: Run OCR, label optionally, delete
- `queued`: cancel queue entry
- `processing`: view progress; request cancellation where supported
- `failed`: inspect attempt, retry manually, delete
- `ready_for_review` or `reviewing`: open source-backed review
- `verified`: add or edit labels
- `ready_to_publish`: publish
- `published`: open filing and audit history

“Run OCR” queues selected items. A durable server-side dispatcher assigns the next queued item to an idle
worker, never more than one active item per worker. Queue and review state survive browser and server
restarts.

## API Surface

Proposed inbox endpoints:

- `POST /api/ocr-inbox` — stream and validate one or more PDFs
- `GET /api/ocr-inbox` — list/filter persistent items
- `GET /api/ocr-inbox/{id}` — item, attempts, review summary, and labels
- `GET /api/ocr-inbox/{id}/file` — serve the local source PDF to the review viewer
- `POST /api/ocr-inbox/{id}/run` — queue an uploaded item
- `POST /api/ocr-inbox/{id}/retry` — create a manual retry attempt
- `POST /api/ocr-inbox/{id}/cancel` — cancel queued work or request active cancellation
- `PATCH /api/ocr-inbox/{id}/labels` — save publication metadata
- `POST /api/ocr-inbox/{id}/publish` — promote verified data transactionally
- `DELETE /api/ocr-inbox/{id}` — delete an unpublished item after confirmation

The existing filing dispatch endpoint may remain temporarily, but both filing and inbox dispatch must call
one internal binary-streaming implementation.

## Validation, Failure Handling, and Security

- Stream uploads to disk; never load an entire PDF into application memory.
- Enforce size, sanitized filename, PDF signature, readability, and page-count checks.
- Compute SHA-256 and warn when the same source already exists. Allow an intentional repeat only after
  confirmation.
- Create the database item only after safe file storage; remove the file if database creation fails.
- With no worker, retain the item in `queued` and dispatch when a worker becomes idle.
- On worker disconnect, fail the attempt and retry once automatically. Preserve the item and all diagnostics.
- On server restart, recover queued items and mark interrupted attempts failed before applying retry rules.
- Canceling a queued item removes only its queue entry, not the source PDF.
- A malformed, partial, oversized, or wrong-job result fails atomically and creates no review rows.
- Label changes before publication are allowed and audited.
- Published history is revised rather than overwritten silently.
- Deleting an unpublished item removes its attempts and reviews transactionally, then its source PDF.
- Published items cannot be removed through ordinary inbox deletion.
- Publication collisions stop for an explicit replace/merge/cancel decision; nothing is overwritten
  automatically.
- Local authentication protects files, inbox data, reviews, and mutation endpoints.
- Operational logs contain identifiers, state changes, timing, and error categories, not extracted values.

## Testing and Acceptance

### Upload and storage

- Accept valid single and multi-PDF uploads.
- Reject oversized, non-PDF, corrupt, and unreadable files.
- Verify streaming, checksum, page count, filename sanitization, duplicate warnings, and orphan cleanup.

### Queue and worker integration

- Dispatch only after Run OCR.
- Enforce one active item per worker and preserve queue order.
- Retain work when no worker is connected and recover the queue after restart.
- Verify disconnect, one automatic retry, and subsequent manual-retry behavior.
- Attach results to the correct inbox item and attempt without a filing ID.

### Review and labeling

- Open the original inbox PDF with page/bounding-box evidence.
- Complete review without financial labels.
- Block publication, not verification, while required labels are missing.
- Preserve decisions, labels, and attempt history across refresh and restart.

### Publication

- Create filing and downstream records atomically and idempotently.
- Reuse the existing source PDF.
- Link publication to inbox item, attempt, review revision, and audit trail.
- Block collisions and ordinary deletion of published items.

### Performance

- Keep the UI and API responsive with a queued batch of 20 PDFs.
- Stream uploads and worker transfer without whole-file application buffering.
- Retain the existing OCR duration targets on the intended hardware.

## Decision Log

| Decision | Alternatives considered | Reason |
|---|---|---|
| Promote after approval | Verification-only discard; permanent separate archive | Supports early OCR testing while still allowing reviewed data to become financial records. |
| Require labels only for publication | Require before review; require immediately after OCR | Keeps OCR and verification independent of classification. |
| Use a dedicated OCR Inbox | Sync-page button; both entry points | Gives unlabeled queued work a clear home and lifecycle. |
| Support batches of about 20 | One at a time; hundreds | Useful operationally without introducing large-scale scheduling complexity. |
| Retain until explicit deletion | 30-day cleanup; delete after failure | Prevents accidental loss of paused review work. |
| Reuse one source PDF after publication | Copy it; move and detach history | Avoids duplicate storage and preserves provenance. |
| Dispatch only on Run OCR | Automatic dispatch; selectable modes | Keeps processing deliberate and queue behavior predictable. |
| Retry automatically once | Manual only; retry indefinitely | Recovers transient failures without creating loops. |
| Use a separate persistent inbox model | Nullable draft Filing; temporary sync job | Preserves the trust boundary and supports durable unlabeled work. |
| Use append-only attempt records | Overwrite the current attempt | Preserves diagnostics and retry provenance. |
| Use a durable server queue | Browser-managed queue; in-memory queue only | Supports refresh and restart recovery. |
| Warn on duplicate checksum | Always reject; silently allow | Prevents accidents while allowing intentional reruns. |
| Never overwrite on publication collision | Automatic replace or merge | Protects existing trusted financial data. |

## Approved Outcome

An uploaded PDF first becomes a persistent, unlabeled OCR Inbox item—not a filing. The user explicitly
queues it, reviews the worker's complete source-backed result, and may verify it without labels. Only after
adding the required financial metadata and explicitly publishing does the system create trusted filing and
statement records, all linked to the original PDF and immutable OCR review history.

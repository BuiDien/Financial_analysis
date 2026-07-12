# Plan — OCR Inbox and Human Verification

**Status:** Implemented and automated checks pass 2026-07-12; live laptop/GPU acceptance remains

Implement a persistent pre-filing OCR Inbox and source-backed review boundary around the existing binary
WebSocket worker transport. Build the feature as a vertical slice: upload an unlabeled PDF, explicitly
queue it, persist the worker result, resolve every row against the PDF, add labels later, and publish the
verified revision transactionally.

## Scope

- In:
  - Persistent unlabeled PDF inbox with small-batch upload and local file retention.
  - Durable OCR attempts, queue/retry state, and reuse of the existing binary PDF streaming protocol.
  - Versioned worker-result validation with page, confidence, and normalized bounding boxes.
  - Persistent immutable raw rows, reviewer decisions, manual missing rows, and append-only audit events.
  - Split-screen PDF review, deferred financial labels, and idempotent publication into a `Filing`.
  - Backend, frontend, worker-protocol, restart-recovery, and end-to-end tests.
- Out:
  - Real PaddleOCR-VL page rendering and row extraction beyond adapting the current placeholder result to
    the versioned contract.
  - TT200 statement placement and reconciliation internals beyond calling their eventual publication
    boundary.
  - Automatic labeling, automatic post-upload dispatch, cloud storage, multi-user approval, advanced job
    scheduling, and batches larger than the agreed small-queue use case.
  - Authentication implementation; keep the current trusted-local-network deployment constraint explicit.

## Action Items

- [x] **Define the inbox and review contracts.** Add Pydantic request/response models and shared constants
  for inbox/job/row states, result `schemaVersion`, row field limits, normalized
  `bbox: {x,y,width,height}`, revision numbers, labels, and publication responses. Document the updated
  WebSocket frames in `docs/design/OCR_PROTOCOL.md` and `docs/design/SYNC_WORKER_GUIDE.md`; add contract
  tests for invalid schema versions, missing fields, page bounds, coordinates, field sizes, and oversized
  results.

- [x] **Add persistent OCR domain models.** Create `backend/app/models/ocr.py` with `OCRInboxItem`,
  `OCRAttempt`, `OCRReviewJob`, `OCRReviewRow`, and `OCRAuditEvent`; model append-only attempts/raw values,
  reviewed values, optimistic revisions, optional pre-publication labels, and the published filing link.
  Register the models in `backend/app/db.py` and test table creation, relationships, state defaults, and
  uniqueness/idempotency constraints using the in-memory database fixture.

- [x] **Implement streamed inbox upload and source-file APIs.** Add `backend/app/routes/ocr_inbox.py` and a
  focused storage service that streams up to the configured limit, sanitizes filenames, verifies the PDF
  signature/readability, records page count and SHA-256, warns on duplicates, cleans orphan files on
  rollback, lists/filters items, serves the local PDF, and safely deletes only unpublished items. Register
  the router in `backend/app/main.py`; test multi-file batches, corrupt/oversized PDFs, duplicate warnings,
  rollback cleanup, file serving, and deletion guards.

- [x] **Refactor dispatch into a durable inbox queue.** Extract the file-to-worker binary streaming logic
  from `backend/app/routes/sync.py` into a reusable coordinator/service path, add explicit run/cancel/retry
  endpoints, persist attempt and queue state, enforce one active item per worker, and dispatch waiting items
  when a worker becomes idle. On startup, recover queued items and convert interrupted attempts into failed
  attempts before applying the single automatic retry rule. Preserve the existing filing dispatch endpoint
  through the shared streaming path and extend `test_sync_dispatch.py` with queue, restart, disconnect,
  retry, cancellation, and no-worker cases.

- [x] **Version and persist worker results atomically.** Update `scripts/ocr_worker.py` to send the accepted
  result schema and make its placeholder row include valid page/confidence/bounding-box evidence until real
  extraction is implemented. Validate the whole result against its attempt/job before inserting any review
  data; reject partial, duplicate-completion, wrong-job, malformed, zero-row, and oversized results; mark
  the worker idle after either success or failure. Expand `tests/test_ocr_worker_protocol.py` and coordinator
  tests to prove serialization, complete-result acceptance, atomic rejection, and attempt linkage.

- [x] **Implement review and audit APIs.** Add endpoints/services to load a review, approve a raw row,
  correct reviewed fields, reject with a required reason, restore a decision, create a manually added row
  with required page/bbox evidence, update document metadata, and verify only when all rows and required
  review conditions are resolved. Require the caller's revision on mutations, return `409` on stale writes,
  and append an audit event for every change. Test immutability, decision counters, missing evidence,
  unresolved-row gates, stale edits, audit before/after values, and verification without financial labels.

- [x] **Build the OCR Inbox frontend.** Add `src/page-ocr-inbox.jsx`, register it in `src/app.jsx` and the
  navigation, and extend `src/api-client.jsx` with multipart upload, list/detail, run, retry, cancel, delete,
  label, review, and publish calls. Implement drag/drop batches, persistent status/progress polling,
  state-dependent actions, duplicate confirmation, storage/error display, and links to review or published
  filings; verify a 20-file list remains responsive and does not rely on browser-local job state.

- [x] **Build the source-backed review interface.** Add a review page/component that renders the inbox PDF
  on the left and rows on the right, navigates to the selected page, applies rotation-aware normalized bbox
  highlights, and supports approve/correct/reject/manual-add operations, filters, resolved counts, keyboard
  navigation, refresh/resume, and stale-update recovery. Keep “Verify” disabled until the backend reports
  all review gates satisfied; add frontend tests for row actions, highlight transforms, rotations, evidence
  selection, persistence, conflicts, and summary confirmation.

- [x] **Implement deferred labeling and transactional publication.** Accept company/ticker, filing type,
  reporting period, currency, and unit after verification; expose missing-label and collision errors; create
  a `Filing` and final accepted financial payload in one idempotent transaction; reuse the inbox PDF path;
  and link the filing to the inbox item, successful attempt, and review revision without copying or erasing
  raw evidence. Test missing labels, approved/corrected/rejected/manual row selection, repeated publish,
  rollback, existing-record collisions, post-publication delete protection, and audit linkage.

- [ ] **Run live end-to-end acceptance and update operating docs.** Automated WebSocket acceptance and docs
  are complete; still exercise upload → explicit queue → physical laptop worker
  transport → persisted result → approve/correct/reject/add → verify without labels → label → publish;
  repeat with no worker, worker disconnect, browser refresh, and server restart. Run backend pytest/ruff and
  the available frontend checks, record the known placeholder-OCR limitation, update `docs/PLAN.md`,
  `README.md`, backend README, and the two approved design specs with delivered status and operator steps.

## Validation

- Backend: from `Financial_analyze/backend`, run `.venv/bin/python -m pytest` and
  `.venv/bin/python -m ruff check app tests`.
- Frontend: run the repository's configured frontend test/build checks; manually confirm PDF highlighting
  at multiple zoom levels and on a rotated page.
- Worker: run `tests/test_ocr_worker_protocol.py`, then pair the actual worker and dispatch a known PDF from
  the OCR Inbox.
- Acceptance: prove an unlabeled PDF creates no `Filing`; prove verification still creates no `Filing`;
  prove only explicit labeled publication creates exactly one linked filing with final reviewed values.
- Safety: prove a malformed/partial result, failed attempt, stale review, publication collision, or restart
  cannot create partial trusted financial data.

## Open Questions

- No blocking questions. The exact real PaddleOCR-VL prompt/output parser and TT200 publication mapping are
  intentionally deferred to their existing Phase-2 plans.

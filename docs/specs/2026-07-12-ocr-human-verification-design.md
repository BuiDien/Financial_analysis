# OCR Human Verification Workflow — Design Spec

**Date:** 2026-07-12  
**Status:** Implemented as a working prototype (2026-07-12)  
**Scope:** Worker result receipt, source-backed human review, verification, and publication

## Purpose

Provide a trustworthy human review boundary between untrusted OCR output and the application's trusted
financial data. After an OCR worker finishes, the server must persist every result as an unverified draft.
An internal reviewer compares every row with its highlighted source in the original PDF, approves,
corrects, or rejects it, adds anything the worker missed, and only then publishes the reviewed data.

This workflow verifies what the worker returned and how it was reviewed. It does not claim that the
current OCR engine is accurate: `Financial_analyze/scripts/ocr_worker.py` still returns a placeholder row
until real page rendering and PaddleOCR-VL extraction are implemented.

## Understanding Summary

- The user is an internal financial analyst who needs reviewable, source-traceable OCR output.
- The worker sends all extracted rows to the server, including page, normalized bounding box, and
  confidence.
- Worker output is untrusted and remains isolated from financial statements and the tracker until review.
- Every row must be approved, corrected, or rejected. A reviewer can add rows the worker missed.
- The review UI displays the original PDF beside the extracted data and highlights the selected source row.
- A document becomes verified only after all rows and required document metadata are resolved.
- Only verified data can be published; raw OCR values and every review decision remain auditable.

## Assumptions and Non-Goals

### Assumptions

- PDFs and review data remain local to the coordinator and worker machines.
- A single internal reviewer may complete a review, although stale concurrent updates are still protected.
- The original PDF remains available at the filing's stored path.
- Bounding boxes use normalized displayed-page coordinates: `x`, `y`, `width`, and `height` are each in
  the range 0–1 and account for page rotation.
- Rejected rows require a reason and never enter published financial data.
- Manually added rows require a page and bounding box.
- Interrupted jobs do not create verified or partially published data.
- The worker/server protocol is the existing foundation, but its result contract will be versioned.

### Non-goals for the first version

- Automated OCR-accuracy benchmarking or model training.
- Automatic acceptance based only on confidence scores.
- Cloud document storage or external audit certification.
- Replacing the planned TT200 placement and reconciliation rules.
- Proving real OCR accuracy while the worker still returns placeholder results.

## Trust Boundary and Data Flow

```text
PDF filing
   -> dispatch to paired worker
   -> OCR result: schema version + rows + source locations
   -> server validates the complete result
   -> persistent unverified review job and immutable raw rows
   -> side-by-side human review
   -> approve / correct / reject / add missing rows
   -> verify completed review
   -> explicit, transactional publication
   -> trusted financial statements and tracker
```

The server accepts one complete, schema-versioned result for an OCR attempt. It validates the job and
filing identity, schema version, required fields, row count, field sizes, page bounds, numeric formats,
and normalized bounding boxes before creating a review. Invalid results fail atomically and cannot become
reviewable or publishable.

## Persistent Model

### OCR review job

An `OCRReviewJob` is linked to the filing, worker identity, attempt, and OCR/result-schema version. It
stores timestamps, progress/failure metadata, required document metadata, review counters, revision, and
publication identity.

Job states:

```text
processing -> ready_for_review -> reviewing -> verified -> published
     |                |              |
     +--------------> failed <-------+
```

`verified` and `published` are deliberately separate. Verification records that all review decisions are
complete; publication copies only the final accepted values into trusted financial records.

### OCR review row

One `OCRReviewRow` represents each worker result. Raw worker fields are immutable and include the row's
code/id, label, section hint, current and previous values, page, bounding box, confidence, and optional raw
text. Reviewed fields are stored separately so corrections never destroy the original evidence.

Row states are `pending`, `approved`, `corrected`, `rejected`, and `manually_added`. A manual row has no
worker-originated raw value but must include reviewer-entered data and source evidence.

### Audit event

Append-only audit events record approval, correction, rejection, restoration, manual addition, metadata
change, verification, reopening, and publication. Each event includes the review/job revision, actor,
timestamp, action, and before/after values where relevant.

## Review Experience

The review page uses a split layout. The left side renders the original PDF; the right side lists OCR rows.
Selecting a row opens its page, centers its normalized bounding box, and highlights the exact evidence.

Each pending row supports:

- **Approve:** accept the raw OCR fields.
- **Correct:** preserve the raw fields and save reviewed fields separately.
- **Reject:** exclude the row and require a reason such as duplicate, irrelevant content, or mistaken
  table/header detection.

“Add missing row” lets the reviewer draw a rectangle on the displayed PDF, enter the missing fields, and
save the result as `manually_added`. The page and selected rectangle are mandatory.

The UI shows resolved progress (for example, `42 of 57 rows`), filters for pending, corrected, rejected,
low-confidence, and manually added rows, plus efficient keyboard navigation. Confidence guides attention
but never automatically approves a row.

Verification remains disabled while any row is pending, any manual row lacks evidence, document metadata
(company, period, currency/unit) is unresolved, or server validation errors remain. A final summary shows
counts by decision type before the reviewer confirms verification. Publication requires a separate action.

## Verification and Publication Rules

- Every extracted row must have a terminal review decision.
- Required document metadata must be reviewed and complete.
- Rejected rows remain visible in the review and audit trail but are excluded from final data.
- Corrected rows publish reviewed fields, never the raw worker fields.
- Approved rows publish the accepted raw fields.
- Manually added rows publish only when they have complete source evidence.
- Publication is transactional and idempotent: either all final accepted rows publish once, or none do.
- A publication failure leaves the review `verified` and `unpublished`, allowing a safe retry.
- Reopening a verified or published review creates a new revision rather than rewriting prior evidence.

## Reliability, Security, and Edge Cases

- A disconnect before a complete result fails the attempt; diagnostics are preserved and one safe retry may
  create a new attempt.
- Zero rows is an incomplete/failed OCR outcome, never a successfully verified document.
- Likely duplicate results are preserved and flagged for reviewer resolution.
- Invalid page references or bounding boxes block verification until corrected or rejected.
- Page rotation is applied consistently when storing and displaying bounding boxes.
- Browser refreshes and server restarts reload review progress from persistent storage.
- Review updates include a revision number; stale writes return a conflict instead of overwriting newer work.
- A repeated OCR run creates a new review revision and never overwrites raw or published results.
- Result row counts, individual field lengths, and total message size are bounded server-side.
- Logs contain identifiers, state transitions, durations, and error categories, but no extracted financial
  text or values.
- PDF access remains within the local authenticated application boundary.

## Testing Strategy

### Worker protocol

- Send schema version, all rows, page, normalized bounding box, and confidence.
- Preserve coordinates through serialization.
- Send an error rather than a partial result on extraction failure.
- Respect the configured result-size contract.

### Server

- Persist valid results as unverified jobs with immutable raw rows.
- Reject malformed, incomplete, wrong-job, duplicate-completion, and oversized results atomically.
- Record audit events for every review action.
- Block verification until rows, evidence, and document metadata are resolved.
- Publish only accepted final values, atomically and idempotently.
- Preserve completed decisions across process restart.

### Review UI

- Open and highlight the correct PDF page and bounding box for a selected row.
- Align highlights on rotated pages.
- Persist decisions across refresh and resume.
- Exercise filters, progress, corrections, rejection reasons, manual row selection, and stale-edit conflicts.

### End-to-end acceptance

Dispatch a known PDF to the real worker, receive and persist all rows, approve several rows, correct one,
reject one, add one missed row with source evidence, verify, and publish. Confirm that only reviewed values
reach trusted financial data and that the raw OCR output and full decision history remain intact. Repeat a
review with a server restart to confirm safe resume.

Until real OCR replaces the placeholder `run_ocr()`, this scenario validates transport and the complete
review workflow, not extraction accuracy.

## Decision Log

| Decision | Alternatives considered | Reason |
|---|---|---|
| Use human source comparison | Golden benchmark first; reconciliation only | Directly supports the immediate need to inspect exactly what the worker returned. |
| Resolve every row | Whole-document approval; exceptions only | Prevents high-confidence errors from silently entering trusted data. |
| Show PDF plus bounding box | Result table only; worker-sent crop images | Provides strong evidence without duplicating image storage. |
| Allow manual missing rows | Rerun only; mark incomplete only | Makes the review complete while preserving explicit provenance. |
| Import only verified data | Immediate import then correction; report only | Keeps untrusted OCR isolated from trusted financial records. |
| Preserve immutable raw output | Keep final values only; temporary retention | Enables auditing and later measurement of OCR errors. |
| Use persistent job/row/event records | Single JSON document; browser-only state | Supports durable row-level review, queries, restart recovery, and a clean audit trail. |
| Normalize bounding-box coordinates | Pixel coordinates; image crops | Keeps highlights stable across zoom, resolution, and display size. |
| Separate verification from publication | Publish automatically on last decision | Provides a clear human confirmation and transactional trust boundary. |
| Accept results atomically | Persist rows incrementally | Prevents partial worker output from appearing reviewable. |
| Version reviews and protect stale writes | Overwrite existing review | Preserves evidence and prevents silent concurrent data loss. |

## Approved Outcome

The accepted design is a persistent, row-level, source-backed review workflow. OCR worker output is always
untrusted on arrival. It becomes trusted only through complete human resolution, explicit verification,
and a separate atomic publication step with immutable provenance.

# OCR Document Workflow — Design Spec

**Date:** 2026-06-24
**Status:** Approved (brainstorm), ready for implementation plan.
**Part of:** Distributed Financial Analysis System (`PLAN.md` Stage 3; `CORE_DESIGN.md`, `OCR_PROTOCOL.md`,
reconciliation spec Stage 4).

## Purpose
The **Core-side (Mac) workflow** that orchestrates the external OCR engine and turns its flat rows into
**3 clean, verified Vietnamese financial statements** (CĐKT / KQKD / LCTT) with correct TT200 Mã số line items.
This spec is the orchestration + structuring layer — **not** the OCR engine (which is external, see `OCR_PROTOCOL.md`).

## The trust boundary (the central principle)
**Laptop reads pixels → rows (UNTRUSTED). Mac structures + verifies (TRUST LIVES HERE).**
The OCR engine is a black box that reports what it sees per page, with a `section` *guess*. It does not
know TT200 logic, does not reconcile, does not authoritatively decide statements. All judgment —
splitting, placing, reconciling, analyzing — is Mac-side Core work. The two-machine boundary *is* the
trust boundary: the Mac never trusts the laptop; reconciliation (Stage 4) catches its errors.

## Lifecycle (machine-tagged)
```
1  Upload   (Mac)        PDF + user-entered period (e.g. "Q4 2024") + fiscal_year
2  Ingest   (Mac)        save file to uploads/, documents row, status=queued
3  Submit   (Mac→Laptop) POST PDF over port (OCR_PROTOCOL), get job_id, status=submitted
4  Triage   (Laptop)     PP-DocLayout finds table regions (skips Thuyết minh narrative)
5  Extract  (Laptop)     PaddleOCR-VL → rows {section,code,label,value,prev,page,confidence}
6  Return   (Laptop→Mac) Core polls /ocr/jobs/{id}; gets rows; status=extracting→placing
7  Split    (Mac)        place each row into CĐKT/KQKD/LCTT via TT200 dictionary
8  Store    (Mac)        write 3 statements + line_items, status=unverified
9  Reconcile(Mac)        Stage-4 engine: verify/repair/flag
10 Analyze  (Mac)        Hermes (Qwen) on verified data → vault (Stage 6)
```

## Decisions (locked in brainstorm 2026-06-24)
- **Statement split = TT200 dictionary, Core-derived** (does not trust the OCR's section guess).
- **KQKD-vs-LCTT disambiguation = fuzzy label-text match** (their Mã số ranges overlap).
- **Period = user enters at upload**, applied to all 3 statements; OCR does not read dates.
- **Unplaceable rows = quarantine + surface** (unmatched bucket in review UI; never dropped/force-placed).
- **OCR failure = mark failed + auto-retry once, then surface** the reason for manual re-trigger.

## §3 Statement split logic (the core gap, solved)
A **TT200 reference dictionary**: for every standard line, `{statement, code, canonical_label}`.
`place_row(row) -> "CDKT" | "KQKD" | "LCTT" | "unmatched"`:
1. **Balance sheet (CĐKT):** Mã số in the balance-sheet range (100–440) → unambiguous; place by code.
2. **Income vs Cash flow:** their codes overlap (both use 20/30/40/50/60/70). Disambiguate by
   **fuzzy-matching the row's label text** against the canonical label for that code in each statement:
   - `code 20 + label≈"lợi nhuận gộp"` → KQKD
   - `code 20 + label≈"lưu chuyển tiền thuần từ HĐKD"` → LCTT
3. **Fuzzy** (not exact) — OCR diacritics are noisy; use a normalized similarity threshold (strip diacritics,
   lowercase, ratio ≥ threshold).
4. The OCR's own `section` field is a **hint/tiebreaker only**; the dictionary is authoritative. If the
   dictionary is confident, it wins; if label match is below threshold for both, the OCR hint breaks the tie;
   if still ambiguous → `unmatched`.

## §4 Unplaceable rows — quarantine + surface
A row matching no dictionary entry (unknown code, garbled label, or sub-threshold on both KQKD/LCTT) →
the document's **`unmatched` bucket**, shown in the review UI. Matched rows still form their statements.
Nothing silently dropped, nothing force-placed. The user can hand-place or ignore. A **whole missing
statement** is caught downstream by the cross-statement reconciliation rule (Stage 4 `missing_data` flag).

## §5 Period assignment
User enters `period` (e.g. "Q4 2024") + `fiscal_year` at upload. Applied to **all 3 statements** from that
PDF. Per row: `value` = kỳ này (current column), `prev_value` = kỳ trước (prior column).

## §6 Failure handling
Document `status` machine: `queued → submitted → extracting → placing → done` | `failed`.
On OCR failure (laptop offline / poll timeout / no tables found / unusable rows): set `status=failed` with a
`fail_reason`, **auto-retry the submit once**; if it still fails, surface to the UI with the reason — user
re-triggers manually. Progress is pushed to the reader page (poll v1; WS later, per `API_CONTRACT.md`).

## Components (Mac-side, isolated units)
- `services/ocr_client.py` — submit/poll; stub vs real by `ocr_worker_url` (already in Stage-3 plan).
- `services/tt200.py` — the reference dictionary + pure `place_row(row) -> kind|"unmatched"` and
  `normalize_label(s)`. No ORM, no I/O — fully unit-testable.
- `services/ingest.py` — orchestrates upload → document row → submit/poll → split (via tt200) → store
  statements/line_items → trigger reconcile. Owns the status machine + retry-once.
- `models/core.py` additions to `Document`: `period`, `fiscal_year`, `fail_reason`, `unmatched` (JSON list of
  rows). (`status` already exists.)
- Route: `POST /api/documents` (multipart: file + period + fiscal_year) — extends Stage-3 ingest endpoint.

## Data flow (Mac internals, step 7–9)
```
rows[] from ocr_client.poll
  → for each row: kind = tt200.place_row(row)
       kind in {CDKT,KQKD,LCTT} → group by kind
       "unmatched"             → document.unmatched.append(row)
  → for each kind present: create Statement(kind, period, fiscal_year, unit="triệu đồng")
       + LineItem per row (code, label, value=curr, prev_value=prev, confidence, status="unverified")
  → reconcile_statement(db, each statement.id)   # Stage 4
```

## Testing
- `tt200.place_row` (pure): `270 → CDKT`; `20 + "lợi nhuận gộp" → KQKD`; `20 + "lưu chuyển tiền thuần" → LCTT`;
  `999 (unknown) → unmatched`; noisy-diacritic label still matches via `normalize_label`.
- Full workflow on the **stub** (canned VNM rows incl. planted Mã số 270): 3 statements stored with the
  correct split, line_items unverified, reconcile runs (270 repaired).
- Quarantine: inject an unknown-code row → lands in `document.unmatched`, not in any statement.
- Failure: stub returns an error → status=failed, one auto-retry, then surfaced with `fail_reason`.

## Out of scope (v1)
The OCR engine internals (external, `OCR_PROTOCOL.md`); WebSocket progress (poll v1); ingestion sources
beyond dashboard upload (watched folder / Slack — later); multi-period-per-PDF beyond curr/prev columns;
auto hand-placement UI for unmatched rows (surfaced as a bucket; manual UI is a later refinement).

## Dependencies
- Stage 2 Core booting (DB, get_db, document model). Stage 3 ingest endpoint + ocr_client/ocr_stub.
- Stage 4 reconciliation (`reconcile_statement`) for step 9 — the workflow stores `unverified` without it,
  but the end-to-end test asserts recon runs.
- The TT200 dictionary content (canonical code→label→statement) — built from the standard chart of accounts;
  start with the lines the VNM fixture exercises, expand over time.

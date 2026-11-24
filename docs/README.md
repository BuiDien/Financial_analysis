# Project Docs — Distributed Financial Analysis System

All planning & design docs for the project. Start with **PLAN.md** (the master build sequence).

## Index

### Top level
- [`PLAN.md`](PLAN.md) — **master build plan & sequence** (single source of truth)
- [`system_description.md`](system_description.md) — the original system spec
- [`../Financial_analyze/INTEGRATION.md`](../Financial_analyze/INTEGRATION.md) — running the app, frontend layout (Vite, `src/pages`, `src/ui`) and routes, backend layout (jobs, market data, Alembic), `/api/jobs` + `/api/alerts`

### `design/` — architecture & reference
- [`CORE_DESIGN.md`](design/CORE_DESIGN.md) — Core (business + data tier) internals
- [`API_CONTRACT.md`](design/API_CONTRACT.md) — Presentation ↔ Core seam (frozen v1)
- [`OCR_PROTOCOL.md`](design/OCR_PROTOCOL.md) — Core ↔ external OCR system (the port)
- [`SYNC_WORKER_GUIDE.md`](design/SYNC_WORKER_GUIDE.md) — how a worker laptop connects + talks to the Sync WebSocket (+ reference worker)
- [`OCR_WORKER_PAGE_MARKDOWN_V2_UPGRADE.md`](design/OCR_WORKER_PAGE_MARKDOWN_V2_UPGRADE.md) — current detailed WSL worker upgrade runbook
- [`OCR_WORKER_V1_UPGRADE.md`](design/OCR_WORKER_V1_UPGRADE.md) — legacy structured-row worker migration only
- [`HERMES_BRAIN.md`](design/HERMES_BRAIN.md) — the agentic brain (Hermes Agent + Qwen3 35B)
- [`SKILL_INTEGRATION.md`](design/SKILL_INTEGRATION.md) — borrowing financial skills/methodology
- [`DISCUSSION_BACKLOG.md`](design/DISCUSSION_BACKLOG.md) — parked topics + external-repo decisions

### `specs/` — feature design specs
- [`2026-06-23-reconciliation-engine-design.md`](specs/2026-06-23-reconciliation-engine-design.md)
- [`2026-06-23-vn-market-scanner-design.md`](specs/2026-06-23-vn-market-scanner-design.md)
- [`2026-06-24-ocr-document-workflow-design.md`](specs/2026-06-24-ocr-document-workflow-design.md)
- [`2026-07-12-ocr-human-verification-design.md`](specs/2026-07-12-ocr-human-verification-design.md)
- [`2026-07-12-ocr-inbox-direct-upload-design.md`](specs/2026-07-12-ocr-inbox-direct-upload-design.md)
- [`multi-company-watchlist.md`](specs/multi-company-watchlist.md)
- [`reader-recon-panel.md`](specs/reader-recon-panel.md) — deferred (recon UI)

### `plans/` — TDD implementation plans
- [`2026-06-23-reconciliation-engine.md`](plans/2026-06-23-reconciliation-engine.md) — 7 tasks
- [`2026-06-23-vn-market-scanner-tier1.md`](plans/2026-06-23-vn-market-scanner-tier1.md) — 8 tasks
- [`2026-06-24-ocr-document-workflow.md`](plans/2026-06-24-ocr-document-workflow.md) — 6 tasks (Stage 3)
- [`2026-07-12-ocr-inbox-human-verification.md`](plans/2026-07-12-ocr-inbox-human-verification.md) — implemented direct-upload and review slice
- [`2026-07-18-ocr-page-markdown-protocol.md`](plans/2026-07-18-ocr-page-markdown-protocol.md) — page-by-page Markdown worker/server migration plan

### `archive/` — superseded
- [`PLAN_DETAILED.md`](archive/PLAN_DETAILED.md) — old detailed plan (superseded by PLAN.md)

## Build order (from PLAN.md)

Stabilize/security -> canonical schema -> real OCR/TT200 -> reconciliation -> Hermes Agent ->
connected VN workflow -> research operations.

The scanner Tier 1 plan is implemented. The OCR and reconciliation plans remain useful, but must be
rebased onto the canonical Phase-1 schema before execution.

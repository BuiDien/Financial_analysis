# Project Docs — Distributed Financial Analysis System

All planning & design docs for the project. Start with **PLAN.md** (the master build sequence).

## Index

### Top level
- [`PLAN.md`](PLAN.md) — **master build plan & sequence** (single source of truth)
- [`system_description.md`](system_description.md) — the original system spec

### `design/` — architecture & reference
- [`CORE_DESIGN.md`](design/CORE_DESIGN.md) — Core (business + data tier) internals
- [`API_CONTRACT.md`](design/API_CONTRACT.md) — Presentation ↔ Core seam (frozen v1)
- [`OCR_PROTOCOL.md`](design/OCR_PROTOCOL.md) — Core ↔ external OCR system (the port)
- [`SYNC_WORKER_GUIDE.md`](design/SYNC_WORKER_GUIDE.md) — how a worker laptop connects + talks to the Sync WebSocket (+ reference worker)
- [`HERMES_BRAIN.md`](design/HERMES_BRAIN.md) — the agentic brain (Hermes Agent + Qwen3 35B)
- [`SKILL_INTEGRATION.md`](design/SKILL_INTEGRATION.md) — borrowing financial skills/methodology
- [`DISCUSSION_BACKLOG.md`](design/DISCUSSION_BACKLOG.md) — parked topics + external-repo decisions

### `specs/` — feature design specs
- [`2026-06-23-reconciliation-engine-design.md`](specs/2026-06-23-reconciliation-engine-design.md)
- [`2026-06-23-vn-market-scanner-design.md`](specs/2026-06-23-vn-market-scanner-design.md)
- [`2026-06-24-ocr-document-workflow-design.md`](specs/2026-06-24-ocr-document-workflow-design.md)
- [`multi-company-watchlist.md`](specs/multi-company-watchlist.md)
- [`reader-recon-panel.md`](specs/reader-recon-panel.md) — deferred (recon UI)

### `plans/` — TDD implementation plans
- [`2026-06-23-reconciliation-engine.md`](plans/2026-06-23-reconciliation-engine.md) — 7 tasks
- [`2026-06-23-vn-market-scanner-tier1.md`](plans/2026-06-23-vn-market-scanner-tier1.md) — 8 tasks
- [`2026-06-24-ocr-document-workflow.md`](plans/2026-06-24-ocr-document-workflow.md) — 6 tasks (Stage 3)

### `archive/` — superseded
- [`PLAN_DETAILED.md`](archive/PLAN_DETAILED.md) — old detailed plan (superseded by PLAN.md)

## Build order (from PLAN.md)
Stage 0 env → Stage 2 Core boots → Stage 3 doc pipeline + stub OCR → Stage 4 reconciliation
→ Stage 5 scanner tier1 → Stage 6 Hermes brain → Stage 7 connect → Stage 8 later.

Three implementation plans are ready (OCR workflow = Stage 3, reconciliation = Stage 4, scanner tier1 = Stage 5),
all blocked on **Stage 2 (Core boots) + the shared `tests/conftest.py` db fixture** existing first.

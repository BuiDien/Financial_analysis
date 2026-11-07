# Master Plan - Financial Analysis System

**Updated:** 2026-07-18
**Product direction:** VN-first financial analysis, with global macro news as context.
**Trust rule:** market feeds are researched/unverified; OCR figures are drafts; only reconciled
statement values may be used for investment analysis.

This document is the source of truth for current status and build order. Detailed implementation
steps remain in `docs/plans/`; design contracts remain in `docs/design/` and `docs/specs/`.

## Current State

| Area | Status | Reality |
|---|---|---|
| React workspace | Prototype working | Mostly browser-loaded JSX; several screens still use clearly labelled demo fixtures |
| FastAPI core | Working | Health, market, portfolio, filings, news, scanner, and sync routes exist |
| VN market data | Working | vnstock/VCI quotes, history, universe fetch, and deterministic signals |
| Scanner tier 1 | Working, operational limits | Tested and persisted; full guest-tier scan takes hours and must run explicitly |
| News/search | Working | CafeF, quality-filtered global feeds, SearXNG/Exa, and curated YouTube metadata |
| Daily digest | Collector working | Curated note is written; Hermes summarization/cron is not complete |
| Sync coordinator | Protocol working | Binary PDF transfer works; worker returns a placeholder row until real OCR parsing exists |
| OCR Inbox and human review | Working prototype | Unlabeled PDF upload, durable dispatch/retry, source-row review, audit, deferred labels, and guarded publication are implemented |
| Canonical document schema | Not built | Current `Filing` model is a prototype and conflicts with the target API contract |
| TT200 OCR structuring | Not built | No trusted line-item placement yet |
| Reconciliation | Not built | Existing plan/spec are ready, but no runtime gate exists yet |
| Hermes Agent | Partially integrated | UI and FastAPI use the real agent API; news MCP is registered. Gateway enablement, financial MCP tools, VN skills, and vault reports remain |
| Authentication | Not built | Backend must remain on a trusted machine/network until this is fixed |

## Decisions

- The product is **VN-first**: HOSE, HNX, and UPCOM companies and Vietnamese statements.
- Global news is included only for macro, commodities, geopolitics, and supply-chain context.
- The scanner is deterministic. An LLM never calculates scores or changes tier-1 rankings.
- Scanner data remains `verified=false`; it identifies candidates, not investment conclusions.
- `Filing` and ticker-based yfinance statements are prototype paths. The target model is
  `Document -> Statement -> LineItem -> ReconFlag/Correction`.
- Cloud AI is disabled by default. Analysis of unreconciled filings is disabled by default.
- Hermes Agent, not a raw Ollama completion, owns the future analysis loop, skills, MCP tools,
  citations, and vault memory.
- Agent-Reach/YouTube transcripts belong to selective deep dives, not the broad daily collector.

## Phase 0 - Stabilize the Prototype

Goal: make the current repository reproducible and honest before expanding it.

- [x] Pin `vnstock`, APScheduler, news, and YouTube runtime dependencies.
- [x] Clarify scanner output as `long_term`/`short_term` holding horizon, not short-selling.
- [x] Fix parenthesized negative-value PDF parsing.
- [x] Align the laptop worker with binary PDF chunk transfer.
- [x] Block article-reader access to local/private network targets.
- [x] Stream and validate PDF uploads; sanitize filenames and financial inputs.
- [x] Stop generated statement values for arbitrary tickers; label remaining UI fixtures as demo data.
- [x] Make live filing load/delete/open/analyze paths use the backend consistently.
- [x] Add digest text budgets, safer YouTube keyword matching, and processed-note overwrite protection.
- [x] Disable cloud AI, unverified filing AI, and the long-running scheduler by default.
- [ ] Add an API/session token and protect HTTP + WebSocket control surfaces.
- [ ] Restrict CORS and document the explicit LAN exposure mode for the OCR worker.
- [ ] Add migration tooling; `create_all()` is not a schema upgrade strategy.
- [ ] Add a frontend build/test harness so JSX does not depend on runtime CDN compilation.

**Exit:** fresh setup succeeds; backend tests/lint pass; no sensitive route is anonymously exposed;
demo and unverified data are unmistakable.

## Phase 1 - Establish the Trust Core

Goal: create one canonical data model before reconciliation or more UI wiring.

- [ ] Implement versioned SQLAlchemy/Alembic models for instruments, documents, statements,
  line items, recon flags, corrections, and alerts.
- [ ] Decide and document migration of the prototype `Filing` table. Do not maintain two statement models.
- [ ] Version the API contract: document IDs identify stored statements; ticker endpoints identify
  third-party market fundamentals and use a distinct route namespace.
- [ ] Add the shared in-memory database fixtures and CRUD/ownership tests.
- [ ] Seed VN instruments from the verified vnstock listing spike.

**Exit:** upload metadata can be persisted in the target schema; migrations upgrade an existing DB;
prototype and canonical endpoints cannot be confused.

## Phase 2 - OCR and TT200 Structuring

Goal: PDF to unverified, auditable statement rows.

- [ ] Run the Mac OCR worker (MiniCPM-OCR-1.0 on MLX + layout SDK) — see the 2026-11-05 design (`docs/superpowers/specs/2026-11-05-mac-ocr-worker-design.md`).
- [x] Define and validate the worker result schema; reject oversized/malformed result frames.
- [ ] Implement TT200 statement classification and `Ma so` placement — statement kind/periods/lines now extracted into a deduplicated company history (`docs/superpowers/specs/2026-11-06-company-history-design.md`); Mã số used when printed. Tick after the owner's acceptance run.
- [x] Persist confidence, page provenance, raw text, current value, and previous value for every review row.
- [ ] Add retries, timeouts, disconnect recovery, and durable job state outside process memory.

Use `docs/plans/2026-06-24-ocr-document-workflow.md`, updated to the Phase-1 schema before execution.

**Exit:** a real Vietnamese scanned statement becomes structured `unverified` line items with page
provenance; no placeholder OCR rows remain.

## Phase 3 - Reconciliation and Human Review

Goal: enforce the project's central trust promise.

- [x] Build the OCR Inbox's source-backed row review gate (approve, correct, reject, add missing,
  immutable raw result, and audit history).

- [ ] Execute `docs/plans/2026-06-23-reconciliation-engine.md` against the canonical schema.
- [ ] Verify totals, back-solve only unambiguous low-confidence errors, and flag ambiguity.
- [ ] Persist correction history and rerun affected rules after every manual edit.
- [ ] Build the reader reconciliation panel from `docs/specs/reader-recon-panel.md`.
- [ ] Add an enforced `verified` gate used by every analysis/export endpoint.

**Exit:** the planted error is repaired, ambiguous cases require review, and no analysis path accepts
unverified statement values.

## Phase 4 - Hermes Agent and Grounded Analysis

Goal: local agent analysis over verified data and cited research.

- [x] Route UI chat through the FastAPI adapter to the Hermes Agent API; do not call a raw model directly.
- [ ] Enable and run the Hermes gateway API with the chosen local model for acceptance testing.
- [ ] Implement/register financial MCP tools for statements, ratios, comparisons, prices, and vault I/O.
- [ ] Register news/search tools and VN analysis skills.
- [ ] Require provenance labels: `verified statement`, `unverified market feed`, or `researched URL`.
- [ ] Write statement notes and reports to Obsidian, then expose grounded chat through Hermes.
- [ ] Remove the Anthropic prototype path after local Hermes acceptance tests pass.

**Exit:** a reconciled VNM statement produces a cited vault report; chat answers use MCP data and no
LLM-authored arithmetic.

## Phase 5 - Connect the Product Workflow

Goal: one coherent VN investor workflow instead of independent prototype screens.

- [ ] Align Home, watchlists, portfolio, screener, statements, filings, and alerts around VN instruments.
- [ ] Replace all remaining hard-coded market/detail/dashboard facts with live or explicitly unavailable data.
- [ ] Move portfolio performance and alert indicators to persisted historical data.
- [ ] Add background scan jobs with progress, cancellation, fixed market-time scheduling, and one worker.
- [ ] Connect: scan candidate -> upload statement -> OCR -> reconcile -> Hermes deep dive -> review triggers.
- [ ] Add responsive and keyboard-accessible workflows plus browser tests.

**Exit:** the complete candidate-to-decision loop works without demo numbers or hidden local-only state.

## Phase 6 - News and Research Operations

Goal: improve decision signal without turning the daily digest into a content dump.

- [ ] Store publication timestamps and enforce a defined daily recency window where sources provide dates.
- [ ] Record per-source fetch failures, accepted/rejected counts, duplicates, and character budgets.
- [ ] Complete Hermes cron registration without maintaining an uncontrolled duplicate script.
- [ ] Add selected YouTube transcripts through Agent-Reach only when a deep-dive topic needs them.
- [ ] Add source-quality evaluation from user feedback; keep social feeds out of the core daily digest.

**Exit:** daily notes are bounded, current, observable, and summarized automatically with cited sources.

## Release Gates

Do not call the system production-ready until all are true:

- Authentication protects filings, portfolio, AI, scanner actions, and sync pairing.
- Database migrations and backup/restore are tested.
- OCR outputs retain source-page provenance.
- Reconciliation gates all statement analysis.
- No visible screen or export presents synthetic values as real.
- Full backend tests, lint, frontend tests, and critical browser workflows pass in CI.
- A fresh machine can install and run from documented commands only.

## Detailed References

- `docs/design/API_CONTRACT.md` - revise/version during Phase 1.
- `docs/design/OCR_PROTOCOL.md` and `SYNC_WORKER_GUIDE.md` - worker transport contract.
- `docs/specs/2026-06-23-reconciliation-engine-design.md` - reconciliation behavior.
- `docs/plans/2026-06-23-vn-market-scanner-tier1.md` - implemented scanner history.
- `docs/superpowers/specs/2026-07-07-daily-news-digest-design.md` - update during Phase 6.
- `docs/design/HERMES_BRAIN.md` - target agent architecture.

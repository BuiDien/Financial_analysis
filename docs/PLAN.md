# Master Build Plan — Distributed Financial Analysis System

**Single source of truth & build sequence.** Adapts the **Helix** prototype (`Financial analyze/`)
into the system in `system_description.md`. This file = WHAT to build, in WHAT order. Detailed designs
and task-level steps live in the companion docs below.

## Companion docs (all under `docs/`)
- `design/API_CONTRACT.md` — Presentation ↔ Core (frozen v1)
- `design/OCR_PROTOCOL.md` — Core ↔ external OCR system
- `design/CORE_DESIGN.md` — Core internals
- `design/HERMES_BRAIN.md` — the agentic brain (Hermes Agent + Qwen3 35B)
- `design/SKILL_INTEGRATION.md` — borrowing financial skills/methodology
- `design/DISCUSSION_BACKLOG.md` — parked topics + external-repo decisions
- `specs/` — feature design specs (reconciliation, vn-market-scanner, ocr-document-workflow,
  multi-company-watchlist, reader-recon-panel)
- `plans/` — TDD implementation plans (reconciliation-engine, vn-market-scanner-tier1,
  ocr-document-workflow)
- `README.md` — index of this folder

## Architecture
```
Mac (M2 Max, 64GB)                                          GPU laptop (RTX 4070, 8GB)
┌ PRESENTATION ── website + sidebar chat → HelixAPI         ┌ OCR system ──────────────┐
│ CORE (FastAPI) ── serve UI · ingest docs · SQLite · vault │ PP-DocLayout +           │
│   · MCP tool server · scanner                             │ PaddleOCR-VL             │
│   ├─ Ollama localhost ─► Hermes Agent = Qwen3 35B [brain] └──────────▲───────────────┘
│   └─ OCR port ───────────────────────────────────────────────────────┘ [stub now]
│ DATA: SQLite (8+ tables) + Obsidian vault + uploads/      │
└────────────────────────────────────────────────────────────┘
```

## Principles
- **Frontend-first, contract-driven** — build UI on mock; both tiers build to `API_CONTRACT.md`; connect = flip `HelixAPI` live.
- **Trust nothing unverified, never fabricate numbers** — OCR is a draft (reconcile before trust); scanner broad data is `verified=false`; scores are deterministic Python; LLM narrates, never calculates.
- **OCR is an external system over a port** — stub now, GPU later, zero core change.
- **Fully local** — data + vault stay on the user's machines.

## Locked decisions (quick reference)
- Mock company **VNM**, đơn vị **triệu đồng**, **TT200** Mã số. UI built in the **Claude design artifact**.
- Runtime = **Python 3.11** (venv exists, wheels fine — settles the 3.14/3.12 question).
- Core serves UI (FastAPI `StaticFiles`); OCR async + poll; OCR stub behind `ocr_client`.
- Brain = **Hermes Agent** + **Qwen3 35B** on the Mac; tools via **MCP server** in Core; skills in `~/.hermes/skills/`; chat via Hermes Agent API server. **deer-flow rejected.**
- Obsidian vault on Mac; **proactive** analysis on parse; **per-company first**.
- Watchlist = **flat list**, **manual-add-first**, **keep all history**, auto-refreshed company hub.
- Scanner = **tiered trust** funnel; deterministic scoring; thesis + horizon-range + triggers; scheduled + on-demand; user picks deep-dive; market data (vnstock) is **core**.
- Reconciliation = iterative solver, back-solve single low-conf suspect, flag ambiguous, human-in-the-loop notify.

---

# BUILD SEQUENCE

Ordered by dependency. Each stage ends with something runnable + tested. ✅ = done, ◧ = drafted/parked, ☐ = todo.

## Stage 0 — Repo & environment  ✅ (one cleanup task left)
- [x] Git repo initialized (7+ commits on `main`).
- [x] Backend venv on **Python 3.11**; deps installed; smoke tests exist (`tests/test_smoke.py`).
- [ ] 0.1 **Commit the in-flight sync work** (`routes/sync.py`, `sync_app.py`, `worker_example.py`,
  `page-sync.jsx`, `api-client.jsx`) — it's the Stage 3.2b coordinator, currently uncommitted.
- [ ] 0.2 **Trim `requirements.txt` to the architecture** — drop unused celery/redis/psycopg2/alembic/
  python-jose/passlib (fully-local, single-user, SQLite); add `vnstock`; keep yfinance only until
  `services/market.py` is swapped (Stage 2.3).
**Accept:** clean `git status`; `pip install -r requirements.txt` into a fresh venv succeeds; `pytest` green.

## Stage 1 — Presentation on mock  ✅ (test-ready)
Website runs on mock data; OCR tool VN-reskinned. Remaining VN reskin = artifact work, non-blocking.
Current mock = acceptable test baseline. See `design-source-of-truth` workflow (edits in the artifact).

## Stage 2 — Core schema inside the booting prototype  ☐  ← FOUNDATION
**Reality check (2026-07-01):** the "parked drafts" (`models/core.py` 8 tables, `seed.py`,
`scheduler.py`) **do not exist** — never committed. What DOES exist is the Helix prototype backend
(`app/main.py` boots, `/health` 200, models `filing/portfolio/user`, yfinance `services/market.py`,
working `routes/sync.py`). So Stage 2 = **grow the planned VN core inside the booting prototype**,
not resurrect drafts. Detail: `CORE_DESIGN.md`.
- [ ] 2.1 Write `models/core.py` (8-table VN schema: instruments, documents, statements, line_items, …
  per `CORE_DESIGN.md`) + `seed.py`; `python -m app.db init` creates the tables; seed populates instruments.
  Prototype tables (filings/portfolios/users) stay untouched until their routes are retired.
- [ ] 2.2 `GET /api/instruments` returns 200 with seeded rows (app already boots — new endpoint only).
- [ ] 2.3 **Validation spike A — vnstock** (shared with scanner): confirm market-wide data + tickers;
  swap `services/market.py` yfinance→vnstock (or add alongside, retire later). Write findings.
- [ ] 2.4 `tests/conftest.py` `db` fixture (in-memory SQLite) — the shared test harness for later plans.
- [ ] 2.5 Decide fate of prototype routes (`portfolio`, `filings`, `news`, `ai`): park or delete —
  don't let two schemas drift silently.
**Accept:** Core boots, health + instruments endpoints work, vnstock confirmed, pytest harness ready.

## Stage 3 — Document pipeline (stub OCR)  ◧→☐  ← PLAN READY
Upload → store → mock OCR → statements/line_items. Makes real data flow.
**Implementation plan written:** `docs/plans/2026-06-24-ocr-document-workflow.md` (TT200 placement +
ingest orchestration, TDD). Spec: `docs/specs/2026-06-24-ocr-document-workflow-design.md`.
Detail: `CORE_DESIGN.md`, `OCR_PROTOCOL.md`.
- [ ] 3.1 `POST /api/documents` (multipart: file + period + fiscal_year) → save file + `documents` row (queued).
- [ ] 3.2 `services/ocr_client.py` (`submit`/`poll` — stub vs live worker; interface unchanged regardless of transport) + `services/ocr_stub.py` (canned VNM rows incl. planted 270 error).
- [◧] 3.2b `routes/sync.py` — WebSocket coordinator: **already built** (pairing-code handshake, job
  dispatch, chunked-binary PDF, `page-sync` UI, `worker_example.py` reference worker, `sync_app.py`
  slim launcher). Remaining: commit it (Stage 0.1), then **rewire from prototype `Filing` to the
  Stage-2 `Document` model** and back `ocr_client` with it when a worker is paired; stub otherwise.
- [ ] 3.3 Orchestration (`services/ingest.py` + `services/tt200.py` per the impl plan): upload → submit → poll → place TT200 rows → write `statements` + `line_items` (unverified) → status machine + retry-once.
- [ ] 3.4 `GET /api/documents[/{id}]`, `GET /api/statements/{id}`.
- [ ] 3.5 Mount `StaticFiles` — Core serves the website.
**Accept:** upload a PDF → poll to done → `GET /api/statements/{id}` returns VNM rows; site served by Core.

## Stage 4 — Reconciliation engine  ☐  ← PLAN READY
Verify/repair/flag statement data. **Implementation plan written:** `docs/plans/2026-06-23-reconciliation-engine.md` (7 TDD tasks). Spec: `docs/specs/2026-06-23-reconciliation-engine-design.md`.
- [ ] Execute that plan (rules → solver → models reason col → ORM bridge → correction route).
- [ ] Wire into Stage 3.3 (run recon after extraction, before verified).
**Accept:** planted VNM fixture → 270 auto-repaired, 440 verified, ambiguous group flagged + notified; manual correction re-reconciles.

## Stage 5 — VN Market Scanner, tier 1 (broad scan)  ☐  ← PLAN READY
Market-wide deterministic screening → ranked candidates. **Implementation plan written:** `docs/plans/2026-06-23-vn-market-scanner-tier1.md` (8 TDD tasks, incl. vnstock spike). Spec: `docs/specs/2026-06-23-vn-market-scanner-design.md`.
- [ ] Execute that plan (universe → signals → score → runner → models → routes → scheduled job).
**Accept:** `POST /api/scan` ranks a universe deterministically; `GET /api/scan/latest` feeds the Screener page; all results `verified=false`.

## Stage 6 — Hermes brain (configure, don't build a loop)  ☐
Hermes Agent supplies loop/skills/MCP/memory/API. We add the MCP tool server + VN skills + wiring. Detail: `HERMES_BRAIN.md`, `SKILL_INTEGRATION.md`.
- [ ] 6.1 Install Hermes Agent; model = Qwen3 35B via Ollama; API server on.
- [ ] 6.2 MCP server `backend/app/mcp/` — tools: calc (`compute_ratios`, `compare_periods`, `growth_cagr`, `cross_statement_check`), data (`get_statement`, `get_line_items`, `get_prices`, `list_documents`), obsidian (`save_statement_note`, `save_report`, `query_vault`, `read_note`, `list_company_notes`, `rebuild_company_hub`).
- [ ] 6.3 Register MCP server in `~/.hermes/config.yaml`; confirm tools discovered.
- [ ] 6.4 VN skills → `~/.hermes/skills/financial/` (`doc-bao-cao-3-phan`, `phan-tich-chi-so`, `phat-hien-bat-thuong`) — borrowed methodology, report schema (kết luận/điểm số/điểm vào-ra/rủi ro/catalysts/checklist).
- [ ] 6.5 Obsidian `_Templates/` + company-hub generation.
- [ ] 6.6 Proactive hook: OCR parse done (+ recon clean) → ping Hermes API → vault note + report.
- [ ] 6.7 Website chat → Hermes Agent API server (`hermesComplete()`).
**Accept:** parse VNM → statement note + analysis report in vault; sidebar question → grounded answer via MCP tools; no LLM arithmetic.

## Stage 7 — Connect tiers (mock → live)  ☐
- [ ] Point `HelixAPI` at the Core; flip each page mock→live, verify unchanged render.
- [ ] End-to-end: upload → OCR stub → recon → analysis in vault → scanner ranks → answer in chat.
**Accept:** full loop runs against the real Core on stub OCR + live Hermes.

## Stage 8 — Later (unscheduled)
- **News/search layer** — MCP tools `get_latest_news` (RSS), `search_news` (SearXNG, Docker or native venv), `read_article` (Trafilatura); Camoufox reserved. Then enable the scanner's catalyst dimension. Detail in this file's history + `DISCUSSION_BACKLOG.md`.
- **Scanner tier 2 (deep-dive)** — user picks a candidate → OCR+reconcile+Hermes → thesis dossier (needs Stages 4+6).
- **Real GPU OCR worker** — PP-DocLayout + PaddleOCR-VL; set `ocr_worker_url`. Spike: OCR quality on real statements.
- **Reconciliation review panel** (UI) — `specs/reader-recon-panel.md`.
- **Cross-company analysis**, **MCP wrapper reuse**, **Slack bot + alerts**, **auth** (single-user minimal).
- **deer-flow** — rejected as brain; possible future standalone deep-research engine only (`DISCUSSION_BACKLOG.md`).

---

## Critical path
```
Stage 0 ✅ → Stage 2 (core schema) ─┬─ Stage 3 (docs+OCR stub; 3.2b half-done) → Stage 4 (recon) ─┐
                                    └─ Stage 5 (scanner tier1)                                     ├─ Stage 7 (connect)
                                       Stage 6 (Hermes brain) ────────────────────────────────────┘
Stage 1 (presentation/mock) runs in parallel (artifact work).  Stage 8 = after deps.
```
- **Stages 3, 4 and 5 plans are already written** but all need **Stage 2 (core schema + conftest.py db fixture)** first. Stage 4 also needs Stage 3 for end-to-end (its unit tests run on seeded fixtures alone).
- **Next action = Stage 0.1 (commit sync work) then Stage 2.** Everything is queued behind the 8-table schema.

## Open items (settle at build time)
- vnstock market-wide data feasibility (Stage 2.3 / scanner Task 0 spike) — gates fundamentals/valuation dimensions.
- Exact `compute_ratios` ratio list (VN: thanh khoản, đòn bẩy, sinh lời, hiệu quả).
- ~~Python 3.14 wheel coverage~~ — settled: venv is Python 3.11.
- ~~Report period source~~ — settled: user enters period + fiscal_year at upload (locked in the ocr-document-workflow spec).
- Sync protocol docstrings drift: `routes/sync.py` header vs `worker_example.py` pairing flow — reconcile when committing (Stage 0.1).

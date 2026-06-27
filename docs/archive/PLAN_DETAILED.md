> **SUPERSEDED (2026-06-22).** `PLAN.md` is now the master plan (reflects OCR-as-external-system,
> Hermes agentic brain + Obsidian vault, deferred reconciliation). This file kept for the granular
> task wording but is **out of date** on architecture — follow `PLAN.md`.

---

# Distributed Financial Analysis System — Detailed Build Plan

Granular, task-by-task expansion of `PLAN.md`. Each task: **what**, **where** (file path), **acceptance**.
Adapts the **Helix** prototype (`Financial analyze/`) into the system in `system_description.md`.

## Conventions
- Repo root: `/Users/dien/Work/Project/Financial_analyze`
- Frontend: `Financial analyze/src/*.jsx` + `Financial Analyze.html` — **comes from a Claude design artifact; re-export wipes local edits.** UI changes belong in the artifact, not here.
- Backend: `Financial analyze/backend/` — hand-written, safe from export churn.
- Mock company: **VNM (Vinamilk)**, đơn vị **triệu đồng**. Codes follow **TT200** chart of accounts (Mã số).
- Status legend: `[ ]` todo · `[~]` in progress · `[x]` done.

## Locked decisions
- Adapt Helix as shell. Mac-core first; **OCR stubbed/mock** (real RTX 4070 worker = Phase 4, DEFERRED).
- Analysis LLM = local **Ollama/Hermes** behind a clean interface.
- First ship = Claude-designed website on mock data.
- UI reskin happens **in the design artifact**.

---

# Phase 0 — Design on mock data + VN reskin

### 0.1 Run the design  `[x]`
- Serve `Financial analyze/` via `python3 -m http.server 5173`; open `Financial Analyze.html`.
- **Accept:** site renders, sidebar nav works, chip = MOCK DATA.

### 0.2 Walk every page  `[x]`
- **Accept:** know which pages work vs broken. (Found: filings/reader/ocr-tool unrouted; `window.claude` missing.)

### 0.3 Structural fixes (must live in artifact)  `[x] locally / [ ] in artifact`
- `app.jsx` — add `filings: PageFilings` to page registry.
- `sidebar.jsx` — add "Documents" nav section → `setPage('filings')`.
- `api-client.jsx` — add `window.claude` mock shim (canned reply offline).
- **Accept:** Filings/Reader reachable from sidebar; AI chat returns canned reply with no backend, no ReferenceError.

### 0.4 Vietnamese reskin (in artifact)
- [x] **step 1 — OCR tool** (`ocr-tool.jsx`): VNM data triệu đồng, Mã số column, PP-DocLayout/PaddleOCR-VL branding, VN scan log, recon fixture (Mã số 270 misread 52.800.000 vs 52.000.000 @ 73%).
- [ ] **step 2 — Reader** (`page-reader.jsx`): `DEFAULT_TRACKER` rows → VN metrics + Mã số + unit "triệu đ"; `DOCUMENT_SECTIONS` body text → VN BCTC sections (CĐKT/KQKD/LCTT); cover page → VNM.
- [ ] **step 3 — Statements page** (`page-statements.jsx`): VN chart-of-accounts layout (Mã số rows, kỳ này/kỳ trước, đơn vị triệu đ).
- [ ] **step 4 — Filings list** (`page-filings.jsx`): `SAMPLE_FILINGS` → VNM BCTC quý/năm, status in VN, sizes/pages realistic.
- [ ] **step 5 — Market data** (`#market-data` JSON in `Financial Analyze.html`): indices → VN-Index/HNX-Index/UPCOM/VN30/gold(SJC)/USD-VND; watchlist → HOSE/HNX tickers (VNM/FPT/HPG/VCB/VIC/MWG…); portfolio + sectors → VND.
- [ ] **step 6 — Header ticker tape + labels** map to VN symbols; currency formatting → VND/triệu.
- **Accept:** every page reads as a Vietnamese product; no US tickers/`$` left; OCR→review→import flow works end-to-end on VNM mock.

### 0.5 Re-export & verify  `[ ]`
- Export from artifact with 0.3+0.4 baked in; drop into `Financial analyze/`.
- **Accept:** fresh export already contains fixes; no manual re-apply; checklist in `[[design-source-of-truth]]` all green.

---

# Phase 1 — Foundation: FastAPI core + SQLite + VN prices

Goal: real backend spine; dashboard shows live VN prices; chip flips to API LIVE.

### 1.1 Trim & retarget deps  `[ ]`
- File: `backend/requirements.txt`. Remove Postgres/Redis/Celery/Anthropic (defer). Add `vnstock`. Keep fastapi, uvicorn, sqlalchemy, pydantic(-settings), pandas, yfinance, pdfplumber, httpx, pytest, ruff.
- **Accept:** `pip install -r requirements.txt` succeeds in a fresh venv.

### 1.2 Settings  `[ ]`
- File: `backend/app/config.py`. Keep SQLite default `sqlite:///./helix.db`. Add: `ocr_worker_url`, `ocr_shared_secret`, `ollama_url`, `ollama_model`, `recon_tolerance` (default 0.01). Drop unused cloud keys.
- **Accept:** settings load from `.env`; defaults sane with no `.env`.

### 1.3 Target SQLite schema (8 tables)  `[ ]`
- Replace `backend/app/models/{user,portfolio,filing}.py` with target models. Tables + key columns:
  - `instruments(id, symbol, market[HOSE|HNX|UPCOM|GOLD|US], name, currency)`
  - `prices(id, instrument_id→, date, open, high, low, close, volume)`
  - `documents(id, path, kind, status[queued|triaging|extracting|done|failed], uploaded_at, instrument_id?)`
  - `statements(id, document_id→, kind[CDKT|KQKD|LCTT], period, unit, fiscal_year)`
  - `line_items(id, statement_id→, code(Mã số), label, value, prev_value, confidence, status[unverified|verified|repaired|flagged], page)`
  - `recon_flags(id, statement_id→, rule, expected, got, member_ids(json), status[open|resolved])`
  - `corrections(id, line_item_id→, old_value, new_value, source[backsolve|manual], created_at)`
  - `alerts(id, kind, condition(json), channel[dashboard|slack], enabled)`
- File: `backend/app/db.py` `init_db()` imports new models.
- **Accept:** `python -m app.db init` creates `helix.db` with 8 tables; `sqlite3 helix.db .tables` lists them.

### 1.4 Seed script  `[ ]`
- File: `backend/app/seed.py`. Insert a handful of instruments (VNM, FPT, HPG, VCB, VIC, gold SJC, USD/VND).
- **Accept:** `python -m app.seed` populates `instruments`; idempotent.

### 1.5 Market service — vnstock + yfinance  `[ ]`
- File: `backend/app/services/market.py`. Functions `get_quote(symbol)`, `get_history(symbol, period)`, `get_indices()`. Route VN symbols → vnstock; gold/US → yfinance. Normalize to one shape: `{symbol, price, change_pct, volume, ...}`. Optional in-memory TTL cache (no Redis).
- **Accept:** `get_quote("VNM")` returns a live price; `get_indices()` returns VN-Index etc.

### 1.6 Validation spike A — vnstock  `[ ]`
- Standalone script/notebook: confirm vnstock returns the intended tickers + history without auth/rate issues.
- **Accept:** documented sample output for VNM/FPT/HPG + VN-Index; note any quirks.

### 1.7 Market routes  `[ ]`
- File: `backend/app/routes/market.py`. `GET /api/quote/{symbol}`, `GET /api/history/{symbol}?period=`, `GET /api/indices`, `GET /api/instruments`. On fetch, upsert into `prices`.
- **Accept:** Swagger `/docs` shows them; curl returns JSON; rows land in `prices`.

### 1.8 Price scheduler  `[ ]`
- APScheduler job (in `main.py` startup) refreshing tracked instruments on an interval.
- **Accept:** prices auto-update; logged each run; survives if a fetch fails.

### 1.9 Wire dashboard to live data  `[ ]`
- In artifact: `page-dashboard.jsx` / `page-detail.jsx` call `HelixAPI.indices()/quote()/history()` when `HelixAPI.live`.
- **Accept:** with backend up, chip = API LIVE and dashboard shows live VN numbers; backend down → mock, no errors.

---

# Phase 2 — Document pipeline with STUB OCR

Goal: upload→store→display path end-to-end; OCR faked but behind the real contract.

### 2.1 Upload endpoint  `[ ]`
- File: `backend/app/routes/documents.py`. `POST /api/documents` (multipart) → save to `uploads/`, insert `documents` row (status=queued). Return `{id}`.
- **Accept:** uploading a PDF creates a file + row; bad type rejected.

### 2.2 OCR worker contract (interface)  `[ ]`
- File: `backend/app/services/ocr_client.py`. Define `submit(doc_path) -> job_id`, `poll(job_id) -> {status, result}`. Document result schema = list of line_items `{code, label, value, prev_value, confidence, page, section}`.
- **Accept:** interface documented; importable; no real network yet.

### 2.3 Stub OCR worker  `[ ]`
- File: `backend/app/services/ocr_stub.py` (impl of the contract). Returns canned VNM line items **including the planted 270 error + low-conf rows** (mirror `ocr-tool.jsx` fixture).
- **Accept:** `submit()`+`poll()` return the fixture after a short fake delay.

### 2.4 Orchestration  `[ ]`
- On upload → submit to OCR client (stub) → on done, write `statements` + `line_items` (status=unverified). Background task; document.status transitions.
- **Accept:** after upload, `line_items` populated; status reaches `done`.

### 2.5 WebSocket progress  `[ ]`
- File: `backend/app/routes/ws.py`. `/ws` pushes `{doc_id, status}` transitions (queued→triaging→extracting→done).
- **Accept:** a WS client sees ordered progress events during processing.

### 2.6 Wire reader/filings to backend  `[ ]`
- In artifact: filings upload → `HelixAPI.uploadFiling`; reader OCR Parse → backend rows; progress from WS.
- **Accept:** upload a PDF in UI → live progress → review table shows backend (stub) rows; Import persists.

---

# Phase 3 — Reconciliation engine (the differentiator)

Goal: untrusted numbers → verified / repaired / flagged via accounting identities.

### 3.1 Identity rules (TT200)  `[ ]`
- File: `backend/app/services/recon_rules.py`. Encode: `270 = 100 + 200`; `440 = 300 + 400`; `270 = 440`; subtotal roll-ups; income `20 = 10 − GiáVốn`; cross-period sanity. Tolerance from settings (rounding + unit).
- **Accept:** rules unit-tested against the VNM fixture; planted 270 error detected.

### 3.2 Recon pass  `[ ]`
- File: `backend/app/services/recon.py`. For a statement → evaluate each rule over `line_items` → group results balanced/failed.
- **Accept:** returns failing groups with expected vs got.

### 3.3 Back-solve repair  `[ ]`
- If a failed group has exactly one low-confidence member → compute from others, update value, status=`repaired`, write `corrections(source=backsolve)`.
- **Accept:** Mã số 270 auto-corrected 52.800.000 → 52.000.000; correction logged.

### 3.4 Flag ambiguous  `[ ]`
- If ≥2 uncertain members in a failed group → write `recon_flags(status=open)`, status=`flagged`.
- **Accept:** the low-conf cashflow group is flagged, not silently changed.

### 3.5 Auto-trigger after extraction  `[ ]`
- Hook recon into Phase 2.4 before anything is marked verified.
- **Accept:** fresh upload ends with statuses across verified/repaired/flagged correctly.

### 3.6 Correction workflow  `[ ]`
- File: `backend/app/routes/line_items.py`. `PUT /api/line_items/{id}` → write correction(source=manual) → re-run recon → update flags → push WS.
- **Accept:** editing a flagged value clears/updates the flag and re-reconciles.

### 3.7 Wire review panel  `[ ]`
- In artifact: reader review panel shows real `recon_flags`; edits hit `PUT /api/line_items`.
- **Accept:** human-in-the-loop closes: flag → edit → re-recon → resolved, live.

---

# Phase 4 — Real GPU OCR worker  — DEFERRED
Stay on stub. When picked up: PP-DocLayout triage → crop → PaddleOCR-VL (vLLM) on RTX 4070; async queue; hostname + shared-secret + multipart; point `ocr_client` at it. Stub stays as fallback. Zero core changes (contract unchanged). Validation spike: OCR quality on real VN statements.

---

# Phase 5 — Local analysis LLM

### 5.1 Ollama + Hermes  `[ ]`
- Install Ollama, pull Hermes on the GPU machine (time-shares GPU with OCR).
- **Accept:** `ollama run hermes3` responds.

### 5.2 AnalysisLLM interface  `[ ]`
- File: `backend/app/services/ai.py`. Methods: `summary(statement)`, `compare(periods)`, `anomalies(statement)`. Ollama impl behind interface.
- **Accept:** swap impl without touching routes.

### 5.3 Verified-only gate  `[ ]`
- Analysis accepts only statements with all line_items verified/repaired (no open flags).
- **Accept:** flagged statement rejected with clear message.

### 5.4 Routes + wire  `[ ]`
- `POST /api/ai/chat`, `POST /api/statements/{id}/analyze`. Artifact AI panel → local LLM. Remove Anthropic.
- **Accept:** local model summarizes a verified VNM statement; nothing leaves the network.

---

# Phase 6 — Slack bot, alerts, polish

### 6.1 Alerts engine  `[ ]`
- `alerts` rules: price thresholds, recon-flag raised, job done. Evaluate on price refresh / pipeline events.
- **Accept:** crossing a threshold produces an alert record.

### 6.2 Slack bot  `[ ]`
- Commands (upload, query, status) + push alerts. Shared-secret/token config.
- **Accept:** a Slack command triggers an action; an alert pushes to Slack.

### 6.3 Alerts page wired  `[ ]`
- Artifact alerts page → real `alerts` CRUD.
- **Accept:** create/edit/delete alert from UI persists.

### 6.4 Hardening  `[ ]`
- Error states, OCR retry, corrections audit view, settings page real, CORS to host.
- **Accept:** failure paths are graceful; audit trail visible.

---

## Critical path
```
0 → 1 ─┬─ 2 → 3 → [4 deferred]
       ├─ 5
       └─ 6
```
Phases 2/3 start once 1 gives the spine. 5/6 are independent tails. UI tasks (0.3/0.4/1.9/2.6/3.7/5.4/6.3) all happen in the artifact.

## Validation spikes (do early)
- **A** vnstock returns intended tickers (Task 1.6).
- **B** OCR quality on real statements (Phase 4, when un-deferred).

## Open questions
- Full TT200 identity set — need real VNM statement samples to enumerate all roll-ups.
- vnstock rate limits / stability.
- Hermes model size vs 8GB VRAM alongside OCR (time-share confirmed; verify load times).

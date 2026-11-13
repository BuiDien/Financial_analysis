# Screener VN Scope & Quality-of-Earnings Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the screener Vietnam-aware: hide warned/controlled/restricted/suspended stocks, scope out all financials and pick exchanges, and add quality-of-earnings rules (profit growth every year, receivable/inventory days, gross-margin trend, share dilution, foreign room).

**Architecture:** All new fundamentals come from data already fetched (`ratio_summary` fiscal-year rows: `gross_margin`, `day_sale_outstanding`, `days_inventory_outstanding`, `number_of_shares_mkt_cap`). Status flag and foreign room come from ONE batched `Trading().price_board(symbols)` call per 400 tickers (~4 s for the whole market) at the start of each prices pass, stored in a new `ticker_metrics.board` JSON column. The provider maps VCI codes to a canonical `flag`, so rules stay provider-agnostic.

**Tech Stack:** FastAPI, SQLAlchemy/SQLite, vnstock 4.0.4 (VCI), React 18 UMD + Babel (no build).

**Spec:** the chat proposal of 2026-11-11 (items 1–4 + "later" items), with the rulings below.

## Global Constraints

- vnstock stays pinned at 4.0.4: no upgrade, no `.venv` rebuild.
- Never `git commit`/`git push`; the user commits. "Commit" steps below are replaced by listing files for the user.
- Fully local runtime; no new network services.
- Tests: `.venv/bin/python -m pytest -q` from `Financial_analyze/backend`; full suite must stay green.
- Saved strategies must keep validating: new params need defaults; no rule id is removed.
- Thresholds in percent; stored ratios are fractions.

## Rulings

- `market_cap` rule kept (off in every starter; removing it would break saved strategies that use it) — cost if wrong: one redundant row in the rules panel.
- P/E-vs-industry minimum peers already exists (`MIN_INDUSTRY_PE = 5`, falls back to universe median) — no task.
- Flagged = VCI `trading_status_code` in {31, 32, 33} → `warning`; 34 → `control`; 70, 71, 73 → `restricted`; 110 → `suspended`. Codes 20, 120 (exceptional price limit), 130 and unknown codes → not flagged. Missing board data → not flagged (never drop a ticker for missing status).
- "Non-bank financials" = industry name containing `tài chính`, `bảo hiểm` or `quỹ đầu tư` (case-folded): brokers, insurers, funds.
- Zero means missing for `gross_margin` and `shares`; a 0 for receivable/inventory days is real (cash-sale and service firms).

## Review Focus

1. A saved strategy with the old scope `{banks:"exclude"}` must still validate and gain `flagged:"exclude"`, `exchanges:[]` by default — test in Task 3.
2. Board fetch failing (network/rate limit) must not abort the price pass — test in Task 2.
3. A ticker with no board row is evaluated normally (not hidden) — test in Task 3.
4. `share_dilution` / `gross_margin_change` with fewer than N+1 fiscal years → missing, not fail — test in Task 3.
5. Old DB without `board` column upgrades in place on startup — test in Task 2.

---

### Task 1: Provider — fiscal-year ratio fields and board

**Files:** Modify `backend/app/screener/provider.py`, `backend/app/screener/vnstock_provider.py`; Test `backend/tests/test_screener_vnstock_provider.py`.

**Interfaces — Produces:**
- `YEAR_KEYS` += `"gross_margin", "receivable_days", "inventory_days", "shares"`.
- `vnstock_provider.map_ratio_years(rows, current_year) -> dict[str, dict]`: per completed fiscal year (Q5 rows, year < current_year): `{"gross_margin": frac|None, "receivable_days": float|None, "inventory_days": float|None, "shares": float|None}`.
- `fetch_financials` merges these into each `years[y]`.
- `vnstock_provider.map_board(rows) -> dict[str, {"flag": str|None, "status": str|None, "foreign_room": float|None}]`; `foreign_room` = `current_room / total_room` (fraction), None if total_room missing/≤0.
- `MarketDataProvider.fetch_board(symbols: list[str]) -> dict[str, dict]`; `VnstockProvider.fetch_board` chunks 400 symbols per limited call; `FixtureProvider(board=...)` returns the given dict (default `{}`), records `("board", "")`.

- [ ] Tests: `test_ratio_years_vnm_fields` (FY2025 gross_margin ≈ 0.4118, receivable_days ≈ 27.23, inventory_days ≈ 61.53, shares == 2089955445; no 2026 key); `test_ratio_years_zero_gross_margin_and_shares_missing`; `test_map_board_flags` (codes 20→None, 33→"warning", 34→"control", 71→"restricted", 110→"suspended", 130→None; foreign_room 424422640/924006547); `test_map_board_flat_columns` (tuple keys `('listing','symbol')` and `('match','current_room')` as produced by `_rows` on the MultiIndex frame are handled).
- [ ] Run → fail; implement; run → pass.

### Task 2: Storage, migration, refresh

**Files:** Modify `backend/app/models/screener.py`, `backend/app/db.py`, `backend/app/screener/store.py`, `backend/app/screener/refresh.py`; Test `backend/tests/test_screener_store.py`, `backend/tests/test_screener_refresh.py`.

**Interfaces:**
- `TickerMetrics.board = Column(JSON, nullable=True)`.
- `db._upgrade_screener_schema()` adds `board JSON` to an existing `ticker_metrics`; called in `init_db` before `create_all`.
- `store.save_board(db, board: dict[str, dict], at: datetime) -> None` writes `{**entry, "as_of": iso}` to known symbols only.
- `load_views` adds `"board": r.board`.
- `RefreshManager._run("prices")`: before the per-ticker loop, `provider.fetch_board(symbols)` → `save_board`; `RateLimited` propagates, any other exception sets `_last_error = "board: …"` and the pass continues.

- [ ] Tests: `test_save_board_and_view`; `test_upgrade_adds_board_column` (create old table without the column, run upgrade, column present, idempotent second run); `test_prices_pass_saves_board`; `test_board_failure_does_not_stop_prices`.
- [ ] Run → fail; implement; run → pass.

### Task 3: Rules and scope

**Files:** Modify `backend/app/screener/rules.py`, `backend/app/screener/evaluate.py`; Test `backend/tests/test_screener_rules.py`, `backend/tests/test_screener_evaluate.py`.

**Interfaces:**
- Scope params: `banks` options `any | exclude | no_financials | only`; `exchanges` list ⊆ {HOSE, HNX, UPCOM} (default `[]` = all); `flagged` `exclude | include` (default `exclude`).
- `rules.in_scope(cfg, view) -> bool` (single source; `_eval_scope` and `evaluate._in_scope` use it). `no_financials` drops banks and non-bank financials.
- New good rules (id, label, kind, applies_to, params):
  - `profit_growth_min` "Net profit growth at least X% in every one of the last N years", at_least, all, x 0 [-50,200] %, n 3 [1,3] years. Value = min yearly growth %; any prior-year profit ≤ 0 → fail.
  - `receivable_days_change` "Receivable days up at most X days over N years", at_most, nonbank, x 15 [0,365] days, n 3 [1,3].
  - `inventory_days_change` "Inventory days up at most X days over N years", at_most, nonbank, x 30 [0,365] days, n 3 [1,3].
  - `gross_margin_change` "Gross margin change at least X pts over N years", at_least, nonbank, x -2 [-50,50] pts, n 3 [1,3]. Value in percentage points.
  - `share_dilution` "Share count growth at most X% a year over N years", at_most, all, x 5 [0,100] %, n 3 [1,3]. CAGR.
  - `foreign_room` "Foreign room left at least X% of the foreign cap", at_least, all, x 5 [0,100] %.
- Change rules use years `[-n-1]` vs `[-1]` of sorted completed years; either end missing → missing.
- Each evaluate row gains `"flag": view.board.flag or None`.

- [ ] Tests: old scope validates with new defaults; `in_scope` for flagged/exchanges/no_financials (DSC-like "Dịch vụ tài chính", "Bảo hiểm phi nhân thọ"); missing board → in scope; each new rule pass/fail/missing incl. fewer years; row carries flag.
- [ ] Run → fail; implement; run → pass.

### Task 4: Frontend and contract

**Files:** Modify `src/page-screener.jsx`, `Financial Analyze.html` (cache-bust), `docs/design/API_CONTRACT.md`.

- Scope bar: segmented `Any | Exclude banks | Exclude financials | Banks only`; exchange chips HOSE/HNX/UPCOM (none selected = all); toggle "Hide warned / controlled stocks".
- `SCR_COLS` entries for the 6 new rules (`pp` format for gross margin points, `days` for day changes); `ScrNumInput` step 1 for days/pts.
- Row: small badge after the symbol when `flag` is set (Warning / Control / Restricted / Suspended).
- Bank-rule visibility: hidden for `exclude` and `no_financials`.

- [ ] Verify by evaluating via API with the new params and reloading the page (user check: no Babel locally).

### Task 5: Data, calibration, starters

**Files:** Modify `backend/app/screener/strategies.py`; Test `backend/tests/test_screener_strategies.py`.

- [ ] Restart backend (user), trigger prices + financials refresh; wait for the board and ≥200 most-traded financials.
- [ ] Measure distributions of the new rules among stocks ≥ 3 bn/day; pick thresholds that remove the worst ~10–20%.
- [ ] Starters: Quality/Deep value/Dividend scope `banks: "no_financials"`; all starters `flagged: "exclude"`; Quality adds `profit_growth_min`, `receivable_days_change`, `share_dilution`; Deep value adds `share_dilution`. Update saved strategies via `PUT`.
- [ ] Full suite green; report pass lists before/after.

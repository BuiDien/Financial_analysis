# Screener Rules Funnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blended-score VN scanner with a rule-based funnel. It runs over the whole market, filters to good companies, and highlights the oversold ones. Rules are grouped into user-editable strategies and ranked by strength. Each ticker gets a dated notes log on the asset detail page.

**Architecture:** A new backend package `backend/app/screener/` splits refresh from evaluation. *Refresh* pulls raw numbers through a swappable `MarketDataProvider` into a `ticker_metrics` table; it is slow and network-bound and runs in a background thread. *Evaluate* applies a strategy's rules to the stored numbers. It is pure Python with no network access, so every rule edit re-ranks immediately. One shared rate limiter guards every vnstock call in the app. The frontend screener page is rewritten around strategies, a rules checklist, funnel counts and the ranked table. The detail page gains a notes card.

**Tech Stack:** FastAPI, SQLAlchemy (SQLite), pytest, vnstock 4.0.4 (VCI), React 18 UMD + Babel standalone (no build step).

**Spec:** `docs/superpowers/specs/2026-11-10-screener-rules-funnel-design.md`. Read it before starting any task. This plan argues from it.

## Global Constraints

- **Never run `git commit` or `git push`** (project CLAUDE.md). Every "Stop" step means: list the changed files and stop. The user commits.
- vnstock stays pinned at `4.0.4`. Do not upgrade, reinstall, or add Python dependencies. Do not recreate `.venv`.
- Backend tests run from `Financial_analyze/backend` with `.venv/bin/python -m pytest -q`. The baseline is 503 passed and 1 skipped. The suite must stay green; Task 8 deletes old scanner tests, so the count drops there.
- Tests never touch the network. Only `screener/vnstock_provider.py` (Task 12) and `services/market.py` import vnstock.
- Units. The provider stores ratios as **fractions** (ROE 0.18, dividend yield 0.05, NPL 0.012). Rule thresholds are entered and displayed in **percent** (15 = 15%); `rules.py` converts. Money is in VND. VCI closes are in **nghìn đồng**, so traded value in VND = `close × 1000 × volume`.
- Vietnam time is `Asia/Ho_Chi_Minh`. A trading day is Monday–Friday (public holidays are ignored in v1). Trading-day close is 15:00.
- The broad-scan data stays labelled `UNVERIFIED` in the UI.
- Frontend: there is no build step. Pages are `<script type="text/babel">` tags in `Financial_analyze/Financial Analyze.html`, exported via `window.X`. Bump the `?v=` query on every changed script tag to `20261110-screener`. Use the existing CSS classes (`page`, `page-header`, `card`, `card-header`, `card-title`, `card-body`, `table`, `btn`, `btn-primary`, `num`, `right`) and the Lucian elements already in `src/lucian-ui.jsx`. Do not edit `Financial Analyze (standalone).html`.
- JSX syntax check (used by the frontend tasks): download `https://unpkg.com/@babel/standalone@7.29.0/babel.min.js` once to the session scratchpad, then run `node -e "const B=require('<scratch>/babel.min.js');const fs=require('fs');for(const f of process.argv.slice(1))B.transform(fs.readFileSync(f,'utf8'),{presets:['react']});console.log('ok')" <files>`. The expected output is `ok`.
- `docs/design/API_CONTRACT.md` documents every endpoint added, changed or removed.

## Review Focus

1. **Out-of-range or malformed rule numbers** (negative threshold, N above the data depth, a missing field, an unknown rule id) sent to evaluate or to a strategy save. Expect a 422 with a readable `detail`, not a 500, and not a silent clamp. Tests: `test_validate_rejects_n_above_depth` (Task 4) and `test_evaluate_rejects_bad_rules_422` (Task 8).
2. **A fresh install, with an empty `ticker_metrics` table and no strategies yet.** Starter strategies get seeded, evaluate returns zero counts with `freshness` nulls, and the page shows a "no data yet, refresh" state. Tests: `test_evaluate_empty_store` (Task 8) and `test_seed_is_idempotent` (Task 6).
3. **The backend is stopped halfway through the 5-hour financial refresh.** On the next start it resumes and skips tickers it already did. Test: `test_financial_refresh_resumes` (Task 7).
4. **A detail-page chart opened during the 80-minute refresh.** The interactive call jumps the queue, and a vnstock `sys.exit()` quota hit does not kill the backend. Tests: `test_interactive_jumps_queue` and `test_systemexit_becomes_ratelimited` (Task 1).
5. **A ticker whose own price fetch keeps failing** while the rest of the market refreshes. Its old RSI must not light up ⚡. Prices more than 3 trading days old count as missing oversold input. Test: `test_stale_prices_never_highlight` (Task 5).

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/app/screener/__init__.py` | empty |
| `backend/app/screener/ratelimit.py` | shared thread-safe vnstock limiter with priority and SystemExit handling |
| `backend/app/screener/metrics.py` | pure price metrics: `sma`, `rsi`, `compute_price_metrics` |
| `backend/app/screener/provider.py` | `MarketDataProvider` protocol, canonical types, `FixtureProvider`, `get_provider()` |
| `backend/app/screener/store.py` | read/write `ticker_metrics` and `screener_state`; builds rule views |
| `backend/app/screener/rules.py` | rule catalog, validation, per-rule evaluation and score |
| `backend/app/screener/evaluate.py` | funnel over all views: scope, pass/fail/skip, strength, ordering |
| `backend/app/screener/strategies.py` | starter strategies, seeding, CRUD |
| `backend/app/screener/refresh.py` | staleness, the `RefreshManager` background thread, priority, resume, progress |
| `backend/app/screener/vnstock_provider.py` | the real vnstock-backed provider (Task 12) |
| `backend/app/models/screener.py` | `TickerMetrics`, `Strategy`, `ScreenerState`, `TickerNote` |
| `backend/app/routes/screener.py` | `/api/screener/*` endpoints |
| `backend/app/routes/notes.py` | `/api/notes/*` endpoints |
| `src/page-screener.jsx` | rewritten screener page |
| `src/page-detail.jsx` | adds the notes card |
| `src/api-client.jsx` | client methods for the endpoints above |

Removed in Task 8: `backend/app/scanner/` (whole package), `backend/app/routes/scan.py`, `backend/app/models/scan.py`, `backend/app/services/scheduler.py`, `market.screen()` and `GET /api/screener` in `routes/market.py`, the `enable_scheduler` setting, and the tests `test_runner.py`, `test_score.py`, `test_signals.py`, `test_universe.py`, `test_scan_route.py`, `test_scheduled_scan.py` and `scanner_fixtures.py`. The old `scan_runs` and `scan_results` tables stay in existing DB files untouched; nothing reads them.

---

### Task 1: Shared vnstock rate limiter

**Files:**
- Create: `backend/app/screener/__init__.py`, `backend/app/screener/ratelimit.py`
- Modify: `backend/app/services/market.py` (`_vn_history`, ~line 100)
- Test: `backend/tests/test_screener_ratelimit.py`

**Interfaces:**
- Produces:
  - `class RateLimited(RuntimeError)`
  - `class RateLimiter(interval_s: float = 3.1, cooldown_s: float = 61.0, clock=time.monotonic, sleep=time.sleep)` with `call(fn, *args, priority: str = "interactive", **kwargs)`, where `priority` is `"interactive"` or `"background"`
  - module singleton `vnstock_limiter = RateLimiter()`

**Behaviour:**
- Calls are spaced at least `interval_s` apart across all threads.
- A background call waits while any interactive call is waiting or running.
- If `fn` raises `SystemExit`, or an exception whose message contains "limit" or "rate" (case-insensitive), the limiter sleeps `cooldown_s` and retries once. If the retry fails the same way, it raises `RateLimited`.
- Other exceptions propagate unchanged.

- [ ] **Step 1: Write the failing tests.** Use a fake clock and a fake sleep (a list that records durations and advances the fake clock):
  - `test_spaces_calls`: two calls; recorded sleeps contain one value ≈ `3.1`.
  - `test_systemexit_becomes_ratelimited`: `fn` always raises `SystemExit("quota")`. Expect `RateLimited`, `fn` called exactly 2 times, and `61.0` in the sleeps.
  - `test_rate_error_retries_once_then_succeeds`: the first call raises `Exception("Rate limit exceeded")`, the second returns `5`. Expect the result to be `5`.
  - `test_other_errors_propagate`: `ValueError("bad symbol")` propagates after 1 call.
  - `test_interactive_jumps_queue`: use real threads with `interval_s=0.05`. One background call holds the limiter (its fn waits on an `Event`). Then a background call B2 and an interactive call I1 both queue. Release the event. The recorded execution order is `[B1, I1, B2]`.
- [ ] **Step 2: Run** `.venv/bin/python -m pytest tests/test_screener_ratelimit.py -q`. Expect a FAIL (module missing).
- [ ] **Step 3: Implement `RateLimiter`.** Use a `threading.Condition`, an `interactive_waiting` counter, and `_last_call` tracked with `clock()`. Sleep outside the lock.
- [ ] **Step 4: Route `market._vn_history` through the limiter.** Wrap the vnstock call as `vnstock_limiter.call(lambda: VnQuote(symbol).history(**kw), priority="interactive")` and map `RateLimited` to the existing `VnRateLimited`. Existing tests that stub `_vn_history` must keep passing.
- [ ] **Step 5: Run** the new test file and then the full suite. Expect all green.
- [ ] **Step 6: Stop.** List the changed files.

### Task 2: Price metrics

**Files:**
- Create: `backend/app/screener/metrics.py`
- Test: `backend/tests/test_screener_metrics.py`

**Interfaces:**
- Produces:
  - `sma(values: list[float], n: int) -> float | None`
  - `rsi(closes: list[float], n: int = 14) -> float | None` (Wilder; copy the algorithm from `scanner/universe.py`, which Task 8 deletes)
  - `compute_price_metrics(bars: list[dict]) -> dict | None`
- `bars` items are `{"date": "YYYY-MM-DD", "close": float, "volume": float}`, oldest first. The function returns `None` for an empty list. Otherwise it returns:
  `{"last_date": str, "close": float, "rsi14": float | None, "closes_tail": list[float] (last 21 closes), "vol_multiple": float | None, "avg_value_bn": float | None}`
- `vol_multiple` is the last volume divided by the mean of the 20 volumes before it. It is `None` with fewer than 21 bars or a zero mean.
- `avg_value_bn` is the mean over the last 20 bars of `close × 1000 × volume / 1e9`. It is `None` with fewer than 20 bars.

- [ ] **Step 1: Write the failing tests:**
  - `test_rsi_matches_known_series`: use the 15-close series from the old `tests/test_universe.py` RSI test and copy its expected value.
  - `test_rsi_all_gains_is_100`.
  - `test_vol_multiple`: 20 bars with volume 100, then the last bar with volume 250. Expect `vol_multiple == 2.5`.
  - `test_avg_value_bn`: 20 bars with close 50.0 and volume 200_000. Expect `avg_value_bn == 10.0`.
  - `test_closes_tail_len`: 30 bars give a tail of 21 closes.
  - `test_short_history_nones`: 5 bars give `rsi14`, `vol_multiple` and `avg_value_bn` all `None`, with `close` set.
  - `test_empty_is_none`.
- [ ] **Step 2: Run** and expect a FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** and expect a PASS.
- [ ] **Step 5: Stop.** List the changed files.

### Task 3: Storage models, provider seam, fixture provider

**Files:**
- Create: `backend/app/models/screener.py`, `backend/app/screener/provider.py`, `backend/app/screener/store.py`
- Modify: `backend/app/db.py` (`init_db` model import list), `backend/tests/conftest.py` (model imports), `backend/app/config.py`
- Test: `backend/tests/test_screener_store.py`

**Interfaces:**
- Consumes: `metrics.compute_price_metrics`
- Produces the models:
  - `TickerMetrics`, table `ticker_metrics`: `symbol` String PK, `exchange` String, `industry` String nullable, `is_bank` Boolean, `financials` JSON nullable, `financials_at` DateTime(tz) nullable, `prices` JSON nullable (the `compute_price_metrics` dict), `prices_at` DateTime(tz) nullable, `last_error` String nullable.
  - `Strategy`, table `screener_strategies`: `id` Integer PK, `name` String unique not null, `starter_key` String nullable (set for shipped starters), `rules` JSON, `updated_at` DateTime(tz).
  - `ScreenerState`, table `screener_state`: `key` String PK, `value` JSON.
  - `TickerNote`, table `ticker_notes`: `id` Integer PK, `symbol` String indexed, `body` Text, `created_at` DateTime(tz), `updated_at` DateTime(tz) nullable (set only when the note is edited).
- Produces in `provider.py`:
  - `UniverseEntry = TypedDict(symbol: str, exchange: str, industry: str | None, is_bank: bool)`
  - `Financials = TypedDict(latest: dict[str, float | None], years: dict[str, dict[str, float | None]])`
  - `LATEST_KEYS = ("pe", "pb", "dividend_yield", "market_cap", "debt_to_equity", "npl", "nim", "cost_to_income", "car")`
  - `YEAR_KEYS = ("roe", "revenue", "net_profit", "operating_cash_flow")`. `years` is keyed by the year as a string and holds **completed** fiscal years only.
  - `class MarketDataProvider(Protocol)`: `name: str`; `list_universe() -> list[UniverseEntry]`; `fetch_financials(entry: UniverseEntry) -> Financials`; `fetch_prices(symbol: str, days: int = 120) -> list[dict]` (bars as in Task 2)
  - `class FixtureProvider(MarketDataProvider)`, built as `FixtureProvider(universe: list[UniverseEntry] | None = None, financials: dict | None = None, prices: dict | None = None, fail: set[str] = frozenset())`. Symbols in `fail` raise `RuntimeError` from both fetches. Calls are recorded in `self.calls: list[tuple[str, str]]`. With no arguments it serves a small built-in sample: 6 tickers covering a non-bank good company, an oversold good company, a weak company, a bank, a loss-maker, and one with no financials.
  - `get_provider() -> MarketDataProvider`, chosen by the setting `screener_provider` (`"fixture"` → `FixtureProvider()`; `"vnstock"` is added in Task 12)
- Produces in `store.py`:
  - `upsert_universe(db, entries: list[UniverseEntry]) -> None`
  - `save_financials(db, symbol: str, fin: Financials, at: datetime) -> None`
  - `save_prices(db, symbol: str, bars: list[dict], at: datetime) -> None` (stores `compute_price_metrics(bars)`)
  - `save_error(db, symbol: str, msg: str) -> None`
  - `get_state(db, key: str, default=None)` and `set_state(db, key: str, value) -> None`
  - `load_views(db, now: datetime) -> list[dict]`. Each view is `{"symbol", "exchange", "industry", "is_bank", "financials": Financials | None, "prices": dict | None, "prices_stale": bool}`. `prices_stale` is true when `prices.last_date` is more than 3 trading days (Mon–Fri) before `now`'s Vietnam date.
- Config: add `screener_provider: str = "fixture"` and `enable_screener_refresh: bool = True`. In `conftest.py`, set `os.environ.setdefault("ENABLE_SCREENER_REFRESH", "false")` next to the existing env defaults.

- [ ] **Step 1: Write the failing tests:**
  - `test_upsert_universe_updates_industry`.
  - `test_save_prices_stores_metrics`.
  - `test_load_views_marks_stale_prices`: last bar date 2026-11-03 (Tue) with `now` = 2026-11-10 Tue 20:00 VN gives stale. Last bar 2026-11-07 (Fri) with `now` = 2026-11-10 gives not stale.
  - `test_fixture_provider_fail_set`.
  - `test_state_roundtrip`.
- [ ] **Step 2: Run** and expect a FAIL.
- [ ] **Step 3: Implement** the models, provider types, `FixtureProvider`, `get_provider` and `store`. Register the models in `init_db` and `conftest.py`.
- [ ] **Step 4: Run** the file and then the full suite. Expect a PASS.
- [ ] **Step 5: Stop.** List the changed files.

### Task 4: Rule catalog and per-rule evaluation

**Files:**
- Create: `backend/app/screener/rules.py`
- Test: `backend/tests/test_screener_rules.py`

**Interfaces:**
- Consumes: view dicts from `store.load_views`
- Produces:
  - `CATALOG: dict[str, dict]`. Each entry is `{"id", "stage": "good" | "oversold" | "scope", "label", "kind": "at_least" | "at_most" | "scope", "applies_to": "all" | "bank" | "nonbank", "params": {name: {"default", "min", "max", "unit"}}}`, exposed verbatim by `GET /api/screener/rules`.
  - `class RuleConfigError(ValueError)`
  - `validate_rules(rules: list[dict]) -> list[dict]` normalises by filling missing params from defaults. It raises `RuleConfigError` naming the rule and param on an unknown id, an out-of-range param, or a duplicate id.
  - `evaluate_rule(cfg: dict, view: dict, ctx: dict) -> dict` returns `{"status": "pass" | "fail" | "missing", "value": float | None, "score": float | None}`. `value` is in display units (percent for percent rules). `score` is 0–100 and is set only on `pass`.
  - `ctx = {"industry_pe": dict[str, float], "universe_pe": float | None}`

**Rule cfg shape:** `{"id": str, "on": bool, ...params}`. Scope cfg: `{"id": "scope", "on": true, "banks": "any" | "exclude" | "only", "industries": list[str]}` (empty list = all industries).

**Catalog** (id → kind, applies_to, params with default and range; values from spec §4):

| id | kind | applies_to | params (default, min–max) | value computed as |
|---|---|---|---|---|
| `roe_years` | at_least | all | `x` 15 (0–100, %), `n` 3 (1–8) | the weakest ROE of the last `n` completed years, ×100 |
| `profit_growth` | at_least | all | `x` 10 (−50–200, %), `n` 3 (1–3) | CAGR of `net_profit`, ×100 |
| `revenue_growth` | at_least | nonbank | `x` 10 (−50–200, %), `n` 3 (1–3) | CAGR of `revenue`, ×100 |
| `debt_to_equity` | at_most | nonbank | `x` 1.0 (0–10) | `latest.debt_to_equity` |
| `ocf_to_profit` | at_least | nonbank | `x` 80 (0–300, %), `n` 3 (1–4) | Σocf / Σnet_profit over `n` years, ×100 |
| `pe_vs_industry` | at_most | all | `x` 100 (10–300, %) | `pe / industry median × 100` |
| `pb` | at_most | all | `x` 2.0 (0.1–20) | `latest.pb` |
| `dividend_yield` | at_least | all | `x` 5 (0–30, %) | `latest.dividend_yield × 100` |
| `traded_value` | at_least | all | `x` 5 (0–1000, bn VND) | `prices.avg_value_bn` |
| `market_cap` | at_least | all | `x` 1000 (0–2,000,000, bn VND) | `latest.market_cap / 1e9` |
| `bank_npl` | at_most | bank | `x` 2 (0–20, %) | `latest.npl × 100` |
| `bank_nim` | at_least | bank | `x` 3 (0–15, %) | `latest.nim × 100` |
| `bank_cir` | at_most | bank | `x` 40 (0–100, %) | `latest.cost_to_income × 100` |
| `bank_car` | at_least | bank | `x` 8 (0–30, %) | `latest.car × 100` |
| `rsi` | at_most (oversold) | all | `x` 30 (1–99) | `prices.rsi14` |
| `price_drop` | oversold | all | `x` 10 (0–80, %), `d` 5 (1–20) | `(close / closes_tail[-1-d] − 1) × 100`; passes when `value ≤ −x` |
| `volume_spike` | at_least (oversold) | all | `x` 1.5 (1–20) | `prices.vol_multiple` |
| `scope` | scope | all | `banks` "any", `industries` [] | — |

`rsi` passes on `value < x`; every other `at_most` rule passes on `value ≤ x`, and every `at_least` rule on `value ≥ x`.

**Status rules (spec §4 "Rule definitions" and "Missing data"):**
- A rule whose `applies_to` does not match the ticker (bank rule on a non-bank, or the reverse) evaluates to `missing`.
- A `None` value evaluates to `missing`. So does a `0` in `pe`, `pb` or `market_cap`, which VCI uses for "not reported".
- A `0` elsewhere is a real value. `dividend_yield` 0 fails a dividend rule; `debt_to_equity` 0 passes a debt rule.
- `pe ≤ 0` (loss-maker) **fails** `pe_vs_industry`.
- In growth rules, a start value `≤ 0` **fails**. Fewer than `n + 1` years available is `missing`.
- In `ocf_to_profit`, a Σnet_profit `≤ 0` **fails**. Fewer than `n` years is `missing`.
- `roe_years` with fewer than `n` years is `missing`.
- The industry median for `pe_vs_industry` is `ctx.industry_pe[industry]`, falling back to `ctx.universe_pe`. If both are `None`, the rule is `missing`.
- Oversold inputs are `missing` when `view.prices` is `None`, when `view.prices_stale` is true, or when the specific field is `None`. `price_drop` is also `missing` when `len(closes_tail) < d + 1`.

**Score (pass only), spec §6:**
```
span = |x| if x != 0 else 10        # at_least
span = |x|/2 if x != 0 else 10      # at_most
score = clip((value - x) / span * 100, 0, 100)   # at_least
score = clip((x - value) / span * 100, 0, 100)   # at_most
```
Oversold rules return `score = None`.

- [ ] **Step 1: Write the failing tests.** Build views with a helper `view(**overrides)`:
  - `test_roe_uses_weakest_year`: ROE 0.20, 0.14, 0.25 with n=3 and x=15 gives `fail` with value 14.0.
  - `test_roe_score`: ROE 0.30 for all years with x=15 gives score 100. ROE 0.225 gives score 50.
  - `test_growth_cagr`: net_profit 100 → 133.1 over 3 years gives value ≈ 10.0 and `pass` at x=10.
  - `test_growth_loss_start_fails`: start −5 gives `fail`.
  - `test_growth_too_few_years_missing`.
  - `test_ocf_negative_profit_fails`.
  - `test_pe_loss_maker_fails`: pe −3 gives `fail`.
  - `test_pe_zero_missing`.
  - `test_pe_vs_industry_value`: pe 9 with industry median 12 gives value 75.0, `pass` at x=100, and score 50.
  - `test_dividend_zero_fails`.
  - `test_debt_zero_passes`.
  - `test_bank_rule_on_nonbank_missing`.
  - `test_debt_rule_on_bank_missing`.
  - `test_rsi_strict_below`: RSI 30.0 at x=30 gives `fail`; RSI 29.9 gives `pass`.
  - `test_price_drop`: tail where the close 5 bars back is 100 and the last close is 88 gives value −12.0, `pass` at x=10.
  - `test_oversold_stale_missing`.
  - `test_validate_fills_defaults`.
  - `test_validate_rejects_n_above_depth`: `profit_growth` with n=4 raises `RuleConfigError` with "profit_growth" in the message.
  - `test_validate_rejects_unknown_id`.
- [ ] **Step 2: Run** and expect a FAIL.
- [ ] **Step 3: Implement.** Keep one small value-extractor function per rule id in a dict, next to `CATALOG`.
- [ ] **Step 4: Run** and expect a PASS.
- [ ] **Step 5: Stop.** List the changed files.

### Task 5: Funnel evaluation, strength, ordering

**Files:**
- Create: `backend/app/screener/evaluate.py`
- Test: `backend/tests/test_screener_evaluate.py`

**Interfaces:**
- Consumes: `rules.validate_rules` and `rules.evaluate_rule`
- Produces: `evaluate_universe(views: list[dict], rules: list[dict]) -> dict`:
```
{"counts": {"universe": int, "in_scope": int, "passed": int, "oversold": int, "skipped": int},
 "rows": [{"symbol", "exchange", "industry", "strength": float, "oversold": "yes"|"no"|"missing",
           "rules": {rule_id: {"status","value","score"}}}],   # good + oversold rules
 "skipped": [{"symbol", "missing": [rule_id, ...]}]}
```

**Algorithm (spec §4–§6):**
1. Build `ctx`. `industry_pe` is the median of `pe > 0` per industry, kept only for industries with at least 5 such tickers. `universe_pe` is the median of all `pe > 0`.
2. Apply the scope rule (if on) to get `in_scope`. `banks: exclude` drops `is_bank`, `only` keeps only banks, and a non-empty `industries` keeps only tickers in that list.
3. For each in-scope ticker, evaluate every active good rule. Any `fail` means the ticker failed. Otherwise any `missing` means it is skipped and listed with the ids of its missing rules. Otherwise it passed.
4. `strength` is the mean `score` of the active good rules, rounded to 1 decimal. It is 0 when there are no active good rules.
5. Oversold for a passed ticker: if no oversold rule is on → `"no"`. Any `fail` → `"no"`. Otherwise any `missing` → `"missing"`. Otherwise `"yes"`.
6. Order the rows with `oversold == "yes"` first, then the rest. Within each block, sort by strength descending, then symbol ascending.

- [ ] **Step 1: Write the failing tests:**
  - `test_fail_beats_missing`: a ticker that fails ROE and lacks P/E is counted as failed, not skipped.
  - `test_missing_only_is_skipped`: it appears in `skipped` with `["pe_vs_industry"]`.
  - `test_oversold_requires_good_pass`: a weak company with RSI 20 is not in the rows at all.
  - `test_oversold_block_first`: an oversold ticker with strength 40 sorts above a non-oversold ticker with strength 90.
  - `test_missing_oversold_input_listed_not_highlighted`: the passed ticker has `prices: None`, so `oversold == "missing"` and it is still in the rows.
  - `test_stale_prices_never_highlight`: `prices_stale: True` with RSI 20, a 15% drop and volume ×3 gives `oversold == "missing"`.
  - `test_scope_banks_only`.
  - `test_industry_median_needs_5`: an industry with 4 P/Es falls back to the universe median.
  - `test_counts`: a 6-ticker fixture gives the exact `counts` dict.
  - `test_strength_mean`: two rules scoring 100 and 50 give strength 75.0.
- [ ] **Step 2: Run** and expect a FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** and expect a PASS.
- [ ] **Step 5: Stop.** List the changed files.

### Task 6: Strategies

**Files:**
- Create: `backend/app/screener/strategies.py`
- Test: `backend/tests/test_screener_strategies.py`

**Interfaces:**
- Consumes: the `Strategy` model and `rules.validate_rules`
- Produces:
  - `STARTERS: dict[str, dict]`, keyed `quality`, `deep_value`, `dividend`, `banks`, each `{"name", "rules"}`
  - `seed_starters(db) -> None` inserts any missing starter by `starter_key`. It never overwrites an existing one.
  - `list_strategies(db) -> list[dict]`. Each dict is `{"id", "name", "starter_key", "rules", "updated_at"}`, starters first in the order above, then user strategies by name.
  - `create_strategy(db, name: str, rules: list) -> dict`
  - `update_strategy(db, id: int, name: str | None, rules: list | None) -> dict`
  - `delete_strategy(db, id: int) -> None`
  - `reset_strategy(db, id: int) -> dict` (starters only)
  - `class StrategyError(ValueError)` with `.status` 404, 409 or 422

**Starter rules (spec §5, verbatim).** The oversold rules for every starter are `rsi` x=30, `price_drop` x=10 d=5, `volume_spike` x=1.5, all on.
- **Quality:** scope banks=exclude; `roe_years` x15 n3; `profit_growth` x10 n3; `debt_to_equity` x1.0; `ocf_to_profit` x80 n3; `pe_vs_industry` x100; `traded_value` x5.
- **Deep value:** scope banks=exclude; `roe_years` x10 n3; `debt_to_equity` x1.0; `pe_vs_industry` x70; `pb` x1.5; `traded_value` x5.
- **Dividend:** scope banks=exclude; `dividend_yield` x5; `roe_years` x12 n3; `debt_to_equity` x1.0; `ocf_to_profit` x80 n3; `traded_value` x5.
- **Banks:** scope banks=only; `roe_years` x15 n3; `bank_npl` x2; `bank_nim` x3; `bank_cir` x40; `pb` x2.0; `traded_value` x5.

Starters list only their active rules. Rules a strategy does not list are treated as off. The UI shows the full catalog with the unlisted rules switched off.

**Errors:**
- A duplicate name raises 409.
- Deleting a starter raises 409 (starters can only be reset).
- An unknown id raises 404.
- Bad rules raise 422, carrying the `RuleConfigError` message.
- `reset_strategy` on a user strategy raises 409.
- Deleting the strategy stored in state `last_strategy_id` clears that key.

- [ ] **Step 1: Write the failing tests:**
  - `test_seed_is_idempotent`: seeding twice gives 4 rows.
  - `test_starter_rules_validate`: every starter passes `validate_rules`.
  - `test_quality_values`: the `roe_years` x is 15 and the scope banks value is `"exclude"`.
  - `test_create_duplicate_name_409`.
  - `test_delete_starter_409`.
  - `test_reset_restores_defaults`: edit Quality's ROE to 20, reset, and it is back to 15.
  - `test_delete_clears_last_strategy`.
  - `test_update_bad_rules_422`.
- [ ] **Step 2: Run** and expect a FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** and expect a PASS.
- [ ] **Step 5: Stop.** List the changed files.

### Task 7: Refresh orchestration

**Files:**
- Create: `backend/app/screener/refresh.py`
- Test: `backend/tests/test_screener_refresh.py`

**Interfaces:**
- Consumes: `provider.get_provider`, `store.*` and `ratelimit.vnstock_limiter` (provider calls go through it with `priority="background"`; the fixture provider has no network, so the tests pass a limiter with `interval_s=0`)
- Produces:
  - `last_trading_close(now: datetime) -> datetime` (tz-aware, VN). On a weekday at or after 15:00 it is today at 15:00; otherwise it is the previous weekday at 15:00.
  - `is_stale(as_of: datetime | None, now: datetime) -> bool` (`None` counts as stale)
  - `class RefreshManager(db_factory, provider_factory, limiter, clock)`:
    - `status() -> dict` returns `{"running": bool, "kind": "prices" | "financials" | None, "done": int, "total": int, "started_at": iso | None, "queued": list[str], "prices_as_of": iso | None, "financials_as_of": iso | None, "last_error": str | None}`
    - `request(kind: str) -> bool` queues a kind. It returns `False` if that kind is already running or queued.
    - `check_and_queue() -> list[str]`: prices if `is_stale(prices_as_of)`, financials if `financials_as_of` is `None` or older than 7 days. Prices always come first.
    - `run_pending() -> None` runs the queued kinds synchronously, one at a time. The tests use this.
    - `boot() -> None` starts a daemon thread that calls `check_and_queue()` and `run_pending()` immediately and then every 10 minutes.
  - module singleton `manager` built from `SessionLocal`, `get_provider` and `vnstock_limiter`

**Run behaviour (spec §2):**
- On start of a run, set state `"<kind>_run_started"` to now **unless it is already set**, which means a run is being resumed.
- Iterate over the targets and skip any ticker whose `<kind>_at >= <kind>_run_started`.
- If `ticker_metrics` is empty, or the kind is financials, call `list_universe()` and `upsert_universe()` first.
- **Price order:** symbols in state `last_pass_symbols` first, then the remaining tickers by symbol.
- **Financial order:** by symbol.
- A per-ticker exception goes to `save_error`. The run continues and the ticker keeps its old numbers.
- After each ticker, commit and update `done` and `total`.
- On completion, set `"<kind>_as_of"` to the run start time and clear `"<kind>_run_started"`.
- A run that raises outside the per-ticker loop leaves `"<kind>_run_started"` set (so it resumes) and records `last_error`.

- [ ] **Step 1: Write the failing tests.** Use an in-memory DB with a `db_factory` bound to it, `FixtureProvider`, and a fixed clock:
  - `test_last_trading_close`: Tue 2026-11-10 at 14:59 VN gives Mon 11-09 15:00. 15:00 gives Tue 15:00. Sun 11-08 gives Fri 11-06 15:00.
  - `test_is_stale`.
  - `test_check_queues_prices_before_financials`.
  - `test_prices_priority_order`: `last_pass_symbols=["ZZZ"]` makes the first fetch_prices call `ZZZ`.
  - `test_failed_ticker_keeps_old_numbers`.
  - `test_financial_refresh_resumes`: pre-set `financials_run_started` and give 2 tickers `financials_at` after it. Only the other tickers are fetched.
  - `test_completion_sets_as_of_and_clears_cursor`.
  - `test_request_rejects_duplicate`.
- [ ] **Step 2: Run** and expect a FAIL.
- [ ] **Step 3: Implement.** Guard `status` and the queue with a `threading.Lock`.
- [ ] **Step 4: Run** and expect a PASS.
- [ ] **Step 5: Stop.** List the changed files.

### Task 8: Screener API, wiring, retire the old scanner

**Files:**
- Create: `backend/app/routes/screener.py`
- Modify: `backend/app/main.py`, `backend/app/routes/market.py`, `backend/app/services/market.py`, `backend/app/config.py`, `backend/app/db.py`, `backend/tests/conftest.py`, `docs/design/API_CONTRACT.md`, `src/api-client.jsx`
- Delete: the files listed under "Removed in Task 8" above
- Test: `backend/tests/test_screener_route.py`

**Interfaces:**
- Consumes: `CATALOG`, `RuleConfigError`, `evaluate_universe`, the strategies functions, `refresh.manager`, `store.load_views`, `store.get_state` and `store.set_state`
- Produces (all under `/api/screener`):
  - `GET /rules` returns `{"catalog": CATALOG}`
  - `GET /strategies` returns `list[strategy]`, and seeds the starters first
  - `POST /strategies` with `{"name", "rules"}` returns the strategy
  - `PUT /strategies/{id}` with `{"name"?, "rules"?}`
  - `DELETE /strategies/{id}` returns 204
  - `POST /strategies/{id}/reset`
  - `POST /evaluate` with `{"strategy_id": int | null, "rules": list}` returns `evaluate_universe(...)` plus `"freshness": {"prices_as_of", "financials_as_of"}`. If `strategy_id` is given, it stores state `last_strategy_id` and stores `last_pass_symbols` as the row symbols.
  - `GET /state` returns `{"last_strategy_id": int | null}`
  - `GET /refresh` returns `manager.status()`
  - `POST /refresh` with `{"kind": "prices" | "financials"}` returns 202 with the status, or 409 if that kind is already running or queued. The background thread picks it up.
  - `StrategyError` maps to its `.status`; `RuleConfigError` maps to 422.
- `main.py` lifespan: remove the scheduler block. Add `if settings.enable_screener_refresh: refresh.manager.boot()`. Register `screener.router` with prefix `/api` and tag `screener`.
- `api-client.jsx`: remove `scanLatest`, `scanRun` and `screener`. Add `screenerRules()`, `screenerStrategies()`, `screenerCreateStrategy(name, rules)`, `screenerUpdateStrategy(id, patch)`, `screenerDeleteStrategy(id)`, `screenerResetStrategy(id)`, `screenerEvaluate(strategyId, rules)`, `screenerState()`, `screenerRefreshStatus()` and `screenerRefresh(kind)`, all following the existing `_get` and `_send` pattern.

- [ ] **Step 1: Write the failing route tests.** Use a `TestClient` with `get_db` overridden to the in-memory session:
  - `test_evaluate_empty_store`: returns 200, all counts 0, `freshness` nulls.
  - `test_strategies_seeded_on_list`: 4 starters.
  - `test_evaluate_with_fixture_data`: load `FixtureProvider()` data through `store`, evaluate Quality, and expect at least one row and the oversold sample ticker first.
  - `test_evaluate_rejects_bad_rules_422`.
  - `test_evaluate_stores_last_strategy`.
  - `test_refresh_post_409_when_running`: monkeypatch `manager.request` to return False.
  - `test_old_scan_routes_gone`: `POST /api/scan` returns 404.
- [ ] **Step 2: Run** and expect a FAIL.
- [ ] **Step 3: Implement the routes and lifespan wiring.**
- [ ] **Step 4: Retire the old scanner.** Delete the listed files and remove their imports from `db.init_db`, `conftest.py` and `main.py`. Remove `market.screen` and `GET /api/screener`. Then run `grep -rn "scanner\|scan_results\|ScanRun\|run_scan\|scanLatest\|scanRun\|HelixAPI.screener\b\|enable_scheduler" backend/app src --include=*.py --include=*.jsx` (excluding `.venv`). Expect no hits other than comments you deliberately keep; fix each hit (`services/ai.py` and `page-settings.jsx` mention the screener and must be checked).
- [ ] **Step 5: Update `API_CONTRACT.md`.** Replace the old scan and screener sections with the endpoints above, including the request and response shapes.
- [ ] **Step 6: Run** the full suite. Expect it green; the count drops by the deleted scanner tests.
- [ ] **Step 7: Run the JSX syntax check** on `src/api-client.jsx`. Expect `ok`.
- [ ] **Step 8: Stop.** List the changed and deleted files.

### Task 9: Screener page — strategies and rules panel

**Files:**
- Modify: `src/page-screener.jsx` (full rewrite of the component; keep `FilterField` only if reused), `Financial_analyze/Financial Analyze.html` (bump `?v=`)

**Interfaces:**
- Consumes: the Task 8 client methods
- Produces (internal to the page): the state `catalog`, `strategies`, `activeId`, `rules` (working copy) and `dirty`, plus `evaluate()`, which is debounced at 250 ms and called on every rule change and strategy switch

**UI (approved mockups `rule-editing.html` option C and `ranked-results.html`, in `.superpowers/brainstorm/34668-1794296780/content/`):**
- The header keeps the title and the single primary button. That button becomes "Refresh prices ↻" (Task 10 wires it). Remove "Save preset" and the localStorage presets.
- **Strategy chips row:** the starters, then user strategies, then "+ My own". Clicking a chip loads its rules and evaluates. On mount, select `screenerState().last_strategy_id`, falling back to the Quality starter.
- **"+ My own"** prompts for a name via the existing `window.askPrompt` and creates a strategy from the current rules.
- **Collapsible "Edit rules" panel** with two groups, "Good company rules" and "Oversold highlight", plus a scope row (banks any/exclude/only). There is one row per catalog rule of that stage: a toggle, the label, and number inputs per param with the catalog `min`/`max`/`unit`. A rule's `applies_to` hides it when it contradicts the scope (bank rules are hidden when scope banks=exclude; non-bank rules when scope banks=only).
- **When `dirty`:** show "Modified · Save · Save as new · Discard". For a starter, also show "Reset to default" (calls reset). For a user strategy, show "Rename" and "Delete" in the same row.
- **Error toasts:** a 422 from evaluate or save shows a toast with the server `detail`, and the last good results stay on screen.

- [ ] **Step 1: Implement** the strategy state, chips, rules panel and debounced evaluate. Render the raw `counts` as text for now; Task 10 builds the table.
- [ ] **Step 2: Run the JSX syntax check** on `src/page-screener.jsx`. Expect `ok`.
- [ ] **Step 3: Verify in a browser.** Run the backend with `cd backend && SCREENER_PROVIDER=fixture .venv/bin/uvicorn app.main:app --port 8000`. Serve the frontend with `python3 -m http.server 8765` from `Financial_analyze/` and open `http://localhost:8765/Financial%20Analyze.html` → Screener. Check that:
  - the 4 chips show;
  - toggling ROE off changes the counts;
  - typing an ROE of 999 shows the 422 toast;
  - Save as new, Rename and Delete work;
  - a reload lands on the last-used strategy;
  - the console shows no errors.
- [ ] **Step 4: Stop.** List the changed files.

### Task 10: Screener page — funnel, results table, freshness, refresh

**Files:**
- Modify: `src/page-screener.jsx`

**UI (mockup `ranked-results.html`):**
- **Freshness line:** "Prices as of {prices_as_of local} · financials as of {financials_as_of} · UNVERIFIED". Null values show "never". While a refresh runs, show "Refreshing prices 120 / 1,519…", polling `screenerRefreshStatus()` every 5 s. Re-evaluate when `done` changes so the list fills in as numbers arrive.
- **Primary button:** "Refresh prices ↻". Next to it, a secondary `btn` labelled "Refresh financials". Both call `screenerRefresh(kind)`; a 409 shows a toast "Already refreshing".
- **Funnel:** Whole market {universe} → Pass good-company rules {passed} → Oversold now {oversold} ⚡, with "{skipped} skipped, missing data" as a button that opens a small list of skipped symbols and their missing rule labels.
- **Table:** every row with no cut-off. Remove the 100-row cap and its footer.
  - Columns: `#`, Ticker (⚡ if oversold "yes"; "no recent price data" in muted text if "missing"), Strength (bar + number), one column per active good rule (header = catalog label, short; cell = value formatted in its unit), then RSI, drop over `d` days, and volume ×.
  - Cell emphasis: score ≥ 66 is bold green, 33–65 is green, below 33 is plain.
  - The ⚡ block gets a separator row "⚡ Oversold now — good company, bounce candidates" and a tinted background. The rest go under "Good companies — hold candidates".
  - Clicking a column header sorts within each block (asc/desc toggle). Clicking a row calls `setActiveAsset(symbol)` and then `setPage('detail')`, as today.
- **Empty and fresh install:** when `counts.universe == 0`, the table area shows "No market data yet. Refresh prices and financials to start." with both refresh buttons.
- **Export CSV:** keep the button. Export the current rows with the same columns.
- **Backend unreachable** (`!HelixAPI.live`): render a built-in `SAMPLE_RESULT` constant (a 5-row VN-shaped evaluate response with fake tickers `AAA`…`EEE`, matching the mockup) and the 4 starter chips (read-only), with a "Sample data — backend offline" badge. Remove the old US mock universe, `buildUniverse` and `runMockScreen`.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Run the JSX syntax check.** Expect `ok`.
- [ ] **Step 3: Verify in a browser** (the same setup as Task 9). Check that:
  - the ⚡ block sits on top, the sample oversold ticker carries ⚡, and rule cells show values;
  - sorting by a column keeps the blocks;
  - the skipped list opens;
  - Refresh prices shows progress and the list updates;
  - with the backend stopped and the page reloaded, the sample badge shows;
  - the console shows no errors.
- [ ] **Step 4: Stop.** List the changed files.

### Task 11: Ticker notes

**Files:**
- Create: `backend/app/routes/notes.py`
- Modify: `backend/app/main.py` (register the router), `backend/app/routes/screener.py` (add `note_latest_at` to the evaluate rows), `src/page-detail.jsx`, `src/page-screener.jsx`, `src/api-client.jsx`, `docs/design/API_CONTRACT.md`, `Financial_analyze/Financial Analyze.html` (`?v=`)
- Test: `backend/tests/test_notes_route.py`

**Interfaces:**
- Consumes: the `TickerNote` model (Task 3)
- Produces:
  - `GET /api/notes/{symbol}` returns `[{"id", "symbol", "body", "created_at", "updated_at"}]`, newest first. The symbol is upper-cased, and a `VN:` prefix is stripped.
  - `POST /api/notes/{symbol}` with `{"body"}` returns 201 with the note. An empty or whitespace-only body returns 422.
  - `PUT /api/notes/item/{id}` with `{"body"}` sets `updated_at`.
  - `DELETE /api/notes/item/{id}` returns 204. An unknown id returns 404.
  - Evaluate rows gain `"note_latest_at": iso | None`.
  - Client: `notesList(symbol)`, `notesAdd(symbol, body)`, `notesEdit(id, body)`, `notesDelete(id)`.
- **Detail page:** add a "Notes" card after "Key Ratios":
  - a textarea and an "Add note" button;
  - the log underneath, newest first, each entry showing its local date/time, an "edited" tag when `updated_at` is set, and Edit and Delete actions;
  - Delete asks for confirmation via the existing confirm helper, if one exists in `ui-kit.jsx`/`lucian-ui.jsx`, otherwise `window.confirm`;
  - when the backend is offline, the card shows "Notes need the backend" and is disabled.
- **Screener:** 📝 after the ticker when `note_latest_at` is set, with the hover title "Last note {date}".

- [ ] **Step 1: Write the failing route tests:**
  - `test_add_and_list_newest_first`.
  - `test_symbol_normalised`: notes for `vn:vnm` are listed under `VNM`.
  - `test_empty_body_422`.
  - `test_edit_sets_updated_at`.
  - `test_delete_404_unknown`.
  - `test_evaluate_rows_carry_note_latest_at`.
- [ ] **Step 2: Run** and expect a FAIL.
- [ ] **Step 3: Implement** the backend.
- [ ] **Step 4: Run** the full suite. Expect a PASS.
- [ ] **Step 5: Implement** the frontend. Run the JSX syntax check on the changed `.jsx` files and expect `ok`.
- [ ] **Step 6: Verify in a browser.** Check that:
  - adding a note on a ticker's detail page shows it at the top of the log;
  - editing it shows "edited";
  - back on the screener, the 📝 mark shows on that ticker;
  - deleting the last note removes the mark;
  - the console shows no errors.
- [ ] **Step 7: Stop.** List the changed files.

### Task 12: Real vnstock provider

**Files:**
- Create: `backend/app/screener/vnstock_provider.py`
- Modify: `backend/app/screener/provider.py` (`get_provider`), `backend/app/config.py` (default `screener_provider = "vnstock"`)
- Test: `backend/tests/test_screener_vnstock_provider.py`, with recorded frames in `backend/tests/fixtures/screener/`

**Interfaces:**
- Consumes: the `MarketDataProvider` protocol and `vnstock_limiter` (`priority="background"` for every call)
- Produces: `class VnstockProvider` implementing the protocol, and the pure mapping functions it uses, so they can be tested without network:
  - `map_universe(listing_rows: list[dict], industry_rows: list[dict]) -> list[UniverseEntry]`
  - `map_ratio_rows(rows: list[dict], is_bank: bool, current_year: int) -> tuple[dict, dict]` returns `(latest, years_roe)`
  - `map_statements(income_rows: list[dict], cashflow_rows: list[dict], is_bank: bool) -> dict[str, dict]` returns per-year `revenue`, `net_profit` and `operating_cash_flow`
  - `map_bars(history_rows: list[dict]) -> list[dict]`

**Pinned mapping decisions (planner's calls):**
- **Universe:** `Listing().symbols_by_exchange()` rows with `type == "stock"` and exchange in HOSE, HNX or UPCOM. The industry comes from `symbols_by_industries()` (first present of `icb_name3`, `icb_name2`, `industry`). `is_bank` is true when the industry name contains "Ngân hàng" or "Bank" (case-insensitive).
- **`latest`:** the newest row by (year, quarter) carrying each field. Field mapping:
  - `pe←pe`, `pb←pb`, `dividend_yield←dividend_yield`, `market_cap←market_cap`
  - `debt_to_equity←debt_per_equity`: interest-bearing borrowings over equity, not total liabilities. VHM reads about 0.78 on this field versus 3.35 on `debt_to_equity`. "Debt" in the spec means borrowings.
  - `npl←npl`, `nim←net_interest_margin`
  - `cost_to_income←cir`, falling back to `cost_to_income` when `cir` is 0 or None
  - `car←car`
  - Bank fields on non-banks, and `debt_to_equity` on banks, are stored as `None`.
- **Yearly ROE:** rows with `quarter == 5` are fiscal-year rows (inferred on 2026-11-10; Step 1 confirms it). The current calendar year is excluded.
- **Statements:** `Finance` yearly `income_statement()` and `cash_flow()`. Revenue is the net revenue row and net profit is the row attributable to the parent company. Operating cash flow is the net operating cash-flow row. Match on `item_id` once Step 1 has recorded them; fall back to `item_en` substrings. For banks, `revenue` and `operating_cash_flow` are `None`, and net profit comes from the bank income layout.
- **Prices:** `Quote(sym).history(start, end, interval="1D")` over the last `days` calendar days, mapped to `{"date", "close", "volume"}`.

- [ ] **Step 1: Probe live and record fixtures.** First confirm vnstock calls still succeed (spec "Build order"). **If they fail, stop this task and report to the user. Do not change anything else.** If they succeed:
  - Run a scratchpad script, not a test, that fetches the listing (first 50 rows), the industry map, and VNM, VCB and VHM `ratio_summary` + yearly `income_statement` + `cash_flow` + 120-day history.
  - Save each as JSON under `backend/tests/fixtures/screener/`.
  - Confirm that `quarter == 5` rows are fiscal-year rows and that `car`/`cir` are populated for VCB.
  - Write down the exact `item_id`s for the four statement rows for both layouts.
  - Determine the working `Finance(...)` constructor form for 4.0.4.
- [ ] **Step 2: Write the failing tests** against the recorded fixtures:
  - `test_map_universe_flags_banks`: VCB → `is_bank` True, VNM → False.
  - `test_ratio_latest_vnm`: `debt_to_equity` equals the recorded `debt_per_equity` and `npl` is None.
  - `test_ratio_years_exclude_current_year`.
  - `test_statements_vnm_years`: 4 completed years, with revenue, net profit and OCF all non-null.
  - `test_statements_bank_revenue_none`.
  - `test_map_bars_shape`.
  - `test_provider_uses_background_priority`: stub the vnstock classes and a recording limiter.
- [ ] **Step 3: Run** and expect a FAIL.
- [ ] **Step 4: Implement** `VnstockProvider` and the mappers. Switch the `screener_provider` default to `"vnstock"`.
- [ ] **Step 5: Run** the full suite. Expect a PASS.
- [ ] **Step 6: Live smoke test.** Start the backend and `POST /api/screener/refresh {"kind": "financials"}`. Watch `GET /api/screener/refresh` progress for about 3 minutes, then stop the backend. Restart it and confirm the run resumes, not restarts (`done` continues, and tickers already done are not refetched). Report the observed rate (tickers per minute) and any field anomalies.
- [ ] **Step 7: Stop.** List the changed files.

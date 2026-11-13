# Stock Screener: Rule-Based Funnel, Strategies, Ticker Notes — Design

**Date:** 2026-11-10
**Status:** Approved by the user 2026-11-10.
**Supersedes (for the broad-scan tier):** `docs/specs/2026-06-23-vn-market-scanner-design.md`. The deep-dive tier of that spec is untouched and out of scope here.

Items marked **[user]** were stated or approved by the user. Items marked **[call]** were decided by the designer and can be overturned. Items under "Left to the builder" are open.

## Intent and why

The user reviews the Vietnamese stock market every evening after close. They want the screener to answer two questions at once:

1. Which companies are good enough to buy and hold?
2. Which of those good companies are oversold right now, so a short bounce trade is possible?

The second question is deliberately gated by the first. An oversold highlight on a weak company is not wanted: if the bounce fails, the user wants to be left holding a good company. **[user]**

Today's screener cannot do this. It blends fundamentals, valuation and technicals into one weighted score, so a weak company with a cheap P/E can rank high; its technical score rewards uptrends and so penalises exactly the oversold names the user wants flagged; its rules are hardcoded in Python; it stores only sub-scores, not the underlying numbers; and the last full scan ran on 2026-07-04.

## Goals

- Scan the whole Vietnamese market (HOSE, HNX, UPCOM). **[user]**
- A funnel: whole market → tickers passing every active good-company rule → among those, tickers passing every active oversold rule get highlighted. **[user]**
- Rules are editable by the user on the screener page. **[user]**
- Rules are grouped into named strategies; each strategy is a checklist of rules with an on/off switch and editable numbers; switching strategy swaps the whole rule set; the user can save their own. **[user]** (mockup option C)
- Oversold means all three together: RSI below 30, a hard price drop, and big volume. **[user]**
- The result is a ranked list with no top-N cut-off. **[user]**
- Ranking is derived from the rules themselves. **[user]**
- Clicking a ticker opens the existing asset detail page. **[user]**
- The asset detail page gets a notes section: a running, dated log per ticker where the user records why a company is good. Tickers with notes carry a mark in the screener list. **[user]**
- Prices are fresh every evening. **[user]** (the user opens the screener every evening after close)
- The data-fetching part is replaceable without touching rules, ranking, strategies or notes. **[user]** (approved after the data-source warning below)

## Non-goals

- Alerts or notifications.
- Any order placement.
- Integration with the backtest feature.
- AI/Hermes commentary on screener results.
- The deep-dive tier (OCR + reconcile + Hermes dossier) from the earlier scanner spec.
- A free-form rule builder (pick any metric, any operator). New kinds of rule are added to the rule catalog in code.
- Markets other than Vietnam.
- Intraday screening.

## Anti-goals

- A ticker highlighted as oversold that does not pass the good-company rules.
- Stale numbers presented without saying so. Every view states how old its prices and financials are.
- Hidden weights. The user must be able to see, per ticker, the actual value behind every rule and why it ranks where it does.
- A ticker silently dropped or silently passed because a number was missing.
- Consuming a third party's pre-computed buy/sell verdict. Only raw numbers come in; every pass/fail and every rank is this project's own deterministic arithmetic. (Carried over from the earlier spec.)
- Changing a rule number triggering a network rescan.

## Constraints

- Fully local at runtime; no cloud services.
- Market data is third-party and unverified. The existing "UNVERIFIED" label stays on screener results.
- **Data-source risk.** On 2026-11-10 the pinned vnstock 4.0.4 printed a notice that generations 4 and 5 stop working from 10/11/2026, citing Decree 363/2026/NĐ-CP (effective 11/11/2026), with generation 6 moving to the user's own broker API or self-prepared data files. This is unverified beyond the notice; calls still succeeded that day. vnstock must not be upgraded as part of this work. The user holds an SSI account; a broker-API route has not been investigated.
- vnstock guest tier allows 20 requests per minute. The existing pacing in `backend/app/scanner/universe.py` (3.1 s between calls, one long retry on rate limit) is the known-good approach.
- UI is built directly in `Financial_analyze/src/` with the Lucian UX/UI elements already in the project. Extend the existing screener page, its table and its buttons rather than adding parallel ones.
- `docs/design/API_CONTRACT.md` is the seam between frontend and backend and must be updated with every endpoint this adds, changes or retires.
- The user commits their own work. Do not run `git commit` or `git push`.

## What data is available (checked 2026-11-10 against VNM, VCB, VHM)

| Need | Source call (vnstock VCI) | Coverage |
|---|---|---|
| ROE, ROA, margins, debt/equity, current ratio, P/E, P/B, dividend yield, market cap, EBIT/EBITDA, ROIC | `Company(sym).ratio_summary()` | one row per period, 2018 → 2026 Q3, quarterly rows plus a yearly row |
| Bank metrics: net interest margin, NPL, CAR, CASA ratio, cost-to-income, loan and deposit growth | same call | same |
| Revenue, net profit (for growth) | `Finance(...).income_statement()` | last 4 fiscal years |
| Operating cash flow | `Finance(...).cash_flow()` | last 4 fiscal years |
| Daily OHLCV (RSI, drop, volume, liquidity, moving averages) | `Quote(sym).history()` | ~1 year fetched today |
| Universe and industry | `Listing().symbols_by_exchange()`, `symbols_by_industries()` | ~1,519 stocks |

Notes from the check:

- Non-bank fields are 0 for banks and bank fields are 0 for non-banks. A 0 in a field that does not apply to the company type means "missing", not zero.
- VCB's debt/equity is about 9.7. Banks cannot share the non-bank debt rule, which is why strategies exist.
- `Finance().ratio()` returns a malformed frame in 4.0.4; do not use it.
- In `ratio_summary`, rows with `quarter` 1–4 are quarterly and the row with `quarter` 5 appears to be the fiscal-year row. This is an inference from the output and should be confirmed before relying on it.
- Statement frames label rows in Vietnamese (`item`) with an `item_en` and `item_id` column, and the row layout differs between banks and non-banks.

## Design

### 1. Stored numbers, instant rules

Refreshing data and evaluating rules are separate. **[call]**

- **Refresh** fetches raw numbers per ticker and stores them. It is slow and network-bound.
- **Evaluate** applies a strategy's rules to the stored numbers. It touches no network and returns in well under a second for the whole market, so every rule edit and every strategy switch re-ranks immediately.

What is stored per ticker is the raw metric set, including per-fiscal-year series where a rule needs several years, plus the dates the financial and price parts were last refreshed.

Rule evaluation runs in the backend, in deterministic Python with exact tests, not in the browser. **[call]**

### 2. Refresh schedule

The user starts the backend themselves in the evening; it is not running at market close. **[user]** The refresh is built around that:

- **Prices, on backend start when stale.** Prices count as stale if they were last refreshed before the most recent trading-day close (15:00 Vietnam time; weekends are not trading days). On start, if stale, a price refresh begins automatically. It runs in **priority order**: first the tickers that passed the good-company rules of the last-used strategy at the last evaluation, then the rest of the market. Priority tickers take a few minutes; the whole market takes about 80 minutes (one history call per ticker). The screener re-evaluates as numbers arrive, so the user's usual list is fresh within minutes. **[call, from the user's answer]**
- From the price history the project computes RSI-14, the D-day price change, the latest volume against its 20-day average, 20-day average traded value, and moving averages.
- **Financials, weekly.** On backend start, if financials are older than 7 days, a financial refresh is queued after the price refresh. Ratios, income statement and cash-flow statement per ticker, about 3 calls each, roughly 4–5 hours, running in the background; it resumes where it left off if the backend is stopped part-way. **[call]**
- **Manual "refresh now"** from the screener page, reusing the existing primary button, for either part.
- If the backend is left running across a trading-day close, the same staleness check starts the price refresh then. **[call]**
- Only one refresh runs at a time. **[call]**
- A refresh in progress shows progress on the page; the page stays usable on the previous numbers meanwhile.
- A ticker that fails to fetch is skipped and keeps its previous numbers; it never aborts the run. Its staleness shows through its own refresh date.
- The page header always states "prices as of …" and "financials as of …".

### 3. Replaceable data provider

All network access for the screener sits behind one provider with a small surface: list the universe with exchange and industry; fetch one ticker's financial numbers; fetch one ticker's daily price history. Within the screener, the vnstock implementation is the only place that imports vnstock or knows its field names. Everything downstream consumes the project's own canonical field names. If vnstock stops working, a new provider (for example a broker API) is written and swapped in with no change to rules, ranking, strategies, UI or notes. **[user approved the principle; shape is a call]**

Scope: **screener only, plus one shared rate limiter.** **[user]** Other features that call vnstock directly (`services/market.py` for detail-page quotes and charts, `backtest/data.py`, `services/portfolio_engine.py`) keep their own vnstock code, but every vnstock call in the app goes through one shared, thread-safe limiter, so using the detail page during a refresh does not trip the 20-requests-per-minute limit. Interactive calls (detail page, charts) get priority over refresh calls. The limiter must also survive vnstock's quota guard, which can call `sys.exit()`: a `SystemExit` raised from inside a vnstock call is caught and treated as a rate-limit hit, not allowed to kill the backend. A later vnstock replacement covers the screener only; the other features would need their own migration. **[call on priority and SystemExit handling]**

### 4. Rules

A rule is an entry from a fixed catalog plus the user's parameters: on/off, a threshold, and for multi-year rules a number of years. Rules belong to one of two stages.

**Good-company stage — starting catalog [call]:**

| Rule | Parameter(s) | Meaning |
|---|---|---|
| ROE at least X% for N years | X, N | each of the last N fiscal years |
| Net profit growth at least X% a year | X, N | average yearly growth over N years |
| Revenue growth at least X% a year | X, N | same |
| Debt/equity below X | X | latest |
| Operating cash flow at least X% of net profit | X, N | summed over N years |
| P/E at most X% of industry median | X | 100% = at the median |
| P/B at most X | X | latest |
| Dividend yield at least X% | X | latest |
| Average daily traded value at least X bn VND | X | 20-day |
| Market cap at least X bn VND | X | latest |
| Bank: NPL at most X% | X | latest |
| Bank: net interest margin at least X% | X | latest |
| Bank: cost-to-income at most X% | X | latest |
| Bank: CAR at least X% | X | latest |
| Industry scope | include / exclude list | limits which tickers the strategy considers |

Industry median P/E is this project's own computation from raw P/Es, as today (`attach_sector_pe`).

**Oversold stage:**

| Rule | Default | Source |
|---|---|---|
| RSI-14 below X | 30 | **[user]** |
| Price change over last D trading days at most −X% | D = 5, X = 10 | concept **[user]**, numbers **[call]** |
| Latest volume at least X × 20-day average | 1.5 | concept **[user]**, numbers **[call]** |

A ticker is in the oversold block only if it passes every active good-company rule and every active oversold rule.

**Rule definitions. [call]**

- *"Latest"* means the newest period row that carries the field (in practice the most recent quarter, which for VCI ratios is a trailing figure). This matches how the existing code picks P/E.
- *"Last N fiscal years"* means the last N completed fiscal years, taken from the fiscal-year rows; the current, incomplete year is excluded.
- *Growth* is compound annual growth from the value N years before the latest completed year to that year: `(end / start)^(1/N) − 1`. If the start value is zero or negative (a loss year), the growth rule **fails on merit**: a company coming out of losses is not a steady grower.
- *Operating cash flow vs profit* is the sum of operating cash flow over N years divided by the sum of net profit over the same years. If summed net profit is zero or negative, the rule fails on merit.
- *P/E* zero or negative (loss-making) **fails on merit** for any P/E rule.
- *Zero values in applicable fields* are real values, not missing: dividend yield 0 is a non-payer (fails a dividend rule), debt/equity 0 is no debt (passes a debt rule). Zero means missing only for a field that does not apply to the company type (bank fields for non-banks and the reverse), and for P/E, P/B and market cap, where VCI uses 0 for "not reported".
- *Depth limits.* Statements give 4 fiscal years, so growth N can be at most 3 and cash-flow N at most 4; ratio-based N (ROE) can be at most 8. The rules panel caps each N at what the data supports.

**Missing data. [call]** Evaluation order for each ticker:

1. If any active good-company rule **fails on merit** using numbers the ticker has, the ticker fails. Missing numbers for other rules do not matter.
2. Otherwise, if any active good-company rule lacks its number, the ticker is **skipped**: excluded from the results, counted separately. The page shows the count ("37 skipped, missing data") and lets the user see which tickers and which numbers.
3. Otherwise the ticker passes.

For the oversold stage, a passing ticker that lacks an oversold input (new listing, suspended, no recent volume) stays in the list as a good company, is not highlighted, and shows "no recent price data" in place of its RSI. It is never highlighted on missing data.

### 5. Strategies

A strategy is a name plus a full set of rule parameters for both stages. Strategies are stored in the app database, not browser storage. **[call]**

Starter strategies shipped with the app **[call — names and numbers are starting points for the user to edit]**:

- **Quality** — excludes banks. ROE ≥ 15% for 3 years; profit growth ≥ 10% over 3 years; debt/equity < 1.0; operating cash flow ≥ 80% of profit over 3 years; P/E ≤ 100% of industry median; traded value ≥ 5 bn VND/day.
- **Deep value** — excludes banks. ROE ≥ 10% for 3 years; debt/equity < 1.0; P/E ≤ 70% of industry median; P/B ≤ 1.5; traded value ≥ 5 bn VND/day.
- **Dividend** — excludes banks. Dividend yield ≥ 5%; ROE ≥ 12% for 3 years; debt/equity < 1.0; operating cash flow ≥ 80% of profit over 3 years; traded value ≥ 5 bn VND/day.
- **Banks** — banks only. ROE ≥ 15% for 3 years; NPL ≤ 2%; net interest margin ≥ 3%; cost-to-income ≤ 40%; P/B ≤ 2.0; traded value ≥ 5 bn VND/day.

All four carry the same default oversold rules.

Behaviour:

- Selecting a strategy loads its rules and re-evaluates.
- Editing any rule re-evaluates immediately and marks the strategy as modified; the user can save the change, save it under a new name, or discard it.
- Starter strategies can be edited and can be reset to their shipped defaults. User-created strategies can be renamed and deleted.
- The last-used strategy is remembered.

### 6. Ranking

Each passing ticker gets a **strength** from 0 to 100: how far past the rule thresholds it lands, averaged over the active good-company rules. **[user approved the idea and the mockup; the formula is a call]**

- For each active rule, a per-rule score runs linearly from 0 at the user's threshold to 100 at a "comfortably past" point, clipped at both ends. Default "comfortably past" point: twice the threshold for "at least" rules, half the threshold for "at most / below" rules. A rule at ROE ≥ 15% therefore scores 0 at 15% and 100 at 30% or above.
- Multi-year "each year" rules use the weakest year.
- Scope rules (industry) contribute nothing to strength.
- Strength is the plain average of the per-rule scores. No per-rule weights.
- Oversold rules do not contribute to strength; they decide block membership only.

List order: the oversold block first, then the remaining passing tickers; within each block, highest strength first. Every column is click-to-sort, and sorting by a column sorts within blocks. **[call on the within-blocks detail]**

### 7. Screener page

Approved layout (mockup `ranked-results.html`, kept under `.superpowers/brainstorm/34668-1794296780/content/`):

- Strategy chips across the top, with one for creating the user's own.
- Freshness line: prices as of, financials as of, UNVERIFIED.
- Funnel counts: whole market → pass good-company rules → oversold now, plus the skipped-for-missing-data count.
- A collapsible rules panel: the checklist for the selected strategy, grouped into "Good company rules" and "Oversold highlight", each rule with a switch and its number(s) (mockup `rule-editing.html`, option C).
- Results table, every passing ticker, no cut-off: rank, ticker (with ⚡ if oversold and 📝 if it has notes), strength with a small bar, one column per active good-company rule showing the real value, then RSI, price drop and volume multiple. Values far past a threshold read stronger than values that barely pass. The oversold block is visually set apart.
- Row click opens asset detail, as today.
- CSV export of the current list stays.

Removed from the page: the blended score columns, the LONG TERM / SHORT TERM / AVOID badge, the mock US dataset and its sliders, the browser-stored presets, and the 100-row cap.

When the backend is unreachable the page still renders, on a small built-in Vietnamese-shaped sample clearly labelled as sample data, consistent with the project's frontend-on-mock approach. **[call]**

### 8. Ticker notes

On the asset detail page, a notes section **[user]**:

- Add a note: free text, saved against the ticker with the date and time it was written.
- Notes are listed newest first as a running log; earlier notes are never overwritten by a new one.
- A note can be edited and deleted by the user; an edited note shows that it was edited. **[call]**
- Stored in the app database. The Obsidian vault is not involved. **[call]**
- The screener list shows 📝 on tickers with at least one note; hovering shows the date of the latest. **[call on hover]**

Notes are independent of the screener rebuild and are built second.

### 9. What happens to the old scanner

The blended scoring (`scanner/signals.py`, `scanner/score.py`), the `lean` classification, and the `POST /api/scan` / `GET /api/scan/latest` pair are replaced by the above. The legacy `GET /api/screener` route in `routes/market.py` and its client method are retired or repurposed. Existing `scan_runs` / `scan_results` rows need not be preserved or migrated. The pure helpers for SMA, RSI, volume ratio and industry-median P/E are reused. **[call]**

## Build order

1. Provider seam with a fixture provider (no network), stored raw metrics, shared rate limiter.
2. Rule catalog, evaluation, missing-data handling, strength and ranking, with exact deterministic tests.
3. Strategies: storage, starter set, API.
4. Refresh orchestration: staleness check on start, priority order, resume, progress, manual trigger — all exercised against the fixture provider.
5. Screener page rebuild.
6. Ticker notes (detail page section + screener mark).
7. The real vnstock provider, last.

**[call]** Steps 1–6 need no live data source. Before step 7, confirm the vnstock calls listed above still succeed (they did on 2026-11-10). If they do not, stop step 7 only and raise it with the user: choosing a replacement data source is a separate decision. Everything else still ships, running on the last stored numbers.

## Left to the builder

- Table and column design for stored metrics, strategies and notes; endpoint names and payload shapes (recorded in `API_CONTRACT.md`).
- How statement rows are identified reliably across company types (by `item_id` or otherwise).
- How refresh progress is reported to the page.
- Exact scheduling mechanics within the existing APScheduler setup. The staleness check must run on backend start regardless of the `enable_scheduler` setting, which defaults to off. Vietnamese public holidays may be ignored in v1 (a holiday just triggers one unnecessary refresh).
- Which Lucian elements to use and the visual treatment, within the approved layout.
- Whether the fixed catalog's "comfortably past" points need per-rule overrides where doubling or halving the threshold is meaningless (for example thresholds of 0, or the P/E-versus-median rule).
- Test fixtures and structure, following the existing backend test conventions.

## Testing expectations

- Rule evaluation, missing-data handling, strength and ordering: exact fixtures in, exact results out.
- An oversold ticker failing a good-company rule never appears in the oversold block.
- Changing a rule parameter makes no provider call.
- Within the screener, the provider is the only module that imports vnstock; tests run without network.
- Every vnstock call in the app passes through the shared limiter; a `SystemExit` from inside a vnstock call does not stop the backend.
- Missing-data rules: fail-on-merit beats missing; skipped tickers are counted; missing oversold inputs never highlight.
- A refresh with some tickers failing completes and leaves those tickers' previous numbers in place.

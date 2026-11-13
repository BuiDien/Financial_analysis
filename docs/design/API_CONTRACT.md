# API Contract — Distributed Financial Analysis System

**The seam between tiers.** Presentation (artifact UI) builds to these shapes on mock data;
Business/Data tiers later implement them. When both sides match this doc, connecting =
flip `HelixAPI` to live, **zero UI change.**

- Base URL: `http://localhost:8000` (set via `localStorage.helix_api_url`)
- All bodies JSON unless noted (uploads = multipart).
- Money values: **number, đơn vị triệu đồng** unless `unit` says otherwise. EPS = đồng.
- Dates: ISO `YYYY-MM-DD`. Timestamps: unix seconds unless noted (newer routes return ISO UTC).
- Errors: `{"detail": "..."}`; structured 409s may carry `{"detail": {"message", "blocking"}}`.
- Changes require bumping this doc + both tiers.

**Source of truth for the route list:** the `@router.*` decorators in `backend/app/routes/*.py`
and the prefixes in `backend/app/main.py`. Regenerate this list from them when routes change
(last regenerated 2026-11-12: 102 routes + `GET /`, `GET /health`). Routes that were designed
but never built are listed under [Planned / not implemented](#planned--not-implemented).

## Security (all routes)
No auth: single-user, loopback-only. `OriginGuardMiddleware` (`backend/app/main.py`) refuses any
HTTP request or WebSocket handshake whose `Origin` header is not in `ALLOWED_ORIGINS`
(403 / WS close 1008). Native clients (curl, OCR worker, MCP server) send no `Origin` and pass.
`ALLOWED_ORIGINS='*'` is no longer honoured (logged, falls back to the local frontend origins).

---

## 0. Health & detection
```
GET /       → service banner
GET /health → 200 {"status":"ok"}
```
HelixAPI pings `/health` (1.5s, 3 attempts). OK → live mode; else → mock.

---

## 1. Market  (`routes/market.py`, tag `market`)

### GET /api/quote/{ticker}
```json
{"symbol":"VNM","price":64500,"previous_close":63800,
 "change":700,"change_pct":1.10,"currency":"VND","ts":1718900000}
```
Nullable: `price`, `previous_close`, `change`, `change_pct` (provider miss → null).

### GET /api/history/{ticker}?period=1mo&interval=1d&end=YYYY-MM-DD&adjusted=false
period ∈ 1d 5d 1mo 3mo 6mo 1y 2y 5y 10y ytd max (anything else: 422). `end` returns the
`period`-long window ending that day (chart scroll-back). `adjusted` (Yahoo tickers only) =
dividend-adjusted closes.
```json
[{"date":"2026-06-01","open":63000,"high":64800,"low":62900,"close":64500,"volume":1234567}]
```
Note: `/api/history/companies` and `/api/history/{ticker}/{scope}/…` belong to company history
(§5); that router is mounted first, so a ticker literally named `COMPANIES` is unreachable here.

### GET /api/indices
```json
{"vnindex":{"symbol":"VNINDEX","price":1280.5,"previous_close":1274.2,"change":6.3,"change_pct":0.49},
 "hnxindex":{...},"upcom":{...},"vn30":{...},"gold":{...},"usdvnd":{...}}
```
Any key may be `null` if unavailable.

---

## 2. Fundamentals  (`routes/fundamentals.py`, tag `fundamentals`)
```
GET /api/statements/{ticker}?period=annual|quarter   # provider statements   HelixAPI.statements
GET /api/ratios/{ticker}                             # provider ratios       HelixAPI.ratios
```
Third-party data (vnstock / Yahoo), not the owner-verified company history of §5.

---

## 3. Filings (legacy uploads)  (`routes/filings.py`, tag `filings`)
```
GET    /api/filings?ticker=VNM               # list                     filings
POST   /api/filings/upload                   # multipart PDF + meta     uploadFiling
POST   /api/filings/{filing_id}/ocr-parse    # stub OCR parse           ocrParse
POST   /api/filings/{filing_id}/analyze      # AI summary
POST   /api/filings/{filing_id}/ask          # {"question"} → AI answer
GET    /api/filings/{filing_id}/tracker      # reader tracker JSON
PUT    /api/filings/{filing_id}/tracker      # save tracker             saveTracker
GET    /api/filings/{filing_id}/file         # PDF download
DELETE /api/filings/{filing_id}
```
New statement PDFs go through the OCR Inbox (§4); publishing an inbox item creates a filing.

---

## 4. OCR Inbox  (`routes/ocr_inbox.py`, tag `ocr-inbox`, prefix `/api/ocr-inbox`)
Upload unlabeled PDFs → OCR on a paired worker (§6) → human review → labels → company history
(§5) and/or publish. Item `status` ∈ uploaded | queued | held | processing | ready_for_review |
reviewing | verified | ready_to_publish | published | failed. Review `status` ∈ reviewing |
verified | published. Every review mutation sends the current `revision`; a stale revision is
409 "Review changed; refresh …". Edits on a verified/published review are 409
"Verified reviews must be reopened before editing".

Items:
```
POST   /api/ocr-inbox                              # multipart files[] (≤20), allow_duplicate, ticker?, scope?, fiscal_year?, period_code?   ocrInboxUpload
GET    /api/ocr-inbox?status=…                     # list items                                   ocrInbox
GET    /api/ocr-inbox/{item_id}                    # item: labels, attempt, review summary        ocrInboxItem
GET    /api/ocr-inbox/{item_id}/file               # original PDF                                 ocrInboxFileUrl
GET    /api/ocr-inbox/{item_id}/pages/{n}          # page n rendered as an image                  ocrInboxPageUrl
POST   /api/ocr-inbox/{item_id}/run                # queue OCR (uploaded/held)                    ocrInboxRun
POST   /api/ocr-inbox/{item_id}/retry              # re-queue a failed item                       ocrInboxRetry
POST   /api/ocr-inbox/{item_id}/cancel             # cancel a queued item                         ocrInboxCancel
DELETE /api/ocr-inbox/{item_id}                    # delete item + OCR history                    ocrInboxDelete
PATCH  /api/ocr-inbox/{item_id}/labels             # {ticker, scope, fiscal_year, period_code, unit, company, …}   ocrInboxLabels
POST   /api/ocr-inbox/{item_id}/review/reopen      # {revision, reason?} → review (verified → reviewing)   (no client method yet)
POST   /api/ocr-inbox/{item_id}/publish            # ready_to_publish → filing                    ocrInboxPublish
DELETE /api/ocr-inbox/{item_id}/history            # remove this document's facts from history    historyRemove
```
Item JSON: `{id, filename, size_bytes, pages, checksum_sha256, status, error, labels:{company,
ticker, filing_type, period, currency, unit, scope, fiscal_year, period_code},
published_filing_id, attempt:{…}|null, review:{id, status, revision, result_format,
counts}|null, created_at, updated_at}`.

Reopen: 409 when there is no review, the revision is stale, the review is published, the
review is not verified, or the document is in company history ("Remove this document from
company history before reopening it"). Success bumps `revision`, sets the review to
`reviewing` and the item to `ready_for_review`, and writes an audit event.

Reviews (`result_format` `page_markdown_v2` = one Markdown result per PDF page; older reviews
are row-based):
```
GET  /api/ocr-inbox/reviews/{review_id}                                   # review + pages/rows      ocrReview
GET  /api/ocr-inbox/reviews/{review_id}/pages/{n}                         # page Markdown            ocrReviewPage
GET  /api/ocr-inbox/reviews/{review_id}/markdown?source=raw|effective      # whole document           ocrReviewMarkdownUrl
POST /api/ocr-inbox/reviews/{review_id}/pages/{n}/{action}                # action ∈ approve|correct|restore; {revision, markdown?}   ocrReviewPageAction
POST /api/ocr-inbox/reviews/{review_id}/rows/{row_id}/{action}            # action ∈ approve|correct|reject|restore; {revision, data?, reason?}   ocrReviewAction
POST /api/ocr-inbox/reviews/{review_id}/rows                              # {revision, data} add a missed row   ocrReviewAdd
POST /api/ocr-inbox/reviews/{review_id}/verify                            # {revision} → verified   ocrReviewVerify
POST /api/ocr-inbox/reviews/{review_id}/label-level-preview/pages/{n}     # {revision, markdown} propose label levels   ocrReviewAutoLevels
POST /api/ocr-inbox/reviews/{review_id}/level-total-preview/pages/{n}     # {revision, markdown} check L0–L2 totals     ocrReviewVerifyLevelTotals
POST /api/ocr-inbox/reviews/{review_id}/pages/{n}/quick-correct-preview   # quick label corrections preview
POST /api/ocr-inbox/reviews/{review_id}/pages/{n}/quick-correct-library   # seed the label library from this page
```
Label review (local LLM via Ollama/Hermes):
```
POST /api/ocr-inbox/reviews/{review_id}/pages/{n}/label-review-runs             # {revision, targets} start   ocrHermesLabelReviewStart
GET  /api/ocr-inbox/reviews/{review_id}/pages/{n}/label-review-runs/latest      # {run|null}                   ocrHermesLabelReviewLatest
GET  /api/ocr-inbox/reviews/{review_id}/pages/{n}/label-review-runs/{run_id}    # poll a run                     ocrHermesLabelReviewRun
POST /api/ocr-inbox/label-suggestions/{suggestion_id}/decision                    # {decision, user_edited_level?}   ocrHermesLabelSuggestionDecision
POST /api/ocr-inbox/reviews/{review_id}/pages/{n}/apply-label-suggestions       # {revision, page_content_sha256, suggestion_ids}   ocrHermesLabelSuggestionsApply
```
Company history from a verified review:
```
POST /api/ocr-inbox/reviews/{review_id}/history-preview   # answers → what still blocks   historyPreview
POST /api/ocr-inbox/reviews/{review_id}/history           # write facts                    historyWrite
```
Answers: `{revision, tables:[{page, table, kind?, unit_multiplier?, columns:[{column, skip, period_type?, period_start?, period_end?}]}], lines:[{page, table, row, line_key | new_line_name}], accepted_misreads:[…], resolutions:[{fact_key, chosen}]}`.
`kind` ∈ balance | income | cashflow | skip; `unit_multiplier` ∈ 1 | 1000 | 1000000 | 1000000000.

---

## 5. Company history  (`routes/history.py`, tag `history`, prefix `/api/history`)
```
GET  /api/history/companies                                         # companies with history
GET  /api/history/{ticker}/{scope}/lines                            # line catalog for a company/scope
GET  /api/history/{ticker}/{scope}/series?lines=a,b&grain=quarter|year&from=&to=
POST /api/history/{ticker}/{scope}/resolutions                      # resolve a conflicting fact
```
`scope` ∈ consolidated | separate. Facts are written only from verified OCR reviews (§4).

---

## 6. Sync — distributed OCR coordinator  (`routes/sync.py`, tag `sync`)
```
WS   /ws/ocr                              # worker connection (pairing + PDF chunks + results)
GET  /api/sync/status                     # {pair_code, host, workers:[…], jobs:[…]}   syncStatus
POST /api/sync/pair-code                  # {pair_code} new code                     syncRegenCode
POST /api/sync/jobs/{job_id}/control      # {action: hold|stop}; 409 if not active   syncControlJob
POST /api/sync/dispatch/{filing_id}       # legacy: send a filing (kind "filing")     syncDispatch
GET  /api/sync/result/{job_id}            # rows returned for a job                    syncResult
```
OCR Inbox items are dispatched with `POST /api/ocr-inbox/{id}/run` (job kind `inbox`).
WS pairing: a loopback peer **without** an `Origin` header skips the pairing code; everyone
else gets `{"type":"pair_required"}` and must send the code. Browser origins not in
`ALLOWED_ORIGINS` are refused at the handshake (see Security).

---

## 7. AI analysis (local Hermes Agent)  (`routes/ai.py`, tag `ai`)

### POST /api/ai/chat
body: `{"provider":"hermes","page":"reader","page_context":{...},"messages":[{"role":"user","content":"..."}]}`
```json
{"answer":"..."}
```

`provider` is `hermes` by default; `cloud` is accepted only when the server-side cloud provider is
explicitly enabled. The Core proxies Hermes so `HERMES_API_KEY` never enters browser storage.
503 when the provider is unavailable.

### GET /api/ai/health
```json
{"status":"ok","provider":"hermes","model":"hermes-agent"}
```

---

## 8. News  (`routes/news.py`, tag `news`)
```
GET /api/news?limit=30                                 # collected headlines (1–100)
GET /api/news/search?q=…&count=5&time_range=day|week|month   # local SearXNG search
GET /api/news/article?url=…                            # fetch + extract one article
GET /api/news/summary                                  # today's daily note from the Obsidian vault
```

---

## 9. Gmail (broker statement import)  (`routes/gmail.py`, tag `gmail`)
```
GET    /api/gmail/settings     # settings (password never returned)
PUT    /api/gmail/settings
DELETE /api/gmail/password     # forget the stored app password
POST   /api/gmail/test         # test the IMAP connection
POST   /api/gmail/check        # check mail now
POST   /api/gmail/import       # import downloaded reports into the ledger
GET    /api/gmail/reports?limit=50
```

---

## 10. Local portfolio ledger  (`routes/portfolio.py`, tag `portfolio`)

Portfolio records retain native currencies; `display_currency` changes presentation
and projections only. Mutations return a durable `job_id`; poll the job before
assuming projections are current.

```
GET    /api/portfolio
PATCH  /api/portfolio/preferences
GET    /api/portfolio/performance?range=1m|3m|ytd|1y|all
GET    /api/portfolio/transactions?page=1&page_size=50&type=BUY&q=VNM
POST   /api/portfolio/transactions
PATCH  /api/portfolio/transactions/{id}   # replacement revision
DELETE /api/portfolio/transactions/{id}   # audited void
GET    /api/portfolio/jobs/{job_id}
```

Transaction types: `BUY`, `SELL`, `DIVIDEND`, `DEPOSIT`, `WITHDRAWAL`, `FEE`,
`TAX`. Trades require `ticker`, `quantity`, `unit_price`, `currency`, and
`effective_at`; cash events use `cash_amount`. Sells consume FIFO lots.

CSV import is staged and atomic:

```
POST /api/portfolio/imports/preview       # multipart file
POST /api/portfolio/imports/{id}/validate # {"mapping":{"CSV column":"canonical_field"}}
POST /api/portfolio/imports/{id}/commit
GET  /api/portfolio/imports/{id}/errors
```

Exports:

```
GET /api/portfolio/statement
GET /api/portfolio/transactions/export
```

Per-ticker views:

```
GET /api/portfolio/tickers    # per-ticker summary with every order/share event (newest first)   portfolioTickers
GET /api/portfolio/realized   # FIFO realized P/L per ticker and per sale, with the lots used     portfolioRealized
```

Legacy adapters (kept for one release; new UI uses the ledger):

```
POST   /api/portfolio/holdings               # converted into a BUY transaction
DELETE /api/portfolio/holdings/{holding_id}  # always 410: void or replace the transaction instead
```

---

## 11. Backtest

Long-only, daily-bar strategy simulation. Fills at the next bar's open; indicators are warmed up from 650 calendar days before `start`.

### GET /api/backtest/strategies
```json
[{"id":"sma_cross","name":"SMA crossover","description":"...",
  "params":[{"key":"fast","label":"Fast SMA","default":20,"min":2,"max":200,"step":1}]}]
```
ids: buy_hold | sma_cross | rsi_reversion | breakout.

### POST /api/backtest/run
```json
{"ticker":"VN:VNM","strategy":"sma_cross","params":{"fast":20,"slow":50},
 "start":"2021-11-09","end":"2026-11-09",
 "initial_capital":null,"fee_pct":null,"sell_tax_pct":null}
```
`ticker` is uppercased server-side. `params` omitted keys use defaults. Null/omitted `initial_capital`, `fee_pct` (percent, e.g. 0.15), `sell_tax_pct` fall back to market defaults:

| | currency | capital | fee % | sell tax % | lot | price_scale | min_hold_bars |
|---|---|---|---|---|---|---|---|
| `VN:` | VND | 100,000,000 | 0.15 | 0.1 | 100 | 1000 | 3 (T+2 settlement) |
| `VN:` index (VNINDEX, VN30, HNXINDEX, HNX30, UPCOMINDEX) | VND | 100,000,000 | 0.15 | 0.1 | 1 | 1 | 3 |
| other | USD | 10,000 | 0 | 0 | 1 | 1 | 0 |

Response:
```json
{"ticker":"VN:VNM","currency":"VND","strategy":{"id":"sma_cross","name":"SMA crossover"},
 "params":{"fast":20,"slow":50},"start":"2021-11-09","end":"2026-11-09",
 "settings":{"initial_capital":100000000,"fee_pct":0.15,"sell_tax_pct":0.1,
             "lot_size":100,"price_scale":1000,"min_hold_bars":3},
 "bars":[{"date":"2021-11-09","open":0,"high":0,"low":0,"close":0,"volume":0}],
 "equity":[{"date":"2021-11-09","value":100000000}],
 "benchmark_equity":[{"date":"2021-11-09","value":100000000}],
 "trades":[], "skipped_buys":0, "metrics":{}, "benchmark_metrics":{}}
```
`bars`, `equity` and `benchmark_equity` have equal length (bars with date >= start). `benchmark_*` is buy & hold with the same settings. `skipped_buys` counts strategy buy attempts that bought 0 shares because capital was below one lot (lot_size x price); the page uses it to explain empty trade lists.

Errors (`{"detail": "..."}`): 400 unknown strategy / invalid params / `start >= end` / fewer than 2 bars in range; 404 no price data for ticker; 503 VN provider rate-limited; 502 other provider failure.

---

## 12. Screener (rules funnel)
Replaces the removed `POST /api/scan`, `GET /api/scan/latest` and `GET /api/screener` (old scanner retired; its `scan_runs`/`scan_results` tables stay in old DB files, unread). Data is third-party and stays labelled UNVERIFIED. Ratios are stored as fractions; rule thresholds are in percent.

### GET /api/screener/rules
`{"catalog": {"<rule_id>": {"id","stage":"good|oversold|scope","label","kind","applies_to","params":{"<p>":{"default","min","max","unit"}}}}}`

Scope params: `banks` `any|exclude|no_financials|only` (`no_financials` also drops brokers, insurers and funds, matched by industry name), `industries` list, `exchanges` list of `HOSE|HNX|UPCOM` (empty = all), `flagged` `exclude|include` (default `exclude`: hides stocks under exchange warning, control, restriction or suspension; a ticker with no status data is kept). Older saved scopes get these defaults on validation.

Quality-of-earnings rules (fiscal-year data): `profit_growth_min` (worst single-year net profit growth, %), `receivable_days_change` / `inventory_days_change` (days, newest year minus N years earlier), `gross_margin_change` (percentage points), `share_dilution` (share count CAGR, %), `foreign_room` (foreign room left as % of the foreign cap, from the exchange board).

### GET /api/screener/strategies
Seeds the 4 starters on first call. Starters first, then user strategies by name.
`[{"id":1,"name":"Quality","starter_key":"quality"|null,"rules":[{"id","on","<param>":value,...}],"updated_at":"ISO UTC"}]`

### POST /api/screener/strategies   `{"name","rules":[...]}` -> strategy
### PUT /api/screener/strategies/{id}   `{"name"?,"rules"?}` -> strategy
### DELETE /api/screener/strategies/{id}  -> 204
### POST /api/screener/strategies/{id}/reset  -> strategy (starters only, restores default rules)
Errors: 404 unknown id, 409 duplicate name, 422 bad name / bad rules (also non-list `rules`), other statuses as raised by the strategy layer.

### POST /api/screener/evaluate   `{"strategy_id": int|null, "rules": [{"id":"roe_years","on":true,"x":15,"n":3}]}`
Rule params are **flat keys** on the rule object next to `id`/`on` (see `validate_rules` in `backend/app/screener/rules.py`); any other key is a 422.
```json
{"counts":{"universe":0,"in_scope":0,"passed":0,"oversold":0,"skipped":0},
 "rows":[{"symbol":"DIPCO","exchange":"HOSE","industry":"Industrials","strength":78.5,
          "flag":"warning|control|restricted|suspended|null","oversold":"yes|no|missing","note_latest_at":"ISO UTC|null","rules":{"roe_years":{"status":"pass|fail|missing|n/a","value":18.2,"score":66}}}],
 "skipped":[{"symbol":"X","missing":["roe_years"]}],
 "freshness":{"prices_as_of":"ISO UTC|null","financials_as_of":"ISO UTC|null"}}
```
Rule `status` `n/a` = the rule does not apply to this company type (e.g. a bank-only rule on a non-bank): neither a fail nor missing data. It does not drop the row, is not counted in `skipped`, and has `score: null` so it does not move `strength`. An oversold rule that is `n/a` is ignored for the `oversold` flag.

An unknown `strategy_id` returns 404 and is not stored. Rows are sorted oversold-first, then strength desc, then symbol. When `strategy_id` is given the server remembers it (`last_strategy_id`) and the passing symbols (`last_pass_symbols`). 422 on unknown rule / bad params.

`note_latest_at` is the latest created/updated time across that ticker's notes (one grouped query), or null.

### GET /api/screener/state  -> `{"last_strategy_id": int|null}`

### GET /api/screener/refresh
```json
{"running":false,"kind":null,"done":0,"total":0,"started_at":null,"queued":[],
 "prices_as_of":null,"financials_as_of":null,"last_error":null}
```
### POST /api/screener/refresh   `{"kind":"prices"|"financials"}`
202 with the status above (kind queued; a background thread picks it up). 409 if that kind is already running or queued. 422 for any other kind. 503 (nothing queued) when the refresh worker is not running. The worker starts at app startup only when `ENABLE_SCREENER_REFRESH` is true (default) AND `SCREENER_PROVIDER` is not `fixture` (the fixture provider would write fake tickers into the real DB); it queues stale kinds itself.
Prices are stale after the last trading-day close (15:00 VN); financials are re-queued 7 days after the last pass *completed* (`financials_as_of` shown to the user is the pass start). A ticker whose fetch fails or returns no data keeps its previous numbers and gets `last_error`. A rate-limit cooldown aborts the pass and puts that kind back at the front of `queued`; it resumes on the next check. A ticker with no price bar for more than 10 trading days counts as missing for `traded_value`. Each prices pass first fetches the exchange board once (status flag + foreign room, batched); a board failure is recorded in `last_error` and does not stop the price pass.

---

## 13. Ticker notes
Dated notes log per ticker. Symbols are upper-cased and a leading `VN:` is stripped. Timestamps are UTC ISO with offset.

### GET /api/notes/{symbol}  -> `[{"id","symbol","body","created_at","updated_at"}]`, newest first
`updated_at` is null until the note is edited.
### POST /api/notes/{symbol}   `{"body"}` -> 201 note. Empty or whitespace-only body: 422.
### PUT /api/notes/item/{id}   `{"body"}` -> note with `updated_at` set. 404 unknown id, 422 empty body.
### DELETE /api/notes/item/{id}  -> 204. 404 unknown id.

| Endpoint | Tables | Client | Page |
|---|---|---|---|
| GET /api/notes/{symbol} | ticker_notes | notesList | detail |
| POST /api/notes/{symbol} | ticker_notes | notesAdd | detail |
| PUT /api/notes/item/{id} | ticker_notes | notesEdit | detail |
| DELETE /api/notes/item/{id} | ticker_notes | notesDelete | detail |

---

## Contract ↔ data model ↔ HelixAPI map
| Contract endpoint | Data tables | HelixAPI method | Section |
|---|---|---|---|
| /api/quote, /api/history/{ticker}, /api/indices | prices (cache) | quote/history/indices | §1 |
| /api/statements/{ticker}, /api/ratios/{ticker} | — (provider) | statements/ratios | §2 |
| /api/filings* | filings | uploadFiling/ocrParse/saveTracker | §3 |
| /api/ocr-inbox* | ocr_inbox_items, ocr_attempts, ocr_review_jobs, ocr_page_results, ocr_review_rows, ocr_audit_events, ocr_label_review_runs, ocr_label_suggestions | ocrInbox*/ocrReview*/ocrHermes*/history* | §4 |
| /api/history/* | statement_facts, fact_resolutions | (statements page) | §5 |
| /api/sync/*, WS /ws/ocr | — (in-memory coordinator) | sync*/syncWsUrl | §6 |
| /api/ai/* | — | aiChat/complete | §7 |
| /api/news* | — | news* | §8 |
| /api/gmail/* | gmail_config, gmail_reports | gmail* | §9 |
| /api/portfolio* | portfolios, portfolio_transactions, portfolio_*_projections, portfolio_daily_snapshots, portfolio_jobs | portfolio*/addTransaction/… | §10 |
| /api/backtest/* | — | backtestStrategies/backtestRun | §11 |
| GET /api/screener/rules | — | screenerRules | §12 |
| GET /api/screener/strategies | strategies | screenerStrategies | §12 |
| POST /api/screener/strategies | strategies | screenerCreateStrategy | §12 |
| PUT /api/screener/strategies/{id} | strategies | screenerUpdateStrategy | §12 |
| DELETE /api/screener/strategies/{id} | strategies | screenerDeleteStrategy | §12 |
| POST /api/screener/strategies/{id}/reset | strategies | screenerResetStrategy | §12 |
| POST /api/screener/evaluate | ticker_metrics, screener_state | screenerEvaluate | §12 |
| GET /api/screener/state | screener_state | screenerState | §12 |
| GET /api/screener/refresh | screener_state | screenerRefreshStatus | §12 |
| POST /api/screener/refresh | screener_state | screenerRefresh | §12 |
| /api/notes/* | ticker_notes | notes* | §13 |

## Rule for the presentation tier
Every page reads data **only via HelixAPI**, and its mock fixtures use **these exact shapes**.
Then mock→live is a flip, not a rewrite.

---

## Planned / not implemented
Designed in v1 of this contract but **no backend route exists**. Kept as design notes; do not
call them. (`GET /api/statements/{ticker}` in §2 exists; `GET /api/statements/{id}` below does not.)

- `GET /api/instruments` — instrument list `[{"id","symbol","market","name","currency"}]`, `market` ∈ HOSE | HNX | UPCOM | GOLD | US.
- `POST /api/documents`, `GET /api/documents`, `GET /api/documents/{id}`, `POST /api/documents/{id}/ocr` — superseded by the OCR Inbox (§4).
  Original row shape (still the shape of legacy row reviews): `{"id","code","section","metric","curr","prev","page","confidence","status"}`;
  `section` ∈ income | balance | cashflow, `code` = Mã số (TT200), `curr`/`prev` raw digit strings.
- `GET /api/statements/{id}`, `PUT /api/line_items/{id}`, `GET /api/statements/{id}/corrections` — statement/line-item store with
  server-side reconciliation (group fails + one low-confidence member → back-solve `repaired`; ≥2 uncertain → open flag;
  tolerance `recon_tolerance`, default 1%). Not built; company history (§5) took its place.
- `POST /api/statements/{id}/analyze` — AI analysis gated on no open flags (409 otherwise). Use `POST /api/filings/{id}/analyze`.
- `WS /ws` — live document/recon events (`doc_status`, `recon`, `line_item`). The only socket is `WS /ws/ocr` (§6); pages poll.
- `GET /api/alerts`, `POST /api/alerts`, `PUT /api/alerts/{id}`, `DELETE /api/alerts/{id}` — alerts CRUD
  (`kind` ∈ price | recon_flag | job_done; `channel` ∈ dashboard | slack). The Alerts page is client-only.

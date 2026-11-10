# API Contract — Distributed Financial Analysis System

**The seam between tiers.** Presentation (artifact UI) builds to these shapes on mock data;
Business/Data tiers later implement them. When both sides match this doc, connecting =
flip `HelixAPI` to live, **zero UI change.**

- Base URL: `http://localhost:8000` (set via `localStorage.helix_api_url`)
- All bodies JSON unless noted (uploads = multipart).
- Money values: **number, đơn vị triệu đồng** unless `unit` says otherwise. EPS = đồng.
- Dates: ISO `YYYY-MM-DD`. Timestamps: unix seconds.
- Frozen v1. Changes require bumping this doc + both tiers.

Status legend per endpoint: **[P1]** market · **[P2]** documents/OCR · **[P3]** recon · **[P5]** AI · **[P6]** alerts.

---

## 0. Health & detection
```
GET /health → 200 {"status":"ok"}
```
HelixAPI pings this (1.5s). OK → live mode; else → mock.

---

## 1. Market  [P1]

### GET /api/instruments
```json
[{"id":1,"symbol":"VNM","market":"HOSE","name":"CTCP Sữa Việt Nam","currency":"VND"}]
```
`market` ∈ HOSE | HNX | UPCOM | GOLD | US.

### GET /api/quote/{symbol}
```json
{"symbol":"VNM","price":64500,"previous_close":63800,
 "change":700,"change_pct":1.10,"currency":"VND","ts":1718900000}
```
Nullable: `price`, `previous_close`, `change`, `change_pct` (provider miss → null).

### GET /api/history/{symbol}?period=1mo&interval=1d
period ∈ 1mo 3mo 6mo 1y 2y 5y ytd max
```json
[{"date":"2026-06-01","open":63000,"high":64800,"low":62900,"close":64500,"volume":1234567}]
```

### GET /api/indices
```json
{"vnindex":{"symbol":"VNINDEX","price":1280.5,"previous_close":1274.2,"change":6.3,"change_pct":0.49},
 "hnxindex":{...},"upcom":{...},"vn30":{...},"gold":{...},"usdvnd":{...}}
```
Any key may be `null` if unavailable.

### GET /api/screener?limit=50
Array of quote objects (same shape as /quote).

---

## 2. Documents & OCR  [P2]

### POST /api/documents  (multipart)
fields: `file` (PDF), `symbol` (optional), `kind` (default "BCTC")
```json
{"id":12,"status":"queued","pages":0}
```

### GET /api/documents
```json
[{"id":12,"symbol":"VNM","kind":"BCTC","status":"done","pages":8,
  "uploaded_at":1718900000}]
```
`status` ∈ queued | triaging | extracting | done | failed.

### GET /api/documents/{id}
Single document + its statements summary:
```json
{"id":12,"symbol":"VNM","kind":"BCTC","status":"done","pages":8,
 "statements":[{"id":30,"kind":"CDKT","period":"Q4 2024","unit":"triệu đồng"}]}
```

### POST /api/documents/{id}/ocr   (trigger OCR; stub in P2, GPU in P4)
Returns the parsed rows (also persisted as line_items):
```json
{"document_id":12,"rows":[
  {"id":"ta","code":"270","section":"balance","metric":"TỔNG CỘNG TÀI SẢN",
   "curr":"52800000","prev":"51000000","page":3,"confidence":73,"status":"unverified"}
]}
```
**Row shape is canonical** — matches the OCR review table (`ocr-tool.jsx`) exactly:
`section` ∈ income(KQKD) | balance(CĐKT) | cashflow(LCTT). `code` = Mã số (TT200).
`curr`/`prev` = strings (raw digits, may be "-"-prefixed). `confidence` = 0–100.
`status` ∈ unverified | verified | repaired | flagged.

---

## 3. Statements, line items, reconciliation  [P3]

### GET /api/statements/{id}
```json
{"id":30,"document_id":12,"kind":"CDKT","period":"Q4 2024","unit":"triệu đồng",
 "line_items":[
   {"id":501,"code":"100","label":"TÀI SẢN NGẮN HẠN","value":36500000,
    "prev_value":35000000,"confidence":94,"status":"verified","page":3}],
 "flags":[
   {"id":7,"rule":"270 = 100 + 200","expected":52000000,"got":52800000,
    "member_ids":[503,501,502],"status":"open"}]}
```

### PUT /api/line_items/{id}   (manual correction)
body: `{"value": 52000000}`
Effect: writes a correction, re-runs recon, updates flags. Returns:
```json
{"line_item":{"id":503,"value":52000000,"status":"repaired"},
 "flags":[{"id":7,"status":"resolved"}]}
```

### GET /api/statements/{id}/corrections   (audit trail)
```json
[{"id":1,"line_item_id":503,"old_value":52800000,"new_value":52000000,
  "source":"backsolve","created_at":1718900100}]
```
`source` ∈ backsolve | manual.

### Reconciliation behavior (server-side, no endpoint)
- Runs automatically after OCR.
- Group fails + exactly 1 low-conf member → back-solve, status=`repaired`, log correction(source=backsolve).
- Group fails + ≥2 uncertain → `recon_flags(open)`, members status=`flagged`.
- Tolerance: `recon_tolerance` (default 1%).

---

## 4. WebSocket — live progress  [P2/P3]
```
WS /ws
```
Server → client events:
```json
{"type":"doc_status","doc_id":12,"status":"extracting"}
{"type":"recon","statement_id":30,"repaired":1,"flagged":1}
{"type":"line_item","id":503,"status":"repaired","value":52000000}
```
Presentation: reader page subscribes, updates progress + review table live.

---

## 5. AI analysis (local Hermes Agent)  [P5]

### POST /api/ai/chat
body: `{"provider":"hermes","page":"reader","page_context":{...},"messages":[{"role":"user","content":"..."}]}`
```json
{"answer":"..."}
```

`provider` is `hermes` by default; `cloud` is accepted only when the server-side cloud provider is
explicitly enabled. The Core proxies Hermes so `HERMES_API_KEY` never enters browser storage.

### GET /api/ai/health
```json
{"status":"ok","provider":"hermes","model":"hermes-agent"}
```

### POST /api/statements/{id}/analyze
```json
{"summary":"...","comparison":[...],"anomalies":[...]}
```
Gate: only statements with no open flags (all verified/repaired). Else 409.

---

## 6. Local portfolio ledger

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

---

## 6. Alerts  [P6]

### GET /api/alerts
```json
[{"id":1,"kind":"price","condition":{"symbol":"VNM","op":">","value":70000},
  "channel":"dashboard","enabled":true}]
```
`kind` ∈ price | recon_flag | job_done. `channel` ∈ dashboard | slack.

### POST /api/alerts · PUT /api/alerts/{id} · DELETE /api/alerts/{id}
Standard CRUD; body = alert object (minus id).

---

## 7. Backtest

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

## Contract ↔ data model ↔ HelixAPI map
| Contract endpoint | Data tables | HelixAPI method | Phase |
|---|---|---|---|
| /api/instruments, /quote, /history, /indices | instruments, prices | indices/quote/history | P1 |
| /api/documents* , /ocr | documents, statements, line_items | uploadFiling/ocrParse | P2 |
| /api/statements, /line_items, /corrections | statements, line_items, recon_flags, corrections | statements/saveTracker | P3 |
| /ws | — | (new ws client) | P2/P3 |
| /api/ai/* | statements | aiChat/complete | P5 |
| /api/alerts* | alerts | (new) | P6 |

## Rule for the presentation tier
Every page reads data **only via HelixAPI**, and its mock fixtures use **these exact shapes**.
Then mock→live is a flip, not a rewrite.

# Helix — Frontend ↔ Backend Integration Guide

The frontend (`src/`, built with Vite into `dist/`) and the Python backend (`backend/`) are two
processes on the same Mac, both bound to 127.0.0.1. `scripts/run.sh` starts both (plus the local
OCR worker); this page explains how they connect and where things live.

## Run it

```bash
./scripts/run.sh        # backend :8000 + frontend dist/ on :5500 + OCR worker (OCR_WORKER=0 skips it)
```

`run.sh` rebuilds `dist/` when it is missing, when any file under `src/` (or `package.json`,
`package-lock.json`, `vite.config.mjs`) is newer than the last build, or when the set of source
files changed (a deleted or renamed file; the build records a hash of the file list in
`dist/.src-manifest`).

For UI work use the Vite dev server instead (hot reload, and the `#/dev/ui` component gallery):

```bash
npm install             # once
npm run dev             # http://127.0.0.1:5500
```

**`npm run dev` and `run.sh` both use port 5500** (the backend's `ALLOWED_ORIGINS` expects it), so
they conflict: stop `run.sh`'s frontend first, or start only the backend
(`cd backend && .venv/bin/uvicorn app.main:app --port 8000`). Other commands: `npm run build`
(writes `dist/`), `npm run preview` (serves `dist/` on :5500).

## Frontend layout (`src/`)

Vite root is `src/` (`vite.config.mjs`); `src/index.html` loads `src/main.jsx`.
`src/public/Financial Analyze.html` only redirects old bookmarks to `index.html`.

| Path | What it is |
|---|---|
| `main.jsx` | Entry: fonts + `styles/app.css` + the `ui` library, then renders `<App/>` |
| `app.jsx` | Shell: hash routes, sidebar/header, AI panel (a modal drawer ≤ 900px), alert monitor, toasts/dialogs |
| `api-client.jsx` | `HelixAPI`: every backend call, timeouts, live/offline detection, `ask()`/`complete()` for AI |
| `sidebar.jsx`, `header.jsx`, `route-tabs.jsx`, `shortcuts.jsx`, `shortcuts-ui.jsx` | Shell pieces |
| `watchlist-store.jsx`, `handoff.js`, `icons.jsx`, `lwchart.jsx` | Shared infra (quotes/watchlists, cross-page hand-off, icons, TradingView chart wrapper) |
| `lib/` | `router.js` (hash routes), `query.js` + `data.js` (shared data layer), `format.js` (number/money house style), `safe-url.js`, `sync-poller.js` |
| `ui/` | The component library (Lucian UX/UI ports + token-built basics). Read [`src/ui/README.md`](src/ui/README.md) before building UI |
| `pages/<section>/` | One folder per section, page-specific code and CSS only |
| `styles/` | `app.css` (theme tokens, shell layout), `charts.css`, `fonts/` |

### Routes

| Hash | Page (folder) |
|---|---|
| `#/today` · `#/today/news` · `#/today/alerts` | Today overview, News, Alerts (`pages/today/`) |
| `#/scan` · `#/scan/backtest` | Screener, Backtest (`pages/scan/`) |
| `#/company/:ticker/overview` · `/statements` · `/notes` | Company (`pages/company/`), e.g. `#/company/VN:FPT/overview` |
| `#/portfolio` | Portfolio (`pages/portfolio/`) |
| `#/inbox/ocr` · `/sync` · `/gmail` · `/activity` | OCR Inbox (`pages/inbox-ocr/`), Sync, Gmail import, Activity (`pages/inbox/`) |
| `#/settings` | Settings (`pages/settings/`) |
| `#/dev/ui` | Component gallery — dev server only, not in the production build |

### Point the frontend at another backend

```js
// browser console
localStorage.setItem('helix_api_url', 'http://127.0.0.1:8000'); location.reload();
```

On load `HelixAPI` pings `GET {base}/health`. Reachable → the header shows **API Live** and every
page uses live data; unreachable → **Backend offline**, pages show empty/offline states (no fake
numbers), and detection retries every 10 s.

## Backend layout (`backend/app/`)

| Path | What it is |
|---|---|
| `routes/` | Thin FastAPI routers (validation + one service call) |
| `services/` | Business logic (portfolio ledger, OCR inbox/review, news, alerts, Gmail, AI) |
| `jobs/` | Background job runner + interval scheduler (see below) |
| `marketdata/` | The only place that imports vnstock / yfinance (provider seam, cache, rate limit) |
| `models/` | SQLAlchemy models |
| `screener/`, `backtest/`, `newswatch/` | Screener rules + refresh, backtest engine, news watch |
| `../alembic/` | Schema migrations |

Run checks: `cd backend && .venv/bin/python -m pytest -q`.

### Background jobs — `app/jobs`, `/api/jobs`

Long work (portfolio import / rebuild, SSI rebuild, Ollama label review) runs on one `JobRunner`
(`app/jobs/runner.py`) and is recorded in the `jobs` table; periodic loops (screener refresh, Gmail
poller) run on the `Scheduler`. `app/jobs/lifecycle.py` starts both in the app lifespan, after
recovering jobs left running by a restart (they are marked failed; domain recoveries may resubmit).

To add a job kind: write the handler (it receives a `JobContext` for progress and cancel checks),
register it in a module like `app/jobs/portfolio.py`, and submit it with `runner.submit(kind, payload)`.
Worker counts: `JOB_WORKERS` (default lane), `JOB_OCR_WORKERS` (Ollama lane).

| Endpoint | |
|---|---|
| `GET /api/jobs?status=&kind=&limit=` | Recent jobs, newest first (the **Inbox → Activity** tab) |
| `GET /api/jobs/{id}` | One job with progress, message, result, error |
| `POST /api/jobs/{id}/cancel` | Request cancellation (cancellable kinds only) |

### Price alerts — `/api/alerts`

Alerts live in the `price_alerts` table (they used to be in browser localStorage). On first load
with the backend live, the frontend moves any old `helix_alerts_v1` localStorage alerts in through
`POST /api/alerts/import` (idempotent; invalid items are parked under `helix_alerts_v1_unimported`).

| Endpoint | |
|---|---|
| `GET /api/alerts` | List, newest first |
| `POST /api/alerts` | Create (201; 409 on duplicate id) |
| `PATCH /api/alerts/{id}` · `DELETE /api/alerts/{id}` · `DELETE /api/alerts` | Update, delete one, delete all |
| `POST /api/alerts/import` | Bulk import (array or `{alerts: [...]}`) → `{imported, skipped}` |

### Market data — `app/marketdata`

All vnstock / yfinance access goes through `marketdata.registry.get_provider()` (VN, chosen by
`SCREENER_PROVIDER`) and `get_global_provider()` (Yahoo). A guard test fails if any other module
imports a vendor library. To add a broker API, implement the `MarketDataProvider` protocol in
`marketdata/base.py` and register it — see [`backend/app/marketdata/README.md`](backend/app/marketdata/README.md).
vnstock is pinned at 4.0.4: do not upgrade it.

### Database migrations — Alembic

`init_db()` (app startup, or `python -m app.db init`) brings any database to head. To change the
schema: edit the model, autogenerate against a scratch DB (never `helix.db`), review the file, run
`tests/test_alembic_migrations.py`, and back up `helix.db` before the first start on the new code.
Full steps: [`backend/README.md` → Database migrations](backend/README.md#database-migrations-alembic).

## AI: Hermes Agent and Ollama

The AI panel calls `HelixAPI.ask()` → `POST /api/ai/chat` (provider `hermes` by default); the
backend proxies the authenticated Hermes Agent API at `http://127.0.0.1:8642`. Run
`hermes gateway start` with its loopback API server enabled. `scripts/run.sh` reuses
`gateway.api_server.key` from the Hermes config when `HERMES_API_KEY` is not set; if you start
FastAPI directly, export the same key as `HERMES_API_KEY`. The browser never sees the key.

OCR label correction does not use Hermes. It sends each user-marked label to local Ollama
(`gemma4:12b` by default: `ollama pull gemma4:12b && ollama serve`) with `think: false`, expecting
JSON with only `corrected_label` and `confidence`. Results stay suggestions until the user accepts
them. When a page-capable OCR worker finishes uploading every page, the server queues an Ollama
review of the remaining labels as a background job; worker acknowledgements never wait on it.

Swagger docs: http://127.0.0.1:8000/docs

## Frontend ↔ backend wiring map

| UI feature | Frontend | Endpoints |
|---|---|---|
| AI panel | `pages/today/ai-panel/` | `POST /api/ai/chat`, `GET /api/ai/health` |
| Today / watch board | `pages/today/overview/`, `watch-board/`, `watchlist/` | `/api/quote/{t}`, `/api/indices`, `/api/history/{t}` |
| News | `pages/today/news/` | `/api/news`, `/api/news/search`, `/api/news/article`, `/api/news/summary` |
| Alerts | `pages/today/alerts/` | `/api/alerts*` |
| Screener / Backtest | `pages/scan/` | `/api/screener*`, `POST /api/backtest/run` |
| Company overview / statements / notes | `pages/company/` | `/api/quote/{t}`, `/api/history/{t}`, `/api/ratios/{t}`, `/api/statements/{t}`, `/api/history/*` (verified OCR history: `companies`, `{t}/{scope}/lines`, `…/series`, `…/resolutions`), `/api/notes*` |
| Portfolio | `pages/portfolio/` | `/api/portfolio*` (transactions, performance, tickers, realized, statement, imports, jobs) |
| OCR Inbox | `pages/inbox-ocr/` | `/api/ocr-inbox/*` (reviews, pages, label-review runs, history preview/write, publish) |
| Sync / Gmail / Activity | `pages/inbox/` | `/api/sync/*`, `/api/gmail/*`, `/api/jobs*` |

## Production checklist

- [ ] Add auth before the API leaves the trusted machine (no auth today; everything binds to 127.0.0.1)
- [ ] Swap vnstock for the broker API in `app/marketdata` once vnstock gen 4/5 stops working
- [ ] Set `ALLOWED_ORIGINS` to the real frontend origin(s)

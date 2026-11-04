# Helix — Python Integration Guide

The frontend (`Financial Analyze.html` + `src/`) and the Python backend (`backend/`)
are designed to snap together with **zero UI changes**.

## The one moving part: `src/api-client.jsx`

Everything goes through the `HelixAPI` global:

- On page load it pings `GET {base}/health` (1.5s timeout).
- **Backend reachable** → `HelixAPI.live = true`, the header shows a green **API LIVE** chip,
  and AI chat / filing Q&A / OCR parse / tracker saves hit the real endpoints.
- **Backend down** → grey **MOCK DATA** chip, everything falls back to embedded mock
  data and `window.claude.complete`. The UI is fully functional either way.

### Point the frontend at your server

```js
// in the browser console:
localStorage.setItem('helix_api_url', 'http://localhost:8000'); location.reload();
```

(Default is already `http://localhost:8000` — just start the server.)

## Start the backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

Hermes Agent itself runs as a separate local gateway. Enable its authenticated
loopback API server, then run `hermes gateway start`. FastAPI connects to it at
`http://127.0.0.1:8642` by default. `scripts/run.sh` automatically reuses
`gateway.api_server.key` from the local Hermes configuration when
`HERMES_API_KEY` is not already set. If you start FastAPI directly, export the
same key as `HERMES_API_KEY` first.

OCR label correction does not use Hermes. It sends each user-marked label
directly to local Ollama and uses `gemma4:12b` by default:

```bash
ollama pull gemma4:12b
ollama serve
```

The backend sends the correction system prompt plus one label, sets
`think: false`, and requires JSON containing only `corrected_label` and
`confidence`. It does not set an output-token limit. The result remains a
suggestion until the user accepts and applies it.

When a page-capable OCR worker uploads Markdown, the server saves and checks
each page against the Obsidian library. Once `result_end` confirms every page
has arrived, the server starts Ollama review for the remaining labels in a
background thread. Worker acknowledgements are not blocked by model work, and
all resulting corrections still require an explicit user Accept or Reject.

Swagger docs: http://localhost:8000/docs

## Frontend ↔ backend wiring map

| UI feature | Frontend file | Endpoint | Status |
|---|---|---|---|
| AI sidebar chat | `src/ai-panel.jsx` | `POST /api/ai/chat`, `GET /api/ai/health` | **wired to Hermes Agent** |
| OCR label correction | `src/page-ocr-inbox.jsx` | `POST /api/ocr-inbox/reviews/{id}/pages/{page}/label-review-runs` | **wired directly to Ollama** |
| Reader "Ask about this filing" | `src/page-reader.jsx` | `POST /api/filings/{id}/ask` | **wired** (auto) |
| Reader OCR Parse | `src/ocr-tool.jsx` | `POST /api/filings/{id}/ocr-parse` | **wired** (auto) |
| Data Tracker autosave | `src/page-reader.jsx` | `PUT /api/filings/{id}/tracker` | **wired** (auto, debounced) |
| Filings list | `src/page-filings.jsx` | `GET /api/filings` | mock — swap when ready |
| PDF upload | `src/page-filings.jsx` | `HelixAPI.uploadFiling(file, meta)` | mock — swap when ready |
| "Analyze with AI" | `src/page-filings.jsx` | `POST /api/filings/{id}/analyze` | mock — swap when ready |
| Dashboard quotes | `src/page-dashboard.jsx` | `GET /api/quote/{t}`, `/api/indices` | mock — swap when ready |
| Asset detail chart | `src/page-detail.jsx` | `GET /api/history/{t}?period=1mo` | mock — swap when ready |
| Statements page | `src/page-statements.jsx` | `GET /api/statements/{t}` | mock — swap when ready |
| Portfolio | `src/page-portfolio.jsx` | `/api/portfolio`, `/api/portfolio/transactions`, `/api/portfolio/performance`, `/api/portfolio/imports/*` | live ledger with explicit read-only demo fallback |
| Screener | `src/page-screener.jsx` | `GET /api/screener` | mock — swap when ready |
| News | `src/page-news.jsx` | `GET /api/news` | mock — swap when ready |

"Wired (auto)" features detect the backend automatically. The "swap when ready" rows
keep their embedded mock data until you replace the mock arrays with `HelixAPI` calls —
each one is a 3-line change, e.g.:

```js
// in page-dashboard.jsx
const [quotes, setQuotes] = React.useState(null);
React.useEffect(() => {
  if (window.HelixAPI?.live) HelixAPI.indices().then(setQuotes).catch(() => {});
}, []);
```

## Schema contracts (already aligned)

- **OCR parse rows** — `backend/app/services/pdf.py :: parse_statements()` returns exactly
  the shape the OCR review table renders: `{id, section, metric, curr, prev, page, confidence}`.
  Tracker ids (`rev`, `gp`, `oi`, `ni`, `eps`, `cash`, `ta`, `ltd`, `te`, `ocf`, `capex`, `buyback`)
  match the Data Tracker's default rows, so imports map 1:1.
- **Tracker state** — saved verbatim as JSON (`income[]`, `balance[]`, `cashflow[]`, `flags[]`)
  to `filings.tracker` (JSON column). Same shape in localStorage and Postgres.
- **AI prompts** — `backend/app/services/ai.py` adds page context and proxies the OpenAI-compatible
  Hermes Agent API. The browser never talks to the raw model or stores the agent bearer key.

## Production checklist

- [ ] Swap yfinance → Polygon/Alpaca in `services/market.py` for real-time data
- [ ] Postgres: set `DATABASE_URL` in `.env` (sqlite is the dev default)
- [ ] Set `ALLOWED_ORIGINS` to your domain (CORS is `*` in dev)
- [ ] Add auth (python-jose is in requirements; portfolio/filings routes need a user dependency)
- [ ] For scanned PDFs add OCR: pytesseract or AWS Textract in `services/pdf.py`
- [ ] Celery + Redis for background analysis jobs (compose file already has Redis)

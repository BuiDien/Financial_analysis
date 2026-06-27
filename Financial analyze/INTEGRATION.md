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
cp .env.example .env            # add ANTHROPIC_API_KEY
uvicorn app.main:app --reload --port 8000
```

Swagger docs: http://localhost:8000/docs

## Frontend ↔ backend wiring map

| UI feature | Frontend file | Endpoint | Status |
|---|---|---|---|
| AI sidebar chat | `src/ai-panel.jsx` | `POST /api/ai/chat` | **wired** (auto) |
| Reader "Ask about this filing" | `src/page-reader.jsx` | `POST /api/filings/{id}/ask` | **wired** (auto) |
| Reader OCR Parse | `src/ocr-tool.jsx` | `POST /api/filings/{id}/ocr-parse` | **wired** (auto) |
| Data Tracker autosave | `src/page-reader.jsx` | `PUT /api/filings/{id}/tracker` | **wired** (auto, debounced) |
| Filings list | `src/page-filings.jsx` | `GET /api/filings` | mock — swap when ready |
| PDF upload | `src/page-filings.jsx` | `HelixAPI.uploadFiling(file, meta)` | mock — swap when ready |
| "Analyze with AI" | `src/page-filings.jsx` | `POST /api/filings/{id}/analyze` | mock — swap when ready |
| Dashboard quotes | `src/page-dashboard.jsx` | `GET /api/quote/{t}`, `/api/indices` | mock — swap when ready |
| Asset detail chart | `src/page-detail.jsx` | `GET /api/history/{t}?period=1mo` | mock — swap when ready |
| Statements page | `src/page-statements.jsx` | `GET /api/statements/{t}` | mock — swap when ready |
| Portfolio | `src/page-portfolio.jsx` | `GET /api/portfolio` | mock — swap when ready |
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
- **AI prompts** — `backend/app/services/ai.py` mirrors the frontend prompt templates,
  so answers feel identical in mock and live mode.

## Production checklist

- [ ] Swap yfinance → Polygon/Alpaca in `services/market.py` for real-time data
- [ ] Postgres: set `DATABASE_URL` in `.env` (sqlite is the dev default)
- [ ] Set `ALLOWED_ORIGINS` to your domain (CORS is `*` in dev)
- [ ] Add auth (python-jose is in requirements; portfolio/filings routes need a user dependency)
- [ ] For scanned PDFs add OCR: pytesseract or AWS Textract in `services/pdf.py`
- [ ] Celery + Redis for background analysis jobs (compose file already has Redis)

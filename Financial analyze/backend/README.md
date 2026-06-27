# Helix Backend

Python/FastAPI backend that powers the Helix financial analysis frontend.

## Quick start

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Set environment
cp .env.example .env
# edit .env and add your ANTHROPIC_API_KEY

# Initialize database
python -m app.db init

# Run dev server
uvicorn app.main:app --reload --port 8000
```

Open `http://localhost:8000/docs` for the auto-generated Swagger UI.

## Project layout

```
backend/
  app/
    main.py              # FastAPI app + CORS + route registration
    config.py            # Settings via pydantic-settings
    db.py                # SQLAlchemy engine + Base + init command
    deps.py              # Reusable FastAPI dependencies
    models/
      __init__.py
      user.py
      portfolio.py
      filing.py
    schemas/             # Pydantic request/response models
      __init__.py
      market.py
      portfolio.py
      filing.py
    routes/
      __init__.py
      market.py          # /api/quote, /api/history, /api/screener
      fundamentals.py    # /api/statements, /api/ratios
      portfolio.py       # /api/portfolio
      filings.py         # /api/filings — upload, list, analyze
      ai.py              # /api/ai/chat — proxies Claude with context
      news.py            # /api/news
    services/
      market.py          # yfinance wrapper + Redis cache
      fundamentals.py    # statements, ratios
      pdf.py             # pdfplumber + camelot extract
      ai.py              # Anthropic client + prompt templates
      rag.py             # embed + retrieve filing chunks (Chroma)
  uploads/               # uploaded PDFs (gitignored)
  tests/
  requirements.txt
  .env.example
  Dockerfile
  docker-compose.yml
```

## How the frontend connects

In your React pages, replace mock data with fetches:

```js
const res = await fetch('http://localhost:8000/api/quote/NVDA');
const data = await res.json();
```

The backend has CORS open in dev. For production, set `ALLOWED_ORIGINS` in `.env`.

## Build order (suggested)

1. Get `/api/quote/{ticker}` working — wire it into the dashboard
2. Add `/api/statements/{ticker}` — wire into Financial Statements page
3. Implement `/api/filings/upload` + storage — wire into Filings tab
4. Add `/api/filings/{id}/analyze` with Claude
5. Build `/api/ai/chat` for the AI sidebar (context-aware)
6. Add WebSocket `/ws/quotes` for live prices
7. Add Celery worker for background re-analysis & portfolio metrics

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/quote/{ticker}` | Latest quote |
| GET | `/api/history/{ticker}` | OHLC history |
| GET | `/api/statements/{ticker}` | Income/balance/cashflow |
| GET | `/api/ratios/{ticker}` | Computed ratios |
| GET | `/api/screener` | Filter equities |
| GET | `/api/portfolio` | User portfolio |
| POST | `/api/portfolio/holdings` | Add/update holding |
| GET | `/api/filings` | List filings |
| POST | `/api/filings/upload` | Upload PDF |
| POST | `/api/filings/{id}/analyze` | AI analysis |
| POST | `/api/filings/{id}/ask` | RAG question |
| POST | `/api/ai/chat` | AI sidebar chat |
| GET | `/api/news` | News feed |
| WS | `/ws/quotes` | Live price stream |

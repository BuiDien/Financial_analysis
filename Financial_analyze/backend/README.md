# Financial Analyze Backend

FastAPI backend for the local financial analysis prototype. The authoritative project status and
build sequence are in [`../../docs/PLAN.md`](../../docs/PLAN.md).

## Run

From `Financial_analyze/backend`:

```bash
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
.venv/bin/python -m app.db init
.venv/bin/uvicorn app.main:app --reload --port 8000
```

Swagger is available at `http://localhost:8000/docs`. Run checks with:

```bash
.venv/bin/python -m pytest
.venv/bin/python -m ruff check app tests
```

The complete app can be started from `Financial_analyze/` with `./scripts/run.sh`.

## Implemented Areas

- Market quotes/history: yfinance plus vnstock/VCI for `VN:<symbol>` tickers.
- Deterministic VN scanner: persisted runs and ranked, explicitly unverified results.
- Filing prototype: validated PDF upload, download, tracker persistence, and OCR dispatch.
- Distributed OCR coordinator: paired WebSocket worker and binary PDF chunks.
- OCR Inbox: unlabeled PDF upload, durable worker attempts/retries, persistent source-backed row review,
  audit history, deferred labels, and guarded filing publication.
- News: CafeF/global feeds, SearXNG search, public-URL article extraction, daily digest parsing.
- Portfolio prototype: one local portfolio and holdings CRUD.

## Safety Defaults

- `ENABLE_CLOUD_AI=false`: raw data is not sent to Anthropic by default.
- `ALLOW_UNVERIFIED_FILING_AI=false`: filing analysis/Q&A stays blocked until reconciliation exists.
- `ENABLE_SCHEDULER=false`: a full guest-tier VN scan takes hours and must currently be triggered explicitly.
- Article extraction rejects localhost, private, link-local, and other non-public targets.

The API does not yet have authentication. Keep it on a trusted machine/network; do not expose port
8000 publicly. Authentication and migration tooling are Phase-0 release blockers.

## Important Boundaries

- `Filing` and `/api/statements/{ticker}` are prototype models/routes, not the target verified
  document model.
- The laptop worker transport is implemented, but `run_ocr()` still returns a placeholder row.
- Scanner and market-provider data are `verified=false`; they are candidate-generation inputs.
- Real statement analysis must wait for the canonical schema, TT200 placement, and reconciliation gate.

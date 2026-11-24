# Financial Analyze Backend

FastAPI backend for the local financial analysis prototype. The authoritative project status and
build sequence are in [`../../docs/PLAN.md`](../../docs/PLAN.md).

## Run

From `Financial_analyze/backend`:

```bash
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt
cp .env.example .env
.venv/bin/python -m app.db init
.venv/bin/uvicorn app.main:app --reload --port 8000
```

Swagger is available at `http://localhost:8000/docs`. Run checks with:

```bash
.venv/bin/python -m pytest
.venv/bin/python -m ruff check app tests
```

## Hermes Agent

AI chat defaults to the full Hermes Agent gateway, not a raw Ollama/MLX model endpoint. Configure
Hermes in `~/.hermes/.env`, start it, then put the matching key in `backend/.env`:

```bash
# ~/.hermes/.env
API_SERVER_ENABLED=true
API_SERVER_KEY=change-me-local-dev

hermes gateway run
```

For a persistent background service, run `hermes gateway install` once, followed by
`hermes gateway start`.

```dotenv
# backend/.env
AI_PROVIDER=hermes
HERMES_API_URL=http://127.0.0.1:8642
HERMES_API_KEY=change-me-local-dev
HERMES_MODEL=mlx-community/gemma-4-26B-A4B-it-OptiQ-4bit
```

Use `GET /api/ai/health` to verify the complete `browser -> FastAPI -> Hermes` path. The API key
is never stored in browser settings. Cloud AI remains an explicit opt-in provider.

OCR label correction is separate from general AI chat. It sends one user-marked
label directly to local Ollama using `gemma4:12b`, with thinking disabled and a
strict JSON response. Install and start it before using **Ask Ollama**:

```bash
ollama pull gemma4:12b
ollama serve
```

The defaults use `http://127.0.0.1:11434`, a 60-second timeout, and a 4096-token
context. Override them with `OLLAMA_API_URL`, `OLLAMA_OCR_MODEL`,
`OLLAMA_TIMEOUT_SECONDS`, and `OLLAMA_OCR_NUM_CTX`. There is intentionally no
output-token cap. Ollama only creates a suggestion; the user's **Accept** action
applies it.

For page-based worker results, automatic label review is enabled by default.
Each page is saved first and checked against the Obsidian library. After the
worker sends `result_end`, unknown labels are reviewed by Ollama in the
background, one label at a time. The worker does not wait for Ollama. Set
`ENABLE_AUTOMATIC_OCR_LABEL_REVIEW=false` to disable this or change
`AUTOMATIC_OCR_LABEL_LIMIT` to control the maximum labels per document.

The complete app can be started from `Financial_analyze/` with `./scripts/run.sh`.

## Implemented Areas

- Market quotes/history: yfinance plus vnstock/VCI for `VN:<symbol>` tickers.
- VN screener rules funnel: editable good-company + oversold rules, saved strategies, background
  vnstock refresh (prices daily, financials weekly), explicitly unverified results.
- Filing prototype: validated PDF upload, download, tracker persistence, and OCR dispatch.
- Distributed OCR coordinator: paired WebSocket worker and binary PDF chunks.
- OCR Inbox: unlabeled PDF upload, durable worker attempts/retries, persistent source-backed row review,
  audit history, deferred labels, and guarded filing publication.
- News: CafeF/global feeds, SearXNG search, public-URL article extraction, daily digest parsing.
- Local portfolio ledger: audited transactions, FIFO lots, multi-currency valuation,
  TWR snapshots, durable CSV imports/jobs, and generated exports. Aggregate holdings
  are derived projections; the old holdings POST endpoint is compatibility-only.

## Safety Defaults

- `ENABLE_CLOUD_AI=false`: raw data is not sent to Anthropic by default.
- `ALLOW_UNVERIFIED_FILING_AI=false`: filing analysis/Q&A stays blocked until reconciliation exists.
- `ENABLE_SCREENER_REFRESH=true`: starts the screener background refresh thread (prices after close, financials weekly); set false to disable. `SCREENER_PROVIDER` defaults to `vnstock` (VCI source; ~4 rate-limited calls per ticker for financials, 1 for prices). The thread never starts while `SCREENER_PROVIDER=fixture` (tests/dev sample data), so fake sample tickers never reach the real DB; `POST /api/screener/refresh` returns 503 then.
- Article extraction rejects localhost, private, link-local, and other non-public targets.

The API does not yet have authentication. Keep it on a trusted machine/network; do not expose port
8000 publicly. Authentication and migration tooling are Phase-0 release blockers.

## Important Boundaries

- `Filing` and `/api/statements/{ticker}` are prototype models/routes, not the target verified
  document model.
- The laptop worker transport is implemented, but `run_ocr()` still returns a placeholder row.
- Scanner and market-provider data are `verified=false`; they are candidate-generation inputs.
- Real statement analysis must wait for the canonical schema, TT200 placement, and reconciliation gate.

## News watch

Telegram alerts for holdings that turn oversold (with a local-LLM verdict on whether news explains it)
and for market-wide / Vietnam-topic events. Runs as three Hermes cron jobs, Mon-Fri, Asia/Ho_Chi_Minh:

| Job | Time | Mode |
| --- | --- | --- |
| `news-daily-collect` | 08:00 | agent; writes the daily digest into the vault, delivery `local` |
| `newswatch-morning` | 08:30 | no-agent script; delivers to Telegram |
| `newswatch-after-close` | 15:15 | no-agent script; delivers to Telegram |

**One-time setup**

1. Create a Telegram bot with BotFather and connect it to the Hermes gateway (`hermes gateway setup`,
   or the Telegram section of `~/.hermes/config.yaml`). Send a test message from Hermes to confirm.
2. SearXNG and the llama.cpp / Hermes API must be running at 08:00, 08:30 and 15:15. If the model is
   offline, verdicts degrade to `unavailable` (the morning alert then sends the matched articles
   unverified); if SearXNG is down or only returns general (non-news) results, it is listed under
   "Sources unavailable".
3. Register the jobs (safe to re-run; existing jobs are skipped):

   ```bash
   Financial_analyze/scripts/register_newswatch_cron.sh --dry-run   # print commands only
   Financial_analyze/scripts/register_newswatch_cron.sh
   ```

   Hermes only runs scripts that live inside `~/.hermes/scripts/` (it resolves and blocks symlinks
   pointing elsewhere), so the script writes a small real Python wrapper there per job script. Each
   wrapper has the absolute repo paths baked in and execs `backend/.venv/bin/python` on the repo script
   (with `PYTHONPATH`/`PYTHONHOME` cleared). `--dry-run` prints the wrapper contents instead of writing
   them. Re-run the script after moving the repo. It aborts if `hermes cron list --all` fails, matches
   existing jobs by exact name, and reports `failed to create <name>` (exit 1) without stopping the
   other jobs.

**Pause or remove**

```bash
hermes cron list --all
hermes cron pause <job_id>           # hermes cron resume <job_id> to undo
hermes cron remove <job_id>
hermes cron runs                        # execution history
```

`pause`, `resume` and `remove` take a job id; use the id shown by `hermes cron list`.

**Where alerts are logged**: the `news_alerts` table (dedupe and daily caps) and the vault note
`News/Alerts/<date>.md`.

**Configuration**: `backend/newswatch.json` is user-editable: alert thresholds (`thresholds`: RSI
trigger/reset, drop % over N sessions, news look-back days, daily holding-alert cap, VN-Index day drop %;
a missing key falls back to the `NEWSWATCH_*` settings), global topics, ticker aliases, and the ETF list
excluded from holding alerts. Changes apply on the next run.

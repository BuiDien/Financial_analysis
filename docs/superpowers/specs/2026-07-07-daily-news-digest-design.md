# Daily news digest — vault + website design

**Date:** 2026-07-07
**Status:** approved in brainstorming, pending spec review
**Related:** `docs/PLAN.md` Stage 8 (news/search layer), `docs/design/HERMES_BRAIN.md`
("daily cadence" note), `docs/superpowers/specs/2026-07-06-news-tab-real-news-design.md`
(this spec builds on its `backend/app/services/news.py` shared module, already built),
`news_collector.py` (repo root, standalone multi-source collector, bug-fixed this session),
`/Users/dien/Obsidian/Projects/Financial_Automation/MOC_Financial_Tools.md` (names this
pillar as "Daily Market Monitor", note file never created).

## Goal

The website's News tab (built in the 2026-07-06 spec) shows a live but unsummarized feed —
no narrative, no "what happened today" digest. Build the pipeline that: downloads every
article the collector can find once a day, has Hermes read all of them and write a
per-article summary plus one day-level summary into the vault, and serves that summary to
the website. This is the "Daily Market Monitor" pillar already planned (and named) in the
user's Obsidian vault but never built.

## Decisions made

- **Merge collectors**: fold `news_collector.py`'s broader source set (yfinance
  stock+global news, StockTwits, Reddit, Exa) into `backend/app/services/news.py`'s
  existing sources (CafeF RSS, SearXNG search) — one canonical collector going forward,
  no duplicate systems.
- **Cadence: daily, via Hermes's own scheduler** — `hermes cron create` with `--script`,
  not a separate system cron. Script mode runs the collector and injects its stdout into
  the agent's prompt for that run.
- **Collector just downloads, no filtering/curation** — matches the existing
  per-source try/except-and-skip behavior already in both source files.
- **Hermes writes per-article summaries AND a day-level summary into the SAME daily vault
  note** — two sections (day summary on top, per-article summaries below grouped by
  source), not split across files, not appended to a separate rolling hub file.
- **Website reads the vault file directly** via a new backend endpoint — no live Hermes
  call per page load (daily cron pre-computes it).

## Architecture

```
Hermes cron (daily, e.g. 06:00)
  │
  ▼
collect_daily_news.py  (~/.hermes/scripts/, deterministic, no LLM)
  merges: yfinance stock+global · StockTwits · Reddit · Exa · CafeF RSS · SearXNG
  │
  ├─ writes  Projects/Financial_Automation/News/{date}.md   (raw articles, all sources)
  └─ stdout: short confirmation, not full article text → injected into Hermes's prompt
  │
  ▼
Hermes Agent (Qwen3 35B)
  reads today's raw note in full, rewrites that SAME file in place:
    1. Day Summary   (top, one paragraph, decision-oriented — kết luận/xu hướng/rủi ro)
    2. Per-article summaries (below, 1-2 lines each, grouped by source, url preserved)
  │
  ▼
GET /api/news/summary   (backend/app/routes/news.py)
  computes today's filename, reads the note off disk (same Mac), parses the two
  sections, returns JSON. Missing/unprocessed file → { stale: true }, never a 500.
  │
  ▼
page-news.jsx — "Daily Digest" panel
  day summary up top; per-article summaries expandable below; existing live feed
  (CafeF + yfinance, from the 07-06 spec) keeps rendering unchanged beneath it.
```

## Components

### 1. Merged collector — `~/.hermes/scripts/collect_daily_news.py` (new)

Path is fixed by `hermes cron --script` (must live under `~/.hermes/scripts/`). Combines:

- From `news_collector.py`: `fetch_reddit_rss`, `fetch_stocktwits`, `fetch_yfinance_news`,
  `fetch_yfinance_global_news`, `fetch_rss_feeds`, `fetch_exa_search`,
  `deduplicate_articles` — carrying forward this session's fixes (Exa `MCPORTER_CONFIG`
  env injection + `exa/search` source tag, Reddit 429 backoff+retry, corrected RSS feed
  URLs).
- From `backend/app/services/news.py`: `fetch_vn_rss` (CafeF), `search_web` (SearXNG) —
  imported directly, no duplicated fetch logic.
- Output: writes `Projects/Financial_Automation/News/{date}.md` — front matter with
  date + per-source counts, then one heading per source listing title/url/summary
  snippet for every article (same shape the current JSON output already has, just
  rendered as markdown instead of dumped to a `.json` file).
- Stdout: one line, e.g. `Collected 294 articles for 2026-07-07 →
  Projects/Financial_Automation/News/2026-07-07.md — summarize them.` Deliberately not
  the full article text — hundreds of articles would blow the prompt; Hermes re-reads
  the file itself for full content.
- Zero articles collected across every source → still write the note with a "no
  articles collected today" placeholder, so the cron run completes and Hermes doesn't
  invent content over an empty file.

### 2. Hermes cron job — registration, no new code

One `hermes cron create "<schedule>" "<prompt>" --script collect_daily_news.py --workdir
<repo path>` command, documented in the implementation plan and run once to register (not
part of the codebase — a local Hermes config entry). The prompt instructs Hermes to open
today's note (path derivable from the stdout confirmation or today's date), read every
article, and rewrite the file in place with the two sections described in Architecture.
Reuses the same report schema already used for statement analysis (kết luận, xu hướng,
cảnh báo rủi ro), scaled to a market-wide daily digest instead of one company.

### 3. Backend endpoint — `GET /api/news/summary` (new, `backend/app/routes/news.py`)

- Computes `Projects/Financial_Automation/News/{today}.md` from the server's local date.
- Reads the file; parses out the "Day Summary" heading's body and the per-article list
  (source, title, url, 1-2 line summary) from underneath it.
- Returns `{date, day_summary, articles: [{source, title, url, summary}], updated_at,
  stale}`.
- `stale: true` (with `day_summary: null`) when: the file doesn't exist yet, or it exists
  but has no "Day Summary" heading (raw dump not yet processed by the cron run).

### 4. Frontend — `page-news.jsx` + `api-client.jsx`

- `api-client.jsx`: add `newsDailySummary()` → `GET /api/news/summary`.
- `page-news.jsx`: new "Daily Digest" panel above the existing live feed list (built in
  the 07-06 spec, unaffected) — renders `day_summary`, then per-article summaries in an
  expandable list. Reuse the existing feed-row component for each article rather than
  building a new one. `stale: true` → "No digest yet — check back after today's run"
  placeholder instead of an error state.

## Error handling summary

| Failure | Behavior |
|---|---|
| Collector: any single source down | unchanged from today — skip that source, keep the rest |
| Collector: zero articles collected | still writes the daily note with a placeholder row; cron run completes normally |
| Hermes cron job fails (agent error, Ollama down, etc.) | raw dump stays in the vault file un-summarized; endpoint finds no "Day Summary" heading → `stale: true` |
| Vault file missing (before the first run of the day) | endpoint 200s with `stale: true`, not 404/500 |
| Backend down entirely | existing mock-data fallback on the frontend (unchanged, per 07-06 spec) |

## Testing

- Unit tests for the merged collector's dedup + per-source counters, using recorded
  fixtures (extends the `backend/tests/test_news_service.py` / `test_news_route.py`
  pattern already in place) — no live network calls in CI.
- Unit test for the vault-note parser: feed it a hand-written processed note fixture
  (both sections present) and a raw/unprocessed one (no Day Summary heading), assert the
  `stale` branch triggers correctly on the latter.
- pytest for `GET /api/news/summary`: file present+processed → 200 with parsed content;
  file present but raw → `stale: true`; file absent → `stale: true`.
- Manual end-to-end: `hermes cron run <job-name>` to fire the job once on demand, confirm
  the vault note is rewritten with both sections, confirm the endpoint returns it,
  confirm the website panel renders it.

## Out of scope

- Camoufox, real sentiment scoring, per-ticker digest pages — same exclusions carried
  over from the 07-06 spec.
- A rolling/historical digest index (e.g. `01_Daily_Market_Monitor.md` as a MOC linking
  past days) — the vault's `MOC_Financial_Tools.md` names that file, but nothing in this
  spec requires it; today's dated note alone satisfies the website's current need.
  Revisit if multi-day browsing is wanted later.
- Automatic retry of a failed Hermes cron run — a stuck `stale: true` just waits for the
  next day's run or a manual `hermes cron run`.
- Editing or regenerating a day's digest from the website after the fact (read-only for
  now).

## Risks / notes

- Depends on the Hermes Agent's cron scheduler actually being installed and running — the
  07-06 spec's own out-of-scope note says "Hermes isn't installed yet" as of that spec.
  Confirm it's set up before this pipeline can run for real; the endpoint and note parser
  can still be built and tested against fixture files independently of that dependency.
- `read_article`'s known SSRF exposure (flagged in the 07-06 spec, accepted there for
  single-user localhost use) is unrelated to this pipeline — it isn't called with
  caller-supplied URLs here — but it's still open and worth remembering.
- Vault path (`/Users/dien/Obsidian`) and `~/.hermes/scripts/` are local, single-machine
  paths — consistent with the project's "fully local" principle, but means this pipeline
  only works on the Mac where both the vault and Hermes Agent live.
- Same artifact-wipe risk as always: `page-news.jsx` / `api-client.jsx` edits must be
  ported into the design artifact before any re-export overwrites `src/`.

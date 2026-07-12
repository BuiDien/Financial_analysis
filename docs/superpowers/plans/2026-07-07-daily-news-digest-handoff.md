# Daily News Digest — handoff to Hermes

**Plan:** `docs/superpowers/plans/2026-07-07-daily-news-digest.md`
**Design:** `docs/superpowers/specs/2026-07-07-daily-news-digest-design.md`
**Status:** Tasks 1-5 complete, reviewed, staged (not committed). Task 6 (cron registration) blocked — needs your help.

## What Tasks 1-5 built

### Task 1 — Merged collector fetch functions

`Financial_analyze/backend/app/services/news_collector.py` (new). Moved a standalone root-level `news_collector.py` script's fetchers into the backend, reusing the existing `app.services.news` module for CafeF RSS / SearXNG instead of duplicating logic:

- `fetch_reddit_rss(ticker, sub, limit)` — Reddit search RSS, 429 retry-once with 30s backoff
- `fetch_stocktwits(ticker, limit)` — StockTwits public API
- `fetch_yfinance_news(ticker)` — per-ticker yfinance news
- `fetch_yfinance_global_news()` — macro/global yfinance search
- `fetch_global_rss_feeds()` — CNBC/Bloomberg/MarketWatch/Yahoo
- `fetch_exa_search(queries, limit)` — mcporter/Exa (needs `MCPORTER_CONFIG=/Users/dien/config/mcporter.json` env var)
- `fetch_searxng_search(queries, count)` — wraps `news.search_web()`
- `deduplicate_articles(articles)` — normalized-title dedup

Tests: `Financial_analyze/backend/tests/test_news_collector.py`, 8 tests, all mocked (no live network). Reviewed clean.

### Task 2 — Vault note writer/parser + orchestrator

Same module, appended:

- `collect_all_articles(date)` — runs every fetcher, merges, dedupes, returns `{collection_date, total_articles, sources: {8 categories}, articles}`
- `write_daily_note(date, result, vault_dir)` — writes the raw dump to `Projects/Financial_Automation/News/{date}.md`
- `parse_daily_note(path)` — reads it back into `{processed, day_summary, articles}`

**This is the exact note format you (Hermes) need to read and rewrite — see "Your job" below.**

Tests: 6 more (14 total in the file). One fix round: strengthened a round-trip test, confirmed the article-parsing regex already handles URLs containing a literal `)` correctly via backtracking (no code change needed there). Reviewed clean, 15/15 passing.

### Task 3 — Cron entrypoint script

`Financial_analyze/scripts/collect_daily_news.py` (new). CLI: `--date today|YYYY-MM-DD`. Calls `collect_all_articles` + `write_daily_note`, prints one confirmation line to stdout. Self-relaunches under `Financial_analyze/backend/.venv/bin/python` if invoked by any other python3 (so it works regardless of what interpreter your cron scheduler calls it with).

Live-verified: run with `/usr/bin/python3` (system python, no yfinance installed), confirmed it re-exec'd into the venv and completed — **336 articles** collected, real note written to `/Users/dien/Obsidian/Projects/Financial_Automation/News/2026-01-01.md`. Reviewed clean.

### Task 4 — Backend endpoint

`Financial_analyze/backend/app/routes/news.py` (modified — added one route, existing `/news`, `/news/search`, `/news/article` untouched).

`GET /api/news/summary` — computes today's filename, reads `Projects/Financial_Automation/News/{today}.md` via `parse_daily_note`, returns `{date, day_summary, articles, updated_at, stale}`. Always 200 — never 404/500, even on a missing or corrupted file.

Tests: `test_news_summary_route.py`, 4 tests (processed / missing / unprocessed / invalid-encoding). Reviewed clean, 67/67 full backend suite passing, no regressions.

### Task 5 — Frontend panel

`src/api-client.jsx` (added `newsDailySummary()`), `src/page-news.jsx` (added a "Daily Digest" panel — renders `day_summary` via the existing markdown formatter, expandable per-article list below it, a "no digest yet" placeholder when `stale: true`).

Verified via live curl of the endpoint + hand-traced JSX (no browser available in the build environment). Reviewed clean.

**Note:** `page-news.jsx`/`api-client.jsx` are exported from a Claude design artifact — the user needs to port these edits into the artifact before its next re-export, or they'll be lost.

## Your job (what Task 6 asks of you)

Once a job is registered (see blocker below), it should fire daily. Each run:

1. A fresh raw note appears at `Projects/Financial_Automation/News/{today}.md` — front matter with `processed: false`, a `## Day Summary` placeholder, and a `## Articles` section with articles grouped under `### <source>` headings, each as:
   ```
   - **[title](url)** — summary
   ```
2. Read every article under every source heading.
3. Rewrite that SAME file in place:
   - Replace the placeholder line under `## Day Summary` with one decision-oriented paragraph summarizing the market's day overall — kết luận / xu hướng / cảnh báo rủi ro style, same as your statement-analysis reports, but market-wide instead of one company.
   - Under each source heading, replace each article's summary (the text after the em-dash) with your own 1-2 line summary of that specific article — keep the exact `- **[title](url)** — summary` format, keep the title and url unchanged, only rewrite the trailing summary text.
   - Change `processed: false` to `processed: true` in the front matter.
   - Do not add or remove articles — only rewrite summaries and the front matter flag.

The backend endpoint (`GET /api/news/summary`) checks for `processed: true` to decide whether to serve your summary or report `stale: true` — so step 3's front-matter flip is what makes the website show your work.

## Blocker: Task 6 (cron registration) — needs your input

The plan's design was: keep `collect_daily_news.py`'s source in the git repo (`Financial_analyze/scripts/collect_daily_news.py`), and symlink it into `~/.hermes/scripts/` so `hermes cron create --script` can find it while the repo stays the single source of truth.

That failed:

```
$ ln -sf "/Users/dien/Work/Project/Financial_analyze/Financial_analyze/scripts/collect_daily_news.py" ~/.hermes/scripts/collect_daily_news.py
$ hermes cron create "0 6 * * *" "..." --name daily-news-digest --script collect_daily_news.py --workdir "/Users/dien/Work/Project/Financial_analyze/Financial_analyze"

Failed to create job: Script path escapes the scripts directory via traversal: 'collect_daily_news.py'
```

**Root cause**, traced in your own source:

`~/.hermes/hermes-agent/tools/path_security.py::validate_within_dir()`:
```python
resolved = path.resolve()            # follows symlinks to their real target
root_resolved = root.resolve()
resolved.relative_to(root_resolved)  # raises if the real target is outside root
```

`Path.resolve()` follows the symlink to its real target. Since `~/.hermes/scripts/collect_daily_news.py` → `.../Financial_analyze/scripts/collect_daily_news.py`, and that real path is outside `~/.hermes/scripts/`, the containment check in `tools/cronjob_tools.py::_validate_cron_script_path` rejects the job. The docstring says this exists "to prevent arbitrary script execution via prompt injection" — this looks like intentional hardening, not a bug, and it doesn't special-case a symlink the user made on purpose.

Confirmed while diagnosing: your local model backend (mlx_lm, `Qwen3.6-35B-A3B-OptiQ-4bit` on `127.0.0.1:8081`) is up and reachable — this isn't a "model not running" problem, purely the script-path check. Also noted: the installed Hermes is 14 commits behind upstream.

**Three options, needs a decision (nothing was changed unilaterally):**

1. **Plain copy** — put an actual (non-symlinked) copy of `collect_daily_news.py` in `~/.hermes/scripts/` instead of a symlink. Unblocks immediately. Trade-off: it's now a second copy that drifts from the repo version if the script is edited later — needs a manual re-copy step after any edit, or some other sync mechanism if that's not acceptable.
2. **`hermes update`** — worth checking if a newer revision (you're 14 commits behind) relaxes this, though it reads as deliberate hardening likely to persist.
3. **Check for an allowlist** — the diagnosis only checked `_validate_cron_script_path`/`validate_within_dir`; there may be a config option for trusted external script directories that wasn't found in that quick pass.

Once resolved, the remaining steps are: `hermes cron create` with the schedule/prompt above, `hermes cron run daily-news-digest` once to verify end-to-end, then confirm `GET http://localhost:8000/api/news/summary` returns `stale: false` with a real `day_summary`.

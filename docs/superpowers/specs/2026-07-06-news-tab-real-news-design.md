# News tab on real news (VN + US) — design

**Date:** 2026-07-06
**Status:** approved in brainstorming, pending spec review
**Related:** `docs/PLAN.md` Stage 8 (news/search layer), `docs/design/HERMES_BRAIN.md`,
`Financial_analyze/backend/app/mcp/news_search_tools.py` (MCP server, already built),
`scripts/setup_searxng.sh` / `scripts/run_searxng.sh` (SearXNG, already installed and verified).

## Goal

The website's News tab currently renders mock/hallucinated content: the feed comes from a
broken yfinance call (returns `[]` — yfinance moved its news payload into a `content`
envelope and `services/market.get_news` still reads the old flat keys), the story modal
asks the LLM to invent article text from a headline, and the "Research" box synthesizes a
briefing from mock headlines. Replace all three with the real news layer that already
exists as MCP tools: CafeF RSS (VN), SearXNG (web search), Trafilatura (article
extraction) — plus a fixed yfinance feed for US news.

## Decisions made

- **Scope: full** — real feed, real article reads, real search. Not feed-only.
- **Reuse: shared module** — one source of truth for fetch logic; MCP server and FastAPI
  routes both import it. No duplication, no backend-calls-MCP indirection.
- **Search UX: SearXNG + AI briefing** — show real result links AND feed them to the LLM
  for a grounded briefing. No more briefings invented from thin air.
- **SearXNG lifecycle: started by `run.sh`** — search always works when the app is up;
  backend still degrades gracefully if SearXNG is down.
- **Feed source: VN + US mix** — CafeF RSS (VN) merged with fixed yfinance news (US).
  Tabs become All / VN Market / VN Companies / US.

## Architecture

One shared module holds all news fetch logic. Three consumers:

```
backend/app/services/news.py   (new — shared fetch logic, no mcp/yfinance imports)
        ├── backend/app/routes/news.py      (FastAPI — website endpoints)
        └── backend/app/mcp/news_search_tools.py  (MCP server for Hermes — thin wrapper)

backend/app/services/market.py  (yfinance news fix stays here, with the other yfinance code)
```

The deterministic scanner never touches any of this (unchanged trust principle:
no news/LLM input to scan scoring).

## Components

### 1. Shared module — `backend/app/services/news.py` (new)

Moves the fetch logic out of `mcp/news_search_tools.py`:

- `fetch_vn_rss(query: str | None = None, limit: int = 30) -> list[dict]`
  CafeF category feeds (`thi-truong-chung-khoan.rss`, `doanh-nghiep.rss`) with the
  browser User-Agent (CafeF 503-blocks default UAs). Optional case-insensitive keyword
  filter against title+summary (the existing `get_latest_news` behavior). Returns
  `{title, url, published, category}` where `published` is epoch seconds (converted from
  feedparser's `published_parsed`; `0` if the entry has no date) and `category` is
  `market` or `companies` depending on the source feed.
- `search_web(query: str, count: int = 5) -> list[dict]`
  SearXNG JSON API at `SEARXNG_URL` (default `http://127.0.0.1:8888`). Returns
  `{title, url, content}`. Raises `RuntimeError` with a clear "is it running?" message
  when unreachable.
- `read_article(url: str) -> dict`
  Trafilatura fetch + extract. Returns `{url, title, text}`. Raises `RuntimeError` when
  the page can't be fetched or yields no article text.

Constraints:
- **No `mcp` import** (the SDK conflicts with the backend's pinned fastapi — that's why
  the MCP server has its own venv).
- **No `yfinance` import** (the MCP venv doesn't have it and doesn't need it).
- Must be importable from both the backend venv and the MCP venv
  (`backend/app/mcp/.venv`).

`mcp/news_search_tools.py` becomes a thin wrapper: keeps `FastMCP`, the `@mcp.tool()`
registrations, and the tool docstrings (they are the LLM-facing API); bodies delegate to
the shared module. The MCP venv already has `feedparser` and `trafilatura`. The wrapper
must keep working when run as a plain script (`python news_search_tools.py`), so it needs
a small sys.path bootstrap (or equivalent) to import `app.services.news` from outside the
package context.

### 2. yfinance news fix — `backend/app/services/market.py`

`get_news` currently reads `n.get("title")` etc. from the old flat shape; the current
yfinance returns `{id, content: {title, pubDate, provider: {displayName}, canonicalUrl:
{url}, ...}}`. Fix to read the `content` envelope. Keep the existing defensive
`except → []`.

### 3. Backend routes — `backend/app/routes/news.py`

- `GET /api/news?limit=30`
  Merge `fetch_vn_rss()` + fixed `market.get_news()` (US), normalized to:
  ```json
  {"title": str, "publisher": str, "url": str, "published": int(epoch seconds),
   "tickers": [str], "region": "vn"|"us", "category": "market"|"companies"|"us"}
  ```
  Sorted newest first, truncated to `limit`. If one source fails, return the other
  (partial results, never a 500 for a single upstream failure).
- `GET /api/news/search?q=...&count=5`
  Proxies `search_web`. SearXNG unreachable → **503** with a message telling the user to
  start it (`./scripts/run_searxng.sh`).
- `GET /api/news/article?url=...`
  Proxies `read_article`. Fetch/extract failure → **422** with the error message.

### 4. `scripts/run.sh`

Start SearXNG alongside backend + frontend. Skip with a note if port 8888 is already in
use (someone ran `run_searxng.sh` manually). Stop it with the rest on exit, matching
however `run.sh` currently manages its child processes.

### 5. Frontend

Files: `src/api-client.jsx`, `src/app.jsx`, `src/page-news.jsx`.

- **api-client**: add `newsSearch(q, count)` → `/api/news/search`, `newsArticle(url)` →
  `/api/news/article`.
- **app.jsx `applyNews`**: keep `url`, `region`, `category` on mapped items; keep
  deriving display time from the epoch. Mock fallback path unchanged.
- **page-news.jsx**:
  - Tabs: **All / VN Market / VN Companies / US**, filtering on `category` (replaces the
    tag-based Macro/Equities/Crypto filters, which can't match the new data).
  - Story modal: "Read full story" calls `/api/news/article` and renders the real text.
    On failure: show the error and an "Open original ↗" link to the source URL. The
    AI-invent-the-article path is removed.
  - Research box: on submit, call `/api/news/search`; render the result links; then feed
    result titles+snippets to `HelixAPI.complete` for a grounded briefing (same briefing
    format as today, but sourced from real search results instead of mock headlines).
    SearXNG down (503) → show "Search unavailable — start ./scripts/run_searxng.sh",
    no LLM call.
  - Sentiment pill: no real sentiment data — keep rendering neutral for now.
  - Sidebar mock cards (Trending Tickers, Economic Calendar) stay as-is.
  - Hero story's hardcoded Fed-minutes blurb: drop the fake paragraph (real items have
    no summary text to put there).

## Error handling summary

| Failure | Behavior |
|---|---|
| CafeF RSS down | `/api/news` returns US-only (partial) |
| yfinance down/broken | `/api/news` returns VN-only (partial) |
| SearXNG down | `/api/news/search` → 503; UI shows "start ./scripts/run_searxng.sh" |
| Article blocked/paywalled/JS-only | `/api/news/article` → 422; modal shows error + "Open original ↗" |
| Backend down entirely | existing mock-data fallback (unchanged) |

## Testing

- **pytest** (`backend/tests/`): normalization + merge logic with mocked feed XML and a
  mocked new-shape yfinance payload; route tests with monkeypatched fetchers covering
  partial-failure (one source down) and the 503/422 error paths.
- **MCP wrapper**: smoke test that the three tools still register and delegate (importable
  + `list_tools` returns the 3 names).
- **Manual e2e**: run the app, confirm real VN+US headlines, open a story (real text),
  research a subject (links + grounded briefing), then stop SearXNG and confirm the
  graceful search-unavailable message.

## Out of scope

- Camoufox (headless-browser fallback for hard-blocked sites) — still reserved, per
  HERMES_BRAIN.md.
- Real sentiment scoring, real trending tickers, real economic calendar.
- Per-ticker news on other pages (detail page etc.) — this spec is the News tab only.
- Hermes Agent registration of the MCP server (Hermes isn't installed yet).

## Risks / notes

- **Artifact wipe**: `src/` is exported from a Claude artifact; local edits to
  `page-news.jsx` / `app.jsx` / `api-client.jsx` will be lost on the next re-export
  unless ported into the artifact. Same situation as the other in-flight local src
  edits (page-home, page-sync). Commit before any re-export.
- CafeF RSS is category-level only (no per-ticker feeds); ticker extraction from VN
  headlines is out of scope — VN items ship with empty `tickers`.
- SearXNG rate limiter warns about missing Valkey/Redis — harmless for single-user
  local use (already noted in setup_searxng.sh).
- **SSRF surface, consciously accepted**: `read_article`/`GET /api/news/article` fetch
  an arbitrary caller-supplied URL server-side (via Trafilatura) with no scheme or
  private-IP allowlist — a caller could point it at `169.254.169.254`, `127.0.0.1`,
  etc. Flagged in final review. Accepted as-is because this backend is single-user
  and localhost-only today. Before this backend is ever exposed beyond localhost,
  add a scheme check (http/https only) + private-IP/hostname denylist to `read_article`
  in `backend/app/services/news.py`.

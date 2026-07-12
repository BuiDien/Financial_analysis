# News Tab on Real News (VN + US) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the News tab's mock/hallucinated content (broken yfinance feed, LLM-invented article text, LLM-invented search briefings) with real news: CafeF RSS (VN), fixed yfinance (US), SearXNG web search, and Trafilatura article extraction — all through one shared backend module also used by the existing MCP server.

**Architecture:** A new `backend/app/services/news.py` holds all fetch logic (no `mcp`/`yfinance` imports, importable from both the backend venv and the MCP server's separate venv). `backend/app/routes/news.py` exposes it over three endpoints; `backend/app/mcp/news_search_tools.py` becomes a thin `@mcp.tool()` wrapper around the same functions. Frontend (`api-client.jsx`, `app.jsx`, `page-news.jsx`) is updated to consume the new shape and drop the AI-invention code paths.

**Tech Stack:** FastAPI, feedparser 6.0.12, trafilatura 2.1.0, pytest + `fastapi.testclient.TestClient`, React (Babel-in-browser, no build step).

## Global Constraints

- Backend venv is Python 3.11 (`backend/.venv`); MCP venv is also Python 3.11 (`backend/app/mcp/.venv`) — both can run the shared module unmodified.
- Pin new backend deps to the versions already installed in the MCP venv: `feedparser==6.0.12`, `trafilatura==2.1.0`.
- `backend/app/services/news.py` must NOT import `mcp` or `yfinance` (mcp SDK conflicts with the backend's pinned fastapi; the MCP venv has no yfinance).
- SearXNG default URL: `http://127.0.0.1:8888` (env var `SEARXNG_URL` overrides).
- CafeF feeds require the browser User-Agent already in use: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36` (CafeF 503-blocks default urllib/curl UAs).
- Deterministic scanner (`backend/app/scanner/`) must never import from `services/news.py` — news stays a UI/deep-dive concern only, per the project's "no LLM/news input to scan scoring" rule.
- Never commit or push — per project CLAUDE.md, prepare changes and let the user commit.

---

### Task 1: Shared news service module

**Files:**
- Modify: `Financial_analyze/backend/requirements.txt`
- Create: `Financial_analyze/backend/app/services/news.py`
- Test: `Financial_analyze/backend/tests/test_news_service.py`

**Interfaces:**
- Produces: `fetch_vn_rss(query: str | None = None, limit: int = 30) -> list[dict]` → items shaped `{title: str, url: str, published: int, category: "market"|"companies"}` (`published` is epoch seconds, `0` if undated), newest first, raises `RuntimeError` if a feed can't be fetched.
- Produces: `search_web(query: str, count: int = 5) -> list[dict]` → items shaped `{title: str, url: str, content: str}`, raises `RuntimeError` if SearXNG is unreachable.
- Produces: `read_article(url: str) -> dict` → `{url: str, title: str, text: str}`, raises `RuntimeError` if the page can't be fetched or yields no text.

- [ ] **Step 1: Add feedparser + trafilatura to backend requirements and install**

Edit `Financial_analyze/backend/requirements.txt`, in the section after the PDF-processing block, add:

```
# News (CafeF RSS + SearXNG search + article extraction)
feedparser==6.0.12
trafilatura==2.1.0
```

Run:
```bash
cd Financial_analyze/backend && .venv/bin/pip install feedparser==6.0.12 trafilatura==2.1.0
```
Expected: both install successfully (trafilatura pulls several sub-dependencies — that's fine, matches what's already installed in the MCP venv).

- [ ] **Step 2: Write the failing tests**

Create `Financial_analyze/backend/tests/test_news_service.py`:

```python
import json
import urllib.request

import pytest

from app.services import news

MARKET_RSS = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>CafeF - Thi truong</title>
<item>
  <title>VNM tang gia phien sang</title>
  <link>https://cafef.vn/vnm-tang-gia.html</link>
  <description>VNM tang 2% trong phien sang nay</description>
  <pubDate>Mon, 06 Jul 2026 03:00:00 GMT</pubDate>
</item>
</channel></rss>"""

COMPANIES_RSS = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>CafeF - Doanh nghiep</title>
<item>
  <title>Hoa Phat mo rong nha may</title>
  <link>https://cafef.vn/hoa-phat-mo-rong.html</link>
  <description>HPG cong bo ke hoach mo rong</description>
  <pubDate>Sun, 05 Jul 2026 10:00:00 GMT</pubDate>
</item>
</channel></rss>"""


class _FakeResponse:
    def __init__(self, data):
        self._data = data

    def read(self):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _fake_urlopen(feeds):
    def _opener(req, timeout=10):
        return _FakeResponse(feeds[req.full_url])
    return _opener


def test_fetch_vn_rss_returns_items_from_both_feeds_newest_first(monkeypatch):
    feeds = {
        "https://cafef.vn/thi-truong-chung-khoan.rss": MARKET_RSS,
        "https://cafef.vn/doanh-nghiep.rss": COMPANIES_RSS,
    }
    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen(feeds))

    items = news.fetch_vn_rss(limit=10)

    assert len(items) == 2
    titles = {i["title"] for i in items}
    assert "VNM tang gia phien sang" in titles
    assert "Hoa Phat mo rong nha may" in titles
    assert items[0]["title"] == "VNM tang gia phien sang"  # Jul 6 > Jul 5
    assert items[0]["published"] > items[1]["published"]
    assert items[0]["category"] == "market"
    assert items[1]["category"] == "companies"


def test_fetch_vn_rss_filters_by_query(monkeypatch):
    feeds = {
        "https://cafef.vn/thi-truong-chung-khoan.rss": MARKET_RSS,
        "https://cafef.vn/doanh-nghiep.rss": COMPANIES_RSS,
    }
    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen(feeds))

    items = news.fetch_vn_rss(query="Hoa Phat", limit=10)

    assert len(items) == 1
    assert items[0]["title"] == "Hoa Phat mo rong nha may"


def test_fetch_vn_rss_raises_on_fetch_failure(monkeypatch):
    def _boom(req, timeout=10):
        raise OSError("network down")
    monkeypatch.setattr(urllib.request, "urlopen", _boom)

    with pytest.raises(RuntimeError, match="Could not fetch"):
        news.fetch_vn_rss()


class _FakeSearchResponse:
    def __init__(self, payload):
        self._payload = json.dumps(payload).encode()

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_search_web_returns_results(monkeypatch):
    payload = {"results": [
        {"title": "A", "url": "https://a.test", "content": "snippet a"},
        {"title": "B", "url": "https://b.test", "content": "snippet b"},
    ]}

    def _opener(req, timeout=10):
        assert "q=test" in req.full_url
        return _FakeSearchResponse(payload)
    monkeypatch.setattr(urllib.request, "urlopen", _opener)

    results = news.search_web("test", count=5)

    assert results == payload["results"]


def test_search_web_raises_when_unreachable(monkeypatch):
    def _boom(req, timeout=10):
        raise OSError("connection refused")
    monkeypatch.setattr(urllib.request, "urlopen", _boom)

    with pytest.raises(RuntimeError, match="SearXNG unreachable"):
        news.search_web("test")


def test_read_article_extracts_text(monkeypatch):
    monkeypatch.setattr(news.trafilatura, "fetch_url", lambda url: "<html>raw</html>")
    monkeypatch.setattr(news.trafilatura, "extract", lambda html: "Article body text.")

    class _Meta:
        title = "Some Title"
    monkeypatch.setattr(news.trafilatura, "extract_metadata", lambda html: _Meta())

    result = news.read_article("https://example.test/a")

    assert result == {"url": "https://example.test/a", "title": "Some Title", "text": "Article body text."}


def test_read_article_raises_when_fetch_fails(monkeypatch):
    monkeypatch.setattr(news.trafilatura, "fetch_url", lambda url: None)

    with pytest.raises(RuntimeError, match="Could not fetch"):
        news.read_article("https://example.test/dead")


def test_read_article_raises_when_no_text_extracted(monkeypatch):
    monkeypatch.setattr(news.trafilatura, "fetch_url", lambda url: "<html>raw</html>")
    monkeypatch.setattr(news.trafilatura, "extract", lambda html: None)

    with pytest.raises(RuntimeError, match="no extractable"):
        news.read_article("https://example.test/blocked")
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd Financial_analyze/backend && .venv/bin/pytest tests/test_news_service.py -v`
Expected: FAIL / ERROR — `ModuleNotFoundError: No module named 'app.services.news'` (module doesn't exist yet).

- [ ] **Step 4: Write the implementation**

Create `Financial_analyze/backend/app/services/news.py`:

```python
"""Shared news fetch logic — CafeF RSS (VN), SearXNG search, Trafilatura
article extraction. Used by both the FastAPI backend (routes/news.py) and
the standalone MCP server (mcp/news_search_tools.py, own venv because the
mcp SDK's starlette dependency conflicts with the pinned fastapi here).

No `mcp` or `yfinance` imports — must stay importable from both venvs.
"""
import calendar
import json
import os
import urllib.parse
import urllib.request

import feedparser
import trafilatura

SEARXNG_URL = os.environ.get("SEARXNG_URL", "http://127.0.0.1:8888")

# CafeF has no per-ticker feed — only these two category feeds. fetch_vn_rss
# keyword-filters across both when `query` is given; category comes from
# which feed an item was found in.
RSS_FEEDS = [
    ("https://cafef.vn/thi-truong-chung-khoan.rss", "market"),
    ("https://cafef.vn/doanh-nghiep.rss", "companies"),
]
_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def fetch_vn_rss(query: str | None = None, limit: int = 30) -> list[dict]:
    """CafeF market + companies RSS, optionally keyword-filtered.

    Args:
        query: case-insensitive substring match against title+summary.
            None returns everything.
        limit: max items to return.

    Returns [{title, url, published, category}] newest first. `published`
    is epoch seconds (0 if the entry has no date). Raises RuntimeError if
    a feed can't be fetched.
    """
    needle = query.strip().lower() if query else None
    items = []
    for feed_url, category in RSS_FEEDS:
        req = urllib.request.Request(feed_url, headers={"User-Agent": _UA})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                raw = resp.read()
        except Exception as e:
            raise RuntimeError(f"Could not fetch {feed_url}: {e}") from e
        parsed = feedparser.parse(raw)
        for entry in parsed.entries:
            haystack = f"{entry.get('title', '')} {entry.get('summary', '')}".lower()
            if needle and needle not in haystack:
                continue
            published = (
                calendar.timegm(entry.published_parsed)
                if entry.get("published_parsed") else 0
            )
            items.append({
                "title": entry.get("title", ""),
                "url": entry.get("link", ""),
                "published": published,
                "category": category,
            })
    items.sort(key=lambda i: i["published"], reverse=True)
    return items[:limit]


def search_web(query: str, count: int = 5) -> list[dict]:
    """Search the web via a local, self-hosted SearXNG instance.

    Args:
        query: search terms.
        count: max results to return.

    Returns [{title, url, content}]. Raises RuntimeError with a clear
    "is it running?" message if SearXNG isn't reachable.
    """
    qs = urllib.parse.urlencode({"q": query, "format": "json"})
    req = urllib.request.Request(f"{SEARXNG_URL}/search?{qs}")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        raise RuntimeError(
            f"SearXNG unreachable at {SEARXNG_URL} — is it running? "
            f"(./scripts/run_searxng.sh) Error: {e}"
        ) from e

    return [
        {"title": r.get("title", ""), "url": r.get("url", ""), "content": r.get("content", "")}
        for r in data.get("results", [])[:count]
    ]


def read_article(url: str) -> dict:
    """Fetch a URL and extract its clean full article text (via Trafilatura).

    Returns {url, title, text}. Raises RuntimeError if the page couldn't be
    fetched or no article content could be extracted (paywalled, JS-only,
    or hard-blocked — those need Camoufox, not built).
    """
    downloaded = trafilatura.fetch_url(url)
    if not downloaded:
        raise RuntimeError(f"Could not fetch {url} (blocked, dead link, or network error)")
    text = trafilatura.extract(downloaded)
    if not text:
        raise RuntimeError(f"Fetched {url} but found no extractable article text")
    metadata = trafilatura.extract_metadata(downloaded)
    title = metadata.title if metadata and metadata.title else ""
    return {"url": url, "title": title, "text": text}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd Financial_analyze/backend && .venv/bin/pytest tests/test_news_service.py -v`
Expected: 8 passed.

- [ ] **Step 6: Commit**

```bash
git add Financial_analyze/backend/requirements.txt Financial_analyze/backend/app/services/news.py Financial_analyze/backend/tests/test_news_service.py
git commit -m "feat(news): add shared news service — CafeF RSS, SearXNG search, article extraction"
```

---

### Task 2: Fix the broken US (yfinance) news feed

**Files:**
- Modify: `Financial_analyze/backend/app/services/market.py:249-262` (the `get_news` function)
- Test: `Financial_analyze/backend/tests/test_market_news_us.py`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `get_news(ticker: str | None = None, limit: int = 30) -> list[dict]` → items shaped `{title, publisher, url, published, tickers}` (`published` epoch seconds, `tickers` always `[]` — the field yfinance no longer provides). Task 4's route consumes this signature.

**Context:** yfinance changed its news payload shape — it now nests everything under a `content` key (`n["content"]["title"]`, `n["content"]["pubDate"]` as ISO string, `n["content"]["provider"]["displayName"]`, `n["content"]["canonicalUrl"]["url"]`). The old code read flat top-level keys (`n.get("title")` etc.) that no longer exist, so `get_news` has been silently returning `[]` for every call. There is no per-item ticker list anywhere in the new payload — `relatedTickers` is gone.

- [ ] **Step 1: Write the failing test**

Create `Financial_analyze/backend/tests/test_market_news_us.py`:

```python
from app.services import market


class _FakeTicker:
    def __init__(self, symbol):
        self.symbol = symbol

    @property
    def news(self):
        return [
            {
                "id": "abc123",
                "content": {
                    "title": "Fed holds rates steady",
                    "pubDate": "2026-07-06T21:24:38Z",
                    "provider": {"displayName": "Reuters"},
                    "canonicalUrl": {"url": "https://reuters.test/fed-holds"},
                    "clickThroughUrl": {"url": "https://finance.yahoo.com/fed-holds"},
                },
            },
            {
                "id": "def456",
                "content": {
                    "title": "No canonical url here",
                    "pubDate": "2026-07-06T20:00:00Z",
                    "provider": {"displayName": "Bloomberg"},
                    "canonicalUrl": None,
                    "clickThroughUrl": {"url": "https://finance.yahoo.com/fallback"},
                },
            },
        ]


def test_get_news_reads_new_content_envelope(monkeypatch):
    monkeypatch.setattr(market.yf, "Ticker", lambda t: _FakeTicker(t))

    items = market.get_news(limit=10)

    assert len(items) == 2
    assert items[0] == {
        "title": "Fed holds rates steady",
        "publisher": "Reuters",
        "url": "https://reuters.test/fed-holds",
        "published": 1783373078,
        "tickers": [],
    }


def test_get_news_falls_back_to_clickthrough_url(monkeypatch):
    monkeypatch.setattr(market.yf, "Ticker", lambda t: _FakeTicker(t))

    items = market.get_news(limit=10)

    assert items[1]["url"] == "https://finance.yahoo.com/fallback"


def test_get_news_returns_empty_list_on_error(monkeypatch):
    def _boom(t):
        raise RuntimeError("yfinance down")
    monkeypatch.setattr(market.yf, "Ticker", _boom)

    assert market.get_news() == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Financial_analyze/backend && .venv/bin/pytest tests/test_market_news_us.py -v`
Expected: FAIL — first test's `items` is `[]` (old code reads nonexistent flat keys, `title`/`publisher`/etc. all end up `None`, but more importantly the assertion on the exact dict will fail since old code doesn't compute `published` from `pubDate` at all).

- [ ] **Step 3: Write minimal implementation**

In `Financial_analyze/backend/app/services/market.py`, add `from datetime import datetime` to the imports at the top of the file (near the existing `import time`), then replace the `get_news` function (lines 249-262):

```python
def get_news(ticker: str | None = None, limit: int = 30) -> list[dict]:
    """US financial news via yfinance. Newest yfinance nests fields under
    `content`; there is no per-item ticker list anymore (`tickers` is
    always []) — that field was removed from the payload upstream.
    """
    try:
        items = yf.Ticker(ticker or "SPY").news[:limit]
        out = []
        for n in items:
            c = n.get("content", {}) or {}
            pub_date = c.get("pubDate")
            published = 0
            if pub_date:
                try:
                    published = int(datetime.fromisoformat(pub_date).timestamp())
                except ValueError:
                    published = 0
            canonical = (c.get("canonicalUrl") or {}) or {}
            click_through = (c.get("clickThroughUrl") or {}) or {}
            url = canonical.get("url") or click_through.get("url")
            out.append({
                "title": c.get("title", ""),
                "publisher": (c.get("provider") or {}).get("displayName", "Yahoo Finance"),
                "url": url,
                "published": published,
                "tickers": [],
            })
        return out
    except Exception:
        return []
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd Financial_analyze/backend && .venv/bin/pytest tests/test_market_news_us.py -v`
Expected: 3 passed.

- [ ] **Step 5: Run the full backend test suite to check for regressions**

Run: `cd Financial_analyze/backend && .venv/bin/pytest -v`
Expected: all tests pass (no other test touches `get_news`).

- [ ] **Step 6: Commit**

```bash
git add Financial_analyze/backend/app/services/market.py Financial_analyze/backend/tests/test_market_news_us.py
git commit -m "fix(news): read yfinance's new content envelope in get_news (was silently returning [])"
```

---

### Task 3: Refactor the MCP server into a thin wrapper

**Files:**
- Modify: `Financial_analyze/backend/app/mcp/news_search_tools.py` (full rewrite)

**Interfaces:**
- Consumes: `fetch_vn_rss`, `search_web`, `read_article` from `app.services.news` (Task 1).
- Produces: nothing new — same 3 MCP tools (`search_news`, `get_latest_news`, `read_article`), same external behavior, now delegating instead of duplicating.

**Context:** `backend/app/mcp/` has no `__init__.py` (it's a standalone script, not a package) and its own venv (`backend/app/mcp/.venv`) with `mcp`, `feedparser`, `trafilatura` installed but not `fastapi`/`sqlalchemy`. `backend/app/__init__.py` and `backend/app/services/__init__.py` are both empty, so importing `app.services.news` triggers no heavy imports (no `app.main`, no `app.config`) — safe to import from the MCP venv once `backend/` is on `sys.path`.

- [ ] **Step 1: Rewrite the MCP wrapper**

Replace the full contents of `Financial_analyze/backend/app/mcp/news_search_tools.py`:

```python
"""MCP tools — the "News/search context layer" from docs/design/HERMES_BRAIN.md
(the same 3 tools listed under docs/PLAN.md Stage 8): `search_news`, `get_latest_news`,
`read_article`. Camoufox (headless-browser fallback for hard-blocked sites) is
explicitly "reserved" in that doc, not scheduled — not built here.

Thin wrapper: all fetch logic lives in backend/app/services/news.py, shared
with the FastAPI routes (backend/app/routes/news.py). This file only adds the
`@mcp.tool()` LLM-facing surface (names, docstrings, argument shapes).

Standalone MCP server (own venv: backend/app/mcp/.venv) because the `mcp` SDK's
starlette dependency conflicts with the pinned fastapi in backend/requirements.txt.
Lives at the path HERMES_BRAIN.md designates for the Core's MCP server so it merges
naturally when the full financial MCP server (calc/data/obsidian tools) gets built.

Register with Hermes Agent:
    hermes mcp add news_search \\
      --command "<repo>/Financial_analyze/backend/app/mcp/.venv/bin/python" \\
      --args "<repo>/Financial_analyze/backend/app/mcp/news_search_tools.py"
"""
import os
import sys

from mcp.server.fastmcp import FastMCP

# backend/app/mcp/news_search_tools.py -> backend/ (two levels up) so
# `app.services.news` is importable when this runs as a standalone script.
_BACKEND_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _BACKEND_ROOT not in sys.path:
    sys.path.insert(0, _BACKEND_ROOT)

from app.services.news import fetch_vn_rss, search_web, read_article as _read_article  # noqa: E402

mcp = FastMCP("news_search")


@mcp.tool()
def search_news(query: str, count: int = 5) -> list[dict]:
    """Search the web via a local, self-hosted SearXNG instance.

    Args:
        query: search terms.
        count: max results to return (default 5).

    Returns a list of {title, url, content} dicts. Raises a clear error if
    SearXNG isn't running — start it with ./scripts/run_searxng.sh.
    """
    return search_web(query, count)


@mcp.tool()
def get_latest_news(symbol: str, count: int = 10) -> list[dict]:
    """Latest VN financial news mentioning a symbol/company name.

    Pulls CafeF's stock-market + doanh-nghiep RSS category feeds and keyword-
    filters entries whose title/summary contain `symbol` (case-insensitive).
    Vietnamese headlines usually name the company, not the ticker (e.g. VNM
    articles say "Vinamilk") — pass a company name for better recall if a bare
    ticker returns nothing.

    Args:
        symbol: ticker or company name to filter for, e.g. "VNM" or "Vinamilk".
        count: max results to return (default 10).

    Returns a list of {title, url, published, category} dicts, newest first.
    """
    return fetch_vn_rss(query=symbol, limit=count)


@mcp.tool()
def read_article(url: str) -> dict:
    """Fetch a URL and extract its clean full article text (via Trafilatura).

    Args:
        url: article URL, e.g. one returned by search_news or get_latest_news.

    Returns {url, title, text}. Raises a clear error if the page couldn't be
    fetched or no article content could be extracted (e.g. paywalled, JS-only,
    or hard-blocked — those need Camoufox, not built yet, see module docstring).
    """
    return _read_article(url)


if __name__ == "__main__":
    mcp.run(transport="stdio")
```

- [ ] **Step 2: Verify it still imports and registers all 3 tools**

Run:
```bash
cd Financial_analyze/backend/app/mcp && .venv/bin/python -c "
import asyncio, news_search_tools as t
tools = asyncio.run(t.mcp.list_tools())
print('MCP server tools:', sorted(x.name for x in tools))
"
```
Expected: `MCP server tools: ['get_latest_news', 'read_article', 'search_news']`

- [ ] **Step 3: Verify delegation actually reaches the shared module (live network smoke test)**

Run:
```bash
cd Financial_analyze/backend/app/mcp && .venv/bin/python -c "
import news_search_tools as t

def unwrap(tool):
    return getattr(tool, 'fn', tool)

r = unwrap(t.get_latest_news)('Vinamilk', 3)
print('get_latest_news:', len(r), 'hits, category=', r[0]['category'] if r else None)
"
```
Expected: `get_latest_news: N hits, category= market` (or `companies`) with N >= 0 — no traceback. (If CafeF happens to be unreachable from this machine right now, a clean `RuntimeError: Could not fetch ...` traceback is also an acceptable pass — the point of this step is confirming delegation wiring, not CafeF's uptime.)

- [ ] **Step 4: Commit**

```bash
git add Financial_analyze/backend/app/mcp/news_search_tools.py
git commit -m "refactor(news): MCP server delegates to shared app.services.news module"
```

---

### Task 4: Backend routes — merge, search, article endpoints

**Files:**
- Modify: `Financial_analyze/backend/app/routes/news.py` (full rewrite)
- Test: `Financial_analyze/backend/tests/test_news_route.py`

**Interfaces:**
- Consumes: `news_service.fetch_vn_rss`, `news_service.search_web`, `news_service.read_article` (Task 1); `market.get_news` (Task 2, now returns `{title, publisher, url, published, tickers}`).
- Produces: `GET /api/news?limit=30` → merged list `{title, publisher, url, published, tickers, region, category}`; `GET /api/news/search?q=&count=` → `{title, url, content}` list or 503; `GET /api/news/article?url=` → `{url, title, text}` or 422. Task 6/7/8 (frontend) consume these three routes.

- [ ] **Step 1: Write the failing tests**

Create `Financial_analyze/backend/tests/test_news_route.py`:

```python
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import market, news as news_service


@pytest.fixture
def client():
    return TestClient(app)


def test_news_merges_vn_and_us_newest_first(monkeypatch, client):
    monkeypatch.setattr(news_service, "fetch_vn_rss", lambda limit: [
        {"title": "VN old", "url": "https://cafef.vn/a", "published": 100, "category": "market"},
    ])
    monkeypatch.setattr(market, "get_news", lambda limit: [
        {"title": "US new", "publisher": "Reuters", "url": "https://reuters.test/b",
         "published": 200, "tickers": []},
    ])

    resp = client.get("/api/news?limit=30")

    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 2
    assert body[0]["title"] == "US new"
    assert body[0]["region"] == "us"
    assert body[0]["category"] == "us"
    assert body[1]["title"] == "VN old"
    assert body[1]["region"] == "vn"
    assert body[1]["category"] == "market"
    assert body[1]["publisher"] == "CafeF"


def test_news_returns_us_only_when_vn_fetch_fails(monkeypatch, client):
    def _boom(limit):
        raise RuntimeError("CafeF down")
    monkeypatch.setattr(news_service, "fetch_vn_rss", _boom)
    monkeypatch.setattr(market, "get_news", lambda limit: [
        {"title": "US new", "publisher": "Reuters", "url": "https://reuters.test/b",
         "published": 200, "tickers": []},
    ])

    resp = client.get("/api/news?limit=30")

    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["title"] == "US new"


def test_news_search_proxies_results(monkeypatch, client):
    monkeypatch.setattr(news_service, "search_web", lambda q, count: [
        {"title": "Result", "url": "https://x.test", "content": "snippet"},
    ])

    resp = client.get("/api/news/search?q=fed+rates&count=5")

    assert resp.status_code == 200
    assert resp.json() == [{"title": "Result", "url": "https://x.test", "content": "snippet"}]


def test_news_search_returns_503_when_searxng_down(monkeypatch, client):
    def _boom(q, count):
        raise RuntimeError("SearXNG unreachable at http://127.0.0.1:8888 — is it running?")
    monkeypatch.setattr(news_service, "search_web", _boom)

    resp = client.get("/api/news/search?q=fed+rates")

    assert resp.status_code == 503
    assert "SearXNG unreachable" in resp.json()["detail"]


def test_news_article_proxies_result(monkeypatch, client):
    monkeypatch.setattr(news_service, "read_article", lambda url: {
        "url": url, "title": "T", "text": "Body text.",
    })

    resp = client.get("/api/news/article?url=https://example.test/a")

    assert resp.status_code == 200
    assert resp.json() == {"url": "https://example.test/a", "title": "T", "text": "Body text."}


def test_news_article_returns_422_when_extraction_fails(monkeypatch, client):
    def _boom(url):
        raise RuntimeError(f"Could not fetch {url} (blocked, dead link, or network error)")
    monkeypatch.setattr(news_service, "read_article", _boom)

    resp = client.get("/api/news/article?url=https://example.test/dead")

    assert resp.status_code == 422
    assert "Could not fetch" in resp.json()["detail"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd Financial_analyze/backend && .venv/bin/pytest tests/test_news_route.py -v`
Expected: FAIL — `/api/news/search` and `/api/news/article` are 404 (routes don't exist yet); `/api/news` test fails because `market.get_news(ticker=..., category=...)` doesn't match the monkeypatched `lambda limit: ...` signature, and VN items aren't merged/normalized.

- [ ] **Step 3: Write the implementation**

Replace the full contents of `Financial_analyze/backend/app/routes/news.py`:

```python
"""News feed, search, and article extraction — VN (CafeF RSS) + US (yfinance)."""
from fastapi import APIRouter, HTTPException

from ..services import market
from ..services import news as news_service

router = APIRouter()


@router.get("/news")
def news(limit: int = 30):
    try:
        vn = [
            {
                "title": item["title"],
                "publisher": "CafeF",
                "url": item["url"],
                "published": item["published"],
                "tickers": [],
                "region": "vn",
                "category": item["category"],
            }
            for item in news_service.fetch_vn_rss(limit=limit)
        ]
    except RuntimeError:
        vn = []

    try:
        us = [
            {
                "title": item["title"],
                "publisher": item["publisher"],
                "url": item["url"],
                "published": item["published"],
                "tickers": item["tickers"],
                "region": "us",
                "category": "us",
            }
            for item in market.get_news(limit=limit)
        ]
    except Exception:
        us = []

    merged = sorted(vn + us, key=lambda n: n["published"], reverse=True)
    return merged[:limit]


@router.get("/news/search")
def news_search(q: str, count: int = 5):
    try:
        return news_service.search_web(q, count)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


@router.get("/news/article")
def news_article(url: str):
    try:
        return news_service.read_article(url)
    except RuntimeError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd Financial_analyze/backend && .venv/bin/pytest tests/test_news_route.py -v`
Expected: 6 passed.

- [ ] **Step 5: Run the full backend test suite to check for regressions**

Run: `cd Financial_analyze/backend && .venv/bin/pytest -v`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add Financial_analyze/backend/app/routes/news.py Financial_analyze/backend/tests/test_news_route.py
git commit -m "feat(news): merge VN+US news, add search and article-read endpoints"
```

---

### Task 5: Start SearXNG from run.sh

**Files:**
- Modify: `Financial_analyze/scripts/run.sh`

**Interfaces:**
- Consumes: `Financial_analyze/scripts/run_searxng.sh` (already exists, already verified working).
- Produces: SearXNG reachable at `http://127.0.0.1:8888` whenever `run.sh` is used — Task 6-8's frontend search feature has something to talk to.

- [ ] **Step 1: Add a SearXNG startup block**

In `Financial_analyze/scripts/run.sh`, replace the comment block that currently explains why nothing is started (the `# NOTE: no Ollama/Hermes startup here...` block) — keep that comment (still true, Hermes isn't built), and insert a new block for SearXNG right before the `# ── Backend (FastAPI/uvicorn) ──` section:

```bash
# ── SearXNG (self-hosted search, backs /api/news/search) ──────────────
# Skip if something's already listening on 8888 — the user may have started
# it by hand with ./scripts/run_searxng.sh. The backend's /api/news/search
# degrades gracefully (503 + clear message) if SearXNG isn't reachable, so
# this is a convenience, not a hard dependency for the rest of the app.
SEARXNG_PORT="${SEARXNG_PORT:-8888}"
if curl -s -o /dev/null -m 1 "http://127.0.0.1:$SEARXNG_PORT"; then
  echo "-- SearXNG already running on :$SEARXNG_PORT --"
elif [ -x "$ROOT/searxng/.venv/bin/python" ]; then
  echo "-- Starting SearXNG on :$SEARXNG_PORT --"
  "$ROOT/scripts/run_searxng.sh" >/tmp/helix_searxng.log 2>&1 &
  PIDS+=("$!")
else
  echo "-- SearXNG not set up (run ./scripts/setup_searxng.sh) — news search will be unavailable --"
fi
```

Also update `cleanup()`'s belt-and-suspenders `pkill` lines to also stop SearXNG's dev server — add this line right after the existing `pkill -f "http.server $FRONTEND_PORT"` line:

```bash
  pkill -f "searx.webapp" 2>/dev/null || true
```

- [ ] **Step 2: Verify manually**

Run:
```bash
cd Financial_analyze && ./scripts/run.sh &
sleep 5
curl -s -m 3 'http://127.0.0.1:8888/search?q=test&format=json' | python3 -c "import json,sys; print('results:', len(json.load(sys.stdin)['results']))"
kill %1 2>/dev/null
```
Expected: `-- Starting SearXNG on :8888 --` printed during startup (or `-- SearXNG already running --` if it was left running from earlier in this session), and `results: N` with N > 0.

- [ ] **Step 3: Commit**

```bash
git add Financial_analyze/scripts/run.sh
git commit -m "feat(news): start SearXNG from run.sh so /api/news/search works out of the box"
```

---

### Task 6: Frontend API client — search + article endpoints

**Files:**
- Modify: `Financial_analyze/src/api-client.jsx`

**Interfaces:**
- Consumes: `GET /api/news`, `GET /api/news/search`, `GET /api/news/article` (Task 4).
- Produces: `HelixAPI.news(limit)`, `HelixAPI.newsSearch(q, count)`, `HelixAPI.newsArticle(url)`. Task 7 (`app.jsx`) and Task 8 (`page-news.jsx`) consume these.

- [ ] **Step 1: Add the three methods**

In `Financial_analyze/src/api-client.jsx`, after the `// ── Filings ──` block (ends at the `deleteFiling` line, before the `// ── Sync` comment), insert:

```jsx
  // ── News ──────────────────────────────────────────────────
  news(limit = 30)                 { return this._get(`/api/news?limit=${limit}`); },
  newsSearch(q, count = 5)         { return this._get(`/api/news/search?q=${encodeURIComponent(q)}&count=${count}`); },
  newsArticle(url)                 { return this._get(`/api/news/article?url=${encodeURIComponent(url)}`); },

```

- [ ] **Step 2: Verify manually in a browser console**

With the backend running (`./scripts/run.sh`), open the app, open the browser dev console, and run:
```js
await window.HelixAPI.news(5)
await window.HelixAPI.newsSearch('Vinamilk', 3)
```
Expected: both resolve to arrays (not throw); the first item of `news(5)` has `region` and `category` keys.

- [ ] **Step 3: Commit**

```bash
git add Financial_analyze/src/api-client.jsx
git commit -m "feat(news): add HelixAPI.news/newsSearch/newsArticle"
```

---

### Task 7: Frontend data flow — applyNews shape

**Files:**
- Modify: `Financial_analyze/src/app.jsx:123-130` (`applyNews`) and `:145` (the hydrate fetch call)

**Interfaces:**
- Consumes: `HelixAPI.news(limit)` (Task 6), array items shaped `{title, publisher, url, published, tickers, region, category}` (Task 4).
- Produces: `data.news` items shaped `{time, title, src, tags, sentiment, url, region, category}`. Task 8 (`page-news.jsx`) consumes this shape.

- [ ] **Step 1: Update `applyNews`**

In `Financial_analyze/src/app.jsx`, replace the `applyNews` function (lines 123-130):

```jsx
  const applyNews = (base, news) => {
    if (!Array.isArray(news) || !news.length) return base.news;
    return news.map(n => ({
      time: n.published ? new Date(n.published * 1000).toTimeString().slice(0, 5) : '—',
      title: n.title, src: n.publisher || 'Wire',
      tags: (n.tickers || []).slice(0, 3), sentiment: 'neutral',
      url: n.url, region: n.region, category: n.category,
    }));
  };
```

- [ ] **Step 2: Update the hydrate fetch call**

In the same file, replace line 145:
```jsx
        window.HelixAPI._get('/api/news?limit=9').catch(() => null),
```
with:
```jsx
        window.HelixAPI.news(9).catch(() => null),
```

- [ ] **Step 3: Verify manually**

With the backend running, open the app's News tab, open dev console, run `window.HELIX_DEBUG_DATA = null;` is not needed — instead just confirm no console errors on page load and that the Network tab shows a request to `/api/news?limit=9` returning 200.

- [ ] **Step 4: Commit**

```bash
git add Financial_analyze/src/app.jsx
git commit -m "feat(news): carry url/region/category through applyNews"
```

---

### Task 8: Frontend News tab — real tabs, real article reads, real search

**Files:**
- Modify: `Financial_analyze/src/page-news.jsx` (full rewrite)

**Interfaces:**
- Consumes: `data.news` items shaped `{time, title, src, tags, sentiment, url, region, category}` (Task 7); `HelixAPI.newsSearch(q, count)`, `HelixAPI.newsArticle(url)` (Task 6); `HelixAPI.complete(prompt, opts)` (existing, unchanged).
- Produces: nothing consumed elsewhere — this is the leaf UI component (`window.PageNews`).

**Context:** Three things change: (1) tabs switch from tag-based (Macro/Equities/Crypto, which nothing in the new data matches) to `category`-based (All/VN Market/VN Companies/US); (2) the hero story's hardcoded "Federal Reserve officials..." paragraph (previously shown under every hero headline regardless of what it actually was) is removed — there's no summary field to put there; (3) the story modal's "expand" and the top research box both stop asking the LLM to invent content from thin air — the modal fetches the real article via `newsArticle`, and the research box searches via `newsSearch` first and only then asks the LLM to synthesize *from those real results*.

- [ ] **Step 1: Rewrite the file**

Replace the full contents of `Financial_analyze/src/page-news.jsx`:

```jsx
// News & Insights page

const PageNews = ({ data }) => {
  const [tab, setTab] = React.useState('all');
  const [subject, setSubject] = React.useState('');
  const [briefing, setBriefing] = React.useState(null);
  const [results, setResults] = React.useState([]);
  const [searchError, setSearchError] = React.useState(null);
  const [researching, setResearching] = React.useState(false);
  const [story, setStory] = React.useState(null);

  const SUGGESTED = ['AI semiconductors', 'Fed rate path', 'NVDA earnings', 'Oil & energy', 'China tech'];

  const research = async (subj) => {
    const topic = (subj || subject).trim();
    if (!topic || researching) return;
    setSubject(topic);
    setResearching(true);
    setBriefing(null);
    setResults([]);
    setSearchError(null);
    try {
      const hits = await window.HelixAPI.newsSearch(topic, 5);
      setResults(hits);
      const context = hits.map(h => `- ${h.title}: ${h.content}`).join('\n');
      const prompt = `You are a financial news analyst agent. Focus ONLY on this subject: "${topic}".\n\nFrom the search results below, synthesize a focused briefing on "${topic}". Use this exact format:\n\n**Why it matters:** [one sharp sentence]\n\n**Key developments:**\n- [point with specifics]\n- [point]\n- [point]\n\n**What to watch:** [1-2 forward-looking items]\n\n**Affected tickers:** [comma-separated symbols]\n\nBe concise and numerical. Use **bold** for figures, *italic* for tickers. No disclaimers, no emoji.\n\nSEARCH RESULTS:\n${context}`;
      const reply = await window.HelixAPI.complete(prompt, { page: 'news', context: { subject: topic } });
      setBriefing(reply);
    } catch (e) {
      const msg = String(e && e.message || e);
      if (msg.startsWith('503')) {
        setSearchError('Search unavailable — start ./scripts/run_searxng.sh');
      } else {
        setBriefing('Could not generate a briefing right now. Try again.');
      }
    }
    setResearching(false);
  };

  const filterFor = {
    all: () => true,
    vn_market: n => n.category === 'market',
    vn_companies: n => n.category === 'companies',
    us: n => n.category === 'us',
  };

  const filtered = data.news.filter(filterFor[tab]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">News & insights.</h1>
          <p className="page-sub">Curated. Filtered to what affects your watchlist.</p>
        </div>
      </div>

      {/* Focus the analyst on a subject */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-body" style={{ padding: 16 }}>
          <div className="row" style={{ gap: 8 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flex: 1, background: 'var(--bg-sunken)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0 12px' }}>
              <Icon name="sparkle" size={15} style={{ color: 'var(--accent)' }} />
              <input
                value={subject}
                onChange={e => setSubject(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') research(); }}
                placeholder="Focus the analyst on a subject — e.g. AI chips, Fed policy, a ticker…"
                style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', padding: '11px 0', fontSize: 14, color: 'var(--text)', fontFamily: 'inherit' }}
              />
            </span>
            <button className="btn btn-primary" onClick={() => research()} disabled={researching || !subject.trim()}>
              <Icon name="search" size={13} /> {researching ? 'Researching…' : 'Research'}
            </button>
          </div>
          <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Try:</span>
            {SUGGESTED.map(s => (
              <button key={s} onClick={() => research(s)} style={{ fontSize: 11, padding: '4px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border)', borderRadius: 999, color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit' }}>{s}</button>
            ))}
          </div>

          {searchError && (
            <div style={{ marginTop: 14, padding: 14, background: 'var(--bg-sunken)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--text-muted)' }}>
              {searchError}
            </div>
          )}

          {!searchError && results.length > 0 && (
            <div style={{ marginTop: 14, padding: 14, background: 'var(--bg-sunken)', border: '1px solid var(--border)', borderRadius: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-subtle)', marginBottom: 8 }}>Sources</div>
              {results.map((r, i) => (
                <div key={i} style={{ padding: '6px 0', borderBottom: i < results.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <a href={r.url} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: 'var(--accent)', textDecoration: 'none' }}>{r.title}</a>
                </div>
              ))}
            </div>
          )}

          {!searchError && (researching || briefing) && (
            <div style={{ marginTop: 14, padding: 16, background: 'var(--accent-bg)', border: '1px solid var(--accent-soft)', borderRadius: 8 }}>
              <div className="row" style={{ gap: 8, marginBottom: 8, justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  <Icon name="sparkle" size={11} style={{ verticalAlign: 'middle', marginRight: 5 }} />
                  Analyst briefing · {subject}
                </span>
                {briefing && (
                  <button onClick={() => { setBriefing(null); setSubject(''); setResults([]); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-subtle)' }}><Icon name="close" size={12} /></button>
                )}
              </div>
              {researching ? (
                <div style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>Searching the web for “{subject}”…</div>
              ) : (
                <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text)' }}>
                  <NewsFormatted text={briefing} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="tabs">
        {[
          { id: 'all', label: 'Top stories' },
          { id: 'vn_market', label: 'VN Market' },
          { id: 'vn_companies', label: 'VN Companies' },
          { id: 'us', label: 'US' },
        ].map(t => (
          <button key={t.id} className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      <div className="grid-2">
        {/* Stories list */}
        <div className="card">
          <div className="card-body" style={{ padding: '0 20px' }}>
            {/* Hero story */}
            {filtered[0] && (
              <div onClick={() => setStory(filtered[0])} style={{ padding: '20px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', background: 'var(--accent)', color: 'white', letterSpacing: '0.05em' }}>TOP STORY</span>
                  <span style={{ fontSize: 11, color: 'var(--text-subtle)' }} className="num">{filtered[0].time} · {filtered[0].src}</span>
                </div>
                <h2 className="serif" style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.25, margin: '0 0 12px' }}>
                  {filtered[0].title}
                </h2>
                <div className="news-tags" style={{ marginTop: 10 }}>
                  {filtered[0].tags.map(t => <span key={t} style={{ fontSize: 10, padding: '2px 6px', background: 'var(--bg-sunken)', color: 'var(--text-muted)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{t}</span>)}
                </div>
              </div>
            )}

            {filtered.slice(1).map((n, i) => (
              <div key={i} className="news-row" onClick={() => setStory(n)} style={{ cursor: 'pointer' }}>
                <span className="news-time">{n.time}</span>
                <div>
                  <div className="news-title">{n.title}</div>
                  <div className="news-meta row" style={{ gap: 8, marginTop: 4 }}>
                    <span style={{ color: 'var(--text-subtle)' }}>{n.src}</span>
                    <span style={{ color: 'var(--text-subtle)' }}>·</span>
                    <div className="news-tags">
                      {n.tags.slice(0, 3).map(t => <span key={t} style={{ fontSize: 10, padding: '1px 5px', background: 'var(--bg-sunken)', color: 'var(--text-muted)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{t}</span>)}
                    </div>
                  </div>
                </div>
                <span className="pill" style={{
                  background: n.sentiment === 'positive' ? 'var(--pos-bg)' : n.sentiment === 'negative' ? 'var(--neg-bg)' : 'var(--bg-sunken)',
                  color: n.sentiment === 'positive' ? 'var(--pos)' : n.sentiment === 'negative' ? 'var(--neg)' : 'var(--text-muted)',
                  alignSelf: 'flex-start',
                }}>
                  {n.sentiment === 'positive' ? '↗ Positive' : n.sentiment === 'negative' ? '↘ Negative' : '→ Neutral'}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Sidebar: trending + economic calendar */}
        <div className="stack">
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Trending Tickers</h3>
              <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Mentions ↑ today</span>
            </div>
            <div className="card-body" style={{ padding: '4px 0' }}>
              {[
                { sym: 'NVDA', mentions: 1284, chg: 32 },
                { sym: 'TSLA', mentions: 892, chg: 18 },
                { sym: 'AAPL', mentions: 612, chg: 12 },
                { sym: 'BTC', mentions: 548, chg: 24 },
                { sym: 'MSFT', mentions: 421, chg: 8 },
              ].map((t, i) => (
                <div key={t.sym} style={{ display: 'grid', gridTemplateColumns: '24px 60px 1fr auto', gap: 8, padding: '8px 16px', alignItems: 'center', borderBottom: i < 4 ? '1px solid var(--border)' : 'none' }}>
                  <span style={{ fontSize: 11, color: 'var(--text-subtle)', fontFamily: 'var(--font-mono)' }}>#{i + 1}</span>
                  <span className="ticker">{t.sym}</span>
                  <span className="num" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t.mentions} mentions</span>
                  <Pill value={t.chg} />                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Economic Calendar</h3>
              <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>This week</span>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              {[
                { date: 'Wed', time: '14:00 ET', event: 'FOMC Minutes', importance: 3 },
                { date: 'Thu', time: '08:30 ET', event: 'CPI (YoY)', importance: 3, est: '2.6%', prev: '2.7%' },
                { date: 'Thu', time: '08:30 ET', event: 'Initial Jobless Claims', importance: 2, est: '218K', prev: '224K' },
                { date: 'Fri', time: '08:30 ET', event: 'Retail Sales', importance: 2, est: '+0.4%', prev: '+0.7%' },
                { date: 'Fri', time: '10:00 ET', event: 'U-Mich Sentiment', importance: 1, est: '72.5', prev: '71.8' },
              ].map((e, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '40px 1fr auto', gap: 12, padding: '12px 16px', alignItems: 'center', borderBottom: i < 4 ? '1px solid var(--border)' : 'none' }}>
                  <div>
                    <div style={{ fontFamily: 'var(--font-serif)', fontWeight: 600, fontSize: 13 }}>{e.date}</div>
                    <div className="num" style={{ fontSize: 10, color: 'var(--text-subtle)' }}>{e.time}</div>
                  </div>
                  <div>
                    <div className="row" style={{ gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{e.event}</span>
                      <span style={{ display: 'inline-flex', gap: 1 }}>
                        {[1, 2, 3].map(n => (
                          <span key={n} style={{ width: 4, height: 4, borderRadius: '50%', background: n <= e.importance ? 'var(--accent)' : 'var(--border-strong)' }}></span>
                        ))}
                      </span>
                    </div>
                    {e.est && <div className="num" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Est. {e.est} · Prev {e.prev}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {story && <StoryModal story={story} allNews={data.news} onClose={() => setStory(null)} />}
    </div>
  );
};

window.PageNews = PageNews;

const StoryModal = ({ story, allNews = [], onClose }) => {
  const [read, setRead] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);

  const expand = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const article = await window.HelixAPI.newsArticle(story.url);
      setRead(article.text);
    } catch (e) {
      setError(String(e && e.message || e));
    }
    setLoading(false);
  };

  React.useEffect(() => { setRead(''); setError(null); }, [story]);

  const related = allNews.filter(n => n !== story && n.tags.some(t => story.tags.includes(t))).slice(0, 3);
  const sentColor = story.sentiment === 'positive' ? 'var(--pos)' : story.sentiment === 'negative' ? 'var(--neg)' : 'var(--text-muted)';

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 520, height: '100%', background: 'var(--bg-elev)', borderLeft: '1px solid var(--border)', boxShadow: '-12px 0 40px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column', animation: 'story-in 200ms ease' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-subtle)' }}>Story</span>
          <button className="icon-btn" onClick={onClose} style={{ width: 28, height: 28 }}><Icon name="close" size={13} /></button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          <div className="row" style={{ gap: 8, marginBottom: 12 }}>
            <span className="num" style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{story.time} · {story.src}</span>
            <span className="pill" style={{ background: 'var(--bg-sunken)', color: sentColor }}>
              {story.sentiment === 'positive' ? '↗ Positive' : story.sentiment === 'negative' ? '↘ Negative' : '→ Neutral'}
            </span>
          </div>
          <h2 className="serif" style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.25, margin: '0 0 14px' }}>{story.title}</h2>
          <div className="news-tags" style={{ marginBottom: 18 }}>
            {story.tags.map(t => <span key={t} style={{ fontSize: 10, padding: '2px 6px', background: 'var(--bg-sunken)', color: 'var(--text-muted)', fontWeight: 600, fontFamily: 'var(--font-mono)', marginRight: 4 }}>{t}</span>)}
          </div>

          {!story.url && (
            <div style={{ padding: 20, background: 'var(--bg-sunken)', borderRadius: 8, textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}>
              No source link available (mock data).
            </div>
          )}

          {story.url && !read && !loading && !error && (
            <div style={{ padding: 20, background: 'var(--bg-sunken)', borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>Read the full article.</div>
              <button className="btn btn-accent" onClick={expand}><Icon name="sparkle" size={12} /> Read full story</button>
            </div>
          )}
          {loading && <div style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>Fetching article…</div>}
          {error && (
            <div style={{ padding: 16, background: 'var(--bg-sunken)', borderRadius: 8 }}>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>Could not load the article: {error}</div>
              <a href={story.url} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: 'var(--accent)' }}>Open original ↗</a>
            </div>
          )}
          {read && <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--text)' }}><NewsFormatted text={read} /></div>}

          {related.length > 0 && (
            <div style={{ marginTop: 28, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-subtle)', marginBottom: 10 }}>Related</div>
              {related.map((r, i) => (
                <div key={i} style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0', borderBottom: i < related.length - 1 ? '1px solid var(--border)' : 'none', lineHeight: 1.4 }}>{r.title}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

if (!document.getElementById('story-style')) {
  const s = document.createElement('style');
  s.id = 'story-style';
  s.textContent = `@keyframes story-in { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }`;
  document.head.appendChild(s);
}

// Lightweight markdown formatter (**bold**, *italic*, - lists) — used for
// both the AI-synthesized briefing and real article text from Trafilatura.
const NewsFormatted = ({ text }) => {
  const lines = String(text).split('\n');
  const out = [];
  let list = [];
  const flush = () => { if (list.length) { out.push(<ul key={'u' + out.length} style={{ margin: '6px 0', paddingLeft: 18 }}>{list.map((l, i) => <li key={i} style={{ margin: '3px 0' }}>{inline(l)}</li>)}</ul>); list = []; } };
  const inline = (s) => {
    const parts = []; let rem = s; let k = 0;
    while (rem.length) {
      const b = rem.match(/\*\*(.+?)\*\*/); const it = rem.match(/\*(.+?)\*/);
      let m = null;
      if (b && (!it || b.index <= it.index)) m = { ...b, t: 'b' }; else if (it) m = { ...it, t: 'i' };
      if (!m) { parts.push(rem); break; }
      if (m.index > 0) parts.push(rem.slice(0, m.index));
      parts.push(m.t === 'b' ? <strong key={k++}>{m[1]}</strong> : <em key={k++} style={{ fontStyle: 'normal', color: 'var(--accent)', fontWeight: 600 }}>{m[1]}</em>);
      rem = rem.slice(m.index + m[0].length);
    }
    return parts;
  };
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('- ') || t.startsWith('• ')) list.push(t.slice(2));
    else { flush(); if (t) out.push(<p key={'p' + i} style={{ margin: '6px 0' }}>{inline(t)}</p>); }
  });
  flush();
  return <>{out}</>;
};
```

- [ ] **Step 2: Commit**

```bash
git add Financial_analyze/src/page-news.jsx
git commit -m "feat(news): wire News tab to real feed, real article reads, real search"
```

---

### Task 9: Manual end-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Start the full stack**

```bash
cd Financial_analyze && ./scripts/run.sh
```
Expected: backend, frontend, and SearXNG all start; browser opens to the app.

- [ ] **Step 2: Verify the News tab shows real headlines**

Open the News tab. Expected: headlines are real CafeF (Vietnamese) and Reuters/Bloomberg/etc. (US) titles — not the old fixed mock set ("Fed signals cautious approach...", "NVIDIA's data center revenue surges 94%...", etc.). Switch between All / VN Market / VN Companies / US tabs and confirm each filters correctly (VN Market shows only `thi-truong-chung-khoan` items, VN Companies only `doanh-nghiep` items, US only yfinance items).

- [ ] **Step 3: Verify real article reads**

Click any story to open the modal, click "Read full story". Expected: real extracted article text appears (not an LLM-written 3-paragraph invention). If a URL is hard-blocked, expected instead: an error message plus a working "Open original ↗" link to the source.

- [ ] **Step 4: Verify search + grounded briefing**

Type a subject (e.g. "Vinamilk") into the research box and submit. Expected: a "Sources" list of real, clickable SearXNG result links appears, followed by an AI briefing that references those results.

- [ ] **Step 5: Verify graceful degradation when SearXNG is down**

```bash
pkill -f "searx.webapp"
```
Then submit another research query in the UI. Expected: "Search unavailable — start ./scripts/run_searxng.sh" message, no broken UI state, no LLM call made.

- [ ] **Step 6: Verify graceful degradation when the whole backend is down**

Stop the backend (Ctrl-C on `run.sh`, or `pkill -f "uvicorn app.main:app"`), reload the page. Expected: the app falls back to mock data (old behavior, unchanged) rather than showing a blank page or crash.

- [ ] **Step 7: Report status to the user**

Summarize what was verified and flag the artifact-export caveat: `src/page-news.jsx`, `src/app.jsx`, and `src/api-client.jsx` were edited locally and will be lost on the next Claude-artifact re-export unless ported back into the artifact first.

# Daily News Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect every news article the merged collector can find once a day, have the Hermes Agent summarize each article plus the whole day into the same Obsidian vault note, and serve that digest to the website.

**Architecture:** A merged `news_collector.py` service (yfinance, StockTwits, Reddit, Exa, CafeF, SearXNG) writes a raw dated note into the vault; a Hermes cron job reads it and rewrites it in place with a day summary plus per-article summaries; a new FastAPI endpoint reads that same file off disk; the website renders it above the existing live feed.

**Tech Stack:** Python 3.11 / FastAPI (existing `backend/.venv`), pytest + monkeypatch, React (existing `src/*.jsx`, no build step), Hermes Agent CLI (`hermes cron`).

## Global Constraints

- Merge `news_collector.py`'s broader source set (yfinance stock+global, StockTwits, Reddit, Exa) into the backend — one canonical collector going forward, no duplicate systems.
- Cadence is daily via `hermes cron create --script` (Hermes's own scheduler) — do not build a separate system cron/launchd timer.
- The collector just downloads, no filtering/curation of articles.
- Hermes writes per-article summaries AND one day-level summary into the SAME daily vault note (two sections: Day Summary on top, per-article summaries below grouped by source) — never split across files.
- The website reads the vault file directly via the new endpoint — no live Hermes call per page load.
- No new pip dependencies: yfinance, feedparser, trafilatura, pandas, numpy are already in `Financial_analyze/backend/.venv` per `requirements.txt` — confirmed by running `backend/.venv/bin/python -c "import yfinance, feedparser, trafilatura, numpy, pandas"` successfully during design.
- **Never run `git commit` or `git push`.** Every task's last step stages changes with `git add` only — the user commits (project `CLAUDE.md` rule, overrides this skill's normal "commit" step).
- `src/page-news.jsx` and `src/api-client.jsx` are exported from a Claude design artifact — local edits are lost on the next re-export. Task 5 ends with a reminder to port the changes into the artifact; it does not do that porting itself.

---

## File Structure

```
Financial_analyze/backend/app/services/news_collector.py   (new — merged collector, vault note writer/parser)
Financial_analyze/backend/tests/test_news_collector.py      (new)
Financial_analyze/backend/app/routes/news.py                (modify — add GET /api/news/summary)
Financial_analyze/backend/tests/test_news_summary_route.py  (new)
Financial_analyze/scripts/collect_daily_news.py              (new — cron entrypoint, symlinked into ~/.hermes/scripts/)
Financial_analyze/src/api-client.jsx                          (modify — add newsDailySummary())
Financial_analyze/src/page-news.jsx                           (modify — add Daily Digest panel)
```

---

### Task 1: Merged collector — fetch functions + dedup

**Files:**
- Create: `Financial_analyze/backend/app/services/news_collector.py`
- Test: `Financial_analyze/backend/tests/test_news_collector.py`

**Interfaces:**
- Consumes: `app.services.news.fetch_vn_rss(limit: int) -> list[dict]` and `app.services.news.search_web(query: str, count: int) -> list[dict]` (both already exist, unmodified).
- Produces (used by Task 2 and Task 3): `fetch_reddit_rss(ticker: str, sub: str, limit: int = 5) -> list[dict]`, `fetch_stocktwits(ticker: str, limit: int = 20) -> list[dict]`, `fetch_yfinance_news(ticker: str) -> list[dict]`, `fetch_yfinance_global_news() -> list[dict]`, `fetch_global_rss_feeds() -> list[dict]`, `fetch_exa_search(queries: list[str], limit: int = 5) -> list[dict]`, `fetch_searxng_search(queries: list[str], count: int = 5) -> list[dict]`, `deduplicate_articles(articles: list[dict]) -> list[dict]`. Every article dict has at least `{title, summary, source, url}`.

- [ ] **Step 1: Write the failing tests**

Create `Financial_analyze/backend/tests/test_news_collector.py`:

```python
import json
import subprocess

import pytest
import yfinance

from app.services import news, news_collector


def test_deduplicate_articles_removes_case_and_punctuation_duplicates():
    articles = [
        {"title": "VN30 rallies!", "source": "a", "url": "https://x/1", "summary": ""},
        {"title": "vn30 rallies", "source": "b", "url": "https://x/2", "summary": ""},
        {"title": "Different story", "source": "a", "url": "https://x/3", "summary": ""},
    ]

    unique = news_collector.deduplicate_articles(articles)

    assert len(unique) == 2
    assert unique[0]["url"] == "https://x/1"
    assert unique[1]["url"] == "https://x/3"


def test_fetch_reddit_rss_retries_once_on_429_then_succeeds(monkeypatch):
    calls = {"n": 0}
    atom_ok = b"""<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>VNM discussion</title><content>Bulls are back</content></entry>
</feed>"""

    def fake_urlopen(req, timeout=10):
        calls["n"] += 1
        if calls["n"] == 1:
            raise Exception("HTTP Error 429: Too Many Requests")
        class _Resp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return atom_ok
        return _Resp()

    monkeypatch.setattr(news_collector, "urlopen", fake_urlopen)
    monkeypatch.setattr(news_collector.time, "sleep", lambda s: None)

    posts = news_collector.fetch_reddit_rss("VNM", "stocks", limit=5)

    assert calls["n"] == 2
    assert posts == [{
        "title": "VNM discussion",
        "summary": "Bulls are back",
        "source": "reddit/r/stocks",
        "url": "https://www.reddit.com/r/stocks/search?q=VNM",
    }]


def test_fetch_stocktwits_handles_missing_entities_gracefully(monkeypatch):
    def fake_urlopen(req, timeout=10):
        class _Resp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return json.dumps({
                "messages": [{"id": 1, "body": "AAPL breaking out", "entities": None}]
            }).encode()
        return _Resp()

    monkeypatch.setattr(news_collector, "urlopen", fake_urlopen)

    posts = news_collector.fetch_stocktwits("AAPL", limit=5)

    assert posts == [{
        "title": "$AAPL: AAPL breaking out",
        "summary": "AAPL breaking out",
        "source": "stocktwits/$AAPL",
        "sentiment": "neutral",
        "url": "https://stocktwits.com/message/1",
    }]


def test_fetch_yfinance_news_parses_content_envelope(monkeypatch):
    def fake_get_news(self, count):
        return [{"content": {
            "title": "Apple hits new high",
            "summary": "AAPL rallied 3%",
            "provider": {"displayName": "Yahoo Finance"},
            "canonicalUrl": {"url": "https://finance.yahoo.com/aapl-high"},
        }}]

    monkeypatch.setattr(yfinance.Ticker, "get_news", fake_get_news)

    articles = news_collector.fetch_yfinance_news("AAPL")

    assert articles == [{
        "title": "Apple hits new high",
        "summary": "AAPL rallied 3%",
        "source": "yfinance/Yahoo Finance",
        "url": "https://finance.yahoo.com/aapl-high",
        "ticker": "AAPL",
    }]


def test_fetch_yfinance_global_news_stops_once_limit_hit(monkeypatch):
    call_count = {"n": 0}

    class FakeSearch:
        def __init__(self, query, news_count):
            call_count["n"] += 1
            self.news = [{"content": {
                "title": "Fed holds rates steady",
                "summary": "No change this meeting",
                "provider": {"displayName": "Reuters"},
                "canonicalUrl": {"url": "https://reuters.com/fed"},
            }}]

    monkeypatch.setattr(yfinance, "Search", FakeSearch)
    monkeypatch.setattr(news_collector, "YFINANCE_GLOBAL_LIMIT", 1)

    articles = news_collector.fetch_yfinance_global_news()

    assert call_count["n"] == 1
    assert articles == [{
        "title": "Fed holds rates steady",
        "summary": "No change this meeting",
        "source": "yfinance/global/Reuters",
        "url": "https://reuters.com/fed",
    }]


def test_fetch_global_rss_feeds_skips_dead_feed_keeps_others(monkeypatch):
    ok_feed = b"""<?xml version="1.0"?>
<rss><channel><item>
  <title>Markets steady</title>
  <description>Quiet session</description>
  <link>https://mw.test/1</link>
</item></channel></rss>"""

    def fake_urlopen(req, timeout=15):
        if "dead" in req.full_url:
            raise Exception("HTTP Error 404: Not Found")
        class _Resp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return ok_feed
        return _Resp()

    monkeypatch.setattr(news_collector, "urlopen", fake_urlopen)
    monkeypatch.setattr(news_collector, "RSS_FEEDS", [
        ("Dead Feed", "https://dead.test/rss"),
        ("MarketWatch", "https://mw.test/rss"),
    ])

    articles = news_collector.fetch_global_rss_feeds()

    assert articles == [{
        "title": "Markets steady",
        "summary": "Quiet session",
        "source": "rss/MarketWatch",
        "url": "https://mw.test/1",
    }]


def test_fetch_exa_search_parses_mcporter_json_and_sets_source_tag(monkeypatch):
    class FakeResult:
        returncode = 0
        stderr = ""
        stdout = json.dumps({"content": [{
            "type": "text",
            "text": "Title: VN Index rallies\nURL: https://example.com/vn\nPublished: 2026-07-07\nHighlights:\nStrong session for VN30.",
        }]})

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: FakeResult())
    monkeypatch.setattr(news_collector.time, "sleep", lambda s: None)

    articles = news_collector.fetch_exa_search(["Vietnam stock market today"], limit=1)

    assert len(articles) == 1
    assert articles[0]["title"] == "VN Index rallies"
    assert articles[0]["source"] == "exa/search"
    assert articles[0]["url"] == "https://example.com/vn"


def test_fetch_searxng_search_wraps_news_search_web(monkeypatch):
    monkeypatch.setattr(news, "search_web", lambda q, count: [
        {"title": "VN market up", "url": "https://x.com", "content": "brief"},
    ])

    articles = news_collector.fetch_searxng_search(["Vietnam stock market today"], count=1)

    assert articles == [{
        "title": "VN market up",
        "summary": "brief",
        "source": "searxng/search",
        "url": "https://x.com",
    }]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd Financial_analyze/backend && .venv/bin/pytest tests/test_news_collector.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.news_collector'`

- [ ] **Step 3: Write the implementation**

Create `Financial_analyze/backend/app/services/news_collector.py`:

```python
"""Merged daily news collector — yfinance, StockTwits, Reddit, Exa, plus the
existing CafeF/SearXNG sources from `app.services.news`. Downloads everything
it can find (no filtering/curation), writes a raw dated note into the
Obsidian vault, and parses that note back once Hermes has summarized it.

Run via `Financial_analyze/scripts/collect_daily_news.py` (Task 3), not
imported by the MCP news server — this module's yfinance/subprocess imports
are local to each function specifically so it stays safe to import even in
contexts that lack those deps (mirrors the constraint already documented in
`app.services.news`).
"""
import html
import json
import os
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from urllib.request import Request, urlopen

from . import news

REDDIT_SUBREDDITS = ("wallstreetbets", "stocks")
REDDIT_UA = "tradingagents/0.2 (+https://github.com/TauricResearch/TradingAgents)"
REDDIT_DELAY = 8
REDDIT_429_BACKOFF = 30

MCPORTER_CONFIG_PATH = "/Users/dien/config/mcporter.json"

STOCKTWITS_API = "https://api.stocktwits.com/api/2/streams/symbol/{ticker}.json"

YFINANCE_NEWS_LIMIT = 20
YFINANCE_GLOBAL_LIMIT = 30

RSS_FEEDS = [
    ("CNBC World", "https://www.cnbc.com/id/100003114/device/rss/rss.html"),
    ("Bloomberg Markets", "https://feeds.bloomberg.com/markets/news.rss"),
    ("MarketWatch Top Stories", "https://feeds.content.dowjones.io/public/rss/mw_topstories"),
    ("Yahoo Finance", "https://finance.yahoo.com/news/rssindex"),
]

EXA_QUERIES = [
    "Vietnam stock market today",
    "ASE HN index news",
    "Federal Reserve interest rate",
    "China economy impact Vietnam",
    "Global market news today",
    "Asian markets update",
]
SEARXNG_QUERIES = EXA_QUERIES

TRACKED_TICKERS = [
    "VN30", "HNX30", "UPCoM",
    "VNM", "VIC", "FPT", "HPG", "MBB",
    "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA",
    "SPY", "QQQ",
    "BTC-USD", "ETH-USD",
]
US_TICKERS = ["AAPL", "MSFT", "GOOGL", "NVDA", "SPY", "QQQ", "TSLA", "AMZN"]

VAULT_NEWS_DIR = os.environ.get(
    "VAULT_NEWS_DIR",
    "/Users/dien/Obsidian/Projects/Financial_Automation/News",
)


def fetch_reddit_rss(ticker: str, sub: str, limit: int = 5) -> list[dict]:
    """Fetch Reddit posts via public RSS feed (no API key needed)."""
    url = f"https://www.reddit.com/r/{sub}/search.rss?q={ticker}&sort=new&t=week&limit={limit}"
    req = Request(url, headers={"User-Agent": REDDIT_UA})

    try:
        with urlopen(req, timeout=10) as resp:
            root = ET.fromstring(resp.read())
    except Exception as e:
        if "429" not in str(e):
            return []
        time.sleep(REDDIT_429_BACKOFF)
        try:
            with urlopen(req, timeout=10) as resp:
                root = ET.fromstring(resp.read())
        except Exception:
            return []

    posts = []
    atom_ns = {"atom": "http://www.w3.org/2005/Atom"}
    for entry in root.findall("atom:entry", atom_ns)[:limit]:
        title_el = entry.find("atom:title", atom_ns)
        content_el = entry.find("atom:content", atom_ns)
        title = title_el.text if title_el is not None else ""
        content = content_el.text if content_el is not None else ""
        if content:
            content = re.sub(r"<[^>]+>", " ", content)
            content = html.unescape(content)
            content = " ".join(content.split())
        if len(content) > 300:
            content = content[:300] + "…"
        posts.append({
            "title": title,
            "summary": content,
            "source": f"reddit/r/{sub}",
            "url": f"https://www.reddit.com/r/{sub}/search?q={ticker}",
        })
    return posts


def fetch_stocktwits(ticker: str, limit: int = 20) -> list[dict]:
    """Fetch StockTwits messages (no API key needed)."""
    url = STOCKTWITS_API.format(ticker=ticker)
    req = Request(url, headers={"User-Agent": REDDIT_UA, "Accept": "application/json"})

    try:
        with urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
    except Exception:
        return []

    messages = data.get("messages", []) if isinstance(data, dict) else []
    posts = []
    for msg in messages[:limit]:
        body = (msg.get("body") or "").replace("\n", " ")
        sentiment = "neutral"
        entities = msg.get("entities")
        if entities and isinstance(entities, dict):
            sentiment_obj = entities.get("sentiment")
            if sentiment_obj and isinstance(sentiment_obj, dict):
                sentiment = sentiment_obj.get("basic", "neutral")
        if len(body) > 300:
            body = body[:300] + "…"
        posts.append({
            "title": f"${ticker}: {body[:100]}",
            "summary": body,
            "source": f"stocktwits/${ticker}",
            "sentiment": sentiment,
            "url": f"https://stocktwits.com/message/{msg.get('id', '')}",
        })
    return posts


def fetch_yfinance_news(ticker: str) -> list[dict]:
    """Fetch news for a specific ticker via yfinance."""
    try:
        import yfinance as yf
        stock = yf.Ticker(ticker)
        news_items = stock.get_news(count=YFINANCE_NEWS_LIMIT)
    except Exception:
        return []

    articles = []
    for article in news_items:
        if "content" in article:
            content = article["content"]
            title = content.get("title", "No title")
            summary = content.get("summary", "")
            publisher = content.get("provider", {}).get("displayName", "Unknown")
            url = content.get("canonicalUrl", {}).get("url", "") or content.get("clickThroughUrl", {}).get("url", "")
        else:
            title = article.get("title", "No title")
            summary = article.get("summary", "")
            publisher = article.get("publisher", "Unknown")
            url = article.get("link", "")
        articles.append({
            "title": title,
            "summary": summary,
            "source": f"yfinance/{publisher}",
            "url": url,
            "ticker": ticker,
        })
    return articles


def fetch_yfinance_global_news() -> list[dict]:
    """Fetch global macro news via yfinance Search."""
    try:
        import yfinance as yf
    except Exception:
        return []

    queries = ["Vietnam stock market", "ASE HN index", "Federal Reserve", "China economy", "Global markets"]
    all_news = []
    seen_titles = set()

    for query in queries:
        try:
            search = yf.Search(query=query, news_count=YFINANCE_GLOBAL_LIMIT)
        except Exception:
            continue
        for article in search.news or []:
            if "content" in article:
                content = article["content"]
                title = content.get("title", "")
                summary = content.get("summary", "")
                publisher = content.get("provider", {}).get("displayName", "Unknown")
                url = content.get("canonicalUrl", {}).get("url", "") or content.get("clickThroughUrl", {}).get("url", "")
            else:
                title = article.get("title", "")
                summary = article.get("summary", "")
                publisher = article.get("publisher", "Unknown")
                url = article.get("link", "")
            if title and title not in seen_titles:
                seen_titles.add(title)
                all_news.append({
                    "title": title,
                    "summary": summary,
                    "source": f"yfinance/global/{publisher}",
                    "url": url,
                })
        if len(all_news) >= YFINANCE_GLOBAL_LIMIT:
            break
    return all_news


def fetch_global_rss_feeds() -> list[dict]:
    """Fetch from the global (non-VN) RSS feeds."""
    articles = []
    for feed_name, feed_url in RSS_FEEDS:
        try:
            req = Request(feed_url, headers={"User-Agent": "Mozilla/5.0"})
            with urlopen(req, timeout=15) as resp:
                root = ET.fromstring(resp.read())
            ns = ""
            if root.tag.startswith("{"):
                ns = root.tag.split("}")[0] + "}"
            for item in root.findall(f"{ns}channel/item")[:10]:
                title_el = item.find(f"{ns}title")
                desc_el = item.find(f"{ns}description")
                link_el = item.find(f"{ns}link")
                title = title_el.text if title_el is not None else ""
                desc = desc_el.text if desc_el is not None else ""
                link = link_el.text if link_el is not None else ""
                if desc:
                    desc = re.sub(r"<[^>]+>", " ", desc)
                    desc = html.unescape(desc)
                    desc = " ".join(desc.split())
                if len(desc) > 400:
                    desc = desc[:400] + "…"
                articles.append({
                    "title": title,
                    "summary": desc,
                    "source": f"rss/{feed_name}",
                    "url": link,
                })
        except Exception:
            continue
    return articles


def fetch_exa_search(queries: list[str], limit: int = 5) -> list[dict]:
    """Fetch news via Exa semantic search using the mcporter CLI."""
    articles = []
    env = dict(os.environ, MCPORTER_CONFIG=MCPORTER_CONFIG_PATH)

    for query in queries:
        cmd = ["mcporter", "call", "exa.web_search_exa", f"query:{query}", f"numResults:{limit}", "--output", "json"]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, env=env)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue

        if result.returncode == 0 and result.stdout.strip():
            try:
                data = json.loads(result.stdout)
            except json.JSONDecodeError:
                continue
            for item in data.get("content", []):
                text = item.get("text", "")
                if not text or "MCP error" in text:
                    continue
                title, url = "", ""
                for line in text.split("\n"):
                    if line.startswith("Title: "):
                        title = line[7:].strip()
                    elif line.startswith("URL: "):
                        url = line[5:].strip()
                    elif line.startswith("Published: "):
                        break
                if "## Story" in text:
                    summary = text.split("## Story")[1].strip()[:500]
                elif "Highlights:" in text:
                    summary = text.split("Highlights:")[1].strip()[:500]
                else:
                    summary = text[:500]
                if title:
                    articles.append({"title": title, "summary": summary, "source": "exa/search", "url": url})
        time.sleep(1)
    return articles


def fetch_searxng_search(queries: list[str], count: int = 5) -> list[dict]:
    """Fetch news via the local SearXNG instance (delegates to app.services.news)."""
    articles = []
    for query in queries:
        try:
            hits = news.search_web(query, count)
        except RuntimeError:
            continue
        for hit in hits:
            articles.append({
                "title": hit["title"],
                "summary": hit["content"],
                "source": "searxng/search",
                "url": hit["url"],
            })
    return articles


def deduplicate_articles(articles: list[dict]) -> list[dict]:
    """Remove duplicate articles by normalized title."""
    seen = set()
    unique = []
    for article in articles:
        title = re.sub(r"[^a-z0-9\s]", "", article.get("title", "").lower().strip())
        title = " ".join(title.split())
        if title not in seen:
            seen.add(title)
            unique.append(article)
    return unique
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd Financial_analyze/backend && .venv/bin/pytest tests/test_news_collector.py -v`
Expected: PASS (8 tests)

- [ ] **Step 5: Stage for commit**

```bash
git add Financial_analyze/backend/app/services/news_collector.py Financial_analyze/backend/tests/test_news_collector.py
```

---

### Task 2: Vault note writer + parser + orchestrator

**Files:**
- Modify: `Financial_analyze/backend/app/services/news_collector.py`
- Modify: `Financial_analyze/backend/tests/test_news_collector.py`

**Interfaces:**
- Consumes: everything from Task 1, plus `news.fetch_vn_rss(limit: int) -> list[dict]`.
- Produces (used by Task 3 and Task 4): `collect_all_articles(date: str) -> dict` returning `{collection_date, total_articles, sources: {reddit, stocktwits, yfinance_stock, yfinance_global, rss, exa, cafef, searxng}, articles: [...]}`; `write_daily_note(date: str, result: dict, vault_dir: str = None) -> str` (returns the path written); `parse_daily_note(path: str) -> dict` returning `{processed: bool, day_summary: str|None, articles: [{source, title, url, summary}]}`, raising `FileNotFoundError` if `path` doesn't exist.

- [ ] **Step 1: Write the failing tests**

Append to `Financial_analyze/backend/tests/test_news_collector.py`:

```python
def test_collect_all_articles_merges_dedupes_and_counts_by_source(monkeypatch):
    monkeypatch.setattr(news_collector.time, "sleep", lambda s: None)
    monkeypatch.setattr(news_collector, "fetch_reddit_rss", lambda ticker, sub, limit=3: [
        {"title": "Reddit post", "summary": "", "source": "reddit/r/stocks", "url": "https://reddit.com/1"},
    ])
    monkeypatch.setattr(news_collector, "fetch_stocktwits", lambda ticker, limit=5: [
        {"title": "STWITS post", "summary": "", "source": "stocktwits/$AAPL", "url": "https://stocktwits.com/1"},
    ])
    monkeypatch.setattr(news_collector, "fetch_yfinance_news", lambda ticker: [
        {"title": "AAPL news", "summary": "", "source": "yfinance/Yahoo", "url": "https://y.com/1", "ticker": ticker},
    ])
    monkeypatch.setattr(news_collector, "fetch_yfinance_global_news", lambda: [
        {"title": "Fed news", "summary": "", "source": "yfinance/global/Reuters", "url": "https://y.com/2"},
    ])
    monkeypatch.setattr(news_collector, "fetch_global_rss_feeds", lambda: [
        {"title": "RSS story", "summary": "", "source": "rss/Bloomberg Markets", "url": "https://b.com/1"},
    ])
    monkeypatch.setattr(news_collector, "fetch_exa_search", lambda queries, limit=5: [
        {"title": "Exa story", "summary": "", "source": "exa/search", "url": "https://e.com/1"},
    ])
    monkeypatch.setattr(news_collector, "fetch_searxng_search", lambda queries, count=5: [
        {"title": "Searxng story", "summary": "", "source": "searxng/search", "url": "https://s.com/1"},
    ])
    monkeypatch.setattr(news, "fetch_vn_rss", lambda limit=30: [
        {"title": "CafeF story", "url": "https://cafef.vn/1", "published": 0, "category": "market"},
    ])

    result = news_collector.collect_all_articles("2026-07-07")

    assert result["collection_date"] == "2026-07-07"
    assert result["total_articles"] == 8
    assert result["sources"] == {
        "reddit": 1, "stocktwits": 1, "yfinance_stock": 1, "yfinance_global": 1,
        "rss": 1, "exa": 1, "cafef": 1, "searxng": 1,
    }


def test_write_daily_note_writes_expected_structure(tmp_path):
    result = {
        "total_articles": 2,
        "articles": [
            {"title": "First story", "summary": "Summary one", "source": "cafef/market", "url": "https://cafef.vn/1"},
            {"title": "Second story", "summary": "Summary two", "source": "reddit/r/stocks", "url": "https://reddit.com/2"},
        ],
    }

    path = news_collector.write_daily_note("2026-07-07", result, vault_dir=str(tmp_path))

    assert path == str(tmp_path / "2026-07-07.md")
    text = (tmp_path / "2026-07-07.md").read_text()
    assert "processed: false" in text
    assert "## Day Summary" in text
    assert "### cafef/market" in text
    assert "- **[First story](https://cafef.vn/1)** — Summary one" in text


def test_write_daily_note_handles_zero_articles(tmp_path):
    result = {"total_articles": 0, "articles": []}

    path = news_collector.write_daily_note("2026-07-07", result, vault_dir=str(tmp_path))

    assert "_No articles collected today._" in open(path).read()


def test_parse_daily_note_raw_note_is_stale(tmp_path):
    result = {"total_articles": 1, "articles": [
        {"title": "Story", "summary": "Brief", "source": "cafef/market", "url": "https://cafef.vn/1"},
    ]}
    path = news_collector.write_daily_note("2026-07-07", result, vault_dir=str(tmp_path))

    parsed = news_collector.parse_daily_note(path)

    assert parsed["processed"] is False
    assert parsed["day_summary"] is None


def test_parse_daily_note_processed_note_returns_summary_and_articles(tmp_path):
    note = """---
date: 2026-07-07
total_articles: 1
processed: true
---

# Daily Market Monitor — 2026-07-07

## Day Summary

Markets were mixed today as VN30 dipped slightly while US futures held steady.

## Articles

### cafef/market
- **[Story](https://cafef.vn/1)** — Modest pullback in VN blue chips.
"""
    path = tmp_path / "2026-07-07.md"
    path.write_text(note)

    parsed = news_collector.parse_daily_note(str(path))

    assert parsed["processed"] is True
    assert "mixed today" in parsed["day_summary"]
    assert parsed["articles"] == [{
        "source": "cafef/market", "title": "Story",
        "url": "https://cafef.vn/1", "summary": "Modest pullback in VN blue chips.",
    }]


def test_parse_daily_note_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        news_collector.parse_daily_note(str(tmp_path / "missing.md"))
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd Financial_analyze/backend && .venv/bin/pytest tests/test_news_collector.py -v -k "collect_all_articles or write_daily_note or parse_daily_note"`
Expected: FAIL with `AttributeError: module 'app.services.news_collector' has no attribute 'collect_all_articles'`

- [ ] **Step 3: Write the implementation**

Append to `Financial_analyze/backend/app/services/news_collector.py`:

```python
def collect_all_articles(date: str) -> dict:
    """Collect news from every source. Just downloads — no filtering/curation."""
    all_articles = []

    for i, sub in enumerate(REDDIT_SUBREDDITS):
        for j, ticker in enumerate(TRACKED_TICKERS[:3]):
            if i > 0 or j > 0:
                time.sleep(REDDIT_DELAY)
            all_articles.extend(fetch_reddit_rss(ticker, sub, limit=3))

    for ticker in US_TICKERS:
        all_articles.extend(fetch_stocktwits(ticker, limit=5))

    for ticker in TRACKED_TICKERS:
        all_articles.extend(fetch_yfinance_news(ticker))

    all_articles.extend(fetch_yfinance_global_news())
    all_articles.extend(fetch_global_rss_feeds())

    try:
        for item in news.fetch_vn_rss(limit=30):
            all_articles.append({
                "title": item["title"],
                "summary": "",
                "source": f"cafef/{item['category']}",
                "url": item["url"],
            })
    except RuntimeError:
        pass

    all_articles.extend(fetch_exa_search(EXA_QUERIES))
    all_articles.extend(fetch_searxng_search(SEARXNG_QUERIES))

    unique_articles = deduplicate_articles(all_articles)

    def _count(prefix, exclude=None):
        return len([
            a for a in unique_articles
            if a["source"].startswith(prefix) and (exclude is None or not a["source"].startswith(exclude))
        ])

    return {
        "collection_date": date,
        "total_articles": len(unique_articles),
        "sources": {
            "reddit": _count("reddit/"),
            "stocktwits": _count("stocktwits/"),
            "yfinance_stock": _count("yfinance/", exclude="yfinance/global"),
            "yfinance_global": _count("yfinance/global"),
            "rss": _count("rss/"),
            "exa": _count("exa/"),
            "cafef": _count("cafef/"),
            "searxng": _count("searxng/"),
        },
        "articles": unique_articles,
    }


def write_daily_note(date: str, result: dict, vault_dir: str = None) -> str:
    """Write the raw collected articles to a dated vault note. Returns the path written."""
    vault_dir = vault_dir or VAULT_NEWS_DIR
    os.makedirs(vault_dir, exist_ok=True)
    path = os.path.join(vault_dir, f"{date}.md")

    by_source = {}
    for article in result["articles"]:
        by_source.setdefault(article["source"], []).append(article)

    lines = [
        "---",
        f"date: {date}",
        f"total_articles: {result['total_articles']}",
        "processed: false",
        "---",
        "",
        f"# Daily Market Monitor — {date}",
        "",
        "## Day Summary",
        "",
        "_(pending — Hermes fills this in during the daily cron run)_",
        "",
        "## Articles",
        "",
    ]

    if not result["articles"]:
        lines.append("_No articles collected today._")
    else:
        for source in sorted(by_source):
            lines.append(f"### {source}")
            lines.append("")
            for article in by_source[source]:
                title = article["title"].replace("\n", " ").strip()
                summary = (article.get("summary") or "").replace("\n", " ").strip()
                lines.append(f"- **[{title}]({article['url']})** — {summary}")
            lines.append("")

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return path


_ARTICLE_RE = re.compile(r"^- \*\*\[(.+?)\]\((.+?)\)\*\* — (.*)$")
_PROCESSED_RE = re.compile(r"^processed:\s*(true|false)\s*$", re.MULTILINE)


def parse_daily_note(path: str) -> dict:
    """Parse a daily vault note into a day summary + per-article summaries.

    Raises FileNotFoundError if `path` doesn't exist.
    """
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()

    match = _PROCESSED_RE.search(text)
    processed = bool(match and match.group(1) == "true")

    day_summary = None
    if processed:
        summary_match = re.search(r"## Day Summary\n+(.*?)\n+## ", text, re.DOTALL)
        if summary_match:
            day_summary = summary_match.group(1).strip()

    articles = []
    current_source = None
    for line in text.splitlines():
        if line.startswith("### "):
            current_source = line[4:].strip()
            continue
        m = _ARTICLE_RE.match(line)
        if m and current_source:
            title, url, summary = m.groups()
            articles.append({"source": current_source, "title": title, "url": url, "summary": summary})

    return {"processed": processed, "day_summary": day_summary, "articles": articles}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd Financial_analyze/backend && .venv/bin/pytest tests/test_news_collector.py -v`
Expected: PASS (13 tests)

- [ ] **Step 5: Stage for commit**

```bash
git add Financial_analyze/backend/app/services/news_collector.py Financial_analyze/backend/tests/test_news_collector.py
```

---

### Task 3: Cron entrypoint script

**Files:**
- Create: `Financial_analyze/scripts/collect_daily_news.py`

**Interfaces:**
- Consumes: `news_collector.collect_all_articles(date)`, `news_collector.write_daily_note(date, result)` from Task 2.
- Produces: a runnable CLI (`python3 collect_daily_news.py [--date YYYY-MM-DD|today]`) that prints one confirmation line to stdout — consumed by the Hermes cron job in Task 6.

- [ ] **Step 1: Write the script**

Create `Financial_analyze/scripts/collect_daily_news.py`:

```python
#!/usr/bin/env python3
"""Daily news collector — cron entrypoint for Hermes.

Runs under backend/.venv (yfinance/pandas/numpy live there, not necessarily
in whatever python Hermes's cron scheduler invokes this with) — re-execs
itself under that interpreter if it isn't already running under it, so
`hermes cron --script` works regardless of which python3 it calls.

Registered as ~/.hermes/scripts/collect_daily_news.py (a symlink to this
file — see docs/superpowers/plans/2026-07-07-daily-news-digest.md Task 6).
"""
import os
import sys

_REPO_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
_BACKEND_DIR = os.path.abspath(os.path.join(_REPO_SCRIPTS_DIR, "..", "backend"))
_VENV_PYTHON = os.path.join(_BACKEND_DIR, ".venv", "bin", "python")

if os.path.exists(_VENV_PYTHON) and os.path.realpath(sys.executable) != os.path.realpath(_VENV_PYTHON):
    os.execv(_VENV_PYTHON, [_VENV_PYTHON, os.path.abspath(__file__)] + sys.argv[1:])

sys.path.insert(0, _BACKEND_DIR)

import argparse
from datetime import datetime

from app.services import news_collector


def main():
    parser = argparse.ArgumentParser(description="Daily news collector — writes today's raw vault note")
    parser.add_argument("--date", default="today", help="YYYY-MM-DD or 'today'")
    args = parser.parse_args()

    date = datetime.now().strftime("%Y-%m-%d") if args.date == "today" else args.date

    result = news_collector.collect_all_articles(date)
    path = news_collector.write_daily_note(date, result)

    print(f"Collected {result['total_articles']} articles for {date} → {path} — summarize them.")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x Financial_analyze/scripts/collect_daily_news.py`

- [ ] **Step 3: Verify the venv re-exec guard**

Run (deliberately with the *system* python3, not backend/.venv, to prove the guard works):
`/usr/bin/python3 Financial_analyze/scripts/collect_daily_news.py --date 2026-01-01`

Expected: no `ModuleNotFoundError` for `app` or `yfinance` — the process re-execs itself under `Financial_analyze/backend/.venv/bin/python` before importing `app.services.news_collector`. It will take a few minutes (real network calls, including the Reddit backoff delays) and end by printing a line starting with `Collected N articles for 2026-01-01 →`. Confirm the file it names exists:
`cat /Users/dien/Obsidian/Projects/Financial_Automation/News/2026-01-01.md | head -20`
Expected: front matter with `processed: false`, a `## Day Summary` placeholder, and `### <source>` sections with article bullets.

- [ ] **Step 4: Stage for commit**

```bash
git add Financial_analyze/scripts/collect_daily_news.py
```

---

### Task 4: Backend endpoint — `GET /api/news/summary`

**Files:**
- Modify: `Financial_analyze/backend/app/routes/news.py`
- Create: `Financial_analyze/backend/tests/test_news_summary_route.py`

**Interfaces:**
- Consumes: `news_collector.VAULT_NEWS_DIR` (str, monkeypatchable module attribute), `news_collector.parse_daily_note(path) -> dict` from Task 2.
- Produces: `GET /api/news/summary` → `{date: str, day_summary: str|None, articles: [{source,title,url,summary}], updated_at: str|None, stale: bool}`. Consumed by Task 5.

- [ ] **Step 1: Write the failing tests**

Create `Financial_analyze/backend/tests/test_news_summary_route.py`:

```python
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import news_collector


@pytest.fixture
def client():
    return TestClient(app)


def test_news_summary_returns_parsed_digest_when_processed(monkeypatch, client, tmp_path):
    monkeypatch.setattr(news_collector, "VAULT_NEWS_DIR", str(tmp_path))
    today = datetime.now().strftime("%Y-%m-%d")
    note = f"""---
date: {today}
total_articles: 1
processed: true
---

# Daily Market Monitor — {today}

## Day Summary

Quiet session, VN30 flat, US futures mixed.

## Articles

### cafef/market
- **[Story](https://cafef.vn/1)** — Modest pullback in VN blue chips.
"""
    (tmp_path / f"{today}.md").write_text(note)

    resp = client.get("/api/news/summary")

    assert resp.status_code == 200
    body = resp.json()
    assert body["stale"] is False
    assert "Quiet session" in body["day_summary"]
    assert body["articles"] == [{
        "source": "cafef/market", "title": "Story",
        "url": "https://cafef.vn/1", "summary": "Modest pullback in VN blue chips.",
    }]
    assert body["updated_at"] is not None


def test_news_summary_stale_when_note_missing(monkeypatch, client, tmp_path):
    monkeypatch.setattr(news_collector, "VAULT_NEWS_DIR", str(tmp_path))

    resp = client.get("/api/news/summary")

    assert resp.status_code == 200
    body = resp.json()
    assert body == {"date": body["date"], "day_summary": None, "articles": [], "updated_at": None, "stale": True}


def test_news_summary_stale_when_note_unprocessed(monkeypatch, client, tmp_path):
    monkeypatch.setattr(news_collector, "VAULT_NEWS_DIR", str(tmp_path))
    today = datetime.now().strftime("%Y-%m-%d")
    note = f"""---
date: {today}
total_articles: 1
processed: false
---

# Daily Market Monitor — {today}

## Day Summary

_(pending — Hermes fills this in during the daily cron run)_

## Articles

### cafef/market
- **[Story](https://cafef.vn/1)** —
"""
    (tmp_path / f"{today}.md").write_text(note)

    resp = client.get("/api/news/summary")

    assert resp.status_code == 200
    body = resp.json()
    assert body["stale"] is True
    assert body["day_summary"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd Financial_analyze/backend && .venv/bin/pytest tests/test_news_summary_route.py -v`
Expected: FAIL with `404 Not Found` (route doesn't exist yet)

- [ ] **Step 3: Write the implementation**

Modify `Financial_analyze/backend/app/routes/news.py` — add imports at the top and a new route at the end:

```python
"""News feed, search, and article extraction — VN (CafeF RSS) + US (yfinance)."""
import os
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

from ..services import market
from ..services import news as news_service
from ..services import news_collector

router = APIRouter()
```

(only the import block changes — `from ..services import news_collector`, `os`, `datetime`/`timezone` are new; everything below the existing `router = APIRouter()` line stays as-is). Then append this route at the end of the file, after `news_article`:

```python
@router.get("/news/summary")
def news_summary():
    today = datetime.now().strftime("%Y-%m-%d")
    path = os.path.join(news_collector.VAULT_NEWS_DIR, f"{today}.md")
    try:
        parsed = news_collector.parse_daily_note(path)
        updated_at = datetime.fromtimestamp(os.path.getmtime(path), tz=timezone.utc).isoformat()
    except FileNotFoundError:
        return {"date": today, "day_summary": None, "articles": [], "updated_at": None, "stale": True}

    return {
        "date": today,
        "day_summary": parsed["day_summary"],
        "articles": parsed["articles"],
        "updated_at": updated_at,
        "stale": not parsed["processed"],
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd Financial_analyze/backend && .venv/bin/pytest tests/test_news_summary_route.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full backend test suite to check for regressions**

Run: `cd Financial_analyze/backend && .venv/bin/pytest -q`
Expected: PASS (all existing tests plus the 16 new ones)

- [ ] **Step 6: Stage for commit**

```bash
git add Financial_analyze/backend/app/routes/news.py Financial_analyze/backend/tests/test_news_summary_route.py
```

---

### Task 5: Frontend — Daily Digest panel

**Files:**
- Modify: `Financial_analyze/src/api-client.jsx:99-102`
- Modify: `Financial_analyze/src/page-news.jsx:1-52` (state/effect), `:125-127` (panel insertion point)

**Interfaces:**
- Consumes: `GET /api/news/summary` (Task 4's response shape).
- Produces: `window.HelixAPI.newsDailySummary(): Promise<{date, day_summary, articles, updated_at, stale}>`.

- [ ] **Step 1: Add the API client method**

In `Financial_analyze/src/api-client.jsx`, in the `// ── News ──` section (around line 100-102), add one line after `newsArticle`:

```js
  // ── News ──────────────────────────────────────────────────
  news(limit = 30)                 { return this._get(`/api/news?limit=${limit}`); },
  newsSearch(q, count = 5)         { return this._get(`/api/news/search?q=${encodeURIComponent(q)}&count=${count}`); },
  newsArticle(url)                 { return this._get(`/api/news/article?url=${encodeURIComponent(url)}`); },
  newsDailySummary()               { return this._get('/api/news/summary'); },
```

- [ ] **Step 2: Add digest state + fetch effect to `PageNews`**

In `Financial_analyze/src/page-news.jsx`, right after the existing `const [story, setStory] = React.useState(null);` line (line 10), add:

```jsx
  const [digest, setDigest] = React.useState(null);
  const [digestExpanded, setDigestExpanded] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    window.HelixAPI.newsDailySummary()
      .then(d => { if (!cancelled) setDigest(d); })
      .catch(() => { if (!cancelled) setDigest({ stale: true, day_summary: null, articles: [] }); });
    return () => { cancelled = true; };
  }, []);
```

- [ ] **Step 3: Render the panel**

In `Financial_analyze/src/page-news.jsx`, insert this block right after the "Focus the analyst" card's closing `</div>` (immediately before the `<div className="tabs">` line):

```jsx
      {digest && !digest.stale && digest.day_summary && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header">
            <h3 className="card-title">Daily Digest</h3>
            <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{digest.date} · {digest.articles.length} articles</span>
          </div>
          <div className="card-body" style={{ padding: 16 }}>
            <div style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--text)' }}>
              <NewsFormatted text={digest.day_summary} />
            </div>
            {digest.articles.length > 0 && (
              <>
                <button
                  onClick={() => setDigestExpanded(v => !v)}
                  style={{ marginTop: 12, fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}
                >
                  {digestExpanded ? 'Hide' : 'Show'} all {digest.articles.length} articles {digestExpanded ? '↑' : '↓'}
                </button>
                {digestExpanded && (
                  <div style={{ marginTop: 10 }}>
                    {digest.articles.map((a, i) => (
                      <div key={i} style={{ padding: '8px 0', borderBottom: i < digest.articles.length - 1 ? '1px solid var(--border)' : 'none' }}>
                        <a href={a.url} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: 'var(--text)', textDecoration: 'none', fontWeight: 500 }}>{a.title}</a>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{a.summary}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-subtle)', marginTop: 2, fontFamily: 'var(--font-mono)' }}>{a.source}</div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {digest && digest.stale && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-body" style={{ padding: 16, textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}>
            No digest yet — check back after today's run.
          </div>
        </div>
      )}
```

- [ ] **Step 4: Manual verification — stale state**

Start the app (`./Financial_analyze/scripts/run.sh`), open the News page. With no vault note for today yet, confirm the "No digest yet — check back after today's run." card renders above the tabs, and the existing live feed below it is unaffected.

- [ ] **Step 5: Manual verification — processed state**

Manually create a processed note for today so the panel has something to render:

```bash
mkdir -p /Users/dien/Obsidian/Projects/Financial_Automation/News
TODAY=$(date +%F)
cat > "/Users/dien/Obsidian/Projects/Financial_Automation/News/${TODAY}.md" << EOF
---
date: ${TODAY}
total_articles: 1
processed: true
---

# Daily Market Monitor — ${TODAY}

## Day Summary

Quiet test session — VN30 flat, US futures mixed.

## Articles

### cafef/market
- **[Test story](https://cafef.vn/1)** — Modest pullback in VN blue chips.
EOF
```

Reload the News page. Confirm the Daily Digest card shows the summary, the "Show all 1 articles ↓" toggle expands to show the one article with its title/summary/source, and clicking the title opens the URL in a new tab.

- [ ] **Step 6: Stage for commit, and note the artifact risk**

```bash
git add Financial_analyze/src/api-client.jsx Financial_analyze/src/page-news.jsx
```

Remind the user (per project memory): these two files are exported from a Claude design artifact — port this same panel into the artifact before the next re-export, or the change is lost.

---

### Task 6: Hermes cron registration

**Files:** none (local Hermes configuration + a symlink, not part of the repo)

**Interfaces:**
- Consumes: `Financial_analyze/scripts/collect_daily_news.py` (Task 3), reads/rewrites files under `news_collector.VAULT_NEWS_DIR` (Task 2's format).
- Produces: a running daily cron job that turns Task 3's raw notes into the processed notes Task 4's endpoint expects.

- [ ] **Step 1: Symlink the script into `~/.hermes/scripts/`**

`hermes cron --script` requires the script to live under `~/.hermes/scripts/`. Keep the actual source under version control and symlink it in:

```bash
mkdir -p ~/.hermes/scripts
ln -sf "/Users/dien/Work/Project/Financial_analyze/Financial_analyze/scripts/collect_daily_news.py" ~/.hermes/scripts/collect_daily_news.py
```

Verify: `ls -la ~/.hermes/scripts/collect_daily_news.py` shows it pointing at the repo path.

- [ ] **Step 2: Register the cron job**

```bash
hermes cron create "0 6 * * *" \
  "A daily news note was just collected in the Obsidian vault at Projects/Financial_Automation/News/ (today's date, e.g. 2026-07-07.md). Open it, read every article listed under each '### <source>' heading, then rewrite the SAME file in place: (1) replace the placeholder line under '## Day Summary' with one decision-oriented paragraph summarizing the market's day overall — kết luận, xu hướng, cảnh báo rủi ro style, same as your statement-analysis reports, but market-wide instead of one company; (2) under each source heading, replace each article's summary — the text after the em-dash in '- **[title](url)** — summary' — with your own 1-2 line summary of that article, keeping the exact '- **[title](url)** — summary' format and leaving the title and url unchanged; (3) change 'processed: false' to 'processed: true' in the front matter. Do not add or remove any articles — only rewrite summaries and the front matter flag." \
  --name daily-news-digest \
  --script collect_daily_news.py \
  --workdir "/Users/dien/Work/Project/Financial_analyze/Financial_analyze"
```

Verify: `hermes cron list` shows a job named `daily-news-digest`.

- [ ] **Step 3: Fire it once on demand and verify end-to-end**

```bash
hermes cron run daily-news-digest
```

Wait for it to finish (the collector alone takes several minutes due to Reddit rate-limit backoffs), then:

```bash
TODAY=$(date +%F)
cat "/Users/dien/Obsidian/Projects/Financial_Automation/News/${TODAY}.md" | head -15
```

Expected: `processed: true` in the front matter, and a real paragraph under `## Day Summary` (not the placeholder text).

Then, with the backend running:

```bash
curl -s http://localhost:8000/api/news/summary | python3 -m json.tool
```

Expected: `"stale": false` and a non-null `"day_summary"` matching what's in the vault note.

- [ ] **Step 4: Nothing to stage**

This task registers local Hermes state (`~/.hermes/`), not repo files — there's nothing to `git add`.

---

## Self-Review Notes

- **Spec coverage:** merged collector (Task 1+2), daily cadence via Hermes's own scheduler (Task 6), vault note two-section format (Task 2's `write_daily_note`/`parse_daily_note`), endpoint reading the vault file directly with `stale` handling (Task 4), website panel (Task 5) — every spec section has a task.
- **Placeholder scan:** no TBD/TODO; every code step is complete, runnable code, not described-but-unwritten.
- **Type consistency:** `parse_daily_note`'s return shape (`processed`, `day_summary`, `articles`) is used identically in Task 4's route; `collect_all_articles`'s `sources` dict keys (`reddit`, `stocktwits`, `yfinance_stock`, `yfinance_global`, `rss`, `exa`, `cafef`, `searxng`) match across Task 2's implementation and test. `VAULT_NEWS_DIR` is defined once in Task 2 and referenced (never re-imported by value) in Tasks 3 and 4 so monkeypatching/env-override both work.

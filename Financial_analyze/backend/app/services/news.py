"""Shared news fetch logic — CafeF RSS (VN), SearXNG search, Trafilatura
article extraction. Used by both the FastAPI backend (routes/news.py) and
the standalone MCP server (mcp/news_search_tools.py, own venv because the
mcp SDK's starlette dependency conflicts with the pinned fastapi here).

No `mcp` or `yfinance` imports — must stay importable from both venvs.
"""
import calendar
import ipaddress
import json
import os
import socket
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


def _resolved_addresses(hostname: str) -> set[str]:
    try:
        return {item[4][0] for item in socket.getaddrinfo(hostname, None)}
    except socket.gaierror as e:
        raise RuntimeError(f"Could not resolve article host {hostname}") from e


def validate_article_url(url: str) -> None:
    """Reject non-public targets before the article fetcher makes a request."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise RuntimeError("Article URL must use http or https")
    if parsed.username or parsed.password:
        raise RuntimeError("Article URL must not contain credentials")

    hostname = parsed.hostname.rstrip(".").lower()
    if hostname == "localhost" or hostname.endswith((".localhost", ".local")):
        raise RuntimeError("Article URL must target a public internet host")

    try:
        addresses = {hostname} if ipaddress.ip_address(hostname) else set()
    except ValueError:
        addresses = _resolved_addresses(hostname)

    if not addresses:
        raise RuntimeError(f"Could not resolve article host {hostname}")
    if any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise RuntimeError("Article URL must target a public internet host")


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


def search_web(query: str, count: int = 5, time_range: str = "week") -> list[dict]:
    """Search recent news via a local, self-hosted SearXNG instance.

    Args:
        query: search terms.
        count: max results to return.
        time_range: SearXNG freshness window (day, week, or month).

    Returns [{title, url, content, source, published}]. Empty and duplicate
    results are removed. Raises RuntimeError with a clear "is it running?"
    message if SearXNG isn't reachable.
    """
    if time_range not in {"day", "week", "month"}:
        raise ValueError("time_range must be day, week, or month")

    def fetch_results(search_query: str, category: str) -> list[dict]:
        qs = urllib.parse.urlencode({
            "q": search_query,
            "format": "json",
            "categories": category,
            "time_range": time_range,
        })
        req = urllib.request.Request(f"{SEARXNG_URL}/search?{qs}")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read()).get("results", [])

    try:
        raw_results = fetch_results(query, "news")
    except Exception as e:
        raise RuntimeError(
            f"SearXNG unreachable at {SEARXNG_URL} — is it running? "
            f"(./scripts/run_searxng.sh) Error: {e}"
        ) from e

    # Public news engines are frequently rate-limited or CAPTCHA-blocked.
    # Preserve a working search by falling back to general engines, while
    # keeping the same freshness window and making news intent explicit.
    if not raw_results:
        try:
            raw_results = fetch_results(f"{query} news", "general")
        except Exception:
            raw_results = []

    results = []
    seen_urls = set()
    for item in raw_results:
        title = str(item.get("title") or "").strip()
        url = str(item.get("url") or "").strip()
        if not title or not url:
            continue

        # Fragments do not identify a different article. Treat a trailing
        # slash as equivalent too, while returning the original clean URL.
        parsed = urllib.parse.urlsplit(url)
        dedupe_url = urllib.parse.urlunsplit(
            (parsed.scheme.lower(), parsed.netloc.lower(), parsed.path.rstrip("/"), parsed.query, "")
        )
        if dedupe_url in seen_urls:
            continue
        seen_urls.add(dedupe_url)

        engines = item.get("engines") or []
        source = item.get("engine") or (engines[0] if engines else "")
        results.append({
            "title": title,
            "url": urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, "")),
            "content": str(item.get("content") or "").strip(),
            "source": str(source or ""),
            "published": str(item.get("publishedDate") or item.get("pubdate") or ""),
        })
        if len(results) >= count:
            break
    return results


def read_article(url: str) -> dict:
    """Fetch a URL and extract its clean full article text (via Trafilatura).

    Returns {url, title, text}. Raises RuntimeError if the page couldn't be
    fetched or no article content could be extracted (paywalled, JS-only,
    or hard-blocked — those need Camoufox, not built).
    """
    validate_article_url(url)
    downloaded = trafilatura.fetch_url(url)
    if not downloaded:
        raise RuntimeError(f"Could not fetch {url} (blocked, dead link, or network error)")
    text = trafilatura.extract(downloaded)
    if not text:
        raise RuntimeError(f"Fetched {url} but found no extractable article text")
    metadata = trafilatura.extract_metadata(downloaded)
    title = metadata.title if metadata and metadata.title else ""
    return {"url": url, "title": title, "text": text}

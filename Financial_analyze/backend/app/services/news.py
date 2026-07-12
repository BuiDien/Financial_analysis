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

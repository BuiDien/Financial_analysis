"""DB-free news feed code: RSS parsing, VN per-holding sources, URL dedupe.

Probe evidence (2026-11-13, plain HTTP, <=10s):
- CafeF: existing RSS via news.fetch_vn_rss -> kept ("cafef").
- Vietstock: public RSS (e.g. /830/chung-khoan/co-phieu.rss, 20 items,
  application/rss+xml, no login) -> kept, one fetcher per category feed
  (keys "vietstock/<feed>", so one failing feed is reported on its own).
- HOSE (hsx.vn): the site is a JS single-page app (1.9 KB shell; the API
  answers 400 without app-issued params) -> dropped, needs a browser.
- HNX (hnx.vn): Vue SPA; disclosure/RSS paths return 404 -> dropped.
Disclosures for HOSE/HNX tickers are therefore only reached via Vietstock
and the per-holding SearXNG news search (always run, week window, because the
RSS feeds only reach back ~1.5-2 days).
"""
from __future__ import annotations

import calendar
import re
import unicodedata
import urllib.request
from datetime import datetime, timezone
from typing import Callable, Iterable, TypedDict

import feedparser

from . import news

__all__ = [
    "NewsItem", "Fetcher", "VIETSTOCK_FEEDS", "DEFAULT_VN_FETCHERS",
    "http_get", "parse_feed", "dedupe_by_url", "search_epoch", "mentions",
    "fetch_all_vn", "match_holding_news",
]


class NewsItem(TypedDict):
    id: str
    title: str
    url: str
    source: str
    published: int
    summary: str


Fetcher = Callable[[], "list[NewsItem]"]

VIETSTOCK_FEEDS = {
    "co-phieu": "https://vietstock.vn/830/chung-khoan/co-phieu.rss",
    "doanh-nghiep": "https://vietstock.vn/733/doanh-nghiep.rss",
    "co-tuc": "https://vietstock.vn/738/doanh-nghiep/co-tuc.rss",
    "giao-dich-noi-bo": "https://vietstock.vn/739/chung-khoan/giao-dich-noi-bo.rss",
}


def http_get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": news.USER_AGENT})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.read()


def _is_url(value) -> bool:
    return isinstance(value, str) and value.startswith(("http://", "https://"))


def parse_feed(raw_or_url: bytes | str, source: str, limit: int | None = None,
               summary_limit: int = 500) -> list[NewsItem]:
    """Parse an RSS/Atom feed into NewsItems (``published`` = epoch, 0 if absent).

    ``raw_or_url`` is either the feed body or an http(s) URL fetched via
    ``http_get``. A body with no entries that is not a recognisable feed
    (e.g. an HTML error page) raises ``RuntimeError("unparseable feed ...")``.
    """
    is_url = _is_url(raw_or_url)
    raw = http_get(raw_or_url) if is_url else raw_or_url
    parsed = feedparser.parse(raw)
    if not parsed.entries and (parsed.get("bozo") or not parsed.get("version")):
        raise RuntimeError(f"unparseable feed {raw_or_url if is_url else source}")
    entries = parsed.entries if limit is None else parsed.entries[:limit]
    out: list[NewsItem] = []
    for e in entries:
        published = (calendar.timegm(e.published_parsed)
                     if e.get("published_parsed") else 0)
        out.append({
            "id": "", "title": e.get("title") or "", "url": e.get("link") or "",
            "source": source, "published": published,
            "summary": news.plain_summary(e.get("summary", ""), summary_limit),
        })
    return out


def dedupe_by_url(items: Iterable[NewsItem]) -> list[NewsItem]:
    """Drop repeated URLs, keeping the first occurrence (order preserved)."""
    seen: set[str] = set()
    out: list[NewsItem] = []
    for it in items:
        if it["url"] in seen:
            continue
        seen.add(it["url"])
        out.append(it)
    return out


def search_epoch(value) -> int:
    """SearXNG ``publishedDate`` (ISO 8601 string) -> epoch seconds; 0 if absent/unparseable.

    Naive timestamps are taken as UTC.
    """
    text = str(value or "").strip()
    if not text:
        return 0
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return 0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def _nfc(text: str) -> str:
    return unicodedata.normalize("NFC", text or "")


def mentions(text: str, names: list[str]) -> bool:
    hay = _nfc(text)
    low = hay.lower()
    for name in names:
        n = _nfc(name).strip()
        if not n:
            continue
        if n.isascii() and n.isupper() and len(n) <= 5:
            if re.search(rf"(?<![A-Za-z0-9]){re.escape(n)}(?![A-Za-z0-9])", hay):
                return True
        elif n.lower() in low:
            return True
    return False


def _fetch_cafef() -> list[NewsItem]:
    return [
        {"id": "", "title": r["title"], "url": r["url"], "source": "cafef",
         "published": r["published"], "summary": r["summary"]}
        for r in news.fetch_vn_rss(limit=200)
    ]


DEFAULT_VN_FETCHERS: dict[str, Fetcher] = {
    "cafef": _fetch_cafef,
    **{
        f"vietstock/{name}": (lambda u=url: parse_feed(u, "vietstock"))
        for name, url in VIETSTOCK_FEEDS.items()
    },
}


def fetch_all_vn(fetchers: dict[str, Fetcher] | None = None
                 ) -> tuple[list[NewsItem], list[str]]:
    """Run every fetcher; a failing one is reported as ``"<key>: <error>"``."""
    fetchers = DEFAULT_VN_FETCHERS if fetchers is None else fetchers
    items: list[NewsItem] = []
    errors: list[str] = []
    for key, fetch in fetchers.items():
        try:
            items.extend(fetch())
        except Exception as e:
            errors.append(f"{key}: {e}")
    return dedupe_by_url(items), errors


def match_holding_news(items: list[NewsItem], names: list[str], since_epoch: int,
                       search=news.search_web, brand: str | None = None
                       ) -> tuple[list[NewsItem], list[str]]:
    """RSS items mentioning the holding, plus a per-holding SearXNG news search.

    The search always runs (RSS reaches back only ~1.5-2 days, the news window
    is a week). Results are merged and deduped by URL, RSS first. A search that
    only returned general-engine fallback results is a source error, not news.
    ``brand`` is the search term; without it the second name (the company
    name) is used, else the first.
    """
    matches = [
        it for it in items
        if (it["published"] >= since_epoch or it["published"] == 0)
        and mentions(f"{it['title']} {it['summary']}", names)
    ]
    errors: list[str] = []
    if names:
        term = brand if brand is not None else (names[1] if len(names) > 1 else names[0])
        try:
            results = search(f'"{term}" cổ phiếu', 5)
        except Exception as e:
            errors.append(f"searxng: {e}")
        else:
            if any(r.get("fallback") for r in results):
                errors.append("searxng: no news results")
            else:
                for r in results:
                    published = search_epoch(r.get("published"))
                    if published and published < since_epoch:
                        continue
                    # Same relevance bar as RSS: a hit must name the holding.
                    if not mentions(f"{r.get('title', '')} {r.get('content', '')}", names):
                        continue
                    matches.append({
                        "id": "", "title": r.get("title", ""), "url": r.get("url", ""),
                        "source": "searxng", "published": published,
                        "summary": news.plain_summary(r.get("content", "")),
                    })
    return dedupe_by_url(matches), errors

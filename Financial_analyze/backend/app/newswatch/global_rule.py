"""Global news rule: trusted Vietnam-topic articles and VN-Index day change."""
from __future__ import annotations

import re
import unicodedata
from urllib.parse import urlparse

from ..services import news, news_collector
from ..services.news_feeds import NewsItem, parse_feed, search_epoch
from .watch_config import WatchConfig


def _norm(s: str) -> str:
    return unicodedata.normalize("NFC", s or "").lower()


def is_trusted(item: NewsItem, trusted: list[str]) -> bool:
    host = (urlparse(item.get("url") or "").hostname or "").lower()
    source = _norm(item.get("source", ""))
    # searxng/<host> sources are derived from the URL host: judge by host only
    check_source = not source.startswith("searxng/")
    for t in trusted:
        t = t.lower()
        if host == t or host.endswith("." + t):
            return True
        label = t.split(".")[0]
        if check_source and re.search(r"\b" + re.escape(label) + r"(?!\w)", source):
            return True
    return False


def _has_term(text: str, term: str) -> bool:
    term = _norm(term)
    if not term:
        return False
    if term.isascii() and " " not in term:
        # word-start boundary: "sbv" must not match inside "crossbvs"
        return re.search(r"(?<!\w)" + re.escape(term), text) is not None
    return term in text


def match_vietnam_topics(items: list[NewsItem], cfg: WatchConfig,
                         exclude_urls: set[str] = frozenset()) -> list[dict]:
    out: list[dict] = []
    for it in items:
        if it.get("url") in exclude_urls or not is_trusted(it, cfg["trusted_sources"]):
            continue
        title = _norm(it.get("title", ""))
        text = _norm(f"{it.get('title', '')} {it.get('summary', '')}")
        if not any(_has_term(title, t) for t in cfg["vietnam_terms"]):
            continue
        for topic, kws in cfg["topics"].items():
            if any(_has_term(text, k) for k in kws):
                out.append({**it, "topic": topic})
                break
    return out


def _item(title: str, url: str, source: str, summary: str, published: int = 0) -> NewsItem:
    return {"id": url, "title": title or "", "url": url or "", "source": source,
            "published": published or 0, "summary": summary or ""}


def _fetch_rss(name: str, url: str) -> list[NewsItem]:
    """One global feed (news_collector.RSS_FEEDS): first 20 entries, id = URL."""
    return [{**it, "id": it["url"]}
            for it in parse_feed(url, f"rss/{name}", limit=20, summary_limit=400)]


def fetch_global_candidates(cfg: WatchConfig, search=news.search_web
                            ) -> tuple[list[NewsItem], list[str]]:
    items: list[NewsItem] = []
    errors: list[str] = []
    for name, url in news_collector.RSS_FEEDS:
        try:
            items.extend(_fetch_rss(name, url))
        except Exception as e:
            errors.append(f"rss/{name}: {e}")
    for topic in cfg["topics"]:
        try:
            results = search(f"Vietnam {topic}", 5, time_range="day")
        except Exception as e:
            errors.append(f"search {topic}: {e}")
            continue
        if any(r.get("fallback") for r in results):
            errors.append(f"search {topic}: no news results")
            continue
        for r in results:
            url = r.get("url") or ""
            host = urlparse(url).netloc.lower()
            items.append(_item(r.get("title"), url, f"searxng/{host}", r.get("content"),
                               search_epoch(r.get("published"))))
    return items, errors


def vnindex_day_change(bars: list[dict]) -> tuple[str, float] | None:
    if len(bars) < 2:
        return None
    try:
        prev, last = float(bars[-2]["close"]), float(bars[-1]["close"])
    except (KeyError, TypeError, ValueError):
        return None
    if prev <= 0 or last <= 0:
        return None
    return str(bars[-1]["date"])[:10], (last / prev - 1) * 100

"""Merged daily news collector.

The daily digest is deliberately source-curated: official/finance-specialized
VN feeds, high-quality global macro feeds, narrow search queries, and optional
world-news YouTube candidates. Reddit and StockTwits fetchers stay available
for a future sentiment workflow, but raw social posts do not enter the daily
market note.

Run via `Financial_analyze/scripts/collect_daily_news.py` (Task 3), not
imported by the MCP news server — this module's market-data/subprocess imports
are local to each function specifically so it stays safe to import even in
contexts that lack those deps (mirrors the constraint already documented in
`app.services.news`).
"""
import concurrent.futures
import html
import json
import os
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from urllib.request import Request, urlopen

from . import news
from .news_feeds import fetch_all_vn, match_holding_news
from ..config import get_settings

FULL_TEXT_WORKERS = 8
MAX_FULL_TEXT_CHARS = 4_000
MAX_DIGEST_FULL_TEXT_CHARS = 160_000

REDDIT_SUBREDDITS = ("wallstreetbets", "stocks")
REDDIT_UA = "tradingagents/0.2 (+https://github.com/TauricResearch/TradingAgents)"
REDDIT_DELAY = 8

MCPORTER_CONFIG_PATH = "/Users/dien/config/mcporter.json"

STOCKTWITS_API = "https://api.stocktwits.com/api/2/streams/symbol/{ticker}.json"

YFINANCE_NEWS_LIMIT = 10
YFINANCE_GLOBAL_LIMIT = 20

RSS_FEEDS = [
    ("CNBC World", "https://www.cnbc.com/id/100003114/device/rss/rss.html"),
    ("Bloomberg Markets", "https://feeds.bloomberg.com/markets/news.rss"),
    ("MarketWatch Top Stories", "https://feeds.content.dowjones.io/public/rss/mw_topstories"),
    ("Yahoo Finance", "https://finance.yahoo.com/news/rssindex"),
]

SEARCH_QUERIES = [
    "Vietnam VN-Index stock market today",
    "Vietnam HNX UPCoM stock market today",
    "Vietnam stock market foreign investors liquidity",
    "Federal Reserve rates inflation markets",
    "China economy Vietnam exports supply chain",
    "global markets oil gold dollar Asia stocks",
]
EXA_QUERIES = SEARCH_QUERIES
SEARXNG_QUERIES = SEARCH_QUERIES

TRACKED_TICKERS = [
    "VN30", "HNX30", "UPCoM",
    "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA",
    "SPY", "QQQ",
    "BTC-USD", "ETH-USD",
]
# Per-ticker Yahoo news is capped and publisher-filtered. It is useful for
# global bellwethers, but broad ticker pulls are where most SEO/opinion noise
# enters the old digest.
US_TICKERS = ["AAPL", "MSFT", "GOOGL", "NVDA", "SPY", "QQQ", "TSLA", "AMZN"]

YOUTUBE_WORLD_CHANNELS = [
    {"name": "Bloomberg Markets", "url": "https://www.youtube.com/@markets/videos"},
    {"name": "Reuters", "url": "https://www.youtube.com/@Reuters/videos"},
    {"name": "Financial Times", "url": "https://www.youtube.com/@FinancialTimes/videos"},
    {"name": "CNBC International", "url": "https://www.youtube.com/@CNBCInternational/videos"},
    {"name": "Wall Street Journal", "url": "https://www.youtube.com/@wsj/videos"},
]

REJECT_SOURCE_PREFIXES = ("reddit/", "stocktwits/")
YFINANCE_ALLOWED_PUBLISHERS = {
    "Associated Press",
    "Barrons.com",
    "Bloomberg",
    "CNBC",
    "Investor's Business Daily",
    "MarketWatch",
    "MT Newswires",
    "Reuters",
    "The Wall Street Journal",
    "Yahoo Finance",
    "Yahoo Finance Video",
}
REJECT_TITLE_PATTERNS = (
    "retirement",
    "social security",
    "wedding",
    "student loans",
    "personal finance",
    "motley fool",
    "insider monkey",
    "24/7 wall st",
    "trefis",
    "zacks",
    "fate/stay",
    "europowers",
    "amazing stocks to buy",
)
YOUTUBE_REJECT_TITLE_PATTERNS = (
    "coveted",
    "luxury",
    "suv",
    "supercar",
    "mansion",
    "real estate tour",
    "how much should you pay",
    "why americans pay",
    "travel guide",
)
YOUTUBE_WORLD_TITLE_KEYWORDS = (
    "ai",
    "asia",
    "bank",
    "bond",
    "china",
    "central bank",
    "dollar",
    "earnings",
    "economy",
    "europe",
    "fed",
    "federal reserve",
    "finance",
    "gdp",
    "gold",
    "inflation",
    "iran",
    "market",
    "macro",
    "oil",
    "rate",
    "russia",
    "stock",
    "tariff",
    "trade",
    "ukraine",
    "vietnam",
    "wall street",
)
SOURCE_LIMITS = {
    "cafef/market": 20,
    "cafef/companies": 20,
    "rss/Bloomberg Markets": 10,
    "rss/CNBC World": 6,
    "rss/MarketWatch Top Stories": 5,
    "rss/Yahoo Finance": 5,
    "exa/search": 8,
    "searxng/search": 8,
    "youtube/world": 8,
    "yfinance/global": 12,
    "yfinance": 20,
}

# From Settings so backend/.env applies (VAULT_NEWS_DIR there or in the env).
VAULT_NEWS_DIR = get_settings().vault_news_dir


class RedditRateLimited(Exception):
    """Raised by fetch_reddit_rss on a 429 — signals the caller to stop
    trying Reddit for the rest of this run instead of burning time on
    requests that will almost certainly 429 again."""


def fetch_reddit_rss(ticker: str, sub: str, limit: int = 5) -> list[dict]:
    """Fetch Reddit posts via public RSS feed (no API key needed).

    Fails fast — no in-function retry/backoff. A 429 raises
    RedditRateLimited immediately so the caller can short-circuit the rest
    of the Reddit fetch loop rather than sleeping through a wall.
    """
    url = f"https://www.reddit.com/r/{sub}/search.rss?q={ticker}&sort=new&t=week&limit={limit}"
    req = Request(url, headers={"User-Agent": REDDIT_UA})

    try:
        with urlopen(req, timeout=10) as resp:
            root = ET.fromstring(resp.read())
    except Exception as e:
        if "429" in str(e):
            raise RedditRateLimited(str(e)) from e
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
        from ..marketdata import get_global_provider
        news_items = get_global_provider().ticker_news(ticker, YFINANCE_NEWS_LIMIT)
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
        from ..marketdata import get_global_provider
        provider = get_global_provider()
    except Exception:
        return []

    queries = ["Vietnam stock market", "ASE HN index", "Federal Reserve", "China economy", "Global markets"]
    all_news = []
    seen_titles = set()

    for query in queries:
        try:
            found = provider.search_news(query, YFINANCE_GLOBAL_LIMIT)
        except Exception:
            continue
        for article in found:
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


def fetch_youtube_world_news(channels: list[dict] = None, per_channel: int = 2) -> list[dict]:
    """Fetch recent world-news video candidates from curated YouTube channels.

    Uses yt-dlp if present. This collector stores metadata/description only;
    transcript extraction belongs in the Hermes/Agent-Reach deep-research step.
    Missing yt-dlp or a blocked channel simply yields no items.
    """
    channels = channels or YOUTUBE_WORLD_CHANNELS
    articles = []
    for channel in channels:
        cmd = [
            sys.executable,
            "-m",
            "yt_dlp",
            "--flat-playlist",
            "--dump-single-json",
            "--playlist-end",
            str(per_channel),
            channel["url"],
        ]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=25)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue
        if result.returncode != 0 or not result.stdout.strip():
            continue
        try:
            data = json.loads(result.stdout)
        except json.JSONDecodeError:
            continue
        for item in (data.get("entries") or [])[:per_channel]:
            title = item.get("title") or ""
            if not is_world_youtube_title(title):
                continue
            video_id = item.get("id") or ""
            url = item.get("url") or (f"https://www.youtube.com/watch?v={video_id}" if video_id else channel["url"])
            duration = item.get("duration")
            if duration is not None and duration < 60:
                continue
            articles.append({
                "title": title,
                "summary": item.get("description") or "",
                "source": f"youtube/world/{channel['name']}",
                "url": url,
            })
    return articles


def is_world_youtube_title(title: str) -> bool:
    normalized = title.lower()
    if any(pattern in normalized for pattern in YOUTUBE_REJECT_TITLE_PATTERNS):
        return False
    return any(
        re.search(rf"(?<!\w){re.escape(keyword)}(?!\w)", normalized)
        for keyword in YOUTUBE_WORLD_TITLE_KEYWORDS
    )


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


def _publisher_from_source(source: str) -> str:
    if source.startswith("yfinance/global/"):
        return source.removeprefix("yfinance/global/")
    if source.startswith("yfinance/"):
        return source.removeprefix("yfinance/")
    return ""


def _source_limit_key(source: str) -> str | None:
    for key in SOURCE_LIMITS:
        if source.startswith(key):
            return key
    return None


def is_daily_digest_article(article: dict) -> bool:
    """True when an article is suitable for the daily market digest."""
    source = article.get("source", "")
    title = article.get("title", "")
    text = f"{title} {article.get('summary', '')}".lower()

    if not title or not article.get("url"):
        return False
    if source.startswith(REJECT_SOURCE_PREFIXES):
        return False
    if any(pattern in text for pattern in REJECT_TITLE_PATTERNS):
        return False
    if source.startswith("yfinance/"):
        publisher = _publisher_from_source(source)
        if publisher not in YFINANCE_ALLOWED_PUBLISHERS:
            return False
    return True


def apply_daily_source_policy(articles: list[dict]) -> list[dict]:
    """Filter noisy sources and cap broad feeds before writing the daily note."""
    kept = []
    counts = {}
    for article in articles:
        if not is_daily_digest_article(article):
            continue
        key = _source_limit_key(article.get("source", ""))
        if key:
            limit = SOURCE_LIMITS[key]
            if counts.get(key, 0) >= limit:
                continue
            counts[key] = counts.get(key, 0) + 1
        kept.append(article)
    return kept


def fetch_full_text(url: str) -> str:
    """Fetch an article's full body text via Trafilatura (delegates to app.services.news).

    Best-effort — returns "" on any failure (dead link, paywall, JS-only page,
    or a URL that isn't a real article page at all, e.g. a search results URL).
    """
    try:
        return news.read_article(url)["text"]
    except RuntimeError:
        return ""


def attach_full_text(articles: list[dict], max_workers: int = FULL_TEXT_WORKERS) -> list[dict]:
    """Fetch full article text for every article, concurrently, in place.

    Same graceful-degradation pattern as every fetcher in this module: a
    failed fetch just leaves `full_text` empty, it never aborts the run.
    """
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
        texts = list(pool.map(lambda a: fetch_full_text(a["url"]), articles))
    remaining = MAX_DIGEST_FULL_TEXT_CHARS
    for article, article_text in zip(articles, texts):
        clipped = article_text[: min(MAX_FULL_TEXT_CHARS, remaining)]
        article["full_text"] = clipped
        remaining -= len(clipped)
    return articles


def _collect_holdings_news(holdings: dict[str, list[str]]) -> tuple[dict, list[str]]:
    """Per-holding VN news from the DB-free feed module."""
    items, errors = fetch_all_vn()
    errors = list(errors)
    since = int(time.time()) - get_settings().newswatch_news_days * 86400
    out: dict = {}
    for ticker, names in holdings.items():
        matches, fb_errors = match_holding_news(items, names, since, search=news.search_web)
        out[ticker] = matches
        errors.extend(fb_errors)
    return out, errors


def collect_all_articles(date: str, holdings: dict[str, list[str]] | None = None) -> dict:
    """Collect and curate daily market news before Hermes summarizes it.

    `holdings` maps ticker -> search names; built by the caller (the script owns
    the DB access, this module stays DB-free).
    """
    all_articles = []

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
    all_articles.extend(fetch_youtube_world_news())

    unique_articles = apply_daily_source_policy(deduplicate_articles(all_articles))
    attach_full_text(unique_articles)

    def _count(prefix, exclude=None):
        return len([
            a for a in unique_articles
            if a["source"].startswith(prefix) and (exclude is None or not a["source"].startswith(exclude))
        ])

    holdings_news, source_errors = _collect_holdings_news(holdings) if holdings else ({}, [])

    return {
        "collection_date": date,
        "holdings": holdings_news,
        "source_errors": source_errors,
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
            "youtube": _count("youtube/world/"),
        },
        "articles": unique_articles,
    }


def write_daily_note(
    date: str,
    result: dict,
    vault_dir: str = None,
    overwrite_processed: bool = False,
) -> str:
    """Write the raw collected articles to a dated vault note. Returns the path written."""
    vault_dir = vault_dir or VAULT_NEWS_DIR
    os.makedirs(vault_dir, exist_ok=True)
    path = os.path.join(vault_dir, f"{date}.md")
    if os.path.exists(path) and not overwrite_processed:
        try:
            existing = parse_daily_note(path)
        except (UnicodeDecodeError, OSError):
            pass
        else:
            if existing["processed"]:
                raise FileExistsError(
                    f"Refusing to overwrite processed daily note {path}; use --force to replace it"
                )

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
    ]

    holdings_news = result.get("holdings") or {}
    if holdings_news:
        lines.extend(["## Holdings", ""])
        for ticker, items in holdings_news.items():
            lines.extend([f"### {ticker}", ""])
            if not items:
                lines.append("_No news._")
            for it in items:
                title = it["title"].replace("\n", " ").strip()
                lines.append(f"- [{title}]({it['url']}) — {it['source']}")
            lines.append("")

    lines.extend(["## Articles", ""])

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
                full_text = (article.get("full_text") or "").strip()
                if full_text:
                    lines.append("")
                    lines.extend(f"> {ln}" for ln in full_text.splitlines())
                    lines.append("")
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

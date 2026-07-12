#!/opt/homebrew/bin/python3.11
"""
Daily News Collector for Financial Analysis
Collects news from multiple sources and outputs structured JSON for AI processing.

Sources:
- Exa Semantic Search (via mcporter CLI)
- Reddit RSS (public feeds, no API key)
- StockTwits (public API, no key)
- yfinance News (Yahoo Finance)
- RSS Feeds (CNBC, Bloomberg, Reuters, CafeF)

Usage:
    python3 news_collector.py --date 2026-07-07 --output news_data.json
    python3 news_collector.py --date today --output news_data.json
"""

# Clear PYTHONPATH to prevent numpy C-extension version mismatch
# (Hermes venv's 3.11 numpy gets picked up by system Python 3.9)
import os
os.environ.pop("PYTHONPATH", None)
os.environ.pop("PYTHONHOME", None)

import json
import argparse
import logging
import time
from datetime import datetime, timedelta
from typing import Optional
from urllib.request import Request, urlopen
from urllib.parse import urlencode
import xml.etree.ElementTree as ET
import html
import re

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Reddit RSS configuration (from TradingAgents)
# Only use subreddits that are less likely to rate-limit
REDDIT_SUBREDDITS = ("wallstreetbets", "stocks")
REDDIT_UA = "tradingagents/0.2 (+https://github.com/TauricResearch/TradingAgents)"
REDDIT_DELAY = 8  # seconds between requests to avoid 429
REDDIT_429_BACKOFF = 30  # seconds to wait after a 429 before retrying once

# mcporter needs this env var to find the exa server config on this machine
MCPORTER_CONFIG_PATH = "/Users/dien/config/mcporter.json"

# StockTwits configuration
STOCKTWITS_API = "https://api.stocktwits.com/api/2/streams/symbol/{ticker}.json"

# yfinance configuration
YFINANCE_NEWS_LIMIT = 20
YFINANCE_GLOBAL_LIMIT = 30

# RSS Feed URLs
RSS_FEEDS = [
    ("CNBC World", "https://www.cnbc.com/id/100003114/device/rss/rss.html"),
    ("Bloomberg Markets", "https://feeds.bloomberg.com/markets/news.rss"),
    ("MarketWatch Top Stories", "https://feeds.content.dowjones.io/public/rss/mw_topstories"),
    ("CafeF Vietnam", "https://cafef.vn/thi-truong-chung-khoan.rss"),
    ("Yahoo Finance", "https://finance.yahoo.com/news/rssindex"),
]

# Exa search queries (Agent-Reach)
EXA_QUERIES = [
    "Vietnam stock market today",
    "ASE HN index news",
    "Federal Reserve interest rate",
    "China economy impact Vietnam",
    "Global market news today",
    "Asian markets update",
]

# Tickers to track
TRACKED_TICKERS = [
    "VN30", "HNX30", "UPCoM",  # Vietnam indices
    "VNM", "VIC", "FPT", "HPG", "MBB",  # Major VN stocks
    "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA",  # US tech
    "SPY", "QQQ",  # US ETFs
    "BTC-USD", "ETH-USD",  # Crypto
]


def fetch_reddit_rss(ticker: str, sub: str, limit: int = 5) -> list[dict]:
    """Fetch Reddit posts via public RSS feed (no API key needed)."""
    url = f"https://www.reddit.com/r/{sub}/search.rss?q={ticker}&sort=new&t=week&limit={limit}"
    req = Request(url, headers={"User-Agent": REDDIT_UA})

    try:
        with urlopen(req, timeout=10) as resp:
            root = ET.fromstring(resp.read())
    except Exception as e:
        is_429 = "429" in str(e)
        if is_429:
            logger.warning(f"Reddit RSS 429 for r/{sub} · {ticker}, backing off {REDDIT_429_BACKOFF}s and retrying once")
            time.sleep(REDDIT_429_BACKOFF)
            try:
                with urlopen(req, timeout=10) as resp:
                    root = ET.fromstring(resp.read())
            except Exception as e2:
                logger.warning(f"Reddit RSS retry failed for r/{sub} · {ticker}: {e2}")
                return []
        else:
            logger.warning(f"Reddit RSS fetch failed for r/{sub} · {ticker}: {e}")
            return []
    
    posts = []
    atom_ns = {"atom": "http://www.w3.org/2005/Atom"}
    
    for entry in root.findall("atom:entry", atom_ns)[:limit]:
        title_el = entry.find("atom:title", atom_ns)
        content_el = entry.find("atom:content", atom_ns)
        
        title = title_el.text if title_el is not None else ""
        content = content_el.text if content_el is not None else ""
        
        # Strip HTML
        if content:
            content = re.sub(r"<[^>]+>", " ", content)
            content = html.unescape(content)
            content = " ".join(content.split())
        else:
            content = ""
        
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
    except Exception as e:
        logger.warning(f"StockTwits fetch failed for {ticker}: {e}")
        return []
    
    messages = data.get("messages", []) if isinstance(data, dict) else []
    
    posts = []
    for msg in messages[:limit]:
        body = (msg.get("body") or "").replace("\n", " ")
        
        # Safely parse sentiment - entities can be None
        sentiment = "neutral"
        try:
            entities = msg.get("entities")
            if entities and isinstance(entities, dict):
                sentiment_obj = entities.get("sentiment")
                if sentiment_obj and isinstance(sentiment_obj, dict):
                    sentiment = sentiment_obj.get("basic", "neutral")
        except (AttributeError, TypeError):
            sentiment = "neutral"
        
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


def fetch_yfinance_news(ticker: str, start_date: str, end_date: str) -> list[dict]:
    """Fetch news for a specific ticker via yfinance."""
    try:
        import yfinance as yf
        stock = yf.Ticker(ticker)
        news = stock.get_news(count=YFINANCE_NEWS_LIMIT)
        
        articles = []
        for article in news:
            # Handle nested content structure
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
    except Exception as e:
        logger.warning(f"yfinance news fetch failed for {ticker}: {e}")
        return []


def fetch_yfinance_global_news(start_date: str, end_date: str) -> list[dict]:
    """Fetch global macro news via yfinance Search."""
    try:
        import yfinance as yf
        
        queries = [
            "Vietnam stock market",
            "ASE HN index",
            "Federal Reserve",
            "China economy",
            "Global markets",
        ]
        
        all_news = []
        seen_titles = set()
        
        for query in queries:
            search = yf.Search(query=query, news_count=YFINANCE_GLOBAL_LIMIT)
            
            if search.news:
                for article in search.news:
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
    except Exception as e:
        logger.warning(f"yfinance global news fetch failed: {e}")
        return []


def fetch_rss_feeds() -> list[dict]:
    """Fetch from configured RSS feeds."""
    articles = []
    
    for feed_name, feed_url in RSS_FEEDS:
        try:
            req = Request(feed_url, headers={"User-Agent": "Mozilla/5.0"})
            with urlopen(req, timeout=15) as resp:
                root = ET.fromstring(resp.read())
            
            # Handle different RSS namespaces
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
                
                # Strip HTML from description
                if desc:
                    desc = re.sub(r"<[^>]+>", " ", desc)
                    desc = html.unescape(desc)
                    desc = " ".join(desc.split())
                else:
                    desc = ""
                
                if len(desc) > 400:
                    desc = desc[:400] + "…"
                
                articles.append({
                    "title": title,
                    "summary": desc,
                    "source": f"rss/{feed_name}",
                    "url": link,
                })
        except Exception as e:
            logger.warning(f"RSS feed fetch failed for {feed_name}: {e}")
    
    return articles


def fetch_exa_search(queries: list[str], limit: int = 5) -> list[dict]:
    """Fetch news via Exa semantic search using mcporter CLI."""
    articles = []
    
    try:
        import subprocess

        env = dict(os.environ, MCPORTER_CONFIG=MCPORTER_CONFIG_PATH)

        for query in queries:
            # Use mcporter CLI to call Exa web_search_exa
            cmd = [
                "mcporter", "call", "exa.web_search_exa",
                f"query:{query}",
                f"numResults:{limit}",
                "--output", "json"
            ]

            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=30, env=env
            )
            
            if result.returncode == 0 and result.stdout.strip():
                try:
                    data = json.loads(result.stdout)
                    # Parse mcporter response
                    content = data.get("content", [])
                    query_count = 0
                    for item in content:
                        text = item.get("text", "")
                        if not text or "MCP error" in text:
                            continue
                        
                        # Extract title and URL from text
                        title = ""
                        url = ""
                        summary = ""
                        
                        # Parse the structured text output
                        lines = text.split("\n")
                        for line in lines:
                            if line.startswith("Title: "):
                                title = line[7:].strip()
                            elif line.startswith("URL: "):
                                url = line[5:].strip()
                            elif line.startswith("Published: "):
                                break  # Stop after metadata
                        
                        # Extract highlights as summary
                        if "## Story" in text:
                            summary = text.split("## Story")[1].strip()[:500]
                        elif "Highlights:" in text:
                            summary = text.split("Highlights:")[1].strip()[:500]
                        else:
                            summary = text[:500]
                        
                        if title:
                            articles.append({
                                "title": title,
                                "summary": summary,
                                "source": "exa/search",
                                "url": url,
                            })
                            query_count += 1

                    logger.info(f"Exa search for '{query}' returned {query_count} articles")
                except json.JSONDecodeError:
                    logger.warning(f"Exa search returned invalid JSON: {result.stdout[:200]}")
            else:
                logger.warning(f"Exa search failed for '{query}': {result.stderr[:200]}")
            
            time.sleep(1)  # Rate limit between queries
            
    except FileNotFoundError:
        logger.warning("mcporter not found in PATH")
    except Exception as e:
        logger.warning(f"Exa search error: {e}")
    
    return articles


def deduplicate_articles(articles: list[dict]) -> list[dict]:
    """Remove duplicate articles by title similarity."""
    seen = set()
    unique = []
    
    for article in articles:
        # Normalize title for comparison
        title = article.get("title", "").lower().strip()
        title = re.sub(r"[^a-z0-9\s]", "", title)
        title = " ".join(title.split())
        
        if title not in seen:
            seen.add(title)
            unique.append(article)
    
    return unique


def collect_all_news(date: str) -> dict:
    """Collect news from all sources."""
    logger.info(f"Starting news collection for {date}")
    
    all_articles = []
    
    # 1. Reddit RSS (limited to avoid rate limiting)
    logger.info("Fetching Reddit RSS...")
    for i, sub in enumerate(REDDIT_SUBREDDITS):
        for j, ticker in enumerate(TRACKED_TICKERS[:3]):  # Only 3 tickers per sub
            if i > 0 or j > 0:
                time.sleep(REDDIT_DELAY)  # Respect Reddit rate limits
            posts = fetch_reddit_rss(ticker, sub, limit=3)
            all_articles.extend(posts)
        reddit_count = len([a for a in all_articles if a['source'].startswith('reddit/')])
        logger.info(f"Reddit r/{sub}: {reddit_count} posts so far")
    
    # 2. StockTwits (only US tickers - VN tickers don't exist on StockTwits)
    logger.info("Fetching StockTwits...")
    US_TICKERS = ["AAPL", "MSFT", "GOOGL", "NVDA", "SPY", "QQQ", "TSLA", "AMZN"]
    for ticker in US_TICKERS:
        messages = fetch_stocktwits(ticker, limit=5)
        all_articles.extend(messages)
    
    # 3. yfinance stock-specific news
    logger.info("Fetching yfinance stock news...")
    for ticker in TRACKED_TICKERS:
        articles = fetch_yfinance_news(ticker, date, date)
        all_articles.extend(articles)
    
    # 4. yfinance global news
    logger.info("Fetching yfinance global news...")
    global_articles = fetch_yfinance_global_news(date, date)
    all_articles.extend(global_articles)
    
    # 5. RSS feeds
    logger.info("Fetching RSS feeds...")
    rss_articles = fetch_rss_feeds()
    all_articles.extend(rss_articles)
    
    # 6. Exa search (placeholder)
    logger.info("Fetching Exa search...")
    exa_articles = fetch_exa_search(EXA_QUERIES)
    all_articles.extend(exa_articles)
    
    # Deduplicate
    logger.info(f"Total articles before dedup: {len(all_articles)}")
    unique_articles = deduplicate_articles(all_articles)
    logger.info(f"Total articles after dedup: {len(unique_articles)}")
    
    # Structure output
    result = {
        "collection_date": date,
        "collected_at": datetime.now().isoformat(),
        "total_articles": len(unique_articles),
        "sources": {
            "reddit": len([a for a in unique_articles if a["source"].startswith("reddit/")]),
            "stocktwits": len([a for a in unique_articles if a["source"].startswith("stocktwits/")]),
            "yfinance_stock": len([a for a in unique_articles if "yfinance/" in a["source"] and "global" not in a["source"]]),
            "yfinance_global": len([a for a in unique_articles if "yfinance/global" in a["source"]]),
            "rss": len([a for a in unique_articles if a["source"].startswith("rss/")]),
            "exa": len([a for a in unique_articles if a["source"].startswith("exa/")]),
        },
        "articles": unique_articles,
    }
    
    return result


def main():
    parser = argparse.ArgumentParser(description="Daily News Collector")
    parser.add_argument("--date", type=str, default="today",
                        help="Date to collect news for (YYYY-MM-DD or 'today')")
    parser.add_argument("--output", type=str, default="news_data.json",
                        help="Output JSON file path")
    
    args = parser.parse_args()
    
    # Parse date
    if args.date == "today":
        date = datetime.now().strftime("%Y-%m-%d")
    else:
        date = args.date
    
    # Collect news
    result = collect_all_news(date)
    
    # Save to file
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    
    logger.info(f"News collection complete. Saved to {args.output}")
    logger.info(f"Total articles: {result['total_articles']}")
    logger.info(f"Sources: {json.dumps(result['sources'], indent=2)}")


if __name__ == "__main__":
    main()

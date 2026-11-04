"""News feed, search, and article extraction — VN (CafeF RSS) + US (yfinance)."""
import os
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query

from ..services import market
from ..services import news as news_service
from ..services import news_collector

router = APIRouter()


@router.get("/news")
def news(limit: int = Query(30, ge=1, le=100)):
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
def news_search(
    q: str = Query(min_length=2, max_length=200),
    count: int = Query(5, ge=1, le=20),
    time_range: str = Query("week", pattern="^(day|week|month)$"),
):
    try:
        return news_service.search_web(q, count, time_range)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


@router.get("/news/article")
def news_article(url: str = Query(min_length=8, max_length=2048)):
    try:
        return news_service.read_article(url)
    except RuntimeError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.get("/news/summary")
def news_summary():
    today = datetime.now().strftime("%Y-%m-%d")
    path = os.path.join(news_collector.VAULT_NEWS_DIR, f"{today}.md")
    try:
        parsed = news_collector.parse_daily_note(path)
        updated_at = datetime.fromtimestamp(os.path.getmtime(path), tz=timezone.utc).isoformat()
    except (FileNotFoundError, OSError, UnicodeDecodeError):
        return {"date": today, "day_summary": None, "articles": [], "updated_at": None, "stale": True}

    return {
        "date": today,
        "day_summary": parsed["day_summary"],
        "articles": parsed["articles"],
        "updated_at": updated_at,
        "stale": not parsed["processed"] or not parsed["day_summary"],
    }

"""Market data — yfinance wrapper with optional Redis cache."""
import json
import time
from typing import Any

import yfinance as yf

from ..config import get_settings

settings = get_settings()

_redis = None
if settings.redis_url:
    try:
        import redis
        _redis = redis.from_url(settings.redis_url, decode_responses=True)
        _redis.ping()
    except Exception:
        _redis = None


def _cache_get(key: str):
    if not _redis:
        return None
    try:
        v = _redis.get(key)
        return json.loads(v) if v else None
    except Exception:
        return None


def _cache_set(key: str, value: Any, ttl: int = 60):
    if not _redis:
        return
    try:
        _redis.setex(key, ttl, json.dumps(value, default=str))
    except Exception:
        pass


def get_quote(ticker: str) -> dict:
    cached = _cache_get(f"quote:{ticker}")
    if cached:
        return cached
    info = yf.Ticker(ticker).fast_info
    out = {
        "ticker": ticker,
        "price": float(info.last_price) if info.last_price else None,
        "open": float(info.open) if info.open else None,
        "previous_close": float(info.previous_close) if info.previous_close else None,
        "day_high": float(info.day_high) if info.day_high else None,
        "day_low": float(info.day_low) if info.day_low else None,
        "year_high": float(info.year_high) if info.year_high else None,
        "year_low": float(info.year_low) if info.year_low else None,
        "market_cap": float(info.market_cap) if info.market_cap else None,
        "currency": info.currency,
        "ts": int(time.time()),
    }
    if out["price"] and out["previous_close"]:
        out["change"] = out["price"] - out["previous_close"]
        out["change_pct"] = (out["change"] / out["previous_close"]) * 100
    _cache_set(f"quote:{ticker}", out, ttl=30)
    return out


def get_history(ticker: str, period: str = "1mo", interval: str = "1d") -> list[dict]:
    key = f"hist:{ticker}:{period}:{interval}"
    cached = _cache_get(key)
    if cached:
        return cached
    df = yf.Ticker(ticker).history(period=period, interval=interval).reset_index()
    out = []
    for _, row in df.iterrows():
        out.append({
            "date": str(row.iloc[0]),
            "open": float(row["Open"]),
            "high": float(row["High"]),
            "low": float(row["Low"]),
            "close": float(row["Close"]),
            "volume": int(row["Volume"]) if row["Volume"] else 0,
        })
    _cache_set(key, out, ttl=300)
    return out


def get_indices() -> dict:
    tickers = {"sp500": "^GSPC", "nasdaq": "^IXIC", "dow": "^DJI",
               "russell": "^RUT", "vix": "^VIX", "ten_year": "^TNX"}
    out = {}
    for name, t in tickers.items():
        try:
            out[name] = get_quote(t)
        except Exception:
            out[name] = None
    return out


def screen(*, sector=None, min_market_cap=None, max_pe=None,
           min_div_yield=None, limit=50) -> list[dict]:
    """Simple universe-based screener. Replace with Finnhub/Polygon for full market."""
    universe = ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA",
                "JPM", "V", "WMT", "XOM", "JNJ", "PG", "MA", "HD", "BAC"]
    rows = []
    for tkr in universe[:limit]:
        try:
            rows.append(get_quote(tkr))
        except Exception:
            continue
    return rows


def get_news(ticker: str | None = None, category: str = "all", limit: int = 30) -> list[dict]:
    try:
        items = yf.Ticker(ticker or "SPY").news[:limit]
        return [
            {
                "title": n.get("title"),
                "publisher": n.get("publisher"),
                "url": n.get("link"),
                "published": n.get("providerPublishTime"),
                "tickers": n.get("relatedTickers", []),
            } for n in items
        ]
    except Exception:
        return []

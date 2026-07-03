"""Market data — yfinance wrapper with optional Redis cache."""
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
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


# Fallback when Redis isn't configured (the common case in dev): a plain
# in-process dict cache. Without ANY cache, every poller (Watch board every
# 2s, the header ticker tape, multiple browser tabs) hits Yahoo fresh for
# the same ticker — that's what tripped Yahoo's rate limit under normal use.
_local_cache: dict[str, tuple[float, Any]] = {}


def _cache_get(key: str):
    if _redis:
        try:
            v = _redis.get(key)
            return json.loads(v) if v else None
        except Exception:
            return None
    hit = _local_cache.get(key)
    if not hit:
        return None
    expires_at, value = hit
    if time.time() >= expires_at:
        del _local_cache[key]
        return None
    return value


def _cache_set(key: str, value: Any, ttl: int = 60):
    if _redis:
        try:
            _redis.setex(key, ttl, json.dumps(value, default=str))
        except Exception:
            pass
        return
    _local_cache[key] = (time.time() + ttl, value)


def get_market_state(ticker: str) -> str | None:
    """Yahoo marketState: PRE | REGULAR | POST | CLOSED (None if unavailable).

    Comes from Ticker.info (a heavier quoteSummary call than fast_info), so it
    gets its own 10-minute cache — state flips a few times a day, not per tick.
    """
    key = f"mstate:{ticker}"
    cached = _cache_get(key)
    if cached:
        return cached.get("state")
    try:
        state = yf.Ticker(ticker).info.get("marketState")
    except Exception:
        state = None
    _cache_set(key, {"state": state}, ttl=600)
    return state


# "VN:<symbol>" tickers (VNINDEX, VN30, VNM, ...) come from vnstock/VCI —
# Yahoo doesn't carry HOSE/HNX listings. Prices are in nghìn đồng as VCI
# returns them; daily closes, so change is vs the prior session.
VN_PREFIX = "VN:"


def _vn_market_state() -> str:
    """HOSE sessions: Mon-Fri 09:00-11:30 and 13:00-14:45 ICT."""
    from datetime import datetime
    from zoneinfo import ZoneInfo
    now = datetime.now(ZoneInfo("Asia/Ho_Chi_Minh"))
    if now.weekday() >= 5:
        return "CLOSED"
    minutes = now.hour * 60 + now.minute
    if 9 * 60 <= minutes <= 11 * 60 + 30 or 13 * 60 <= minutes <= 14 * 60 + 45:
        return "REGULAR"
    return "CLOSED"


def _get_quote_vn(symbol: str) -> dict:
    from datetime import date, timedelta
    from vnstock.explorer.vci import Quote as VnQuote

    end = date.today()
    start = end - timedelta(days=15)
    df = VnQuote(symbol).history(start=start.isoformat(), end=end.isoformat(), interval="1D")
    closes = [float(c) for c in df["close"].tolist()]
    if not closes:
        raise ValueError(f"no VCI data for {symbol}")
    price = closes[-1]
    prev = closes[-2] if len(closes) > 1 else None
    out = {
        "ticker": f"{VN_PREFIX}{symbol}",
        "price": price,
        "open": float(df["open"].iloc[-1]),
        "previous_close": prev,
        "day_high": float(df["high"].iloc[-1]),
        "day_low": float(df["low"].iloc[-1]),
        "year_high": None, "year_low": None, "market_cap": None,
        "currency": "VND",
        "market_state": _vn_market_state(),
        "ts": int(time.time()),
    }
    if prev:
        out["change"] = price - prev
        out["change_pct"] = (out["change"] / prev) * 100
    return out


def get_quote(ticker: str) -> dict:
    cached = _cache_get(f"quote:{ticker}")
    if cached:
        return cached
    if ticker.startswith(VN_PREFIX):
        out = _get_quote_vn(ticker[len(VN_PREFIX):])
        _cache_set(f"quote:{ticker}", out, ttl=120)
        return out
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
        "market_state": get_market_state(ticker),
        "ts": int(time.time()),
    }
    if out["price"] and out["previous_close"]:
        out["change"] = out["price"] - out["previous_close"]
        out["change_pct"] = (out["change"] / out["previous_close"]) * 100
    # 120s: guarantees each 5-minute frontend poll gets fresh data, while
    # overlapping pollers (ticker tape, watch board, multiple tabs) within
    # the window share one Yahoo call instead of stacking requests.
    _cache_set(f"quote:{ticker}", out, ttl=120)
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
               "russell": "^RUT", "vix": "^VIX", "ten_year": "^TNX",
               "gold": "GC=F", "oil": "CL=F"}
    # each get_quote is a blocking Yahoo round-trip (~0.3-0.8s); fetching the
    # 8 tickers one at a time serializes to several seconds. Run them
    # concurrently on a thread pool instead — pure I/O wait, no GIL contention.
    out = {}
    with ThreadPoolExecutor(max_workers=len(tickers)) as pool:
        futures = {pool.submit(get_quote, t): name for name, t in tickers.items()}
        for future in as_completed(futures):
            name = futures[future]
            try:
                out[name] = future.result()
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

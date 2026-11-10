"""Daily OHLCV loader for backtests (VN via vnstock, others via yfinance)."""
import math
from datetime import date, timedelta

import yfinance as yf

from app.services import market

WARMUP_DAYS = 650  # (~440 sessions, covers slow SMA 400)
# calendar days fetched before the requested start
CACHE_TTL = 3600


def _bar(day, row) -> dict | None:
    try:
        vals = {k: float(row[k]) for k in ("open", "high", "low", "close")}
    except (KeyError, TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in vals.values()):
        return None
    try:
        vol = float(row.get("volume", 0))
        vol = int(vol) if math.isfinite(vol) else 0
    except (TypeError, ValueError, OverflowError):
        vol = 0
    return {"date": day, **vals, "volume": vol}


def load_daily_bars(ticker: str, start: date, end: date) -> list[dict]:
    key = f"bt:{ticker}:{start}:{end}"
    cached = market._cache_get(key)
    if cached:
        return cached

    bars: list[dict] = []
    if ticker.startswith(market.VN_PREFIX):
        df = market._vn_history(ticker[len(market.VN_PREFIX):], start=start.isoformat(),
                                end=end.isoformat(), interval="1D")
        for _, row in df.iterrows():
            b = _bar(str(row["time"])[:10], row)
            if b:
                bars.append(b)
    else:
        df = yf.Ticker(ticker).history(start=start.isoformat(),
                                       end=(end + timedelta(days=1)).isoformat(),
                                       interval="1d", auto_adjust=True)
        for idx, row in df.iterrows():
            b = _bar(idx.strftime("%Y-%m-%d"), {k.lower(): v for k, v in row.items()})
            if b:
                bars.append(b)

    bars.sort(key=lambda b: b["date"])
    if not bars:
        raise ValueError(f"no price data for {ticker}")
    market._cache_set(key, bars, ttl=CACHE_TTL)
    return bars

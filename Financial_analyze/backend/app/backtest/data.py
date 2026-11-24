"""Daily OHLCV loader for backtests (VN via the VN market-data provider, others
via the global/Yahoo provider). VN bars come out in full VND (index points for
an index)."""
import math
from datetime import date, timedelta

from app.marketdata import (ProviderRateLimited, drop_partial_bar, get_global_provider,
                            get_provider, vn_symbol)
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
    key = f"bt:v2:{ticker}:{start}:{end}"  # v2: VN bars switched to full VND
    cached = market._cache_get(key)
    if cached:
        return cached

    bars: list[dict] = []
    symbol = vn_symbol(ticker)
    if symbol is not None:
        try:
            raw = get_provider().fetch_ohlc(symbol, start, end, "1d", priority="interactive")
        except ProviderRateLimited as e:
            raise market.VnRateLimited(str(e)) from None
        # Today's bar before the close is still forming: never backtest on it.
        for row in drop_partial_bar(raw):
            b = _bar(str(row["date"])[:10], row)
            if b:
                bars.append(b)
    else:
        # Yahoo's end bound is exclusive: ask for the day after to include `end`.
        rows = get_global_provider().history(ticker, interval="1d", adjusted=True,
                                             start=start, end=end + timedelta(days=1))
        for row in rows:
            b = _bar(row["date"][:10], row)
            if b:
                bars.append(b)

    bars.sort(key=lambda b: b["date"])
    if not bars:
        raise ValueError(f"no price data for {ticker}")
    market._cache_set(key, bars, ttl=CACHE_TTL)
    return bars

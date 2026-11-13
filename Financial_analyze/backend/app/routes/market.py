"""Market data — quotes, history, indices."""
from datetime import date

from fastapi import APIRouter, HTTPException
from ..services import market

router = APIRouter()


@router.get("/quote/{ticker}")
def get_quote(ticker: str):
    try:
        return market.get_quote(ticker.upper())
    except Exception as e:
        raise HTTPException(404, f"Quote unavailable: {e}")


@router.get("/history/{ticker}")
def get_history(ticker: str, period: str = "1mo", interval: str = "1d", end: date | None = None,
                adjusted: bool = False):
    """period: 1d 5d 1mo 3mo 6mo 1y 2y 5y 10y ytd max (anything else: 422).
    end (YYYY-MM-DD): return the `period`-long window ending on that day — for
    loading older bars as the chart scrolls back.
    adjusted: Yahoo tickers only — dividend-adjusted closes (default: as traded)."""
    try:
        kw = {"adjusted": True} if adjusted else {}  # keep the default call shape
        return market.get_history(ticker.upper(), period=period, interval=interval, end=end, **kw)
    except market.InvalidPeriod as e:
        raise HTTPException(422, str(e))
    except Exception as e:
        raise HTTPException(404, f"History unavailable: {e}")


@router.get("/indices")
def indices():
    return market.get_indices()

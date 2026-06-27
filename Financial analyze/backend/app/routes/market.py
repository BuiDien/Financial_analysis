"""Market data — quotes, history, indices, screener."""
from fastapi import APIRouter, HTTPException, Query
from ..services import market

router = APIRouter()


@router.get("/quote/{ticker}")
def get_quote(ticker: str):
    try:
        return market.get_quote(ticker.upper())
    except Exception as e:
        raise HTTPException(404, f"Quote unavailable: {e}")


@router.get("/history/{ticker}")
def get_history(ticker: str, period: str = "1mo", interval: str = "1d"):
    """period: 1d 5d 1mo 3mo 6mo 1y 2y 5y 10y ytd max"""
    try:
        return market.get_history(ticker.upper(), period=period, interval=interval)
    except Exception as e:
        raise HTTPException(404, f"History unavailable: {e}")


@router.get("/indices")
def indices():
    return market.get_indices()


@router.get("/screener")
def screener(
    sector: str | None = None,
    min_market_cap: float | None = None,
    max_pe: float | None = None,
    min_div_yield: float | None = None,
    limit: int = Query(50, le=200),
):
    return market.screen(
        sector=sector, min_market_cap=min_market_cap,
        max_pe=max_pe, min_div_yield=min_div_yield, limit=limit,
    )

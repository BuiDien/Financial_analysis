"""News feed."""
from fastapi import APIRouter
from ..services import market

router = APIRouter()


@router.get("/news")
def news(ticker: str | None = None, category: str = "all", limit: int = 30):
    return market.get_news(ticker=ticker, category=category, limit=limit)

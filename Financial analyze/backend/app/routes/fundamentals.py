"""Financial statements & ratios."""
from fastapi import APIRouter, HTTPException
from ..services import fundamentals

router = APIRouter()


@router.get("/statements/{ticker}")
def statements(ticker: str, period: str = "annual"):
    """period: annual | quarterly"""
    try:
        return fundamentals.get_statements(ticker.upper(), period=period)
    except Exception as e:
        raise HTTPException(404, f"Statements unavailable: {e}")


@router.get("/ratios/{ticker}")
def ratios(ticker: str):
    try:
        return fundamentals.get_ratios(ticker.upper())
    except Exception as e:
        raise HTTPException(404, f"Ratios unavailable: {e}")

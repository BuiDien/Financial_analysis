"""Fundamentals — statements + ratios from yfinance."""
import math

import yfinance as yf


def _num(val) -> float | None:
    """A reported number, or None when the line was not reported (NaN/None)."""
    try:
        f = float(val)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _to_records(df) -> list[dict]:
    """Unreported lines come out as None, never as a fake 0."""
    if df is None or df.empty:
        return []
    cols = [str(c.year) if hasattr(c, "year") else str(c) for c in df.columns]
    return [
        {"label": str(idx), "values": {col: _num(val) for col, val in zip(cols, row)}}
        for idx, row in df.iterrows()
    ]


def get_statements(ticker: str, period: str = "annual") -> dict:
    t = yf.Ticker(ticker)
    if period == "quarterly":
        return {
            "income": _to_records(t.quarterly_income_stmt),
            "balance": _to_records(t.quarterly_balance_sheet),
            "cashflow": _to_records(t.quarterly_cashflow),
        }
    return {
        "income": _to_records(t.income_stmt),
        "balance": _to_records(t.balance_sheet),
        "cashflow": _to_records(t.cashflow),
    }


def get_ratios(ticker: str) -> dict:
    info = yf.Ticker(ticker).info
    return {
        "profitability": {
            "gross_margin": info.get("grossMargins"),
            "operating_margin": info.get("operatingMargins"),
            "net_margin": info.get("profitMargins"),
            "roe": info.get("returnOnEquity"),
            "roa": info.get("returnOnAssets"),
        },
        "liquidity": {
            "current_ratio": info.get("currentRatio"),
            "quick_ratio": info.get("quickRatio"),
            "debt_to_equity": info.get("debtToEquity"),
        },
        "valuation": {
            "pe_trailing": info.get("trailingPE"),
            "pe_forward": info.get("forwardPE"),
            "ps": info.get("priceToSalesTrailing12Months"),
            "pb": info.get("priceToBook"),
            "ev_ebitda": info.get("enterpriseToEbitda"),
            "peg": info.get("pegRatio"),
        },
    }

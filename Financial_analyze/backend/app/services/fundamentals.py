"""Fundamentals — statements + ratios from yfinance."""
import yfinance as yf


def _to_records(df) -> list[dict]:
    if df is None or df.empty:
        return []
    df = df.fillna(0)
    cols = [str(c.year) if hasattr(c, "year") else str(c) for c in df.columns]
    return [
        {"label": str(idx), "values": {col: float(val) for col, val in zip(cols, row)}}
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

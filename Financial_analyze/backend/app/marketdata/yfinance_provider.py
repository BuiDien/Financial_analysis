"""yfinance (Yahoo) implementation of GlobalMarketProvider: US stocks, indices,
gold/oil futures, FX pairs. The only module in the app that imports yfinance.

No caching here (app.marketdata.cache is applied by the callers, who own the
keys and TTLs) and no error swallowing beyond what the vendor payload needs:
exceptions propagate so callers keep their own fallbacks.
"""
from __future__ import annotations

import math
from datetime import date, datetime

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


def _f(v) -> float | None:
    """A finite, non-zero number, else None (Yahoo reports NaN/0 for "no data")."""
    f = _num(v)
    return f if f else None


class YFinanceProvider:
    name = "yfinance"

    def quote(self, ticker: str) -> dict:
        info = yf.Ticker(ticker).fast_info
        return {
            "price": _f(info.last_price),
            "open": _f(info.open),
            "previous_close": _f(info.previous_close),
            "day_high": _f(info.day_high),
            "day_low": _f(info.day_low),
            "year_high": _f(info.year_high),
            "year_low": _f(info.year_low),
            "market_cap": _f(info.market_cap),
            "currency": info.currency,
        }

    def market_state(self, ticker: str) -> str | None:
        # Ticker.info is a heavier quoteSummary call than fast_info.
        return yf.Ticker(ticker).info.get("marketState")

    def history(self, ticker: str, *, interval: str = "1d", adjusted: bool = False,
                period: str | None = None, start: date | None = None,
                end: date | None = None) -> list[dict]:
        t = yf.Ticker(ticker)
        if period is None:
            df = t.history(start=start.isoformat(), end=end.isoformat(),
                           interval=interval, auto_adjust=adjusted)
        else:
            df = t.history(period=period, interval=interval, auto_adjust=adjusted)
        cols = {"open": "Open", "high": "High", "low": "Low", "close": "Close",
                "volume": "Volume"}
        return [{"date": str(idx), **{k: row.get(c) for k, c in cols.items()}}
                for idx, row in df.iterrows()]

    def statements(self, ticker: str, period: str = "annual") -> dict:
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

    def ratios(self, ticker: str) -> dict:
        info = yf.Ticker(ticker).info
        return {
            "profitability": {
                "gross_margin": _num(info.get("grossMargins")),
                "operating_margin": _num(info.get("operatingMargins")),
                "net_margin": _num(info.get("profitMargins")),
                "roe": _num(info.get("returnOnEquity")),
                "roa": _num(info.get("returnOnAssets")),
            },
            "liquidity": {
                "current_ratio": _num(info.get("currentRatio")),
                "quick_ratio": _num(info.get("quickRatio")),
                "debt_to_equity": _num(info.get("debtToEquity")),
            },
            "valuation": {
                "pe_trailing": _num(info.get("trailingPE")),
                "pe_forward": _num(info.get("forwardPE")),
                "ps": _num(info.get("priceToSalesTrailing12Months")),
                "pb": _num(info.get("priceToBook")),
                "ev_ebitda": _num(info.get("enterpriseToEbitda")),
                "peg": _num(info.get("pegRatio")),
            },
        }

    def news(self, ticker: str, limit: int) -> list[dict]:
        """Newest yfinance nests fields under `content`; there is no per-item
        ticker list anymore (`tickers` is always []) — that field was removed
        from the payload upstream. Unparseable items are skipped."""
        out = []
        for n in yf.Ticker(ticker).news[:limit]:
            try:
                c = n.get("content", {}) or {}
                pub_date = c.get("pubDate")
                published = 0
                if pub_date:
                    try:
                        published = int(datetime.fromisoformat(pub_date).timestamp())
                    except ValueError:
                        published = 0
                canonical = c.get("canonicalUrl") or {}
                click_through = c.get("clickThroughUrl") or {}
                url = canonical.get("url") or click_through.get("url")
                out.append({
                    "title": c.get("title", ""),
                    "publisher": (c.get("provider") or {}).get("displayName", "Yahoo Finance"),
                    "url": url,
                    "published": published,
                    "tickers": [],
                })
            except Exception:
                continue
        return out

    def ticker_news(self, ticker: str, count: int) -> list[dict]:
        return yf.Ticker(ticker).get_news(count=count)

    def search_news(self, query: str, count: int) -> list[dict]:
        return yf.Search(query=query, news_count=count).news or []

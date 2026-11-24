"""Canonical market-data shapes and the provider protocols.

Two seams, because the app has two kinds of market:

- ``MarketDataProvider`` -- the Vietnamese exchange (HOSE/HNX/UPCOM): listings,
  financials, board status, OHLCV. vnstock/VCI today; a broker API tomorrow.
  Ratios are fractions (ROE 0.18 = 18%). Money is VND. Bar prices are FULL VND
  for stocks (an index bar is in index points).
- ``GlobalMarketProvider`` -- everything Yahoo carries (US stocks, indices,
  gold/oil futures, FX pairs): quotes, history, statements/ratios, news.

Callers never import a vendor library; they go through ``app.marketdata``.
"""
from __future__ import annotations

from datetime import date, datetime, time as dtime, timedelta
from typing import Literal, Protocol, TypedDict
from zoneinfo import ZoneInfo

VN_TZ = ZoneInfo("Asia/Ho_Chi_Minh")
# App-wide ticker prefix that routes a symbol to the VN exchange provider.
VN_PREFIX = "VN:"

LATEST_KEYS = ("pe", "pb", "dividend_yield", "market_cap", "debt_to_equity",
               "npl", "nim", "cost_to_income", "car")
YEAR_KEYS = ("roe", "revenue", "net_profit", "operating_cash_flow",
             "gross_margin", "receivable_days", "inventory_days", "shares")
# VN market-wide indexes: quoted in points, not lot-traded.
VN_INDEX_SYMBOLS = frozenset({"VNINDEX", "VN30", "HNXINDEX", "HNX30", "UPCOMINDEX"})
MARKET_CLOSE = dtime(15, 0)  # ICT: after this the day's bar is final
# yfinance-style interval tokens a provider must accept in fetch_ohlc.
INTERVALS = ("1m", "5m", "15m", "30m", "1h", "1d", "1wk", "1mo")
# Canonical board flags (exchange status). None = trading normally / unknown.
BOARD_FLAGS = ("warning", "control", "restricted", "suspended")


class UniverseEntry(TypedDict):
    symbol: str
    exchange: str
    industry: str | None
    is_bank: bool


class BoardEntry(TypedDict):
    flag: str | None            # one of BOARD_FLAGS, or None
    status: str | None          # provider's raw status text, for display/debug
    foreign_room: float | None  # fraction of the foreign-ownership cap still free


class Financials(TypedDict):
    latest: dict[str, float | None]
    years: dict[str, dict[str, float | None]]  # completed fiscal years only


class Bar(TypedDict):
    """One OHLCV bar. `date` is "YYYY-MM-DD HH:MM:SS" (or "YYYY-MM-DD"),
    labelled by the bar's period START (Monday for weekly, the 1st for monthly).
    Prices in full VND (index points for an index); volume in shares."""
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: float


Priority = Literal["interactive", "background"]


class ProviderRateLimited(RuntimeError):
    """The provider is over its quota/cooling down. Retry later."""


class MarketDataProvider(Protocol):
    """The VN exchange seam. Network calls raise ProviderRateLimited when the
    vendor quota is exhausted (vnstock: see ratelimit.py)."""
    name: str

    def list_universe(self) -> list[UniverseEntry]: ...
    def fetch_financials(self, entry: UniverseEntry) -> Financials: ...
    def fetch_prices(self, symbol: str, days: int = 120) -> list[dict]:
        """Completed daily bars [{date "YYYY-MM-DD", close (full VND), volume}],
        oldest first; never includes today's bar before the close."""
        ...
    def fetch_ohlc(self, symbol: str, start: date, end: date, interval: str = "1d",
                   priority: Priority = "background") -> list[Bar]:
        """Bars with start <= date <= end, oldest first. `interval` is one of
        INTERVALS. May include today's still-forming bar (charts want it)."""
        ...
    def fetch_board(self, symbols: list[str]) -> dict[str, BoardEntry]: ...
    def list_company_names(self) -> dict[str, str]:
        """symbol -> official company name (Vietnamese)."""
        ...


class GlobalMarketProvider(Protocol):
    """Yahoo-style global data (US/indices/gold/FX). Errors propagate; callers
    decide the fallback."""
    name: str

    def quote(self, ticker: str) -> dict:
        """{price, open, previous_close, day_high, day_low, year_high, year_low,
        market_cap (floats or None), currency}."""
        ...
    def market_state(self, ticker: str) -> str | None:
        """PRE | REGULAR | POST | CLOSED, or None."""
        ...
    def history(self, ticker: str, *, interval: str = "1d", adjusted: bool = False,
                period: str | None = None, start: date | None = None,
                end: date | None = None) -> list[dict]:
        """Rows {date (str), open, high, low, close, volume} oldest first, values
        as the vendor sent them (may be NaN: callers validate). Either `period`
        or `start`/`end` (end exclusive)."""
        ...
    def statements(self, ticker: str, period: str = "annual") -> dict:
        """{income, balance, cashflow}: [{label, values: {year: float|None}}]."""
        ...
    def ratios(self, ticker: str) -> dict:
        """{profitability, liquidity, valuation} fraction/multiple dicts."""
        ...
    def news(self, ticker: str, limit: int) -> list[dict]:
        """[{title, publisher, url, published (epoch s), tickers}]."""
        ...
    def ticker_news(self, ticker: str, count: int) -> list[dict]:
        """Raw vendor news items for one ticker (daily collector parses them)."""
        ...
    def search_news(self, query: str, count: int) -> list[dict]:
        """Raw vendor news items for a free-text query."""
        ...


def vn_symbol(ticker: str) -> str | None:
    """The VN exchange symbol for a "VN:<symbol>" app ticker, else None (global)."""
    return ticker[len(VN_PREFIX):] if ticker.startswith(VN_PREFIX) else None


def price_unit(symbol: str) -> float:
    """VCI quotes stocks in nghin dong (x1000 = VND) and indexes in points."""
    return 1.0 if symbol.upper() in VN_INDEX_SYMBOLS else 1000.0


def drop_partial_bar(bars: list[dict], now: datetime | None = None) -> list[dict]:
    """Drop a bar dated today (Vietnam time) while the session is still open:
    before 15:00 ICT its close/volume are not final."""
    n = (now or datetime.now(VN_TZ)).astimezone(VN_TZ)
    if not bars or n.time() >= MARKET_CLOSE:
        return bars
    today = n.date().isoformat()
    return [b for b in bars if str(b.get("date", ""))[:10] != today]


def trading_days_ending(end: date, n: int) -> list[str]:
    """The n Mon-Fri dates ending on `end` (rolled back to a weekday), oldest first."""
    d = end
    while d.weekday() > 4:
        d -= timedelta(days=1)
    out: list[str] = []
    while len(out) < n:
        if d.weekday() <= 4:
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return out[::-1]

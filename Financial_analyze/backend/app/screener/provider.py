"""Swappable market-data seam for VN data (screener, charts, quotes, backtests).

Ratios are fractions (ROE 0.18 = 18%). Money is VND. Bar prices are FULL VND
for stocks (an index bar is in index points). Replacing vnstock means writing
one new class that implements MarketDataProvider and wiring it in get_provider.
"""
from __future__ import annotations

from datetime import date, datetime, time as dtime, timedelta
from typing import Literal, Protocol, TypedDict
from zoneinfo import ZoneInfo

VN_TZ = ZoneInfo("Asia/Ho_Chi_Minh")

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


def _entry(symbol, exchange, industry, is_bank=False) -> UniverseEntry:
    return {"symbol": symbol, "exchange": exchange, "industry": industry, "is_bank": is_bank}


def _years(roe, rev, profit, ocf, first=2022) -> dict:
    # Steady quality-of-earnings fields: margin, collection/stock days, share count.
    return {str(first + i): {"roe": roe[i], "revenue": rev[i], "net_profit": profit[i],
                             "operating_cash_flow": ocf[i], "gross_margin": 0.30,
                             "receivable_days": 30.0, "inventory_days": 60.0,
                             "shares": 100_000_000.0} for i in range(len(roe))}


def _latest(**kw) -> dict:
    out = {k: None for k in LATEST_KEYS}
    out.update(kw)
    return out


# ---- Built-in sample (one constant set so later tasks/tests can import it) ----
# GOODCO  non-bank good company, not oversold
# DIPCO   good company that is oversold (RSI<30, -18% over 5 bars, volume spike)
# WEAKCO  weak company (low ROE, falling profit, negative OCF)
# BANKCO  bank (uses npl/nim/cost_to_income/car)
# LOSSCO  loss-maker (negative profit)
# NOFINCO no financials available (fetch_financials returns empty years/None latest)
SAMPLE_UNIVERSE: list[UniverseEntry] = [
    _entry("GOODCO", "HOSE", "Retail"),
    _entry("DIPCO", "HOSE", "Industrials"),
    _entry("WEAKCO", "HNX", "Materials"),
    _entry("BANKCO", "HOSE", "Banks", True),
    _entry("LOSSCO", "UPCOM", "Real Estate"),
    _entry("NOFINCO", "HOSE", None),
]

B = 1e9
SAMPLE_FINANCIALS: dict[str, Financials] = {
    "GOODCO": {
        "latest": _latest(pe=11.0, pb=1.8, dividend_yield=0.04, market_cap=12000 * B,
                          debt_to_equity=0.4),
        "years": _years([0.17, 0.18, 0.19, 0.20], [900 * B, 1000 * B, 1150 * B, 1300 * B],
                        [90 * B, 105 * B, 125 * B, 150 * B], [80 * B, 100 * B, 120 * B, 140 * B]),
    },
    "DIPCO": {
        "latest": _latest(pe=9.0, pb=1.4, dividend_yield=0.05, market_cap=8000 * B,
                          debt_to_equity=0.5),
        "years": _years([0.16, 0.17, 0.18, 0.19], [700 * B, 760 * B, 840 * B, 930 * B],
                        [70 * B, 80 * B, 92 * B, 105 * B], [60 * B, 75 * B, 88 * B, 100 * B]),
    },
    "WEAKCO": {
        "latest": _latest(pe=25.0, pb=0.8, dividend_yield=0.0, market_cap=900 * B,
                          debt_to_equity=2.5),
        "years": _years([0.08, 0.06, 0.04, 0.03], [500 * B, 480 * B, 450 * B, 420 * B],
                        [30 * B, 20 * B, 12 * B, 8 * B], [10 * B, -5 * B, -10 * B, -15 * B]),
    },
    "BANKCO": {
        "latest": _latest(pe=8.0, pb=1.5, dividend_yield=0.02, market_cap=60000 * B,
                          npl=0.012, nim=0.034, cost_to_income=0.35, car=0.12),
        "years": _years([0.18, 0.19, 0.20, 0.21], [20000 * B, 23000 * B, 26000 * B, 30000 * B],
                        [6000 * B, 7000 * B, 8200 * B, 9500 * B], [5000 * B, 6000 * B, 7000 * B, 8000 * B]),
    },
    "LOSSCO": {
        "latest": _latest(pe=None, pb=0.6, dividend_yield=0.0, market_cap=400 * B,
                          debt_to_equity=3.0),
        "years": _years([0.02, -0.03, -0.08, -0.12], [300 * B, 250 * B, 200 * B, 150 * B],
                        [5 * B, -10 * B, -25 * B, -40 * B], [0, -8 * B, -20 * B, -30 * B]),
    },
    # NOFINCO intentionally absent: provider returns empty financials.
}


def _flat_then(tail: list[float], base: float = 50.0, n: int = 45) -> list[float]:
    head = [base + (0.3 if i % 2 else -0.3) for i in range(n - len(tail))]
    return head + tail


def _vols(last: float, base: float = 1_000_000.0, n: int = 45) -> list[float]:
    return [base] * (n - 1) + [last]


# symbol -> (closes in nghin dong, volumes), oldest first; dated by FixtureProvider
# at runtime and served in full VND (x1000).
SAMPLE_PRICES: dict[str, tuple[list[float], list[float]]] = {
    "GOODCO": (_flat_then([50.5, 51.0, 51.3, 51.5, 52.0]), _vols(1_100_000)),
    "DIPCO": (_flat_then([49.0, 47.0, 45.0, 43.0, 41.0]), _vols(2_000_000)),
    "WEAKCO": (_flat_then([10.1, 10.2, 10.0, 10.1, 10.0], base=10.0), _vols(300_000, 300_000)),
    "BANKCO": (_flat_then([30.1, 30.2, 30.3, 30.2, 30.0], base=30.0), _vols(3_000_000, 3_000_000)),
    "LOSSCO": (_flat_then([4.9, 4.8, 4.7, 4.6, 4.5], base=5.0), _vols(200_000, 200_000)),
    "NOFINCO": (_flat_then([20.1, 20.2, 20.3, 20.2, 20.0], base=20.0), _vols(500_000, 500_000)),
}


class FixtureProvider:
    """In-memory provider for tests/dev. Records calls in self.calls.

    With no `prices` given, the SAMPLE_PRICES series are dated as Mon-Fri trading
    days ending on `end_date` (default: today in Vietnam time).
    """
    name = "fixture"

    def __init__(self, universe: list[UniverseEntry] | None = None,
                 financials: dict | None = None, prices: dict | None = None,
                 fail: set[str] = frozenset(), end_date: date | None = None,
                 board: dict | None = None, ohlc: dict[str, list[Bar]] | None = None):
        self.universe = SAMPLE_UNIVERSE if universe is None else universe
        self.financials = SAMPLE_FINANCIALS if financials is None else financials
        self._prices = prices
        self.fail = set(fail)
        self.end_date = end_date
        self.board = board or {}
        self._ohlc = ohlc
        self.calls: list[tuple[str, str]] = []
        self.ohlc_calls: list[dict] = []

    def list_universe(self) -> list[UniverseEntry]:
        self.calls.append(("universe", ""))
        return [dict(e) for e in self.universe]  # type: ignore[misc]

    def fetch_financials(self, entry: UniverseEntry) -> Financials:
        sym = entry["symbol"]
        self.calls.append(("financials", sym))
        if sym in self.fail:
            raise RuntimeError(f"fixture failure for {sym}")
        return self.financials.get(sym) or {"latest": {k: None for k in LATEST_KEYS}, "years": {}}

    def fetch_prices(self, symbol: str, days: int = 120) -> list[dict]:
        self.calls.append(("prices", symbol))
        if symbol in self.fail:
            raise RuntimeError(f"fixture failure for {symbol}")
        if self._prices is not None:
            return list(self._prices.get(symbol, []))[-days:]
        if symbol not in SAMPLE_PRICES:
            return []
        return [{"date": b["date"], "close": b["close"], "volume": b["volume"]}
                for b in self._sample_ohlc(symbol)][-days:]

    def _sample_ohlc(self, symbol: str) -> list[Bar]:
        if symbol not in SAMPLE_PRICES:
            return []
        closes, vols = SAMPLE_PRICES[symbol]
        end = self.end_date or datetime.now(VN_TZ).date()
        dates = trading_days_ending(end, len(closes))
        out: list[Bar] = []
        prev = closes[0]
        for d, c, v in zip(dates, closes, vols):
            o, cl = prev * 1000, c * 1000
            out.append({"date": d, "open": o, "high": max(o, cl) * 1.005,
                        "low": min(o, cl) * 0.995, "close": cl, "volume": v})
            prev = c
        return out

    def fetch_ohlc(self, symbol: str, start: date, end: date, interval: str = "1d",
                   priority: Priority = "background") -> list[Bar]:
        self.calls.append(("ohlc", symbol))
        self.ohlc_calls.append({"symbol": symbol, "start": start, "end": end,
                                "interval": interval, "priority": priority})
        if symbol in self.fail:
            raise RuntimeError(f"fixture failure for {symbol}")
        bars = (list(self._ohlc.get(symbol, [])) if self._ohlc is not None
                else self._sample_ohlc(symbol))
        lo, hi = start.isoformat(), end.isoformat()
        return [dict(b) for b in bars if lo <= str(b["date"])[:10] <= hi]  # type: ignore[misc]


    def fetch_board(self, symbols: list[str]) -> dict:
        self.calls.append(("board", ""))
        return {s: dict(self.board[s]) for s in symbols if s in self.board}


def get_provider() -> MarketDataProvider:
    from ..config import get_settings
    name = get_settings().screener_provider
    if name == "fixture":
        return FixtureProvider()
    if name == "vnstock":
        from .vnstock_provider import VnstockProvider
        return VnstockProvider()
    raise ValueError(f"unknown screener_provider: {name!r}")

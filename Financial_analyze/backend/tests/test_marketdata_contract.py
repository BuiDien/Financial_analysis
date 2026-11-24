"""Contract tests for the app.marketdata seam.

`check_vn_provider` is what any VN exchange adapter (vnstock today, a broker API
tomorrow) must satisfy; `check_global_provider` the same for the Yahoo side.
Everything runs on fakes: no network, no vendor library calls.
"""
import math
import pathlib
import re
import subprocess
import sys
from datetime import date, timedelta

import pandas as pd
import pytest

from app import marketdata
from app.marketdata import registry
from app.marketdata import yfinance_provider as yp
from app.marketdata.fixture import FixtureProvider
from app.services import market

APP_DIR = pathlib.Path(__file__).resolve().parents[1] / "app"
END = date(2026, 11, 10)


# ---- VN exchange contract -------------------------------------------------

def check_vn_provider(p, symbol: str, end: date = END) -> None:
    assert isinstance(p.name, str) and p.name

    universe = p.list_universe()
    assert universe, "universe must not be empty"
    for e in universe:
        assert set(e) >= {"symbol", "exchange", "industry", "is_bank"}
        assert e["exchange"] in ("HOSE", "HNX", "UPCOM")
        assert isinstance(e["is_bank"], bool)
    entry = next(e for e in universe if e["symbol"] == symbol)

    fin = p.fetch_financials(entry)
    assert set(fin) == {"latest", "years"}
    assert set(fin["latest"]) == set(marketdata.LATEST_KEYS)
    for year, row in fin["years"].items():
        assert len(year) == 4 and year.isdigit()
        assert set(row) <= set(marketdata.YEAR_KEYS)

    bars = p.fetch_ohlc(symbol, end - timedelta(days=30), end, "1d", priority="interactive")
    assert bars, "ohlc must return bars inside the window"
    dates = [b["date"] for b in bars]
    assert dates == sorted(dates)
    for b in bars:
        assert set(b) >= {"date", "open", "high", "low", "close", "volume"}
        assert (end - timedelta(days=30)).isoformat() <= b["date"][:10] <= end.isoformat()
        assert all(math.isfinite(b[k]) for k in ("open", "high", "low", "close"))
        assert b["low"] <= b["close"] <= b["high"]
    # full VND for a stock: VCI's nghìn đồng would be < 1000 for these samples
    assert bars[-1]["close"] >= 1000

    prices = p.fetch_prices(symbol, days=30)
    assert prices and all(set(r) == {"date", "close", "volume"} for r in prices)
    assert all(len(r["date"]) == 10 for r in prices)

    board = p.fetch_board([symbol])
    for row in board.values():
        assert set(row) == {"flag", "status", "foreign_room"}
        assert row["flag"] in (None, *marketdata.BOARD_FLAGS)

    names = p.list_company_names()
    assert all(isinstance(k, str) and isinstance(v, str) for k, v in names.items())


class FakeBrokerProvider:
    """What a broker-API adapter looks like: canonical shapes, full VND."""
    name = "fakebroker"

    def list_universe(self):
        return [{"symbol": "AAA", "exchange": "HOSE", "industry": "Retail", "is_bank": False}]

    def fetch_financials(self, entry):
        return {"latest": {k: None for k in marketdata.LATEST_KEYS},
                "years": {"2025": {"roe": 0.2, "revenue": 1e12, "net_profit": 1e11}}}

    def fetch_ohlc(self, symbol, start, end, interval="1d", priority="background"):
        out, d = [], start
        while d <= end:
            if d.weekday() < 5:
                out.append({"date": f"{d} 00:00:00", "open": 10_000.0, "high": 10_500.0,
                            "low": 9_900.0, "close": 10_200.0, "volume": 1_000.0})
            d += timedelta(days=1)
        return out

    def fetch_prices(self, symbol, days=120):
        bars = self.fetch_ohlc(symbol, END - timedelta(days=days), END)
        return [{"date": b["date"][:10], "close": b["close"], "volume": b["volume"]}
                for b in marketdata.drop_partial_bar(bars)]

    def fetch_board(self, symbols):
        return {s: {"flag": None, "status": None, "foreign_room": 0.3} for s in symbols}

    def list_company_names(self):
        return {"AAA": "Công ty AAA"}


@pytest.mark.parametrize("make,symbol", [
    (lambda: FixtureProvider(end_date=END), "GOODCO"),
    (FakeBrokerProvider, "AAA"),
])
def test_vn_providers_satisfy_contract(make, symbol):
    check_vn_provider(make(), symbol)


# ---- global (Yahoo) contract ---------------------------------------------

class _FastInfo:
    last_price, open, previous_close = 101.0, 100.0, 100.0
    day_high, day_low, year_high, year_low = 102.0, 99.0, 120.0, 80.0
    market_cap, currency = 1e12, "USD"


class _FakeYfTicker:
    def __init__(self, t):
        self.t = t
        self.fast_info = _FastInfo()
        self.info = {"marketState": "REGULAR", "returnOnEquity": 0.3, "trailingPE": 20.0}
        frame = pd.DataFrame({pd.Timestamp("2025-12-31"): [1.0, float("nan")]},
                             index=["Total Revenue", "Unreported"])
        self.income_stmt = self.balance_sheet = self.cashflow = frame
        self.quarterly_income_stmt = self.quarterly_balance_sheet = frame
        self.quarterly_cashflow = frame
        self.news = [{"content": {"title": "T", "pubDate": "2026-07-06T21:24:38Z",
                                  "provider": {"displayName": "Reuters"},
                                  "canonicalUrl": {"url": "https://r.test/1"}}}]

    def history(self, **kw):
        idx = pd.DatetimeIndex(["2026-11-09", "2026-11-10"], name="Date")
        return pd.DataFrame({"Open": [1.0, 2.0], "High": [1.5, 2.5], "Low": [0.5, 1.5],
                             "Close": [1.2, float("nan")], "Volume": [10, 20]}, index=idx)

    def get_news(self, count=10):
        return self.news[:count]


class _FakeSearch:
    def __init__(self, query, news_count):
        self.news = [{"title": query}][:news_count]


@pytest.fixture
def fake_yf(monkeypatch):
    monkeypatch.setattr(yp.yf, "Ticker", _FakeYfTicker)
    monkeypatch.setattr(yp.yf, "Search", _FakeSearch)


def check_global_provider(p, ticker: str) -> None:
    assert isinstance(p.name, str) and p.name
    q = p.quote(ticker)
    assert list(q) == ["price", "open", "previous_close", "day_high", "day_low",
                       "year_high", "year_low", "market_cap", "currency"]
    assert p.market_state(ticker) in (None, "PRE", "REGULAR", "POST", "CLOSED")
    for rows in (p.history(ticker, period="1mo"),
                 p.history(ticker, start=date(2026, 11, 1), end=date(2026, 11, 11))):
        assert rows and all(set(r) == {"date", "open", "high", "low", "close", "volume"}
                            for r in rows)
        assert all(isinstance(r["date"], str) for r in rows)
    for period in ("annual", "quarterly"):
        st = p.statements(ticker, period=period)
        assert set(st) == {"income", "balance", "cashflow"}
        for rec in st["income"]:
            assert set(rec) == {"label", "values"}
    assert set(p.ratios(ticker)) == {"profitability", "liquidity", "valuation"}
    for item in p.news(ticker, 5):
        assert set(item) == {"title", "publisher", "url", "published", "tickers"}
    assert isinstance(p.ticker_news(ticker, 5), list)
    assert isinstance(p.search_news("Fed", 5), list)


def test_yfinance_provider_satisfies_contract(fake_yf):
    check_global_provider(yp.YFinanceProvider(), "AAPL")


def test_yfinance_statements_keep_unreported_as_none(fake_yf):
    st = yp.YFinanceProvider().statements("AAPL")
    assert st["income"] == [{"label": "Total Revenue", "values": {"2025": 1.0}},
                            {"label": "Unreported", "values": {"2025": None}}]


class _NanFastInfo:
    """What Yahoo's fast_info returns for a symbol it has no data for."""
    last_price = open = previous_close = float("nan")
    day_high = day_low = year_high = year_low = market_cap = float("nan")
    currency = "USD"


class _NanYfTicker(_FakeYfTicker):
    """All-NaN quote for ^VIX only; every other symbol answers normally."""
    def __init__(self, t):
        super().__init__(t)
        if t == "^VIX":
            self.fast_info = _NanFastInfo()
        self.info = {"marketState": "CLOSED", "trailingPE": float("inf"),
                     "returnOnEquity": float("nan"), "forwardPE": 12.5}


@pytest.fixture
def nan_yf(monkeypatch):
    monkeypatch.setattr(yp.yf, "Ticker", _NanYfTicker)
    monkeypatch.setattr(registry, "get_global_provider", lambda: yp.YFinanceProvider())
    monkeypatch.setattr(market, "_cache_get", lambda k: None)
    monkeypatch.setattr(market, "_cache_set", lambda *a, **kw: None)


def test_yfinance_all_nan_quote_is_all_none(nan_yf):
    q = yp.YFinanceProvider().quote("^VIX")
    assert {k: v for k, v in q.items() if k != "currency"} == dict.fromkeys(
        ["price", "open", "previous_close", "day_high", "day_low",
         "year_high", "year_low", "market_cap"])


def test_yfinance_ratios_drop_non_finite(nan_yf):
    r = yp.YFinanceProvider().ratios("AAPL")
    assert r["valuation"]["pe_trailing"] is None
    assert r["profitability"]["roe"] is None
    assert r["valuation"]["pe_forward"] == 12.5


def test_api_quote_with_all_nan_yahoo_is_200_with_nulls(nan_yf):
    from fastapi.testclient import TestClient
    from app.main import app
    res = TestClient(app).get("/api/quote/^VIX")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["price"] is None and body.get("change") is None


def test_api_indices_degrades_per_symbol(nan_yf):
    from fastapi.testclient import TestClient
    from app.main import app
    res = TestClient(app).get("/api/indices")
    assert res.status_code == 200, res.text
    body = res.json()
    assert set(body) == {"sp500", "nasdaq", "dow", "russell", "vix", "ten_year", "gold", "oil"}
    assert body["vix"]["price"] is None           # the bad symbol: nulls, not a 500
    assert body["sp500"]["price"] == 101.0        # the rest are untouched


def test_get_indices_nulls_non_finite_from_any_provider(monkeypatch):
    """Defence in depth: even a provider that leaks NaN can't break the list."""
    class _Leaky(_RecordingGlobal):
        def quote(self, ticker):
            q = super().quote(ticker)
            if ticker == "^GSPC":
                q.update(price=float("nan"), previous_close=float("inf"))
            return q
    monkeypatch.setattr(registry, "get_global_provider", lambda: _Leaky())
    monkeypatch.setattr(market, "_cache_get", lambda k: None)
    monkeypatch.setattr(market, "_cache_set", lambda *a, **kw: None)
    out = market.get_indices()
    assert out["sp500"]["price"] is None and out["sp500"]["previous_close"] is None
    assert out["dow"]["price"] == 2.0


# ---- routing ---------------------------------------------------------------

def test_vn_symbol_routing_rule():
    assert marketdata.vn_symbol("VN:VNM") == "VNM"
    assert marketdata.vn_symbol("AAPL") is None
    assert marketdata.vn_symbol("GC=F") is None and marketdata.vn_symbol("USDVND=X") is None


def test_registry_selects_by_settings(monkeypatch):
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "screener_provider", "fixture")
    assert isinstance(registry.get_provider(), FixtureProvider)
    monkeypatch.setattr(get_settings(), "screener_provider", "nope")
    with pytest.raises(ValueError):
        registry.get_provider()
    assert isinstance(registry.get_global_provider(), yp.YFinanceProvider)


class _RecordingGlobal:
    name = "recording"

    def __init__(self):
        self.calls = []

    def quote(self, ticker):
        self.calls.append(("quote", ticker))
        return {"price": 2.0, "open": 1.0, "previous_close": 1.0, "day_high": 2.0,
                "day_low": 1.0, "year_high": None, "year_low": None, "market_cap": None,
                "currency": "USD"}

    def market_state(self, ticker):
        return "CLOSED"


def test_market_facade_routes_vn_and_global(monkeypatch):
    vn = FixtureProvider(end_date=date.today())
    glob = _RecordingGlobal()
    monkeypatch.setattr(registry, "get_provider", lambda: vn)
    monkeypatch.setattr(registry, "get_global_provider", lambda: glob)
    monkeypatch.setattr(market, "_cache_get", lambda k: None)
    monkeypatch.setattr(market, "_cache_set", lambda *a, **kw: None)

    q = market.get_quote("AAPL")
    assert glob.calls == [("quote", "AAPL")] and vn.ohlc_calls == []
    assert q["ticker"] == "AAPL" and q["change"] == 1.0 and q["market_state"] == "CLOSED"

    q = market.get_quote("VN:GOODCO")
    assert [c["symbol"] for c in vn.ohlc_calls] == ["GOODCO"] and len(glob.calls) == 1
    assert q["ticker"] == "VN:GOODCO" and q["currency"] == "VND"
    assert q["price"] == 52.0  # legacy nghìn đồng unit on the public output


# ---- the seam itself -------------------------------------------------------

def test_no_vendor_imports_outside_marketdata():
    pat = re.compile(r"^\s*(import|from)\s+(vnstock|yfinance)\b", re.M)
    offenders = []
    for path in APP_DIR.rglob("*.py"):
        rel = path.relative_to(APP_DIR)
        if rel.parts[0] in ("marketdata",) or ".venv" in rel.parts:
            continue
        if pat.search(path.read_text(encoding="utf-8")):
            offenders.append(str(rel))
    assert offenders == []


def test_importing_marketdata_does_not_load_vendor_libraries():
    code = ("import sys, app.marketdata, app.services.market; "
            "bad = [m for m in ('yfinance', 'vnstock') if m in sys.modules]; "
            "assert not bad, bad")
    r = subprocess.run([sys.executable, "-c", code], cwd=APP_DIR.parent,
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr

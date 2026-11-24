"""VN: history branch — goes through the market-data provider, returns
yfinance-shaped rows in the legacy VCI unit (nghìn đồng; index points)."""
import json
from datetime import date, timedelta

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.marketdata import registry as provider_mod
from app.marketdata import yfinance_provider as yp
from app.marketdata.ratelimit import RateLimited
from app.services import market


class FakeProvider:
    """Records fetch_ohlc calls; serves canned full-VND bars inside the window."""
    name = "fake"

    def __init__(self, bars=None, exc=None):
        self.bars = bars
        self.exc = exc
        self.calls = []

    def fetch_ohlc(self, symbol, start, end, interval="1d", priority="background"):
        self.calls.append({"symbol": symbol, "start": start, "end": end,
                           "interval": interval, "priority": priority})
        if self.exc:
            raise self.exc
        if self.bars is not None:
            return [dict(b) for b in self.bars
                    if start.isoformat() <= b["date"][:10] <= end.isoformat()]
        return [
            {"date": f"{start} 13:40:00", "open": 54800.0, "high": 55000.0,
             "low": 54700.0, "close": 54900.0, "volume": 120000.0},
            {"date": f"{start} 13:45:00", "open": 54900.0, "high": 55100.0,
             "low": 54800.0, "close": 55000.0, "volume": 98000.0},
        ]


@pytest.fixture
def fake(monkeypatch):
    p = FakeProvider()
    monkeypatch.setattr(provider_mod, "get_provider", lambda: p)
    monkeypatch.setattr(market, "_cache_get", lambda k: None)
    monkeypatch.setattr(market, "_cache_set", lambda *a, **kw: None)
    return p


def test_vn_history_maps_interval_and_row_shape(fake):
    rows = market.get_history("VN:VNM", period="1d", interval="5m")

    call = fake.calls[0]
    assert call["symbol"] == "VNM"
    assert call["interval"] == "5m"
    assert call["priority"] == "interactive"
    assert rows == [
        {"date": f"{call['start']} 13:40:00", "open": 54.8, "high": 55.0,
         "low": 54.7, "close": 54.9, "volume": 120000},
        {"date": f"{call['start']} 13:45:00", "open": 54.9, "high": 55.1,
         "low": 54.8, "close": 55.0, "volume": 98000},
    ]


def test_vn_index_history_stays_in_points(fake):
    fake.bars = [{"date": "2026-11-10 00:00:00", "open": 1250.5, "high": 1260.0,
                  "low": 1249.0, "close": 1255.25, "volume": 5e8}]
    rows = market.get_history("VN:VNINDEX", period="1mo", interval="1d", end=date(2026, 11, 11))
    assert rows[0]["close"] == 1255.25 and rows[0]["open"] == 1250.5


def test_vn_history_daily_interval_passed_through(fake):
    market.get_history("VN:VNINDEX", period="1mo", interval="1d")
    assert fake.calls[0]["interval"] == "1d"


def test_vn_history_drops_non_finite_candles(fake):
    fake.bars = [
        {"date": "2026-07-10 13:40:00", "open": 54800.0, "high": float("nan"),
         "low": 54700.0, "close": 54900.0, "volume": 120000},
        {"date": "2026-07-10 13:45:00", "open": 54900.0, "high": 55100.0,
         "low": 54800.0, "close": 55000.0, "volume": float("nan")},
    ]
    rows = market.get_history("VN:VNM", period="1d", interval="5m", end=date(2026, 7, 10))

    assert rows == [{"date": "2026-07-10 13:45:00", "open": 54.9, "high": 55.1,
                     "low": 54.8, "close": 55.0, "volume": 0}]
    json.dumps(rows, allow_nan=False)


def test_history_sanitizes_non_finite_cached_candles(monkeypatch):
    cached = [
        {"date": "2026-07-10 13:40:00", "open": 54.8, "high": float("nan"),
         "low": 54.7, "close": 54.9, "volume": 120000},
        {"date": "2026-07-10 13:45:00", "open": 54.9, "high": 55.1,
         "low": 54.8, "close": 55.0, "volume": float("nan")},
    ]
    writes = []
    monkeypatch.setattr(market, "_cache_get", lambda key: cached)
    monkeypatch.setattr(market, "_cache_set", lambda *args, **kwargs: writes.append(args))

    rows = market.get_history("VN:VNINDEX", period="1d", interval="5m")

    assert rows == [{"date": "2026-07-10 13:45:00", "open": 54.9, "high": 55.1,
                     "low": 54.8, "close": 55.0, "volume": 0}]
    assert writes
    json.dumps(rows, allow_nan=False)


def test_provider_rate_limit_becomes_vn_rate_limited(fake):
    fake.exc = RateLimited("vnstock rate limit: Rate limit exceeded.")
    with pytest.raises(market.VnRateLimited):
        market._get_quote_vn("VNM")
    with pytest.raises(market.VnRateLimited):
        market.get_history("VN:VNM", period="1mo")


def test_vnstock_sys_exit_becomes_vn_rate_limited_end_to_end(monkeypatch):
    """vnai's quota guard calls sys.exit(); the limiter + provider + market chain
    must turn that into a normal error."""
    from app.marketdata import vnstock_provider as vp

    class Boom:
        def __init__(self, *a, **k):
            pass

        def history(self, **kw):
            raise SystemExit("Rate limit exceeded.")

    monkeypatch.setattr(vp, "_vnstock", lambda: {"Quote": Boom})
    monkeypatch.setattr(provider_mod, "get_provider", lambda: vp.VnstockProvider())
    with pytest.raises(market.VnRateLimited):
        market._get_quote_vn("VNM")


def test_vn_quote_uses_last_two_sessions(fake):
    today = date.today()
    fake.bars = [
        {"date": f"{today - timedelta(days=2)} 00:00:00", "open": 50000.0, "high": 51000.0,
         "low": 49000.0, "close": 50000.0, "volume": 1.0},
        {"date": f"{today} 00:00:00", "open": 50500.0, "high": 52000.0,
         "low": 50000.0, "close": 51000.0, "volume": 1.0},
    ]
    q = market.get_quote("VN:VNM")
    assert q["price"] == 51.0 and q["previous_close"] == 50.0 and q["open"] == 50.5
    assert q["change"] == pytest.approx(1.0) and q["currency"] == "VND"


def test_vn_history_end_pages_back_in_time(monkeypatch, fake):
    keys = []
    monkeypatch.setattr(market, "_cache_get", lambda k: keys.append(k) and None)

    market.get_history("VN:SSI", period="1y", interval="1d", end=date(2023, 3, 1))

    call = fake.calls[0]
    assert call["end"] == date(2023, 3, 1)
    assert call["start"] == date(2022, 2, 24)  # 370 days before end
    assert keys[0].endswith(":2023-03-01")     # older windows cache separately


def _daily_bars(first: date, last: date) -> list[dict]:
    out, d = [], first
    while d <= last:
        if d.weekday() < 5:
            out.append({"date": f"{d} 00:00:00", "open": 10000.0, "high": 10100.0,
                        "low": 9900.0, "close": 10000.0, "volume": 100.0})
        d += timedelta(days=30)
    return out


def test_vn_period_max_returns_full_window(fake):
    """portfolio_engine values VN positions from period='max'; it used to get
    only the 35-day fallback window."""
    fake.bars = _daily_bars(date(2006, 1, 2), date(2026, 11, 10))
    rows = market.get_history("VN:VNM", period="max", interval="1d", end=date(2026, 11, 11))
    assert fake.calls[0]["start"] == date(2000, 1, 1)
    assert len(rows) == len(fake.bars) and rows[0]["date"].startswith("2006-")


def test_vn_period_ytd_and_10y(fake):
    market.get_history("VN:VNM", period="ytd", interval="1d", end=date(2026, 11, 11))
    market.get_history("VN:VNM", period="10y", interval="1d", end=date(2026, 11, 11))
    assert fake.calls[0]["start"] == date(2026, 1, 1)
    assert fake.calls[1]["start"] == date(2026, 11, 11) - timedelta(days=3660)


def test_unknown_period_raises_instead_of_35_days(fake):
    with pytest.raises(market.InvalidPeriod):
        market.get_history("VN:VNM", period="7y")
    with pytest.raises(market.InvalidPeriod):
        market.get_history("AAPL", period="bogus")
    with pytest.raises(ValueError):  # InvalidPeriod is a ValueError
        market.get_history("VN:VNM", period="1mo", interval="2h")
    assert fake.calls == []


def test_history_route_unknown_period_is_422(fake):
    from app.main import app
    r = TestClient(app).get("/api/history/VN:VNM?period=7y")
    assert r.status_code == 422 and "period" in r.json()["detail"]


# ---- Yahoo path: unadjusted by default, and the same period handling ---------

class _FakeYfTicker:
    calls = []

    def __init__(self, t):
        self.t = t

    def history(self, **kw):
        _FakeYfTicker.calls.append(kw)
        idx = pd.DatetimeIndex(["2026-11-10"], name="Date")
        return pd.DataFrame({"Open": [100.0], "High": [101.0], "Low": [99.0],
                             "Close": [100.5], "Volume": [10]}, index=idx)


@pytest.fixture
def fake_yf(monkeypatch):
    _FakeYfTicker.calls = []
    monkeypatch.setattr(yp.yf, "Ticker", _FakeYfTicker)
    monkeypatch.setattr(market, "_cache_get", lambda k: None)
    monkeypatch.setattr(market, "_cache_set", lambda *a, **kw: None)
    return _FakeYfTicker.calls


def test_yahoo_history_is_not_dividend_adjusted_by_default(fake_yf):
    rows = market.get_history("AAPL", period="max")
    assert fake_yf[0]["auto_adjust"] is False and fake_yf[0]["period"] == "max"
    assert rows[0]["close"] == 100.5
    market.get_history("AAPL", period="1y", adjusted=True)
    assert fake_yf[1]["auto_adjust"] is True


def test_yahoo_end_window_handles_max_and_ytd(fake_yf):
    market.get_history("AAPL", period="max", end=date(2026, 11, 11))
    market.get_history("AAPL", period="ytd", end=date(2026, 11, 11))
    assert fake_yf[0]["start"] == "2000-01-01" and fake_yf[0]["auto_adjust"] is False
    assert fake_yf[1]["start"] == "2026-01-01"

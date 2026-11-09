"""VN: history branch — routes to vnstock/VCI, returns yfinance-shaped rows."""
import json
import sys
import types

import pandas as pd

from app.services import market


class FakeVnQuote:
    """Stands in for vnstock.explorer.vci.Quote — records the call, returns canned bars."""
    calls = []

    def __init__(self, symbol):
        self.symbol = symbol

    def history(self, start, end, interval):
        FakeVnQuote.calls.append({"symbol": self.symbol, "start": start,
                                  "end": end, "interval": interval})
        return pd.DataFrame([
            {"time": f"{start} 13:40:00", "open": 54.8, "high": 55.0,
             "low": 54.7, "close": 54.9, "volume": 120000},
            {"time": f"{start} 13:45:00", "open": 54.9, "high": 55.1,
             "low": 54.8, "close": 55.0, "volume": 98000},
        ])


def _install_fake_vnstock(monkeypatch):
    vci = types.ModuleType("vnstock.explorer.vci")
    vci.Quote = FakeVnQuote
    explorer = types.ModuleType("vnstock.explorer")
    explorer.vci = vci
    root = types.ModuleType("vnstock")
    root.explorer = explorer
    monkeypatch.setitem(sys.modules, "vnstock", root)
    monkeypatch.setitem(sys.modules, "vnstock.explorer", explorer)
    monkeypatch.setitem(sys.modules, "vnstock.explorer.vci", vci)


def test_vn_history_maps_interval_and_row_shape(monkeypatch):
    _install_fake_vnstock(monkeypatch)
    monkeypatch.setattr(market, "_cache_get", lambda k: None)
    monkeypatch.setattr(market, "_cache_set", lambda *a, **kw: None)
    FakeVnQuote.calls.clear()

    rows = market.get_history("VN:VNM", period="1d", interval="5m")

    call = FakeVnQuote.calls[0]
    assert call["symbol"] == "VNM"
    assert call["interval"] == "5m"          # yfinance token mapped to VCI token
    assert rows == [
        {"date": f"{call['start']} 13:40:00", "open": 54.8, "high": 55.0,
         "low": 54.7, "close": 54.9, "volume": 120000},
        {"date": f"{call['start']} 13:45:00", "open": 54.9, "high": 55.1,
         "low": 54.8, "close": 55.0, "volume": 98000},
    ]


def test_vn_history_daily_interval_maps_to_1D(monkeypatch):
    _install_fake_vnstock(monkeypatch)
    monkeypatch.setattr(market, "_cache_get", lambda k: None)
    monkeypatch.setattr(market, "_cache_set", lambda *a, **kw: None)
    FakeVnQuote.calls.clear()

    market.get_history("VN:VNINDEX", period="1mo", interval="1d")

    assert FakeVnQuote.calls[0]["interval"] == "1D"


def test_vn_history_drops_non_finite_candles(monkeypatch):
    _install_fake_vnstock(monkeypatch)
    monkeypatch.setattr(market, "_cache_get", lambda k: None)
    monkeypatch.setattr(market, "_cache_set", lambda *a, **kw: None)

    def history_with_nan(self, start, end, interval):
        return pd.DataFrame([
            {"time": f"{start} 13:40:00", "open": 54.8, "high": float("nan"),
             "low": 54.7, "close": 54.9, "volume": 120000},
            {"time": f"{start} 13:45:00", "open": 54.9, "high": 55.1,
             "low": 54.8, "close": 55.0, "volume": float("nan")},
        ])

    monkeypatch.setattr(FakeVnQuote, "history", history_with_nan)

    rows = market.get_history("VN:VNINDEX", period="1d", interval="5m")

    assert len(rows) == 1
    assert rows[0]["date"].endswith(" 13:45:00")
    assert {key: value for key, value in rows[0].items() if key != "date"} == {
        "open": 54.9,
        "high": 55.1,
        "low": 54.8,
        "close": 55.0,
        "volume": 0,
    }
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

    assert rows == [{
        "date": "2026-07-10 13:45:00",
        "open": 54.9,
        "high": 55.1,
        "low": 54.8,
        "close": 55.0,
        "volume": 0,
    }]
    assert writes
    json.dumps(rows, allow_nan=False)


def test_vnstock_rate_limit_sys_exit_becomes_normal_error(monkeypatch):
    import pytest
    from app.services import market
    import vnstock.explorer.vci as vci

    class Boom:
        def __init__(self, *a, **k): pass
        def history(self, **kw): raise SystemExit("Rate limit exceeded.")
    monkeypatch.setattr(vci, "Quote", Boom)
    with pytest.raises(market.VnRateLimited):
        market._get_quote_vn("VNM")


def test_vn_history_end_pages_back_in_time(monkeypatch):
    from datetime import date

    _install_fake_vnstock(monkeypatch)
    keys = []
    monkeypatch.setattr(market, "_cache_get", lambda k: keys.append(k) and None)
    monkeypatch.setattr(market, "_cache_set", lambda *a, **kw: None)
    FakeVnQuote.calls.clear()

    market.get_history("VN:SSI", period="1y", interval="1d", end=date(2023, 3, 1))

    call = FakeVnQuote.calls[0]
    assert call["end"] == "2023-03-01"
    assert call["start"] == "2022-02-24"     # 370 days before end
    assert keys[0].endswith(":2023-03-01")   # older windows cache separately


def test_vn_weekly_and_monthly_bars_are_labelled_by_period_start():
    assert market._vn_bar_start("2026-11-15 00:00:00", "1W") == "2026-11-09 00:00:00"  # Sun → Mon
    assert market._vn_bar_start("2026-11-30", "1M") == "2026-11-01 00:00:00"
    assert market._vn_bar_start("2026-11-05 09:15:00", "5m") == "2026-11-05 09:15:00"

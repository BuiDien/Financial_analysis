"""Backtest loader: VN bars come through the provider seam, full VND, no partial bar."""
from datetime import date, datetime

import pytest

from app.backtest import data
from app.screener import provider as provider_mod
from app.screener.provider import VN_TZ, FixtureProvider
from app.screener.ratelimit import RateLimited
from app.services import market

OHLC = [{"date": f"2026-11-{d:02d} 00:00:00", "open": 50_000.0, "high": 51_000.0,
         "low": 49_000.0, "close": 50_500.0, "volume": 1000.0} for d in (6, 9, 10)]


@pytest.fixture
def no_cache(monkeypatch):
    monkeypatch.setattr(market, "_cache_get", lambda k: None)
    monkeypatch.setattr(market, "_cache_set", lambda *a, **kw: None)


def _use(monkeypatch, prov):
    monkeypatch.setattr(data, "get_provider", lambda: prov)


def test_vn_bars_from_provider_in_full_vnd(monkeypatch, no_cache):
    prov = FixtureProvider(ohlc={"VNM": OHLC})
    _use(monkeypatch, prov)
    monkeypatch.setattr("app.screener.provider.datetime", _Frozen)  # after close
    bars = data.load_daily_bars("VN:VNM", date(2026, 11, 1), date(2026, 11, 10))
    assert [b["date"] for b in bars] == ["2026-11-06", "2026-11-09", "2026-11-10"]
    assert bars[0]["open"] == 50_000.0 and bars[0]["volume"] == 1000
    assert prov.ohlc_calls[0]["priority"] == "interactive"


class _Frozen(datetime):
    now_value = datetime(2026, 11, 10, 16, 0, tzinfo=VN_TZ)

    @classmethod
    def now(cls, tz=None):
        return cls.now_value if tz is None else cls.now_value.astimezone(tz)


def test_vn_partial_bar_dropped_before_close(monkeypatch, no_cache):
    _use(monkeypatch, FixtureProvider(ohlc={"VNM": OHLC}))

    class Morning(_Frozen):
        now_value = datetime(2026, 11, 10, 10, 0, tzinfo=VN_TZ)

    monkeypatch.setattr("app.screener.provider.datetime", Morning)
    bars = data.load_daily_bars("VN:VNM", date(2026, 11, 1), date(2026, 11, 10))
    assert bars[-1]["date"] == "2026-11-09"


def test_vn_rate_limit_maps_to_vn_rate_limited(monkeypatch, no_cache):
    class Limited(FixtureProvider):
        def fetch_ohlc(self, *a, **kw):
            raise RateLimited("cooldown")

    _use(monkeypatch, Limited())
    with pytest.raises(market.VnRateLimited):
        data.load_daily_bars("VN:VNM", date(2026, 11, 1), date(2026, 11, 10))


def test_vn_no_bars_is_value_error(monkeypatch, no_cache):
    _use(monkeypatch, FixtureProvider(ohlc={}))
    with pytest.raises(ValueError):
        data.load_daily_bars("VN:VNM", date(2026, 11, 1), date(2026, 11, 10))

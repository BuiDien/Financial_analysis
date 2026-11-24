"""The VN market-data seam: drop_partial_bar, units, fixture fetch_ohlc."""
from datetime import date, datetime

from app.marketdata import VN_TZ, ProviderRateLimited, drop_partial_bar, price_unit
from app.marketdata.fixture import FixtureProvider
from app.marketdata.ratelimit import RateLimited

BARS = [{"date": "2026-11-09", "close": 1.0}, {"date": "2026-11-10", "close": 2.0}]


def test_drop_partial_bar_only_before_close_and_only_today():
    assert drop_partial_bar(BARS, datetime(2026, 11, 10, 14, 59, tzinfo=VN_TZ)) == BARS[:1]
    assert drop_partial_bar(BARS, datetime(2026, 11, 10, 15, 0, tzinfo=VN_TZ)) == BARS
    assert drop_partial_bar(BARS, datetime(2026, 11, 11, 9, 0, tzinfo=VN_TZ)) == BARS
    # timezone: 02:00 UTC is 09:00 ICT on the same day
    from datetime import timezone
    assert drop_partial_bar(BARS, datetime(2026, 11, 10, 2, 0, tzinfo=timezone.utc)) == BARS[:1]
    intraday = [{"date": "2026-11-10 00:00:00", "close": 1.0}]
    assert drop_partial_bar(intraday, datetime(2026, 11, 10, 10, tzinfo=VN_TZ)) == []


def test_price_unit():
    assert price_unit("VNM") == 1000.0 and price_unit("vnindex") == 1.0 and price_unit("VN30") == 1.0


def test_rate_limited_is_a_provider_rate_limit():
    assert issubclass(RateLimited, ProviderRateLimited)


def test_fixture_fetch_ohlc_window_and_full_vnd():
    p = FixtureProvider(end_date=date(2026, 11, 10))
    bars = p.fetch_ohlc("GOODCO", date(2026, 11, 3), date(2026, 11, 10))
    assert [b["date"] for b in bars][-1] == "2026-11-10" and bars[0]["date"] >= "2026-11-03"
    assert bars[-1]["close"] == 52_000.0
    assert all(b["low"] <= min(b["open"], b["close"]) and b["high"] >= max(b["open"], b["close"])
               for b in bars)
    assert p.ohlc_calls[0]["interval"] == "1d"
    custom = FixtureProvider(ohlc={"X": [{"date": "2020-01-02", "open": 1, "high": 1, "low": 1,
                                         "close": 1, "volume": 1}]})
    assert len(custom.fetch_ohlc("X", date(2000, 1, 1), date(2026, 1, 1))) == 1

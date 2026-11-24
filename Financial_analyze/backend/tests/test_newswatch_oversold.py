from datetime import date

import pytest

from app.newswatch import store
from app.newswatch.oversold import check_oversold, latest_rsi, pct_change


def test_rsi_trigger():
    closes = [100 - i for i in range(30)]
    sig = check_oversold(closes)
    assert sig is not None
    assert sig["rsi"] is not None and sig["rsi"] < 30


def test_drop_trigger_without_low_rsi():
    up = [100 + 2 * i for i in range(60)]  # long uptrend
    base = up[-1]
    closes = up + [base * (1 - 0.12 * (k / 5)) for k in range(1, 6)]
    sig = check_oversold(closes)
    assert sig is not None
    assert sig["rsi"] >= 30
    assert sig["drop_pct"] == pytest.approx(-12.0)


def test_no_signal_on_flat_series():
    assert check_oversold([100.0] * 30) is None


def test_short_history_returns_none():
    assert check_oversold([100 - i for i in range(10)]) is None
    assert pct_change([1.0, 2.0], 5) is None
    assert latest_rsi([1.0] * 5) is None


def test_global_alert_sent_and_urls(db):
    day = date(2026, 11, 13)
    assert store.global_alert_sent(db, day) is False
    store.record_alert(db, kind="global", ticker=None, alert_date=day, verdict="market_wide",
                       message="m", facts={"urls": ["https://r/1"]}, episode_open=False)
    assert store.global_alert_sent(db, day) is True
    assert store.alerted_urls(db) == {"https://r/1"}


# --- test-gap round (2026-11-15) ---
def test_alerted_urls_tolerates_null_facts_and_filters_kinds(db):
    day = date(2026, 11, 13)
    store.record_alert(db, kind="global", ticker=None, alert_date=day, verdict="v",
                       message="m", facts=None, episode_open=False)
    store.record_alert(db, kind="holding", ticker="HPG", alert_date=day, verdict="v",
                       message="m", facts={"urls": ["https://h/1"]}, episode_open=True)
    assert store.alerted_urls(db) == set()
    assert store.alerted_urls(db, kinds=("holding",)) == {"https://h/1"}

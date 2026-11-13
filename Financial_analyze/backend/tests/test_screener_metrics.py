import pytest
from app.screener.metrics import compute_price_metrics, rsi, sma

WILDER = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84,
          46.08, 45.89, 46.03, 45.61, 46.28, 46.28]


def bars(closes, vols=None):
    vols = vols or [1000.0] * len(closes)
    return [{"date": f"2026-01-{i + 1:02d}", "close": c, "volume": v}
            for i, (c, v) in enumerate(zip(closes, vols))]


def test_sma():
    assert sma([1, 2, 3, 4], 2) == 3.5
    assert sma([1, 2], 5) is None


def test_rsi_matches_known_series():
    # Wilder series, 14 changes: RSI = 100-100/(1+gains/losses) = 70.464
    assert rsi(WILDER) == pytest.approx(70.464, abs=0.001)


def test_rsi_all_gains_is_100():
    assert rsi([float(x) for x in range(1, 20)]) == 100.0


def test_vol_multiple():
    m = compute_price_metrics(bars([10.0] * 21, [100.0] * 20 + [250.0]))
    assert m["vol_multiple"] == 2.5


def test_avg_value_bn():
    # closes are full VND now: 50,000 VND x 200,000 shares = 10 bn VND a day
    m = compute_price_metrics(bars([50_000.0] * 20, [200_000.0] * 20))
    assert m["avg_value_bn"] == pytest.approx(10.0)


def test_closes_tail_len():
    m = compute_price_metrics(bars([float(x) for x in range(1, 31)]))
    assert len(m["closes_tail"]) == 21
    assert m["closes_tail"][-1] == 30.0
    assert m["last_date"] == "2026-01-30"


def test_short_history_nones():
    m = compute_price_metrics(bars([10.0] * 5))
    assert m["rsi14"] is None and m["vol_multiple"] is None and m["avg_value_bn"] is None
    assert m["close"] == 10.0 and len(m["closes_tail"]) == 5


def test_empty_is_none():
    assert compute_price_metrics([]) is None

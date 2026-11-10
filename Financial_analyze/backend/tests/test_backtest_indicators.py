from app.backtest.indicators import sma, ema, rsi, highest, lowest

def test_sma_aligned_with_none_warmup():
    assert sma([1, 2, 3, 4], 2) == [None, 1.5, 2.5, 3.5]

def test_ema_seeded_by_sma():
    out = ema([1, 2, 3, 4], 2)   # seed 1.5 at i=1, k=2/3
    assert out[0] is None and out[1] == 1.5
    assert abs(out[2] - (3 * 2/3 + 1.5 * 1/3)) < 1e-9

def test_rsi_all_gains_is_100_and_warmup_none():
    out = rsi(list(range(1, 20)), 14)
    assert out[:14] == [None] * 14 and out[14] == 100.0

def test_rsi_known_value_mixed_moves():
    closes = [44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28]
    assert abs(rsi(closes, 14)[14] - 72.98) < 0.1   # standard Wilder, SMA seed (verified 72.98387)

def test_highest_lowest_exclude_current_bar():
    assert highest([1, 5, 2, 3], 2) == [None, None, 5, 5]
    assert lowest([4, 1, 2, 3], 2) == [None, None, 1, 1]

def test_short_input_all_none():
    assert sma([1.0], 5) == [None] and rsi([1.0, 2.0], 14) == [None, None]

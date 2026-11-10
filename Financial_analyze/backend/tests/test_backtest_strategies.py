import pytest
from app.backtest.strategies import list_strategies, get_strategy, resolve_params

def bars_from(closes):
    return [{"date": f"2020-01-{i+1:02d}", "open": c, "high": c, "low": c, "close": c, "volume": 0} for i, c in enumerate(closes)]

def test_registry_ids_in_order():
    assert [s["id"] for s in list_strategies()] == ["buy_hold", "sma_cross", "rsi_reversion", "breakout"]

def test_resolve_params_defaults_and_validation():
    s = get_strategy("sma_cross")
    assert resolve_params(s, None) == {"fast": 20, "slow": 50}
    with pytest.raises(ValueError): resolve_params(s, {"fast": 60, "slow": 50})
    with pytest.raises(ValueError): resolve_params(s, {"bogus": 1})
    with pytest.raises(ValueError): resolve_params(s, {"fast": 1})

def test_unknown_strategy_keyerror():
    with pytest.raises(KeyError): get_strategy("nope")

def test_sma_cross_none_during_warmup_is_flat():
    s = get_strategy("sma_cross")
    out = s.targets(bars_from([10] * 30), {"fast": 5, "slow": 40})
    assert out == [0] * 30

def test_sma_cross_goes_long_on_uptrend():
    s = get_strategy("sma_cross")
    out = s.targets(bars_from(list(range(1, 31))), {"fast": 2, "slow": 5})
    assert out[3] == 0 and out[-1] == 1

def test_rsi_reversion_holds_between_thresholds():
    s = get_strategy("rsi_reversion")
    closes = [100 - i for i in range(20)] + [80 + i * 0.1 for i in range(5)]   # crash then drift
    out = s.targets(bars_from(closes), {"period": 5, "buy_below": 30, "sell_above": 70})
    first_long = out.index(1)
    assert all(v == 1 for v in out[first_long:])   # never exceeded 70 → still held

def test_breakout_enters_on_new_high_exits_on_new_low():
    s = get_strategy("breakout")
    closes = [10] * 6 + [12] + [11] * 3 + [8]
    out = s.targets(bars_from(closes), {"entry": 5, "exit": 3})
    assert out[6] == 1 and out[9] == 1 and out[10] == 0

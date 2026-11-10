from app.backtest.engine import run_backtest


def mk(opens, closes=None):
    closes = closes or opens
    return [{"date": f"2021-01-{i+1:02d}", "open": o, "high": max(o, c), "low": min(o, c), "close": c, "volume": 0}
            for i, (o, c) in enumerate(zip(opens, closes))]


KW = dict(initial_capital=10_000, fee_rate=0.0, sell_tax_rate=0.0, lot_size=1, price_scale=1, min_hold_bars=0)


def test_signal_fills_next_open():
    r = run_backtest(mk([10, 11, 12, 13], [10, 11, 12, 13]), [1, 1, 0, 0], **KW)
    t = r["trades"][0]
    assert t["entry_date"] == "2021-01-02" and t["entry_price"] == 11
    assert t["exit_date"] == "2021-01-04" and t["exit_price"] == 13
    assert t["shares"] == 909 and not t["open"]


def test_fees_and_tax_reduce_pnl():
    kw = {**KW, "fee_rate": 0.01, "sell_tax_rate": 0.01}
    t = run_backtest(mk([100, 100, 100]), [1, 0, 0], **kw)["trades"][0]
    assert t["shares"] == 99 and round(t["pnl"], 2) == -297.0


def test_lot_size_and_price_scale():
    kw = {**KW, "initial_capital": 100_000_000, "lot_size": 100, "price_scale": 1000}
    t = run_backtest(mk([57.8, 57.8, 57.8]), [1, 0, 0], **kw)["trades"][0]
    assert t["shares"] == 1700


def test_capital_below_one_lot_never_trades():
    kw = {**KW, "initial_capital": 1_000_000, "lot_size": 100, "price_scale": 1000}
    r = run_backtest(mk([120, 121, 122]), [1, 1, 1], **kw)
    assert r["trades"] == [] and {e["value"] for e in r["equity"]} == {1_000_000}
    assert r["skipped_buys"] > 0


def test_sell_deferred_until_min_hold():
    kw = {**KW, "min_hold_bars": 2}
    r = run_backtest(mk([10, 10, 10, 10, 10]), [1, 0, 0, 0, 0], **kw)
    t = r["trades"][0]
    assert t["entry_date"] == "2021-01-02" and t["exit_date"] == "2021-01-04"


def test_open_position_at_end_is_reported():
    r = run_backtest(mk([10, 10, 20], [10, 10, 20]), [1, 1, 1], **KW)
    t = r["trades"][0]
    assert t["open"] and t["exit_date"] is None and t["pnl"] == 10_000
    assert r["equity"][-1]["value"] == 20_000


def test_start_index_ignores_warmup_signals():
    r = run_backtest(mk([10] * 5), [1, 1, 0, 0, 0], start_index=2, **KW)
    assert r["trades"] == [] and len(r["equity"]) == 3


def test_float_flooring_guard():
    from app.backtest.engine import _lots
    assert _lots(100_000_000, 57_800, 100) == 1700
    assert _lots(10_000, 11, 1) == 909
    assert _lots(0.3, 0.1, 1) == 3
    assert _lots(1_000_000, 120_000, 100) == 0


def test_pending_sell_cancelled_when_target_returns_to_one():
    kw = {**KW, "min_hold_bars": 3}
    r = run_backtest(mk([10] * 6), [1, 0, 1, 1, 1, 1], **kw)
    assert len(r["trades"]) == 1 and r["trades"][0]["open"]
    assert r["exposure_bars"] == 5

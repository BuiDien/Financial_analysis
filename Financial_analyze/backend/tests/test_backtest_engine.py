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


# ---- fill realism ----------------------------------------------------------

def bar(d, o, h, l, c, v=1_000_000):
    return {"date": f"2021-01-{d:02d}", "open": o, "high": h, "low": l, "close": c, "volume": v}


def test_slippage_is_adverse_on_both_sides():
    r = run_backtest(mk([100, 100, 100]), [1, 0, 0], **{**KW, "slippage_rate": 0.01})
    t = r["trades"][0]
    assert t["entry_price"] == 101 and t["exit_price"] == 99
    assert t["shares"] == 99 and round(t["pnl"], 6) == round(99 * 99 - 99 * 101, 6)


def test_lock_check_skips_one_price_bar_both_sides():
    bars = [bar(1, 10, 11, 9, 10), bar(2, 10, 10, 10, 10), bar(3, 10, 11, 9, 10),
            bar(4, 12, 12, 12, 12), bar(5, 12, 13, 11, 12)]
    r = run_backtest(bars, [1, 1, 0, 0, 0], lock_check=True, **KW)
    t = r["trades"][0]
    assert t["entry_date"] == "2021-01-03"   # 01-02 was locked
    assert t["exit_date"] == "2021-01-05"    # 01-04 was locked
    assert r["blocked_fills"] == 2


def test_lock_check_off_by_default():
    r = run_backtest(mk([100, 100, 100]), [1, 0, 0], **KW)
    assert r["trades"][0]["entry_date"] == "2021-01-02" and r["blocked_fills"] == 0


def test_ceiling_and_floor_block_with_limit():
    from app.backtest.engine import vn_tick
    kw = {**KW, "initial_capital": 100_000_000, "lot_size": 100, "lock_check": True,
          "limit_pct": 0.07, "tick_fn": lambda p: vn_tick(p, "HOSE")}
    # 23_450 * 1.07 = 25_091.5 -> ceiling 25_050 (50-dong tick); opens there
    bars = [bar(1, 23_450, 23_500, 23_400, 23_450), bar(2, 25_050, 25_050, 24_800, 24_900),
            bar(3, 24_900, 25_000, 24_800, 24_900),
            bar(4, 23_200, 23_400, 23_200, 23_300),   # 24_900*0.93=23_157 -> floor 23_200
            bar(5, 23_300, 23_500, 23_200, 23_400)]
    r = run_backtest(bars, [1, 1, 0, 0, 0], **kw)
    t = r["trades"][0]
    assert t["entry_date"] == "2021-01-03" and t["exit_date"] == "2021-01-05"
    assert r["blocked_fills"] == 2


def test_volume_cap_limits_buy_and_splits_sell():
    bars = [bar(1, 10, 11, 9, 10, 1000), bar(2, 10, 11, 9, 10, 1000),
            bar(3, 10, 11, 9, 10, 500), bar(4, 10, 11, 9, 10, 500), bar(5, 10, 11, 9, 10, 500)]
    r = run_backtest(bars, [1, 0, 0, 0, 0], max_volume_frac=0.1, **KW)
    t = r["trades"][0]
    assert t["shares"] == 100                      # 10% of 1000
    assert t["exit_date"] == "2021-01-04" and not t["open"]  # 50 + 50 over two bars
    assert t["exit_price"] == 10 and t["pnl"] == 0

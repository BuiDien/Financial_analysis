from app.backtest.metrics import compute_metrics


def eq(vals, start="2020-01-01"):
    from datetime import date, timedelta
    d0 = date.fromisoformat(start)
    return [{"date": (d0 + timedelta(days=i)).isoformat(), "value": v} for i, v in enumerate(vals)]


def tr(pnl, ret, open_=False):
    return {"pnl": pnl, "return_pct": ret, "open": open_}


def test_drawdown_and_return():
    m = compute_metrics({"equity": eq([100, 120, 90, 130]), "trades": [], "exposure_bars": 2}, 100)
    assert m["total_return_pct"] == 30.0 and m["max_drawdown_pct"] == -25.0 and m["exposure_pct"] == 50.0


def test_metrics_no_trades():
    m = compute_metrics({"equity": eq([100, 100]), "trades": [], "exposure_bars": 0}, 100)
    assert m["trades"] == 0 and m["win_rate_pct"] is None and m["avg_trade_pct"] is None and m["sharpe"] is None


def test_metrics_ignore_open_trade():
    m = compute_metrics({"equity": eq([100, 110]), "trades": [tr(10, 10), tr(-5, -5), tr(99, 99, True)], "exposure_bars": 2}, 100)
    assert m["trades"] == 2 and m["win_rate_pct"] == 50.0 and m["best_trade_pct"] == 10.0


def test_cagr_two_years_doubling():
    vals = [100] * 731
    vals[-1] = 200
    m = compute_metrics({"equity": eq(vals), "trades": [], "exposure_bars": 0}, 100)
    assert abs(m["cagr_pct"] - 41.4) < 0.2


def test_empty_equity():
    m = compute_metrics({"equity": [], "trades": [], "exposure_bars": 0}, 100)
    assert m["final_equity"] is None and m["sharpe"] is None and m["trades"] == 0

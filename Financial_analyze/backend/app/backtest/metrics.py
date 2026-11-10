"""Summary statistics for a backtest result."""
from datetime import date
from math import sqrt
from statistics import mean, stdev


def _r(x):
    return None if x is None else round(x, 2)


def compute_metrics(result: dict, initial_capital: float) -> dict:
    equity = result.get("equity") or []
    closed = [t for t in (result.get("trades") or []) if not t.get("open")]
    values = [p["value"] for p in equity]

    out = {
        "final_equity": None, "total_return_pct": None, "cagr_pct": None,
        "max_drawdown_pct": 0.0, "sharpe": None, "trades": len(closed),
        "win_rate_pct": None, "avg_trade_pct": None, "best_trade_pct": None,
        "worst_trade_pct": None, "exposure_pct": 0.0,
    }

    if closed:
        rets = [t["return_pct"] for t in closed]
        out["win_rate_pct"] = _r(sum(1 for t in closed if t["pnl"] > 0) / len(closed) * 100)
        out["avg_trade_pct"] = _r(mean(rets))
        out["best_trade_pct"] = _r(max(rets))
        out["worst_trade_pct"] = _r(min(rets))

    if not values:
        return out

    final = values[-1]
    out["final_equity"] = round(final, 0)
    if initial_capital:
        out["total_return_pct"] = _r((final / initial_capital - 1) * 100)
    out["exposure_pct"] = _r(result.get("exposure_bars", 0) / len(values) * 100)

    years = (date.fromisoformat(equity[-1]["date"]) - date.fromisoformat(equity[0]["date"])).days / 365.25
    if years >= 0.1 and final > 0 and initial_capital and initial_capital > 0:
        out["cagr_pct"] = _r(((final / initial_capital) ** (1 / years) - 1) * 100)

    peak, mdd = values[0], 0.0
    for v in values:
        peak = max(peak, v)
        if peak > 0:
            mdd = min(mdd, (v / peak - 1) * 100)
    out["max_drawdown_pct"] = _r(mdd)

    rets = [values[i] / values[i - 1] - 1 for i in range(1, len(values)) if values[i - 1] != 0]
    if len(rets) >= 2:
        sd = stdev(rets)
        if sd > 0:
            out["sharpe"] = _r(mean(rets) / sd * sqrt(252))
    return out

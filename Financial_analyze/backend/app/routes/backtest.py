from datetime import date, timedelta

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.backtest import data
from app.backtest.engine import run_backtest
from app.backtest.metrics import compute_metrics
from app.backtest.strategies import get_strategy, list_strategies, resolve_params
from app.services import market

router = APIRouter()

VN_DEFAULTS = dict(currency="VND", initial_capital=100_000_000, fee_pct=0.15, sell_tax_pct=0.1,
                   lot_size=100, price_scale=1000, min_hold_bars=3)
US_DEFAULTS = dict(currency="USD", initial_capital=10_000, fee_pct=0.0, sell_tax_pct=0.0,
                   lot_size=1, price_scale=1, min_hold_bars=0)


VN_INDEX_SYMBOLS = {"VNINDEX", "VN30", "HNXINDEX", "HNX30", "UPCOMINDEX"}  # mirrors VN_INDEXES in page-detail.jsx


class BacktestRequest(BaseModel):
    ticker: str
    strategy: str
    params: dict[str, float] = {}
    start: date
    end: date
    initial_capital: float | None = None
    fee_pct: float | None = None
    sell_tax_pct: float | None = None


@router.get("/backtest/strategies")
def strategies():
    return list_strategies()


def _simulate(bars, targets, start_index, s):
    result = run_backtest(
        bars, targets,
        initial_capital=s["initial_capital"], fee_rate=s["fee_pct"] / 100,
        sell_tax_rate=s["sell_tax_pct"] / 100, lot_size=s["lot_size"],
        price_scale=s["price_scale"], min_hold_bars=s["min_hold_bars"],
        start_index=start_index,
    )
    return result, compute_metrics(result, s["initial_capital"])


@router.post("/backtest/run")
def run(req: BacktestRequest):
    ticker = req.ticker.strip().upper()
    if req.start >= req.end:
        raise HTTPException(400, "Start date must be before end date")
    try:
        strat = get_strategy(req.strategy)
    except KeyError:
        raise HTTPException(400, f"Unknown strategy: {req.strategy}")
    try:
        params = resolve_params(strat, req.params)
    except ValueError as e:
        raise HTTPException(400, str(e))

    s = dict(VN_DEFAULTS if ticker.startswith(market.VN_PREFIX) else US_DEFAULTS)
    if ticker.startswith(market.VN_PREFIX) and ticker[len(market.VN_PREFIX):] in VN_INDEX_SYMBOLS:
        # VCI index prices are not in 1000-VND units, and an index is not lot-traded.
        s["price_scale"], s["lot_size"] = 1, 1
    for k, v in (("initial_capital", req.initial_capital), ("fee_pct", req.fee_pct),
                 ("sell_tax_pct", req.sell_tax_pct)):
        if v is not None:
            s[k] = v
    currency = s.pop("currency")

    try:
        bars = data.load_daily_bars(ticker, req.start - timedelta(days=data.WARMUP_DAYS), req.end)
    except ValueError:
        raise HTTPException(404, f"No price data for {ticker}")
    except market.VnRateLimited:
        raise HTTPException(503, "VN data provider rate-limited, try again in a minute")
    except Exception as e:
        raise HTTPException(502, f"Price data provider error: {e}")

    start_iso = req.start.isoformat()
    start_index = next((i for i, b in enumerate(bars) if b["date"] >= start_iso), len(bars))
    if len(bars) - start_index < 2:
        raise HTTPException(400, "Not enough price history in this range")

    result, metrics = _simulate(bars, strat.targets(bars, params), start_index, s)
    bh = get_strategy("buy_hold")
    bench, bench_metrics = _simulate(bars, bh.targets(bars, {}), start_index, s)

    return {
        "ticker": ticker, "currency": currency,
        "strategy": {"id": strat.id, "name": strat.name}, "params": params,
        "start": start_iso, "end": req.end.isoformat(),
        "settings": {**s, "initial_capital": s["initial_capital"]},
        "bars": bars[start_index:],
        "equity": result["equity"], "benchmark_equity": bench["equity"],
        "trades": result["trades"], "skipped_buys": result["skipped_buys"], "metrics": metrics, "benchmark_metrics": bench_metrics,
    }

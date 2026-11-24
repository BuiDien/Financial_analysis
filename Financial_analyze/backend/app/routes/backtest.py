from datetime import date, timedelta

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.backtest import data
from app.backtest.engine import VN_LIMIT_PCT, run_backtest, vn_tick
from app.backtest.metrics import compute_metrics
from app.backtest.strategies import get_strategy, list_strategies, resolve_params
from app.marketdata import VN_INDEX_SYMBOLS
from app.services import market

router = APIRouter()

# Bars from data.load_daily_bars are in full currency units (VND for VN), so
# price_scale is 1 everywhere; it stays in `settings` for the frontend.
VN_DEFAULTS = dict(currency="VND", initial_capital=100_000_000, fee_pct=0.15, sell_tax_pct=0.1,
                   lot_size=100, price_scale=1, min_hold_bars=3)
US_DEFAULTS = dict(currency="USD", initial_capital=10_000, fee_pct=0.0, sell_tax_pct=0.0,
                   lot_size=1, price_scale=1, min_hold_bars=0)
DEFAULT_SLIPPAGE_PCT = 0.1     # adverse, per fill
DEFAULT_MAX_VOLUME_PCT = 10.0  # of the fill bar's volume


class BacktestRequest(BaseModel):
    ticker: str
    strategy: str
    params: dict[str, float] = {}
    start: date
    end: date
    initial_capital: float | None = Field(None, gt=0)
    fee_pct: float | None = Field(None, ge=0)
    sell_tax_pct: float | None = Field(None, ge=0)
    slippage_pct: float = Field(DEFAULT_SLIPPAGE_PCT, ge=0)
    max_volume_pct: float = Field(DEFAULT_MAX_VOLUME_PCT, gt=0, le=100)
    exchange: str | None = None  # VN: HOSE/HNX/UPCOM; looked up when omitted


def _vn_exchange(symbol: str) -> str | None:
    """Exchange from the screener's ticker table, None if unknown."""
    try:
        from app.db import SessionLocal
        from app.models.screener import TickerMetrics
        with SessionLocal() as db:
            row = db.get(TickerMetrics, symbol)
            return (row.exchange or None) if row is not None else None
    except Exception:
        return None


@router.get("/backtest/strategies")
def strategies():
    return list_strategies()


def _simulate(bars, targets, start_index, s):
    exchange = s.get("exchange")
    result = run_backtest(
        bars, targets,
        initial_capital=s["initial_capital"], fee_rate=s["fee_pct"] / 100,
        sell_tax_rate=s["sell_tax_pct"] / 100, lot_size=s["lot_size"],
        price_scale=s["price_scale"], min_hold_bars=s["min_hold_bars"],
        start_index=start_index, slippage_rate=s["slippage_pct"] / 100,
        lock_check=s["lock_check"], limit_pct=s["limit_pct"],
        tick_fn=lambda p: vn_tick(p, exchange),
        max_volume_frac=s["max_volume_pct"] / 100,
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

    is_vn = ticker.startswith(market.VN_PREFIX)
    symbol = ticker[len(market.VN_PREFIX):] if is_vn else ticker
    is_index = is_vn and symbol in VN_INDEX_SYMBOLS
    s = dict(VN_DEFAULTS if is_vn else US_DEFAULTS)
    if is_index:
        s["lot_size"] = 1  # an index is not lot-traded
    for k, v in (("initial_capital", req.initial_capital), ("fee_pct", req.fee_pct),
                 ("sell_tax_pct", req.sell_tax_pct)):
        if v is not None:
            s[k] = v
    exchange = None
    if is_vn and not is_index:
        exchange = (req.exchange or _vn_exchange(symbol) or "").upper() or None
    s.update(slippage_pct=req.slippage_pct, max_volume_pct=req.max_volume_pct,
             exchange=exchange, limit_pct=VN_LIMIT_PCT.get(exchange) if exchange else None,
             # A one-price bar is a locked limit move on VN; US/index bars never lock.
             lock_check=is_vn and not is_index)
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
        "trades": result["trades"], "skipped_buys": result["skipped_buys"],
        "blocked_fills": result["blocked_fills"],
        "metrics": metrics, "benchmark_metrics": bench_metrics,
    }

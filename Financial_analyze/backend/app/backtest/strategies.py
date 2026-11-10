"""Strategy registry: each strategy maps bars + params to a 0/1 target position per bar."""
from dataclasses import dataclass
from typing import Callable

from app.backtest.indicators import sma, rsi, highest, lowest


@dataclass(frozen=True)
class ParamSpec:
    key: str
    label: str
    default: float
    min: float
    max: float
    step: float = 1


@dataclass(frozen=True)
class Strategy:
    id: str
    name: str
    description: str
    params: tuple[ParamSpec, ...]
    targets: Callable[[list[dict], dict], list[int]]


def _buy_hold(bars, params):
    return [1] * len(bars)


def _sma_cross(bars, params):
    closes = [b["close"] for b in bars]
    fast = sma(closes, params["fast"])
    slow = sma(closes, params["slow"])
    return [1 if f is not None and s is not None and f > s else 0 for f, s in zip(fast, slow)]


def _rsi_reversion(bars, params):
    r = rsi([b["close"] for b in bars], params["period"])
    out, state = [], 0
    for v in r:
        if v is not None:
            if v < params["buy_below"]:
                state = 1
            elif v > params["sell_above"]:
                state = 0
        out.append(state)
    return out


def _breakout(bars, params):
    hi = highest([b["high"] for b in bars], params["entry"])
    lo = lowest([b["low"] for b in bars], params["exit"])
    out, state = [], 0
    for b, h, l in zip(bars, hi, lo):
        c = b["close"]
        if h is not None and c > h:
            state = 1
        elif l is not None and c < l:
            state = 0
        out.append(state)
    return out


_REGISTRY: tuple[Strategy, ...] = (
    Strategy("buy_hold", "Buy & hold",
             "Buy on the first day and hold until the end.",
             (), _buy_hold),
    Strategy("sma_cross", "Moving-average crossover",
             "Hold while the 20-day average is above the 50-day; sell when it drops below.",
             (ParamSpec("fast", "Fast average (days)", 20, 2, 200),
              ParamSpec("slow", "Slow average (days)", 50, 5, 400)),
             _sma_cross),
    Strategy("rsi_reversion", "RSI mean reversion",
             "Buy when the 14-day RSI drops below 30 (oversold); sell when it rises above 70 (overbought).",
             (ParamSpec("period", "RSI period (days)", 14, 2, 50),
              ParamSpec("buy_below", "Buy below RSI", 30, 5, 50),
              ParamSpec("sell_above", "Sell above RSI", 70, 50, 95)),
             _rsi_reversion),
    Strategy("breakout", "Breakout (Donchian)",
             "Buy when the price closes above the 20-day high; sell when it closes below the 10-day low.",
             (ParamSpec("entry", "Entry high (days)", 20, 5, 200),
              ParamSpec("exit", "Exit low (days)", 10, 2, 200)),
             _breakout),
)


def list_strategies() -> list[dict]:
    return [
        {
            "id": s.id, "name": s.name, "description": s.description,
            "params": [{"key": p.key, "label": p.label, "default": p.default,
                        "min": p.min, "max": p.max, "step": p.step} for p in s.params],
        }
        for s in _REGISTRY
    ]


def get_strategy(strategy_id: str) -> Strategy:
    for s in _REGISTRY:
        if s.id == strategy_id:
            return s
    raise KeyError(strategy_id)


def resolve_params(strategy: Strategy, params: dict | None) -> dict[str, float]:
    params = dict(params or {})
    specs = {p.key: p for p in strategy.params}
    unknown = sorted(set(params) - set(specs))
    if unknown:
        raise ValueError(f"Unknown parameter(s) for {strategy.id}: {', '.join(unknown)}")
    out: dict[str, float] = {}
    for key, spec in specs.items():
        v = params.get(key, spec.default)
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ValueError(f"{spec.label} must be a number")
        if v < spec.min or v > spec.max:
            raise ValueError(f"{spec.label} must be between {spec.min:g} and {spec.max:g}")
        out[key] = int(v)
    if strategy.id == "sma_cross" and out["fast"] >= out["slow"]:
        raise ValueError("Fast average must be shorter than slow average")
    return out

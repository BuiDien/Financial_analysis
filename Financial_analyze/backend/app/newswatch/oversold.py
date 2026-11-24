"""Pure oversold detection (no I/O)."""
from typing import TypedDict

from ..backtest.indicators import rsi


class OversoldSignal(TypedDict):
    rsi: float | None
    drop_pct: float
    sessions: int
    close: float


def pct_change(closes: list[float], sessions: int) -> float | None:
    if sessions <= 0 or len(closes) <= sessions:
        return None
    base = closes[-1 - sessions]
    if not base:
        return None
    return (closes[-1] / base - 1) * 100


def latest_rsi(closes: list[float], n: int = 14) -> float | None:
    if len(closes) <= n:
        return None
    return rsi(closes, n)[-1]


def check_oversold(closes, *, rsi_max=30.0, drop_pct=10.0, sessions=5) -> OversoldSignal | None:
    r = latest_rsi(closes)
    chg = pct_change(closes, sessions)
    low_rsi = r is not None and r < rsi_max
    big_drop = chg is not None and chg <= -drop_pct
    if not (low_rsi or big_drop):
        return None
    return {"rsi": r, "drop_pct": chg if chg is not None else 0.0,
            "sessions": sessions, "close": closes[-1]}

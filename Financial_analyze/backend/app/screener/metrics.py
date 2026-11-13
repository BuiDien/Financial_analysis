"""Pure price metrics from daily bars (no network)."""


def sma(values: list[float], n: int) -> float | None:
    if len(values) < n:
        return None
    return sum(values[-n:]) / n


def rsi(closes: list[float], n: int = 14) -> float | None:
    """Wilder RSI over daily closes."""
    if len(closes) < n + 1:
        return None
    gains, losses = [], []
    for prev, cur in zip(closes[:-1], closes[1:]):
        delta = cur - prev
        gains.append(max(delta, 0.0))
        losses.append(max(-delta, 0.0))
    avg_gain = sum(gains[:n]) / n
    avg_loss = sum(losses[:n]) / n
    for gain, loss in zip(gains[n:], losses[n:]):
        avg_gain = (avg_gain * (n - 1) + gain) / n
        avg_loss = (avg_loss * (n - 1) + loss) / n
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)


def compute_price_metrics(bars: list[dict]) -> dict | None:
    """bars: oldest first, completed sessions, {"date","close","volume"} (close in full VND)."""
    if not bars:
        return None
    closes = [float(b["close"]) for b in bars]
    vols = [float(b["volume"]) for b in bars]
    vol_multiple = None
    if len(bars) >= 21:
        mean = sum(vols[-21:-1]) / 20
        if mean > 0:
            vol_multiple = vols[-1] / mean
    avg_value_bn = None
    if len(bars) >= 20:
        avg_value_bn = sum(c * v / 1e9
                           for c, v in zip(closes[-20:], vols[-20:])) / 20
    return {
        "last_date": bars[-1]["date"],
        "close": closes[-1],
        "rsi14": rsi(closes),
        "closes_tail": closes[-21:],
        "vol_multiple": vol_multiple,
        "avg_value_bn": avg_value_bn,
    }

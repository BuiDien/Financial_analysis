"""Pure indicator functions. Each returns list[float | None] aligned with input."""


def sma(values, n):
    out = [None] * len(values)
    if n <= 0:
        return out
    total = 0.0
    for i, v in enumerate(values):
        total += v
        if i >= n:
            total -= values[i - n]
        if i >= n - 1:
            out[i] = total / n
    return out


def ema(values, n):
    out = [None] * len(values)
    if n <= 0 or len(values) < n:
        return out
    k = 2 / (n + 1)
    prev = sum(values[:n]) / n
    out[n - 1] = prev
    for i in range(n, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def rsi(closes, n=14):
    out = [None] * len(closes)
    if n <= 0 or len(closes) <= n:
        return out
    gains = [max(closes[i] - closes[i - 1], 0.0) for i in range(1, len(closes))]
    losses = [max(closes[i - 1] - closes[i], 0.0) for i in range(1, len(closes))]
    avg_g = sum(gains[:n]) / n
    avg_l = sum(losses[:n]) / n

    def val(g, l):
        return 100.0 if l == 0 else 100.0 - 100.0 / (1 + g / l)

    out[n] = val(avg_g, avg_l)
    for i in range(n + 1, len(closes)):
        avg_g = (avg_g * (n - 1) + gains[i - 1]) / n
        avg_l = (avg_l * (n - 1) + losses[i - 1]) / n
        out[i] = val(avg_g, avg_l)
    return out


def _window(values, n, fn):
    out = [None] * len(values)
    if n <= 0:
        return out
    for i in range(n, len(values)):
        out[i] = fn(values[i - n:i])
    return out


def highest(values, n):
    return _window(values, n, max)


def lowest(values, n):
    return _window(values, n, min)

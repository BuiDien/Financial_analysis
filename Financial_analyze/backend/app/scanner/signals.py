"""Deterministic per-dimension sub-scores (0-100) from a stock's broad data.

Pure functions over a plain dict. No ORM, no vnstock, no LLM. Reproducible.
"""


def _clip(x: float) -> float:
    return max(0.0, min(100.0, x))


def fundamentals_score(stock: dict) -> float:
    # higher ROE/ROA/margins/growth => higher score. Simple linear maps, clipped.
    roe = (stock.get("roe") or 0) * 100          # 0.20 -> 20
    roa = (stock.get("roa") or 0) * 100
    gm = (stock.get("gross_margin") or 0) * 100
    nm = (stock.get("net_margin") or 0) * 100
    growth = ((stock.get("revenue_growth") or 0) + (stock.get("profit_growth") or 0)) * 100
    raw = roe * 1.5 + roa * 1.0 + gm * 0.4 + nm * 1.0 + growth * 0.5
    return _clip(raw)


def valuation_score(stock: dict) -> float:
    # cheaper than sector => higher score. P/E relative to sector + absolute P/B sanity.
    pe = stock.get("pe") or 0
    sector_pe = stock.get("sector_pe") or 0
    pb = stock.get("pb") or 0
    if pe <= 0:
        pe_component = 0.0           # negative/zero earnings: no valuation credit
    elif sector_pe > 0:
        pe_component = _clip((sector_pe / pe) * 50)   # at sector P/E -> 50; half sector P/E -> 100
    else:
        pe_component = 50.0
    pb_component = _clip((2.0 / pb) * 50) if pb > 0 else 0.0  # P/B 2 -> 50; lower -> higher
    return _clip(pe_component * 0.6 + pb_component * 0.4)


def technical_score(stock: dict) -> float:
    # uptrend (price>sma50>sma200), healthy RSI, volume>avg => higher.
    price = stock.get("price") or 0
    sma50 = stock.get("sma50") or 0
    sma200 = stock.get("sma200") or 0
    rsi = stock.get("rsi") or 50
    vol_ratio = stock.get("vol_ratio") or 1.0
    trend = 0.0
    if price > sma50 > 0:
        trend += 30
    if sma50 > sma200 > 0:
        trend += 30
    rsi_component = _clip(40 - abs(rsi - 55) * 1.5)   # best near 55, falls off both ways
    vol_component = min(_clip((vol_ratio - 1.0) * 20), 10)  # above-avg volume adds a little
    return _clip(trend + rsi_component + vol_component)


def catalysts_score(stock: dict) -> float:
    # zero-weighted in v1 until the news layer exists.
    return 0.0


def compute_signals(stock: dict) -> dict:
    return {
        "fundamentals": fundamentals_score(stock),
        "valuation": valuation_score(stock),
        "technical": technical_score(stock),
        "catalysts": catalysts_score(stock),
    }

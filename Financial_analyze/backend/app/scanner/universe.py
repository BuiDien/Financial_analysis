"""Fetch the VN market universe + broad per-stock metrics from vnstock (4.x, VCI).

The ONLY scanner module that touches the network. Output dicts are third-party
data tagged verified=False. Field names verified in the 2026-06-23 spike doc.

TRUST RULE: map_row pulls ONLY raw-number fields via _FIELD_MAP (the allowlist).
It must NEVER copy a pre-baked verdict/signal field — a third party's decision.
SMA/RSI/vol_ratio are computed HERE from raw OHLCV: our arithmetic, reproducible.
"""
import statistics

# raw-input fields only (no third-party verdicts). Keys = our canonical names;
# values = vnstock VCI Company.ratio_summary() column names.
_FIELD_MAP = {
    "roe": "roe", "roa": "roa", "gross_margin": "gross_margin",
    "net_margin": "after_tax_profit_margin",
    "pe": "pe", "pb": "pb", "market_cap": "market_cap",
}


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
    for g, l in zip(gains[n:], losses[n:]):
        avg_gain = (avg_gain * (n - 1) + g) / n
        avg_loss = (avg_loss * (n - 1) + l) / n
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)


def volume_ratio(volumes: list[float], n: int = 20) -> float | None:
    if len(volumes) < n + 1:
        return None
    avg = sum(volumes[-n - 1:-1]) / n
    return volumes[-1] / avg if avg > 0 else None


def ebitda_yoy(rows: list[dict]) -> float | None:
    """YoY EBITDA growth from ratio_summary rows (same quarter, latest vs prior year)."""
    latest = None
    for r in rows:
        if r.get("ebitda") in (None, 0):
            continue
        if latest is None or (r["year"], r.get("quarter") or 0) > (latest["year"], latest.get("quarter") or 0):
            latest = r
    if latest is None:
        return None
    for r in rows:
        if r.get("year") == latest["year"] - 1 and r.get("quarter") == latest.get("quarter") \
                and r.get("ebitda") not in (None, 0):
            return (latest["ebitda"] - r["ebitda"]) / abs(r["ebitda"])
    return None


def map_row(raw: dict) -> dict:
    """Pure: normalize one vnstock record to the canonical stock dict (raw inputs only)."""
    out = {
        "symbol": raw.get("symbol") or raw.get("ticker"),
        "market": raw.get("exchange") or raw.get("market") or "",
        "verified": False,
        "revenue_growth": None,       # not exposed by ratio_summary (spike) — scored as 0
        "profit_growth": raw.get("profit_growth"),
        "sector_pe": raw.get("sector_pe"),
        "price": raw.get("price"), "sma50": raw.get("sma50"), "sma200": raw.get("sma200"),
        "rsi": raw.get("rsi"), "vol_ratio": raw.get("vol_ratio"),
        "news_count": 0, "news_sentiment": 0.0,   # catalysts placeholder (zero-weighted v1)
    }
    for canon, src in _FIELD_MAP.items():
        val = raw.get(src)
        out[canon] = raw.get(canon) if val is None and canon != src else val
    return out


def attach_sector_pe(stocks: list[dict], industry_by_symbol: dict, min_industry_size: int = 5) -> None:
    """Set sector_pe = median P/E of the stock's industry (our computation from raw PEs).

    Industries smaller than min_industry_size fall back to the universe median.
    Mutates stocks in place.
    """
    pes = [s["pe"] for s in stocks if s.get("pe") and s["pe"] > 0]
    universe_median = statistics.median(pes) if pes else None
    by_industry: dict = {}
    for s in stocks:
        ind = industry_by_symbol.get(s["symbol"])
        if ind and s.get("pe") and s["pe"] > 0:
            by_industry.setdefault(ind, []).append(s["pe"])
    for s in stocks:
        ind = industry_by_symbol.get(s["symbol"])
        vals = by_industry.get(ind, [])
        if len(vals) >= min_industry_size:
            s["sector_pe"] = statistics.median(vals)
        else:
            s["sector_pe"] = universe_median


def _latest_ratio_row(rows: list[dict]) -> dict | None:
    """Most recent row that carries a P/E (yearly/TTM rows do; empty rows don't)."""
    best = None
    for r in rows:
        if r.get("pe") is None:
            continue
        key = (r.get("year") or 0, r.get("quarter") or 0)
        if best is None or key > (best.get("year") or 0, best.get("quarter") or 0):
            best = r
    return best or (rows[-1] if rows else None)


def _fetch_symbol(symbol: str, exchange: str, start: str, end: str) -> dict | None:
    """Two network calls: TTM ratios + 1y daily OHLCV. Returns a canonical stock dict."""
    from vnstock.explorer.vci import Company, Quote

    rows = Company(symbol).ratio_summary().to_dict("records")
    latest = _latest_ratio_row(rows)
    if latest is None:
        return None
    raw = {**latest, "symbol": symbol, "exchange": exchange,
           "profit_growth": ebitda_yoy(rows)}

    hist = Quote(symbol).history(start=start, end=end, interval="1D")
    closes = [float(c) for c in hist["close"].tolist()]
    vols = [float(v) for v in hist["volume"].tolist()]
    if closes:
        raw.update(price=closes[-1], sma50=sma(closes, 50), sma200=sma(closes, 200),
                   rsi=rsi(closes), vol_ratio=volume_ratio(vols))
    return map_row(raw)


def fetch_universe(limit: int | None = None) -> list[dict]:
    """Fetch the whole VN market (HOSE/HNX/UPCOM): listing -> per-symbol metrics.

    Per-symbol failures are skipped (logged), never crash the run.
    """
    from datetime import date, timedelta
    from vnstock import Listing

    listing = Listing().symbols_by_exchange()
    stocks_meta = [r for r in listing.to_dict("records")
                   if r.get("type") == "stock" and r.get("exchange") in ("HOSE", "HNX", "UPCOM")]
    if limit:
        stocks_meta = stocks_meta[:limit]

    end = date.today()
    start = end - timedelta(days=400)   # enough daily bars for SMA200
    out: list[dict] = []
    for meta in stocks_meta:
        symb = meta["symbol"]
        try:
            stock = _fetch_symbol(symb, meta["exchange"], start.isoformat(), end.isoformat())
            if stock is not None:
                out.append(stock)
        except Exception as e:
            print(f"  scanner: skip {symb}: {e}")

    industry_by_symbol = _industry_map()
    attach_sector_pe(out, industry_by_symbol)
    return out


def _industry_map() -> dict:
    """symbol -> ICB industry name (used only to group OUR median-P/E computation)."""
    from vnstock import Listing
    try:
        df = Listing().symbols_by_industries()
        records = df.to_dict("records")
        for key in ("icb_name3", "icb_name2", "industry", "icb_code2"):
            if records and key in records[0]:
                return {r["symbol"]: r[key] for r in records if r.get("symbol")}
    except Exception as e:
        print(f"  scanner: industry map unavailable ({e}); universe-median sector_pe")
    return {}

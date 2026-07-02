# Spike: vnstock broad market data for the VN scanner (verified 2026-07-01)

**Question:** Does vnstock return market-wide fundamentals/valuation (not just prices), and with which exact field names?

**Environment:** vnstock **4.0.4** (installed in `Financial_analyze/backend/.venv`). NOTE: the plan was written against vnstock 3.x — 4.x removed the TCBS source and the `Screener` class entirely. All probes below ran against live VCI endpoints.

## Findings

### 1. Market-wide one-call `Screener().stock()` — GONE
`from vnstock import Screener` → `ImportError`. vnstock 4.x dropped TCBS (explorer sources: `fmarket, kbs, misc, msn, vci`). The plan's preferred path is dead → **per-symbol fallback is the path.**

### 2. Universe listing — WORKS
`Listing().symbols_by_exchange()` → 3301 rows, cols `[symbol, organ_name, en_organ_name, exchange, type, id]`. Filter `type == "stock"` and `exchange in {HOSE, HNX, UPCOM}` → ~1.6k tradable tickers. (`all_symbols()` returns only symbol+organ_name, 1527 rows — less useful.)

### 3. Fundamentals + valuation — `Company(sym).ratio_summary()` (VCI) — WORKS
One call per symbol; returns one row per (year, quarter incl. TTM rows). Verified live for VNM. Raw fields we consume:

| canonical | vnstock field | note |
|---|---|---|
| roe | `roe` | ratio (0.28 = 28%) |
| roa | `roa` | ratio |
| gross_margin | `gross_margin` | ratio |
| net_margin | `after_tax_profit_margin` | ratio |
| profit_growth | derived: `ebitda` YoY from yearly rows | same call, our arithmetic |
| revenue_growth | **unavailable** in this call | None in v1 (signals treat as 0) |
| pe | `pe` | TTM |
| pb | `pb` | |
| market_cap | `market_cap` | |
| sector_pe | **computed by us**: median `pe` per ICB industry (`icb_code2` from listing / `symbols_by_industries()`), fallback universe median | deterministic, from raw PEs |

`Finance().ratio()` (unified + explorer.vci) returns a malformed frame in 4.0.4 (duplicate `2018` columns, zeros) — do not use; `Company.ratio_summary()` is the reliable source.

### 4. Technicals — `Quote(sym).history()` daily OHLCV — WORKS
Cols `[time, open, high, low, close, volume]` (~264 rows/yr, close in thousands VND). No pre-computed sma/rsi anywhere in 4.x → **we compute from raw OHLCV** (pure functions): `price` = last close, `sma50`/`sma200` = simple means, `rsi` = Wilder RSI-14, `vol_ratio` = last volume / 20-day avg volume.

### 5. Batched price board — `Trading(source="VCI").price_board([syms])` — WORKS
82 cols (price/volume/exchange/bid-ask), **no fundamentals**. Not needed v1 (history call already yields price+volume); noted for future intraday refresh.

## TRUST RULE (spec)
Only raw numbers are mapped. vnstock 4.x/VCI exposes no pre-baked verdict fields in the calls above (the TCBS `tcbsBuySellSignal`/`priceBreakOut52Week`/`rsi14Status` died with 3.x) — and if any appear, `_FIELD_MAP` in `universe.py` is the single allowlist: anything not listed never enters the stock dict. SMA/RSI/vol_ratio are OUR computations from raw OHLCV, reproducible.

## Decision — canonical `stock` dict (locks Tasks 1–6)
```python
{
  "symbol": "VNM", "market": "HOSE", "verified": False,
  # fundamentals (ratios)
  "roe": 0.28, "roa": 0.22, "gross_margin": 0.42, "net_margin": 0.16,
  "revenue_growth": None,          # unavailable v1 -> scored as 0
  "profit_growth": 0.05,           # ebitda YoY, our arithmetic
  # valuation
  "pe": 15.0, "pb": 4.1, "sector_pe": 18.0,   # sector_pe = our industry-median
  # technicals (computed from raw OHLCV)
  "price": 55.5, "sma50": 54.0, "sma200": 52.0, "rsi": 55.0, "vol_ratio": 1.2,
  # catalysts placeholder (zero-weighted v1)
  "news_count": 0, "news_sentiment": 0.0,
}
```

## Cost/limits
2 HTTP calls per symbol (ratio_summary + history) + 2 listing calls total. Full ~1.6k universe ≈ 3.2k calls — minutes-scale with VCI throttling; fine for the daily scheduled scan. `POST /api/scan {limit}` caps universe size for manual/interactive runs.

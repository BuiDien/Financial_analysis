# app.marketdata — market data seam

The only package that imports a market-data vendor (`vnstock`, `yfinance`).
Everything else (`services/market.py`, `services/fundamentals.py`,
`backtest/data.py`, the screener, newswatch, the daily news collector) imports
from `app.marketdata`.

| Module | What |
|---|---|
| `base.py` | Canonical shapes (`Bar`, `UniverseEntry`, `Financials`, `BoardEntry`), the two protocols, `ProviderRateLimited`, helpers (`vn_symbol`, `price_unit`, `drop_partial_bar`, `trading_days_ending`). |
| `registry.py` | `get_provider()` (VN exchange, chosen by `SCREENER_PROVIDER`) and `get_global_provider()` (Yahoo). |
| `vnstock_provider.py` | `VnstockProvider` (VCI source, vnstock pinned 4.0.4). |
| `ratelimit.py` | Shared vnstock limiter: call spacing, interactive-before-background, cooldown on quota errors. |
| `yfinance_provider.py` | `YFinanceProvider`: US stocks, indices, gold/oil, FX. |
| `fixture.py` | `FixtureProvider` + sample data (tests, `SCREENER_PROVIDER=fixture`). |
| `cache.py` | The TTL cache (Redis if `REDIS_URL` is set and reachable, else bounded in-process dict). Callers own keys/TTLs. |

Routing: a `VN:<symbol>` ticker goes to the VN exchange provider; anything else goes to the global provider.

## How to add a broker API adapter (vnstock replacement)

1. **Create `app/marketdata/<broker>_provider.py`** with a class that implements
   `MarketDataProvider` from `base.py`:
   `name`, `list_universe`, `list_company_names`, `fetch_financials`,
   `fetch_prices`, `fetch_ohlc`, `fetch_board`. This module is the only place
   allowed to import the broker SDK. Import the SDK lazily (inside a function),
   the way `vnstock_provider._vnstock()` does, so tests never load it.
2. **Return the canonical units.** Prices are **full VND** (VCI's nghìn đồng
   gets multiplied by 1000; index bars are points, see `price_unit`). Ratios
   are fractions (ROE 0.18). Bars are sorted oldest first and labelled by the
   period start (Monday for weekly, the 1st for monthly). `fetch_ohlc` accepts
   every token in `INTERVALS` and keeps only `start <= date <= end`.
   `fetch_prices` never includes today's bar before 15:00 ICT
   (`drop_partial_bar`).
3. **Respect quotas.** Send every network call through a limiter. Reuse
   `ratelimit.RateLimiter` (or add one instance per vendor), pass the caller's
   `priority` through, and raise `ProviderRateLimited` (or a subclass) when the
   quota is exhausted. `services/market.py` turns it into `VnRateLimited`
   (the backtest route answers 503). Don't sleep through a cooldown on
   interactive calls.
4. **Raise per-ticker data gaps as an ordinary error**, not as an empty
   result. Raise `ValueError`/`ProviderError` when the broker has no usable
   data. The screener refresh then keeps the ticker's previous numbers instead
   of wiping them.
5. **Register it** in `registry.get_provider()` under a new
   `SCREENER_PROVIDER` value (add the value to the comment in `config.py`).
6. **Test it without network.** Record a few real responses as fixtures, stub
   the SDK, and run the shared contract:
   `tests/test_marketdata_contract.py::check_vn_provider(YourProvider(...), "VNM")`.
   Add the mapping tests next to `tests/test_screener_vnstock_provider.py`.
7. Switch with `SCREENER_PROVIDER=<broker>`. No caller changes are needed.

A non-Yahoo global source works the same way: implement `GlobalMarketProvider`
and return it from `get_global_provider()`.

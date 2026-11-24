"""Market data seam: the only package that talks to market-data vendors.

Import from here, never from vnstock/yfinance. Vendor modules
(``vnstock_provider``, ``yfinance_provider``) are loaded lazily by the registry,
so importing this package is cheap. See README.md for adding a broker adapter.
"""
from .base import (BOARD_FLAGS, INTERVALS, LATEST_KEYS, MARKET_CLOSE, VN_INDEX_SYMBOLS,
                   VN_PREFIX, VN_TZ, YEAR_KEYS, Bar, BoardEntry, Financials,
                   GlobalMarketProvider, MarketDataProvider, Priority, ProviderRateLimited,
                   UniverseEntry, drop_partial_bar, price_unit, trading_days_ending,
                   vn_symbol)
from .registry import get_global_provider, get_provider

__all__ = [
    "BOARD_FLAGS", "INTERVALS", "LATEST_KEYS", "MARKET_CLOSE", "VN_INDEX_SYMBOLS",
    "VN_PREFIX", "VN_TZ", "YEAR_KEYS", "Bar", "BoardEntry", "Financials",
    "GlobalMarketProvider", "MarketDataProvider", "Priority", "ProviderRateLimited",
    "UniverseEntry", "drop_partial_bar", "price_unit", "trading_days_ending", "vn_symbol",
    "get_global_provider", "get_provider",
]

"""Provider selection. Routing rule (unchanged from before the seam): a
"VN:<symbol>" ticker goes to the VN exchange provider (``base.vn_symbol``),
everything else to the global (Yahoo) provider."""
from __future__ import annotations

from .base import GlobalMarketProvider, MarketDataProvider


def get_provider() -> MarketDataProvider:
    """The VN exchange provider, picked by settings.screener_provider."""
    from ..config import get_settings
    name = get_settings().screener_provider
    if name == "fixture":
        from .fixture import FixtureProvider
        return FixtureProvider()
    if name == "vnstock":
        from .vnstock_provider import VnstockProvider
        return VnstockProvider()
    raise ValueError(f"unknown screener_provider: {name!r}")


def get_global_provider() -> GlobalMarketProvider:
    """US stocks, indices, gold/oil futures, FX pairs. Imported lazily so code
    that only needs VN data never loads yfinance."""
    from .yfinance_provider import YFinanceProvider
    return YFinanceProvider()

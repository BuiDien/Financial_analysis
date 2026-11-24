"""Fundamentals — statements + ratios from the global (Yahoo) provider."""
from ..marketdata import get_global_provider


def get_statements(ticker: str, period: str = "annual") -> dict:
    return get_global_provider().statements(ticker, period=period)


def get_ratios(ticker: str) -> dict:
    return get_global_provider().ratios(ticker)

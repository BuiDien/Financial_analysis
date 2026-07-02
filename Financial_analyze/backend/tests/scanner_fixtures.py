"""Deterministic stock-dict fixtures matching the Task 0 spike shape."""


def good_stock():
    return {
        "symbol": "VNM", "market": "HOSE", "verified": False,
        "roe": 0.20, "roa": 0.12, "gross_margin": 0.42, "net_margin": 0.16,
        "revenue_growth": 0.10, "profit_growth": 0.12,
        "pe": 12.0, "pb": 2.0, "sector_pe": 18.0,
        "price": 66000, "sma50": 62000, "sma200": 60000, "rsi": 58, "vol_ratio": 1.3,
        "news_count": 0, "news_sentiment": 0.0,
    }


def weak_stock():
    return {
        "symbol": "XYZ", "market": "HNX", "verified": False,
        "roe": 0.02, "roa": 0.01, "gross_margin": 0.08, "net_margin": 0.01,
        "revenue_growth": -0.05, "profit_growth": -0.10,
        "pe": 40.0, "pb": 6.0, "sector_pe": 18.0,
        "price": 9000, "sma50": 10000, "sma200": 11000, "rsi": 38, "vol_ratio": 0.6,
        "news_count": 0, "news_sentiment": 0.0,
    }

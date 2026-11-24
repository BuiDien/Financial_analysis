"""Unreported statement lines must not become real zeros."""
import pandas as pd

from app.marketdata.yfinance_provider import _to_records


def test_nan_becomes_none_not_zero():
    df = pd.DataFrame({pd.Timestamp("2024-12-31"): [100.0, float("nan"), 0.0],
                       pd.Timestamp("2023-12-31"): [90.0, 5.0, None]},
                      index=["Revenue", "Goodwill", "Zero Line"])
    recs = {r["label"]: r["values"] for r in _to_records(df)}
    assert recs["Revenue"] == {"2024": 100.0, "2023": 90.0}
    assert recs["Goodwill"] == {"2024": None, "2023": 5.0}
    assert recs["Zero Line"] == {"2024": 0.0, "2023": None}


def test_empty_frame():
    assert _to_records(pd.DataFrame()) == [] and _to_records(None) == []

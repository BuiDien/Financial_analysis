from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import market


@pytest.fixture
def client():
    return TestClient(app)


def fake_bars(n=600, start="2020-01-01", step=0.1):
    d0 = datetime.fromisoformat(start).date()
    out = []
    for i in range(n):
        p = 10 + i * step
        out.append({"date": (d0 + timedelta(days=i)).isoformat(), "open": p, "high": p + 0.5,
                    "low": p - 0.5, "close": p + 0.1, "volume": 1000})
    return out


def patch_loader(monkeypatch, bars=None, calls=None):
    bars = bars if bars is not None else fake_bars()

    def fake(ticker, start, end):
        if calls is not None:
            calls.append((ticker, start, end))
        return bars

    monkeypatch.setattr("app.backtest.data.load_daily_bars", fake)


def body(**kw):
    b = {"ticker": "vn:vnm", "strategy": "sma_cross", "start": "2021-06-01", "end": "2021-08-01"}
    b.update(kw)
    return b


def test_strategies_endpoint(client):
    r = client.get("/api/backtest/strategies")
    assert r.status_code == 200
    assert [s["id"] for s in r.json()] == ["buy_hold", "sma_cross", "rsi_reversion", "breakout"]


def test_run_vn_defaults(client, monkeypatch):
    patch_loader(monkeypatch)
    r = client.post("/api/backtest/run", json=body())
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["ticker"] == "VN:VNM" and j["currency"] == "VND"
    s = j["settings"]
    assert s["lot_size"] == 100 and s["price_scale"] == 1000
    assert s["fee_pct"] == 0.15 and s["sell_tax_pct"] == 0.1
    assert s["initial_capital"] == 100000000 and s["min_hold_bars"] == 3
    assert len(j["equity"]) == len(j["bars"]) == len(j["benchmark_equity"])
    assert j["bars"][0]["date"] >= "2021-06-01"
    assert j["strategy"]["id"] == "sma_cross"
    assert "metrics" in j and "benchmark_metrics" in j


def test_run_us_defaults(client, monkeypatch):
    patch_loader(monkeypatch)
    r = client.post("/api/backtest/run", json=body(ticker="AAPL"))
    assert r.status_code == 200, r.text
    j = r.json()
    s = j["settings"]
    assert j["currency"] == "USD" and s["lot_size"] == 1 and s["fee_pct"] == 0
    assert s["initial_capital"] == 10000 and s["min_hold_bars"] == 0 and s["price_scale"] == 1


def test_run_uses_warmup_bars_before_start(client, monkeypatch):
    calls = []
    patch_loader(monkeypatch, calls=calls)
    r = client.post("/api/backtest/run",
                    json=body(ticker="AAPL", params={"fast": 2, "slow": 5}))
    assert r.status_code == 200, r.text
    assert calls[0][1] == date(2021, 6, 1) - timedelta(days=650)
    assert calls[0][2] == date(2021, 8, 1)
    j = r.json()
    assert j["trades"][0]["entry_date"] == j["bars"][1]["date"]


def test_run_unknown_strategy_400(client, monkeypatch):
    patch_loader(monkeypatch)
    assert client.post("/api/backtest/run", json=body(strategy="nope")).status_code == 400


def test_run_bad_params_400(client, monkeypatch):
    patch_loader(monkeypatch)
    r = client.post("/api/backtest/run", json=body(params={"fast": 60, "slow": 50}))
    assert r.status_code == 400


def test_run_start_after_end_400(client):
    r = client.post("/api/backtest/run", json=body(start="2021-08-01", end="2021-06-01"))
    assert r.status_code == 400


def test_run_unknown_ticker_404(client, monkeypatch):
    def boom(*a, **k):
        raise ValueError("empty")
    monkeypatch.setattr("app.backtest.data.load_daily_bars", boom)
    r = client.post("/api/backtest/run", json=body())
    assert r.status_code == 404 and "No price data" in r.json()["detail"]


def test_run_rate_limited_503(client, monkeypatch):
    def boom(*a, **k):
        raise market.VnRateLimited("x")
    monkeypatch.setattr("app.backtest.data.load_daily_bars", boom)
    assert client.post("/api/backtest/run", json=body()).status_code == 503


def test_run_generic_loader_error_502(client, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("x")
    monkeypatch.setattr("app.backtest.data.load_daily_bars", boom)
    assert client.post("/api/backtest/run", json=body()).status_code == 502


def test_run_too_few_bars_400(client, monkeypatch):
    patch_loader(monkeypatch, bars=fake_bars(n=10, start="2021-05-25"))
    r = client.post("/api/backtest/run", json=body(start="2021-06-03"))
    assert r.status_code == 400


def test_run_vn_index_uses_unit_scale_and_lot(client, monkeypatch):
    patch_loader(monkeypatch)
    r = client.post("/api/backtest/run", json=body(ticker="VN:VNINDEX", strategy="buy_hold"))
    assert r.status_code == 200, r.text
    s = r.json()["settings"]
    assert s["price_scale"] == 1 and s["lot_size"] == 1
    assert s["fee_pct"] == 0.15 and s["min_hold_bars"] == 3
    assert len(r.json()["trades"]) == 1


def test_run_reports_skipped_buys(client, monkeypatch):
    patch_loader(monkeypatch)
    r = client.post("/api/backtest/run", json=body(strategy="buy_hold", initial_capital=1000))
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["trades"] == [] and j["skipped_buys"] > 0

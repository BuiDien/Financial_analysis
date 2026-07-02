from app.scanner import universe as u


def test_map_row_produces_canonical_stock():
    raw = {  # vnstock 4.x VCI field names (Task 0 spike) — mapper normalizes them
        "symbol": "VNM", "exchange": "HOSE",
        "roe": 0.20, "roa": 0.12, "gross_margin": 0.42, "after_tax_profit_margin": 0.16,
        "pe": 12.0, "pb": 2.0,
    }
    out = u.map_row(raw)
    assert out["symbol"] == "VNM"
    assert out["market"] == "HOSE"
    assert out["verified"] is False
    assert out["roe"] == 0.20 and out["pe"] == 12.0
    assert out["net_margin"] == 0.16
    # unavailable v1 fields present but None / zeroed
    assert out["revenue_growth"] is None
    assert out["news_count"] == 0 and out["news_sentiment"] == 0.0


def test_map_row_never_copies_verdict_fields():
    out = u.map_row({"symbol": "X", "exchange": "HNX", "tcbs_buy_sell_signal": "BUY",
                     "rsi14_status": "overbought"})
    assert "tcbs_buy_sell_signal" not in out
    assert "rsi14_status" not in out


def test_sma():
    assert u.sma([1, 2, 3, 4], 2) == 3.5
    assert u.sma([1, 2], 5) is None


def test_rsi_direction():
    rising = list(range(1, 40))
    falling = list(range(40, 1, -1))
    assert u.rsi([float(x) for x in rising]) > 65
    assert u.rsi([float(x) for x in falling]) < 35
    assert u.rsi([1.0, 2.0]) is None  # too short


def test_volume_ratio():
    vols = [100.0] * 20 + [200.0]
    r = u.volume_ratio(vols)
    assert 1.8 < r <= 2.1
    assert u.volume_ratio([100.0]) is None


def test_ebitda_yoy():
    rows = [
        {"year": 2024, "quarter": 4, "ebitda": 100.0},
        {"year": 2025, "quarter": 4, "ebitda": 110.0},
    ]
    assert abs(u.ebitda_yoy(rows) - 0.10) < 1e-9
    assert u.ebitda_yoy([{"year": 2025, "quarter": 4, "ebitda": 110.0}]) is None


def test_attach_sector_pe_uses_industry_median():
    stocks = [
        {"symbol": "A", "pe": 10.0}, {"symbol": "B", "pe": 20.0}, {"symbol": "C", "pe": 30.0},
        {"symbol": "D", "pe": 8.0},
    ]
    industry = {"A": "food", "B": "food", "C": "food", "D": "food"}
    u.attach_sector_pe(stocks, industry, min_industry_size=3)
    assert stocks[0]["sector_pe"] == 15.0  # median of [8,10,20,30]

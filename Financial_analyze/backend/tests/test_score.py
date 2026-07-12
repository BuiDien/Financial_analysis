from app.scanner import score as sc


def test_weighted_total():
    signals = {"fundamentals": 80, "valuation": 60, "technical": 40, "catalysts": 0}
    out = sc.score_stock(signals)
    # 80*.4 + 60*.3 + 40*.3 + 0 = 32 + 18 + 12 = 62
    assert out["total_score"] == 62.0


def test_lean_long_when_fundamentals_valuation_dominate():
    out = sc.score_stock({"fundamentals": 80, "valuation": 80, "technical": 30, "catalysts": 0})
    assert out["lean"] == "long_term"


def test_lean_short_term_when_bullish_technicals_dominate():
    out = sc.score_stock({"fundamentals": 50, "valuation": 45, "technical": 95, "catalysts": 0})
    assert out["lean"] == "short_term"


def test_lean_avoid_when_total_below_40():
    out = sc.score_stock({"fundamentals": 20, "valuation": 20, "technical": 20, "catalysts": 0})
    assert out["lean"] == "avoid"


def test_rank_orders_desc_and_sets_rank():
    results = [
        {"symbol": "A", "total_score": 50.0},
        {"symbol": "B", "total_score": 80.0},
        {"symbol": "C", "total_score": 65.0},
    ]
    ranked = sc.rank(results)
    assert [r["symbol"] for r in ranked] == ["B", "C", "A"]
    assert [r["rank"] for r in ranked] == [1, 2, 3]

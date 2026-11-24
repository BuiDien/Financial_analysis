import json
from decimal import Decimal

from app.models.portfolio import Portfolio, PositionProjection
from app.newswatch.holdings import current_vn_holdings
from app.newswatch.watch_config import load_watch_config


def _pos(pid, ticker, qty, cur):
    return PositionProjection(
        portfolio_id=pid, ticker=ticker, currency=cur, quantity=Decimal(qty),
        cost_basis_native=Decimal(0), cost_basis_display=Decimal(0), revision=1,
    )


def test_current_vn_holdings_filters_zero_foreign_and_etf(db):
    p1, p2 = Portfolio(name="A"), Portfolio(name="B")
    db.add_all([p1, p2])
    db.flush()
    db.add_all([
        _pos(p1.id, "HPG", 100, "VND"),
        _pos(p1.id, "MBB", 0, "VND"),
        _pos(p1.id, "AAPL", 5, "USD"),
        _pos(p1.id, "E1VFVN30", 50, "VND"),
        _pos(p2.id, "FPT", 10, "VND"),
        _pos(p2.id, "HPG", 1, "VND"),
    ])
    db.commit()
    assert current_vn_holdings(db, ["E1VFVN30"]) == ["FPT", "HPG"]


def test_load_watch_config_defaults_missing_keys(tmp_path):
    f = tmp_path / "nw.json"
    f.write_text(json.dumps({"aliases": {"hpg": ["Hòa Phát"]}}), encoding="utf-8")
    cfg = load_watch_config(str(f))
    assert cfg["etf_tickers"] == []
    assert cfg["aliases"] == {"HPG": ["Hòa Phát"]}
    assert cfg["topics"] == {}

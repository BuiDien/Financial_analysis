"""Bonus shares / stock dividends spread the existing cost basis (FIFO)."""
from datetime import datetime, timezone

import pytest

from app.models.portfolio import (
    Portfolio, PortfolioTransaction, PositionProjection, ProjectionSummary,
)
from app.services import portfolio_engine as engine


@pytest.fixture
def ledger(db, monkeypatch):
    monkeypatch.setattr(engine.market, "get_history", lambda *a, **k: [])
    p = Portfolio(name="Main", display_currency="VND")
    db.add(p)
    db.flush()

    def tx(day, kind, qty, price, source="ssi_email", **kw):
        db.add(PortfolioTransaction(portfolio_id=p.id, type=kind, ticker="SSI", quantity=qty,
                                    unit_price=price, currency="VND", source=source,
                                    effective_at=datetime(2026, 1, day, 8, tzinfo=timezone.utc), **kw))
        db.commit()
    return p, tx


def test_bonus_rescales_lot_instead_of_zero_cost_lot(db, ledger):
    p, tx = ledger
    tx(1, "BUY", 1000, 30_000)
    tx(2, "BUY", 200, 0, source="ssi_corporate")  # 5:1 bonus
    tx(3, "SELL", 1000, 26_000)

    out = engine.realized_fifo(db, p)
    sale = out["sales"][0]
    assert sale["cost"] == pytest.approx(25_000_000)
    assert sale["gain"] == pytest.approx(1_000_000)
    assert sale["lots"][0]["unit_cost"] == pytest.approx(25_000)

    engine.rebuild(db, p.id)
    assert float(db.get(ProjectionSummary, p.id).realized_gain) == pytest.approx(1_000_000)
    pos = db.query(PositionProjection).filter_by(portfolio_id=p.id).one()
    assert float(pos.quantity) == 200 and float(pos.cost_basis_native) == pytest.approx(5_000_000)

    t = engine.ticker_breakdown(db, p)["tickers"][0]
    assert t["realized_fifo"] == pytest.approx(1_000_000)
    assert t["open_cost"] == pytest.approx(5_000_000)
    assert t["shares_received"] == 200


def test_bonus_spreads_over_every_open_lot(db, ledger):
    p, tx = ledger
    tx(1, "BUY", 1000, 30_000)   # 30M
    tx(2, "BUY", 500, 20_000)    # 10M
    tx(3, "BUY", 300, 0, source="ssi_corporate")  # 100:20
    tx(4, "SELL", 1200, 30_000)  # exactly the first (scaled) lot
    sale = engine.realized_fifo(db, p)["sales"][0]
    assert sale["cost"] == pytest.approx(30_000_000)
    assert sale["gain"] == pytest.approx(6_000_000)
    engine.rebuild(db, p.id)
    pos = db.query(PositionProjection).filter_by(portfolio_id=p.id).one()
    assert float(pos.quantity) == 600 and float(pos.cost_basis_native) == pytest.approx(10_000_000)


def test_bonus_without_open_lots_stays_zero_cost(db, ledger):
    p, tx = ledger
    tx(1, "BUY", 100, 0, source="ssi_corporate")
    tx(2, "SELL", 100, 10_000)
    assert engine.realized_fifo(db, p)["sales"][0]["gain"] == pytest.approx(1_000_000)


def test_rights_shares_remain_a_paid_lot(db, ledger):
    p, tx = ledger
    tx(1, "BUY", 1000, 30_000)
    tx(2, "BUY", 100, 15_000, source="ssi_corporate")  # rights, paid
    tx(3, "SELL", 1000, 30_000)
    assert engine.realized_fifo(db, p)["sales"][0]["gain"] == pytest.approx(0)


def test_bonus_split_keeps_exact_share_total(db, ledger):
    p, tx = ledger
    for day in (1, 2, 3):
        tx(day, "BUY", 1, 10_000)
    tx(4, "BUY", 1, 0, source="ssi_corporate")  # 3:1 -> 4/3 per lot
    tx(5, "SELL", 4, 10_000)  # must not raise a phantom oversell
    sale = engine.realized_fifo(db, p)["sales"][0]
    assert sale["cost"] == pytest.approx(30_000) and sale["gain"] == pytest.approx(10_000)
    engine.rebuild(db, p.id)
    assert db.query(PositionProjection).filter_by(portfolio_id=p.id).count() == 0

"""rebuild_snapshots / TWR: gaps in price data, multiple flows, non-positive value."""
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal

import pytest

from app.models.portfolio import DailyPortfolioSnapshot, Portfolio, PortfolioTransaction
from app.services import portfolio_engine as engine

VN = timezone(timedelta(hours=7))
TODAY = date.today()


def _at(day: date, hour=10) -> datetime:
    return datetime.combine(day, time(hour), tzinfo=VN).astimezone(timezone.utc)


@pytest.fixture
def setup(db, monkeypatch):
    p = Portfolio(name="Main", display_currency="VND")
    db.add(p)
    db.commit()
    series: dict[date, float] = {}

    def history(symbol, period="1mo", interval="1d", **kw):
        # VN tickers come back in nghìn đồng
        return [{"date": d.isoformat(), "close": v} for d, v in sorted(series.items())]

    monkeypatch.setattr(engine.market, "get_history", history)

    def tx(day, kind, **kw):
        db.add(PortfolioTransaction(portfolio_id=p.id, type=kind, currency="VND",
                                    effective_at=_at(day, kw.pop("hour", 10)), **kw))
        db.commit()

    return p, series, tx


def _snaps(db, p):
    return {s.date: s for s in db.query(DailyPortfolioSnapshot).filter_by(portfolio_id=p.id)}


def test_flows_during_price_gap_are_not_counted_as_return(db, setup):
    p, series, tx = setup
    d0 = TODAY - timedelta(days=40)
    tx(d0, "DEPOSIT", cash_amount=Decimal(100_000_000))
    tx(d0 + timedelta(days=1), "BUY", ticker="ABC", quantity=1000, unit_price=100_000)
    tx(d0 + timedelta(days=30), "DEPOSIT", cash_amount=Decimal(400_000_000))
    # price history only starts on day 35 and is flat at the buy price
    for k in range(35, 41):
        series[d0 + timedelta(days=k)] = 100  # x1000 = 100,000 đ
    engine.rebuild_snapshots(db, p)
    snaps = _snaps(db, p)
    first_after_gap = snaps[d0 + timedelta(days=35)]
    assert float(first_after_gap.value) == pytest.approx(500_000_000)
    assert float(first_after_gap.net_flow) == pytest.approx(400_000_000)
    assert float(snaps[TODAY].twr) == pytest.approx(0, abs=1e-9)


def test_multiple_flows_with_price_moves(db, setup):
    p, series, tx = setup
    d0 = TODAY - timedelta(days=5)
    tx(d0, "DEPOSIT", cash_amount=Decimal(100_000_000), hour=9)
    tx(d0, "BUY", ticker="ABC", quantity=1000, unit_price=100_000)
    tx(d0 + timedelta(days=2), "DEPOSIT", cash_amount=Decimal(50_000_000))
    tx(d0 + timedelta(days=3), "WITHDRAWAL", cash_amount=Decimal(20_000_000))
    for k, px in enumerate([100, 110, 110, 121, 121, 121]):
        series[d0 + timedelta(days=k)] = px
    engine.rebuild_snapshots(db, p)
    snaps = _snaps(db, p)
    assert float(snaps[d0 + timedelta(days=1)].twr) == pytest.approx(10)
    assert float(snaps[d0 + timedelta(days=2)].twr) == pytest.approx(10)
    # 110M stock + 50M cash -> +11M on 160M, then 20M withdrawn
    expected = (1.10 * (1 + 11 / 160) - 1) * 100
    assert float(snaps[d0 + timedelta(days=3)].twr) == pytest.approx(expected)
    assert float(snaps[TODAY].twr) == pytest.approx(expected)


def test_non_positive_previous_value_does_not_flip_sign(db, setup):
    p, series, tx = setup
    d0 = TODAY - timedelta(days=3)
    # bought on margin: cash -10M, shares marked below cost -> negative equity
    tx(d0, "BUY", ticker="ABC", quantity=100, unit_price=100_000)
    for k, px in enumerate([90, 99, 110, 121]):
        series[d0 + timedelta(days=k)] = px
    engine.rebuild_snapshots(db, p)
    snaps = _snaps(db, p)
    assert float(snaps[d0].value) == pytest.approx(-1_000_000)
    # previous value <= 0: no return is chained (it would come out -90%)
    assert float(snaps[d0 + timedelta(days=1)].twr) == pytest.approx(0)
    assert float(snaps[d0 + timedelta(days=2)].twr) == pytest.approx(0)
    # 1.0M -> 2.1M
    assert float(snaps[d0 + timedelta(days=3)].twr) == pytest.approx(110)


def test_snapshot_day_is_vietnam_local(db, setup):
    p, series, tx = setup
    d0 = TODAY - timedelta(days=2)
    # 06:30 in Hanoi is 23:30 UTC the previous day
    tx(d0, "DEPOSIT", cash_amount=Decimal(1_000_000), hour=6)
    engine.rebuild_snapshots(db, p)
    snaps = _snaps(db, p)
    assert min(snaps) == d0

from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from app.screener import store
from app.screener.metrics import compute_price_metrics
from app.marketdata import trading_days_ending
from app.marketdata.fixture import SAMPLE_UNIVERSE, FixtureProvider

VN = ZoneInfo("Asia/Ho_Chi_Minh")
NOW = datetime(2026, 11, 10, 20, 0, tzinfo=VN)


def _entry(**kw):
    e = {"symbol": "AAA", "exchange": "HOSE", "industry": None, "is_bank": False}
    e.update(kw)
    return e


def _bars(last_date, n=30):
    return [{"date": d, "close": 10.0 + i * 0.1, "volume": 1000.0}
            for i, d in enumerate(trading_days_ending(date.fromisoformat(last_date), n))]


def test_upsert_universe_updates_industry(db):
    store.upsert_universe(db, [_entry()])
    store.upsert_universe(db, [_entry(industry="Steel", exchange="HNX")])
    v = store.load_views(db, NOW)
    assert len(v) == 1 and v[0]["industry"] == "Steel" and v[0]["exchange"] == "HNX"


def test_save_prices_stores_metrics(db):
    store.upsert_universe(db, [_entry()])
    bars = _bars("2026-11-10")
    store.save_prices(db, "AAA", bars, NOW)
    v = store.load_views(db, NOW)[0]
    assert v["prices"] == compute_price_metrics(bars)
    assert v["prices_stale"] is False and v["financials"] is None


def test_load_views_marks_stale_prices(db):
    store.upsert_universe(db, [_entry()])
    store.save_prices(db, "AAA", _bars("2026-11-03"), NOW)
    assert store.load_views(db, NOW)[0]["prices_stale"] is True
    store.save_prices(db, "AAA", _bars("2026-11-07"), NOW)
    assert store.load_views(db, NOW)[0]["prices_stale"] is False


def test_save_financials_and_error(db):
    fin = {"latest": {"pe": 10.0}, "years": {"2025": {"roe": 0.2}}}
    store.save_error(db, "ZZZ", "boom")
    store.save_financials(db, "ZZZ", fin, NOW)
    v = store.load_views(db, NOW)[0]
    assert v["financials"] == fin


def test_fixture_provider_fail_set():
    p = FixtureProvider(fail={"BANKCO"})
    entry = next(e for e in SAMPLE_UNIVERSE if e["symbol"] == "BANKCO")
    with pytest.raises(RuntimeError):
        p.fetch_financials(entry)
    with pytest.raises(RuntimeError):
        p.fetch_prices("BANKCO")
    assert p.fetch_prices("GOODCO")
    assert ("prices", "BANKCO") in p.calls


def test_fixture_sample_roles():
    p = FixtureProvider(end_date=date(2026, 11, 10))
    m = {s: compute_price_metrics(p.fetch_prices(s)) for s in
         ("GOODCO", "DIPCO")}
    d = m["DIPCO"]
    assert d["rsi14"] < 30 and d["closes_tail"][-1] <= 0.9 * d["closes_tail"][-6]
    assert d["vol_multiple"] >= 1.5
    assert m["GOODCO"]["rsi14"] >= 30
    assert len(p.fetch_financials(SAMPLE_UNIVERSE[0])["years"]) >= 4


def test_state_roundtrip(db):
    assert store.get_state(db, "k", "dflt") == "dflt"
    store.set_state(db, "k", {"a": 1})
    store.set_state(db, "k", {"a": 2})
    assert store.get_state(db, "k") == {"a": 2}


def test_load_views_marks_dead_prices_after_ten_trading_days(db):
    store.upsert_universe(db, [_entry()])
    store.save_prices(db, "AAA", _bars("2026-10-27"), NOW)  # 10 trading days before 11-10
    assert store.load_views(db, NOW)[0]["prices_dead"] is False
    store.save_prices(db, "AAA", _bars("2026-10-26"), NOW)  # 11
    assert store.load_views(db, NOW)[0]["prices_dead"] is True


def test_save_board_and_view(db):
    store.upsert_universe(db, [_entry(), _entry(symbol="BBB")])
    store.save_board(db, {"AAA": {"flag": "warning", "status": "s", "foreign_room": 0.2},
                          "ZZZ": {"flag": None, "status": None, "foreign_room": None}}, NOW)
    v = {x["symbol"]: x for x in store.load_views(db, NOW)}
    assert v["AAA"]["board"]["flag"] == "warning"
    assert v["AAA"]["board"]["foreign_room"] == 0.2
    assert v["AAA"]["board"]["as_of"].startswith("2026-11-10")
    assert v["BBB"]["board"] is None
    assert "ZZZ" not in v  # unknown symbols are not created


def test_upgrade_adds_board_column(tmp_path, monkeypatch):
    from sqlalchemy import create_engine, inspect, text
    from app import db as dbmod
    eng = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with eng.begin() as c:
        c.execute(text("CREATE TABLE ticker_metrics (symbol VARCHAR PRIMARY KEY, exchange VARCHAR)"))
    monkeypatch.setattr(dbmod, "engine", eng)
    dbmod._upgrade_screener_schema()
    dbmod._upgrade_screener_schema()  # idempotent
    assert "board" in {c["name"] for c in inspect(eng).get_columns("ticker_metrics")}

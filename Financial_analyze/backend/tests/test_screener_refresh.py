from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base
from app.models.screener import TickerMetrics
from app.screener import store
from app.marketdata import VN_TZ
from app.marketdata.fixture import FixtureProvider
from app.marketdata.ratelimit import RateLimited
from app.screener.refresh import RefreshManager, is_stale, last_trading_close

NOW = datetime(2026, 11, 10, 16, 0, tzinfo=VN_TZ)  # Tuesday after close


def vn(y, m, d, h, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=VN_TZ)


@pytest.fixture
def factory():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


def make(factory, provider=None, now=NOW):
    prov = provider or FixtureProvider()
    mgr = RefreshManager(factory, lambda: prov, lambda: now)
    return mgr, prov


def test_last_trading_close():
    assert last_trading_close(vn(2026, 11, 10, 14, 59)) == vn(2026, 11, 9, 15)
    assert last_trading_close(vn(2026, 11, 10, 15, 0)) == vn(2026, 11, 10, 15)
    assert last_trading_close(vn(2026, 11, 8, 12)) == vn(2026, 11, 6, 15)
    assert last_trading_close(vn(2026, 11, 9, 9)) == vn(2026, 11, 6, 15)


def test_is_stale():
    assert is_stale(None, NOW)
    assert is_stale(vn(2026, 11, 10, 14, 0), NOW)
    assert not is_stale(vn(2026, 11, 10, 15, 30), NOW)


def test_check_queues_prices_before_financials(factory):
    mgr, _ = make(factory)
    assert mgr.check_and_queue() == ["prices", "financials"]
    assert mgr.status()["queued"] == ["prices", "financials"]


def test_check_skips_fresh(factory):
    mgr, _ = make(factory)
    with factory() as db:
        store.set_state(db, "prices_as_of", NOW.isoformat())
        store.set_state(db, "financials_as_of", (NOW - timedelta(days=2)).isoformat())
    assert mgr.check_and_queue() == []


def test_prices_priority_order(factory):
    with factory() as db:
        store.set_state(db, "last_pass_symbols", ["ZZZ"])
    prov2 = FixtureProvider(prices={"ZZZ": []})
    mgr, prov = make(factory, prov2)
    with factory() as db:
        store.upsert_universe(db, [{"symbol": "ZZZ", "exchange": "HOSE", "industry": None, "is_bank": False},
                                   {"symbol": "AAA", "exchange": "HOSE", "industry": None, "is_bank": False}])
    mgr.request("prices")
    mgr.run_pending()
    fetched = [s for k, s in prov.calls if k == "prices"]
    assert fetched[0] == "ZZZ"
    assert fetched[1:] == sorted(fetched[1:])


def test_failed_ticker_keeps_old_numbers(factory):
    mgr, _ = make(factory)
    mgr.request("prices")
    mgr.run_pending()
    with factory() as db:
        old = db.get(TickerMetrics, "GOODCO").prices
    prov = FixtureProvider(fail={"GOODCO"})
    mgr2, _ = make(factory, prov, now=NOW + timedelta(days=1))
    mgr2.request("prices")
    mgr2.run_pending()
    with factory() as db:
        row = db.get(TickerMetrics, "GOODCO")
        assert row.prices == old
        assert "fixture failure" in row.last_error
        assert db.get(TickerMetrics, "DIPCO").last_error is None
        assert store.get_state(db, "prices_as_of") is not None


def test_financial_refresh_resumes(factory):
    mgr, prov = make(factory)
    start = NOW - timedelta(hours=1)
    with factory() as db:
        store.upsert_universe(db, prov.list_universe())
        store.set_state(db, "financials_run_started", start.isoformat())
        for sym in ("BANKCO", "DIPCO"):
            store.save_financials(db, sym, prov.financials[sym], start + timedelta(minutes=5))
    prov.calls.clear()
    mgr.request("financials")
    mgr.run_pending()
    fetched = {s for k, s in prov.calls if k == "financials"}
    assert fetched == {"GOODCO", "WEAKCO", "LOSSCO", "NOFINCO"}
    with factory() as db:
        assert store.get_state(db, "financials_run_started") is None


def test_completion_sets_as_of_and_clears_cursor(factory):
    mgr, _ = make(factory)
    mgr.request("prices")
    mgr.run_pending()
    with factory() as db:
        assert store.get_state(db, "prices_as_of") == NOW.isoformat()
        assert store.get_state(db, "prices_run_started") is None
    st = mgr.status()
    assert not st["running"] and st["kind"] is None
    assert st["done"] == st["total"] == 6
    assert st["prices_as_of"] == NOW.isoformat()


def test_whole_run_failure_keeps_cursor(factory):
    class Boom(FixtureProvider):
        def list_universe(self):
            raise RuntimeError("down")
    mgr, _ = make(factory, Boom())
    mgr.request("financials")
    mgr.run_pending()
    with factory() as db:
        assert store.get_state(db, "financials_run_started") is not None
        assert store.get_state(db, "financials_as_of") is None
    assert "down" in mgr.status()["last_error"]


def test_request_rejects_duplicate(factory):
    mgr, _ = make(factory)
    assert mgr.request("prices") is True
    assert mgr.request("prices") is False
    assert mgr.request("financials") is True


def test_stale_price_cursor_discarded(factory):
    mon = vn(2026, 11, 9, 20)
    tue = vn(2026, 11, 10, 20)
    mgr, prov = make(factory, now=mon + timedelta(minutes=5))
    with factory() as db:
        store.upsert_universe(db, prov.list_universe())
        store.set_state(db, "prices_run_started", mon.isoformat())
        for sym in ("GOODCO", "DIPCO"):
            store.save_prices(db, sym, [{"date": "2026-11-09", "close": 1.0, "volume": 1}],
                              mon + timedelta(minutes=5))
    mgr, prov = make(factory, now=tue)
    mgr.request("prices")
    mgr.run_pending()
    fetched = [s for k, s in prov.calls if k == "prices"]
    assert "GOODCO" in fetched and "DIPCO" in fetched and len(fetched) == 6
    with factory() as db:
        assert store.get_state(db, "prices_as_of") == tue.isoformat()


def test_rate_limited_aborts_run(factory):
    class Limited(FixtureProvider):
        def fetch_prices(self, symbol, days=120):
            if symbol == "DIPCO":
                raise RateLimited("cooldown")
            return super().fetch_prices(symbol, days)
    mgr, _ = make(factory, Limited())
    mgr.request("prices")
    mgr.run_pending()
    with factory() as db:
        assert store.get_state(db, "prices_run_started") is not None
        assert store.get_state(db, "prices_as_of") is None
        assert db.get(TickerMetrics, "DIPCO").last_error is None
    assert "cooldown" in mgr.status()["last_error"]


def test_success_clears_last_error(factory):
    mgr, _ = make(factory, FixtureProvider(fail={"GOODCO"}))
    mgr._last_error = "old"
    mgr.request("prices")
    mgr.run_pending()
    assert mgr.status()["last_error"] is None


def test_loop_tick_survives_system_exit(factory):
    class Exiting(FixtureProvider):
        def list_universe(self):
            raise SystemExit("vnai quota guard")

    mgr, _ = make(factory, Exiting())
    mgr.tick()  # must not raise
    st = mgr.status()
    assert "SystemExit" in st["last_error"] and "vnai quota guard" in st["last_error"]
    assert st["running"] is False


def test_loop_tick_lets_keyboard_interrupt_through(factory):
    class Interrupting(FixtureProvider):
        def list_universe(self):
            raise KeyboardInterrupt

    mgr, _ = make(factory, Interrupting())
    with pytest.raises(KeyboardInterrupt):
        mgr.tick()


def test_empty_price_bars_keep_old_numbers(factory):
    mgr, _ = make(factory)
    mgr.request("prices")
    mgr.run_pending()
    with factory() as db:
        old = db.get(TickerMetrics, "GOODCO").prices
    assert old is not None
    prov = FixtureProvider(prices={"GOODCO": []})
    mgr2, _ = make(factory, prov, now=NOW + timedelta(days=1))
    mgr2.request("prices")
    mgr2.run_pending()
    with factory() as db:
        row = db.get(TickerMetrics, "GOODCO")
        assert row.prices == old
        assert row.last_error and "no price" in row.last_error


def test_rate_limited_requeues_kind_at_front_and_stops(factory):
    class Limited(FixtureProvider):
        def fetch_financials(self, entry):
            raise RateLimited("cooldown")
    mgr, prov = make(factory, Limited())
    mgr.request("financials")
    mgr.request("prices")
    mgr.run_pending()
    st = mgr.status()
    assert st["queued"] == ["financials", "prices"]
    assert not st["running"]
    assert not [c for c in prov.calls if c[0] == "prices"]


def test_financials_completed_at_drives_age_check(factory):
    started = NOW - timedelta(days=9)
    mgr, _ = make(factory, now=NOW)
    with factory() as db:
        store.set_state(db, "prices_as_of", NOW.isoformat())
        store.set_state(db, "financials_run_started", started.isoformat())
    mgr.request("financials")
    mgr.run_pending()
    with factory() as db:
        assert store.get_state(db, "financials_as_of") == started.isoformat()
        assert store.get_state(db, "financials_completed_at") == NOW.isoformat()
    assert mgr.check_and_queue() == []


def test_financials_age_falls_back_to_as_of(factory):
    mgr, _ = make(factory)
    with factory() as db:
        store.set_state(db, "prices_as_of", NOW.isoformat())
        store.set_state(db, "financials_as_of", (NOW - timedelta(days=8)).isoformat())
    assert mgr.check_and_queue() == ["financials"]


def test_financials_most_traded_first(factory):
    mgr, prov = make(factory)
    with factory() as db:
        store.upsert_universe(db, prov.list_universe())
        for sym, val in {"WEAKCO": 200.0, "DIPCO": 50.0, "GOODCO": 10.0}.items():
            db.get(TickerMetrics, sym).prices = {"avg_value_bn": val}
        db.commit()
    mgr.request("financials")
    mgr.run_pending()
    fetched = [s for k, s in prov.calls if k == "financials"]
    assert fetched[:3] == ["WEAKCO", "DIPCO", "GOODCO"]
    rest = fetched[3:]
    assert rest == sorted(rest) and len(rest) == len(prov.list_universe()) - 3


def test_prices_pass_saves_board(factory):
    prov = FixtureProvider(board={"GOODCO": {"flag": "control", "status": "s", "foreign_room": 0.5}})
    mgr, _ = make(factory, prov)
    mgr.request("prices")
    mgr.run_pending()
    with factory() as db:
        assert db.get(TickerMetrics, "GOODCO").board["flag"] == "control"
    assert ("board", "") in prov.calls


def test_board_failure_does_not_stop_prices(factory):
    class Boom(FixtureProvider):
        def fetch_board(self, symbols):
            raise RuntimeError("board down")
    mgr, _ = make(factory, Boom())
    mgr.request("prices")
    mgr.run_pending()
    with factory() as db:
        assert db.get(TickerMetrics, "GOODCO").prices is not None
        assert store.get_state(db, "prices_as_of") is not None


def test_board_rate_limited_aborts(factory):
    class Limited(FixtureProvider):
        def fetch_board(self, symbols):
            raise RateLimited("cool down")
    mgr, _ = make(factory, Limited())
    mgr.request("prices")
    mgr.run_pending()
    assert mgr.status()["queued"] == ["prices"]


# ---- repeated rate-limit aborts on one ticker -------------------------------

def test_two_rate_limit_aborts_on_same_ticker_record_error_and_move_on(factory):
    class Limited(FixtureProvider):
        def fetch_prices(self, symbol, days=120):
            if symbol == "DIPCO":
                raise RateLimited("vnstock rate limit: cooldown")
            return super().fetch_prices(symbol, days)

    mgr, prov = make(factory, Limited())
    mgr.request("prices")
    mgr.run_pending()                      # 1st abort on DIPCO: run stops, requeued
    assert mgr.status()["queued"] == ["prices"]
    with factory() as db:
        assert db.get(TickerMetrics, "DIPCO").last_error is None
    mgr.run_pending()                      # 2nd abort on DIPCO: give up on it, finish
    st = mgr.status()
    assert st["queued"] == [] and st["last_error"] is None
    with factory() as db:
        row = db.get(TickerMetrics, "DIPCO")
        assert "rate-limited" in row.last_error and row.prices is None
        assert store.get_state(db, "prices_as_of") is not None
        assert all(db.get(TickerMetrics, s).prices for s in ("GOODCO", "WEAKCO", "BANKCO"))


def test_rate_limit_strike_resets_after_success(factory):
    hits = {"n": 0}

    class Flaky(FixtureProvider):
        def fetch_prices(self, symbol, days=120):
            if symbol == "DIPCO":
                hits["n"] += 1
                if hits["n"] == 1:
                    raise RateLimited("cooldown")
            return super().fetch_prices(symbol, days)

    mgr, _ = make(factory, Flaky())
    mgr.request("prices")
    mgr.run_pending()
    mgr.run_pending()
    with factory() as db:
        assert db.get(TickerMetrics, "DIPCO").last_error is None
        assert db.get(TickerMetrics, "DIPCO").prices is not None
    assert mgr._strikes == {}


# ---- never store today's still-forming bar ---------------------------------

def test_price_pass_before_close_drops_todays_bar(factory):
    from app.marketdata import trading_days_ending
    morning = vn(2026, 11, 10, 10, 30)   # Tuesday, session open
    days = trading_days_ending(morning.date(), 30)
    bars = [{"date": d, "close": 10_000.0 + i, "volume": 1000.0} for i, d in enumerate(days)]
    mgr, _ = make(factory, FixtureProvider(prices={s: bars for s in
                                                   ("GOODCO", "DIPCO", "WEAKCO", "BANKCO",
                                                    "LOSSCO", "NOFINCO")}), now=morning)
    mgr.request("prices")
    mgr.run_pending()
    with factory() as db:
        assert db.get(TickerMetrics, "GOODCO").prices["last_date"] == "2026-11-09"


def test_module_manager_looks_up_get_provider_at_call_time(monkeypatch):
    """Patching app.marketdata.registry.get_provider must reach the module-level
    manager (it used to bind the function at import time)."""
    from app.marketdata import registry
    from app.screener import refresh

    sentinel = object()
    monkeypatch.setattr(registry, "get_provider", lambda: sentinel)
    assert refresh.manager._provider_factory() is sentinel

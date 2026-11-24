import os
import time
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base, get_db
from app import db as db_module
from app.main import app
from app.models.portfolio import DailyPortfolioSnapshot, Portfolio, PortfolioTransaction
from app.services import portfolio_engine


@pytest.fixture
def portfolio_client(monkeypatch):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)

    def override():
        session = factory()
        try:
            yield session
        finally:
            session.close()

    today = date.today()
    monkeypatch.setattr(
        portfolio_engine.market,
        "get_quote",
        lambda ticker: {
            "ticker": ticker,
            "price": 15,
            "previous_close": 14,
            "change": 1,
            "change_pct": 100 / 14,
            "currency": "USD",
            "ts": 0,
        },
    )
    monkeypatch.setattr(
        portfolio_engine.market,
        "get_history",
        lambda *args, **kwargs: [
            {"date": str(today - timedelta(days=2)), "close": 10},
            {"date": str(today - timedelta(days=1)), "close": 14},
            {"date": str(today), "close": 15},
        ],
    )
    app.dependency_overrides[get_db] = override
    yield TestClient(app)
    app.dependency_overrides.clear()


def add(client, **overrides):
    body = {
        "type": "BUY",
        "effective_at": f"{date.today().isoformat()}T09:30:00Z",
        "ticker": "ABC",
        "quantity": 10,
        "unit_price": 10,
        "currency": "USD",
    }
    body.update(overrides)
    return client.post("/api/portfolio/transactions", json=body)


def test_live_empty_portfolio_is_authoritatively_empty(portfolio_client):
    body = portfolio_client.get("/api/portfolio").json()
    assert body["holdings"] == []
    assert body["total_value"] == 0
    assert body["complete"] is True


def test_ledger_builds_cash_fifo_position_and_real_performance(portfolio_client):
    client = portfolio_client
    assert (
        add(
            client,
            type="DEPOSIT",
            ticker=None,
            quantity=None,
            unit_price=None,
            cash_amount=1000,
        ).status_code
        == 201
    )
    assert add(client).status_code == 201

    # Each manual transaction's rebuild ran on the job runner (/api/jobs).
    jobs = client.get("/api/jobs?kind=portfolio.rebuild").json()["items"]
    assert [j["status"] for j in jobs] == ["done", "done"]
    assert all(j["payload"]["portfolio_job_type"] == "rebuild" for j in jobs)
    portfolio = client.get("/api/portfolio").json()
    assert portfolio["cash_value"] == pytest.approx(900)
    assert portfolio["position_value"] == pytest.approx(150)
    assert portfolio["holdings"][0]["cost_basis"] == pytest.approx(100)
    assert portfolio["holdings"][0]["gain"] == pytest.approx(50)
    assert portfolio["today_change"] == pytest.approx(10)
    statement = client.get("/api/portfolio/statement")
    assert statement.status_code == 200
    assert "Ledger revision" in statement.text

    sold = add(client, type="SELL", quantity=4, unit_price=15)
    assert sold.status_code == 201
    after = client.get("/api/portfolio").json()
    assert after["holdings"][0]["shares"] == pytest.approx(6)
    assert after["realized_gain"] == pytest.approx(20)
    assert client.get("/api/portfolio/performance?range=all").json()["items"]


def test_oversell_is_rejected_without_mutating_ledger(portfolio_client):
    client = portfolio_client
    assert add(client).status_code == 201
    before = client.get("/api/portfolio").json()["ledger_revision"]
    response = add(client, type="SELL", quantity=11, unit_price=15)
    assert response.status_code == 422
    assert client.get("/api/portfolio").json()["ledger_revision"] == before


def test_replace_and_void_preserve_audit_history(portfolio_client):
    client = portfolio_client
    created = add(client).json()["transaction"]
    replacement = {**created, "quantity": 12}
    for key in (
        "id",
        "status",
        "created_at",
        "replaces_transaction_id",
        "currency_assumed",
    ):
        replacement.pop(key, None)
    response = client.patch(
        f"/api/portfolio/transactions/{created['id']}", json=replacement
    )
    assert response.status_code == 200
    new_id = response.json()["transaction"]["id"]
    history = client.get("/api/portfolio/transactions").json()
    assert history["total"] == 2
    assert {row["status"] for row in history["items"]} == {"active", "replaced"}
    assert client.delete(f"/api/portfolio/transactions/{new_id}").status_code == 200
    assert client.get("/api/portfolio").json()["holdings"] == []


def test_csv_mapping_preview_validation_and_atomic_commit(portfolio_client):
    client = portfolio_client
    csv_body = (
        "Action,When,Symbol,Qty,Price,CCY,Ref\n"
        f"DEPOSIT,{date.today().isoformat()}T08:00:00Z,,,,USD,dep-1\n"
    )
    preview = client.post(
        "/api/portfolio/imports/preview",
        files={"file": ("ledger.csv", csv_body, "text/csv")},
    )
    assert preview.status_code == 200
    import_id = preview.json()["import_id"]
    mapping = {
        "Action": "type",
        "When": "effective_at",
        "Symbol": "ticker",
        "Qty": "quantity",
        "Price": "unit_price",
        "CCY": "currency",
        "Ref": "external_id",
    }
    validated = client.post(
        f"/api/portfolio/imports/{import_id}/validate", json={"mapping": mapping}
    )
    assert (
        validated.json()["error_rows"] == 1
    )  # deposit correctly requires a cash amount mapping/value
    commit = client.post(f"/api/portfolio/imports/{import_id}/commit")
    assert commit.status_code == 409
    report = client.get(f"/api/portfolio/imports/{import_id}/errors")
    assert report.status_code == 200
    assert "cash_amount" in report.text
    assert client.get("/api/portfolio/transactions").json()["total"] == 0


def test_csv_import_replays_buys_and_sells_atomically(portfolio_client):
    client = portfolio_client
    today = date.today().isoformat()
    csv_body = (
        "type,effective_at,ticker,quantity,unit_price,cash_amount,currency,external_id\n"
        f"DEPOSIT,{today}T08:00:00Z,,,,1000,USD,dep-1\n"
        f"BUY,{today}T09:00:00Z,ABC,10,10,,USD,buy-1\n"
        f"SELL,{today}T10:00:00Z,ABC,4,15,,USD,sell-1\n"
    )
    preview = client.post(
        "/api/portfolio/imports/preview",
        files={"file": ("ledger.csv", csv_body, "text/csv")},
    ).json()
    mapping = {header: header for header in preview["headers"]}
    validated = client.post(
        f"/api/portfolio/imports/{preview['import_id']}/validate",
        json={"mapping": mapping},
    ).json()
    assert validated["can_commit"] is True
    committed = client.post(f"/api/portfolio/imports/{preview['import_id']}/commit")
    assert committed.status_code == 200
    assert committed.json()["imported"] == 3
    assert client.get("/api/portfolio").json()["holdings"][0]["shares"] == 6


def test_legacy_holdings_are_migrated_idempotently(tmp_path, monkeypatch):
    legacy_engine = create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    with legacy_engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE portfolios (id INTEGER PRIMARY KEY, user_id INTEGER, name VARCHAR, created_at DATETIME)"
            )
        )
        connection.execute(
            text(
                "CREATE TABLE holdings (id INTEGER PRIMARY KEY, portfolio_id INTEGER NOT NULL, ticker VARCHAR NOT NULL, shares FLOAT NOT NULL, cost_basis FLOAT NOT NULL, opened_at DATETIME)"
            )
        )
        connection.execute(text("INSERT INTO portfolios (id, name) VALUES (1, 'Main')"))
        connection.execute(
            text(
                "INSERT INTO holdings (id, portfolio_id, ticker, shares, cost_basis, opened_at) VALUES (7, 1, 'ABC', 10, 100, '2026-01-02 09:30:00')"
            )
        )
    factory = sessionmaker(bind=legacy_engine)
    monkeypatch.setattr(db_module, "engine", legacy_engine)
    monkeypatch.setattr(db_module, "SessionLocal", factory)
    rebuilt = []
    monkeypatch.setattr(
        portfolio_engine,
        "rebuild",
        lambda session, portfolio_id: rebuilt.append(portfolio_id),
    )

    db_module._upgrade_legacy_portfolio_schema()
    Base.metadata.create_all(bind=legacy_engine)
    db_module._migrate_legacy_holdings()
    db_module._migrate_legacy_holdings()

    assert "display_currency" in {
        c["name"] for c in inspect(legacy_engine).get_columns("portfolios")
    }
    session = factory()
    try:
        migrated = session.query(PortfolioTransaction).all()
        assert len(migrated) == 1
        assert migrated[0].currency == "USD"
        assert migrated[0].currency_assumed is True
        assert rebuilt == [1]
    finally:
        session.close()


@pytest.mark.skipif(
    os.getenv("HELIX_RUN_SCALE_TEST") != "1",
    reason="set HELIX_RUN_SCALE_TEST=1 for the 100k-transaction release gate",
)
def test_100k_transaction_projection_and_cached_chart_gate(db):
    portfolio = Portfolio(name="Scale", display_currency="USD", ledger_revision=100_000)
    db.add(portfolio)
    db.commit()
    start = datetime.now(timezone.utc) - timedelta(days=3650)
    rows = []
    for index in range(100_000):
        rows.append(
            PortfolioTransaction(
                portfolio_id=portfolio.id,
                type="DEPOSIT" if index % 2 == 0 else "WITHDRAWAL",
                effective_at=start + timedelta(days=index % 3650, seconds=index),
                cash_amount=100,
                currency="USD",
                fees=0,
                taxes=0,
                source="scale_test",
                external_id=f"scale-{index}",
            )
        )
    db.bulk_save_objects(rows)
    db.commit()
    portfolio_engine.rebuild(db, portfolio.id)

    before = time.perf_counter()
    snapshots = (
        db.query(DailyPortfolioSnapshot)
        .filter_by(portfolio_id=portfolio.id)
        .order_by(DailyPortfolioSnapshot.date.desc())
        .limit(366)
        .all()
    )
    elapsed = time.perf_counter() - before
    assert snapshots
    assert elapsed < 0.5


def test_vnd_holding_is_priced_from_vnstock_in_dong(portfolio_client, monkeypatch):
    """A VND ticker like VCB is a HOSE listing: Yahoo has no data for it, and
    vnstock quotes it in nghìn đồng. The ledger is in đồng, so 53.6 → 53,600."""
    asked = {"quote": [], "history": []}
    today = date.today()

    def fake_quote(ticker):
        asked["quote"].append(ticker)
        if ticker == "USDVND=X":
            return {"ticker": ticker, "price": 25000, "currency": "VND", "ts": 0}
        if ticker != "VN:VCB":
            raise ValueError("Yahoo has no HOSE data")
        return {"ticker": ticker, "price": 53.6, "previous_close": 54.2,
                "change": -0.6, "change_pct": -1.107, "currency": "VND", "ts": 0}

    def fake_history(symbol, **kwargs):
        asked["history"].append(symbol)
        if symbol == "USDVND=X":
            return [{"date": str(today - timedelta(days=1)), "close": 25000},
                    {"date": str(today), "close": 25000}]
        if symbol != "VN:VCB":
            return []
        return [{"date": str(today - timedelta(days=1)), "close": 54.2},
                {"date": str(today), "close": 53.6}]

    monkeypatch.setattr(portfolio_engine.market, "get_quote", fake_quote)
    monkeypatch.setattr(portfolio_engine.market, "get_history", fake_history)

    assert add(portfolio_client, ticker="VCB", quantity=200, unit_price=53600,
               currency="VND").status_code == 201
    body = portfolio_client.get("/api/portfolio").json()
    assert body["holdings"], body
    holding = body["holdings"][0]
    assert "VN:VCB" in asked["quote"]
    assert "VN:VCB" in asked["history"]
    assert holding["price"] == pytest.approx(53600)
    assert holding["value_native"] == pytest.approx(200 * 53600)
    assert not [m for m in body.get("missing", []) if m.get("kind") == "quote"]
    # VCB fell 0.6 nghìn đồng = 600 đồng/share; the second load of the day
    # must still report it (a cached price alone has no day change).
    again = portfolio_client.get("/api/portfolio").json()
    assert again["holdings"][0]["price"] == pytest.approx(53600)
    assert body["today_change"] != 0
    assert again["today_change"] == pytest.approx(body["today_change"])


def test_realized_fifo_uses_oldest_lots_first(db):
    from datetime import datetime, timezone
    from app.models.portfolio import Portfolio, PortfolioTransaction
    from app.services import portfolio_engine as engine

    p = Portfolio(name="Main", display_currency="VND")
    db.add(p); db.flush()
    def tx(day, kind, qty, price, fees=0, taxes=0):
        db.add(PortfolioTransaction(portfolio_id=p.id, type=kind, ticker="NKG", quantity=qty,
                                    unit_price=price, fees=fees, taxes=taxes, currency="VND",
                                    effective_at=datetime(2026, 1, day, 8, tzinfo=timezone.utc)))
    tx(1, "BUY", 100, 10_000, fees=15_000)      # lot A: 1,015,000 -> 10,150/share
    tx(2, "BUY", 100, 20_000)                   # lot B: 2,000,000 -> 20,000/share
    tx(3, "SELL", 150, 18_000, fees=4_050, taxes=2_700)
    db.commit()

    out = engine.realized_fifo(db, p)
    sale = out["sales"][0]
    # FIFO: all of lot A + 50 of lot B
    assert [(l["quantity"], l["unit_cost"]) for l in sale["lots"]] == [(100.0, 10150.0), (50.0, 20000.0)]
    assert sale["cost"] == 1_015_000 + 1_000_000
    assert sale["proceeds"] == 150 * 18_000 - 4_050 - 2_700
    assert sale["gain"] == sale["proceeds"] - sale["cost"]
    # matches the ledger rebuild's realized gain
    engine.rebuild(db, p.id)
    from app.models.portfolio import ProjectionSummary
    assert float(db.get(ProjectionSummary, p.id).realized_gain) == out["total_gain"]
    # average cost would differ: avg 15,075/share -> gain 432,000 vs FIFO 678,250
    assert out["total_gain"] == 678_250


def test_ticker_breakdown_counts_orders_and_received_shares(db):
    from datetime import datetime, timezone
    from app.models.portfolio import Portfolio, PortfolioTransaction
    from app.services import portfolio_engine as engine

    p = Portfolio(name="Main", display_currency="VND")
    db.add(p); db.flush()
    def tx(day, kind, qty=None, price=None, source="ssi_email", cash=None, taxes=0, fees=0):
        db.add(PortfolioTransaction(portfolio_id=p.id, type=kind, ticker="SSI", quantity=qty, unit_price=price,
                                    cash_amount=cash, fees=fees, taxes=taxes, currency="VND", source=source,
                                    effective_at=datetime(2026, 1, day, 8, tzinfo=timezone.utc)))
    tx(1, "BUY", 100, 20_000, fees=3_000)                  # bought
    tx(2, "BUY", 20, 0, source="ssi_corporate")            # bonus shares
    tx(3, "BUY", 10, 15_000, source="ssi_corporate")       # rights
    tx(4, "DIVIDEND", cash=100_000, taxes=5_000)
    tx(5, "SELL", 120, 25_000, fees=4_500, taxes=3_000)
    db.commit()
    t = engine.ticker_breakdown(db, p)["tickers"][0]
    assert (t["orders_buy"], t["orders_sell"]) == (1, 1)
    assert (t["shares_bought"], t["shares_received"], t["shares_sold"], t["shares_now"]) == (100, 30, 120, 10)
    assert t["paid"] == 2_003_000 + 150_000 and t["received"] == 3_000_000 - 7_500
    assert t["dividends"] == 95_000
    assert [e["kind"] for e in t["events"]] == ["SELL", "DIVIDEND", "RIGHTS", "BONUS", "BUY"]
    assert t["events"][0]["shares_after"] == 10


def test_all_nan_quote_never_breaks_valuation(portfolio_client, monkeypatch):
    """Yahoo with no data: a NaN price must fall back (missing quote), never
    reach the JSON response or the NOT NULL market-data cache."""
    nan = float("nan")
    monkeypatch.setattr(portfolio_engine.market, "get_quote", lambda ticker: {
        "ticker": ticker, "price": nan, "previous_close": nan, "change": nan,
        "change_pct": nan, "currency": "USD", "ts": 0})
    assert add(portfolio_client).status_code == 201
    jobs = portfolio_client.get("/api/jobs?kind=portfolio.rebuild").json()["items"]
    assert [j["status"] for j in jobs] == ["done"]
    res = portfolio_client.get("/api/portfolio")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["holdings"], body
    assert [m for m in body.get("missing", []) if m.get("kind") == "quote"]


def test_quote_drops_non_finite_secondary_fields(db, monkeypatch):
    monkeypatch.setattr(portfolio_engine.market, "get_quote", lambda ticker: {
        "ticker": ticker, "price": 10.0, "previous_close": float("nan"),
        "change": float("inf"), "currency": "USD", "ts": 0})
    item, meta = portfolio_engine.quote(db, "ABC", "USD")
    assert item["price"] == 10.0
    assert item["previous_close"] is None and item["change"] is None
    db.commit()


def test_nan_fx_quote_is_treated_as_unavailable(db, monkeypatch):
    monkeypatch.setattr(portfolio_engine.market, "get_quote",
                        lambda ticker: {"ticker": ticker, "price": float("nan")})
    with pytest.raises(ValueError):
        portfolio_engine.fx_rate(db, "USD", "VND")
    db.commit()  # nothing NaN was queued for the NOT NULL cache


def test_slow_quotes_never_hold_up_portfolio(portfolio_client, monkeypatch):
    """vnstock calls are serialised ~3s apart, so a dozen holdings fetched one by
    one blew the frontend's 15s timeout. The view waits a bounded budget, then
    answers with the stored price and reports the quotes still loading."""
    import threading
    release = threading.Event()
    calls = []

    def slow_quote(ticker):
        calls.append(ticker)
        release.wait(5)
        return {"ticker": ticker, "price": 12.0, "previous_close": 11.0,
                "change": 1.0, "currency": "USD", "ts": 0}

    monkeypatch.setattr(portfolio_engine, "PREFETCH_BUDGET_S", 0.2)
    monkeypatch.setattr(portfolio_engine.prefetch_quotes, "__defaults__", (0.2,))
    assert add(portfolio_client).status_code == 201
    monkeypatch.setattr(portfolio_engine.market, "get_quote", slow_quote)
    started = time.monotonic()
    body = portfolio_client.get("/api/portfolio").json()
    assert time.monotonic() - started < 3
    assert body["quotes_pending"] == 1
    # A second load while the first fetch is in flight reuses it (no pile-up).
    portfolio_client.get("/api/portfolio")
    assert len(calls) == 1
    release.set()
    time.sleep(0.2)
    done = portfolio_client.get("/api/portfolio").json()
    assert done["quotes_pending"] == 0
    assert done["holdings"][0]["price"] == pytest.approx(12.0)


def test_editing_an_imported_row_moves_its_external_id(db):
    """Replacing a row that carries (source, external_id) must not hit
    uq_portfolio_import_external: the id moves to the new version."""
    from decimal import Decimal
    from app.services import portfolio_ledger as ledger
    from app.services.portfolio_schemas import TransactionIn

    class BG:
        def add_task(self, *a, **k):
            pass
    p = Portfolio(name="Main", display_currency="VND")
    db.add(p); db.commit()
    tx = PortfolioTransaction(portfolio_id=p.id, type="BUY", ticker="VCB", quantity=200,
                              unit_price=53600, currency="VND", source="ssi_email",
                              external_id="acc:2026-11-06:1",
                              effective_at=datetime(2026, 11, 6, 8, tzinfo=timezone.utc))
    db.add(tx); db.commit()
    payload = TransactionIn(type="BUY", effective_at=tx.effective_at, ticker="VCB",
                            quantity=Decimal(200), unit_price=Decimal(53700), currency="VND",
                            source="ssi_email", external_id="acc:2026-11-06:1")
    out = ledger.replace_transaction(db, BG(), tx.id, payload)
    assert out["transaction"]["external_id"] == "acc:2026-11-06:1"
    assert db.get(PortfolioTransaction, tx.id).status == "replaced"
    assert db.get(PortfolioTransaction, tx.id).external_id is None

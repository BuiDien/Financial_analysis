from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base, get_db
from app.main import app
from app.screener import refresh, store
from app.screener.provider import FixtureProvider
from app.screener.refresh import RefreshManager


@pytest.fixture
def factory():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


@pytest.fixture
def client(factory, monkeypatch):
    def override():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    mgr = RefreshManager(factory, FixtureProvider, lambda: datetime.now(timezone.utc))
    monkeypatch.setattr(refresh, "manager", mgr)
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def load_fixture(factory):
    prov = FixtureProvider()
    now = datetime.now(timezone.utc)
    with factory() as db:
        entries = prov.list_universe()
        store.upsert_universe(db, entries)
        for e in entries:
            store.save_financials(db, e["symbol"], prov.fetch_financials(e), now)
            store.save_prices(db, e["symbol"], prov.fetch_prices(e["symbol"]), now)


def quality(client):
    return next(s for s in client.get("/api/screener/strategies").json() if s["starter_key"] == "quality")


def test_rules_catalog(client):
    body = client.get("/api/screener/rules").json()
    assert "scope" in body["catalog"]


def test_evaluate_empty_store(client):
    r = client.post("/api/screener/evaluate", json={"strategy_id": None, "rules": []})
    assert r.status_code == 200
    body = r.json()
    assert body["counts"]["universe"] == 0 and body["counts"]["passed"] == 0
    assert body["freshness"] == {"prices_as_of": None, "financials_as_of": None}


def test_strategies_seeded_on_list(client):
    r = client.get("/api/screener/strategies")
    assert r.status_code == 200
    assert len(r.json()) == 4


def test_evaluate_with_fixture_data(client, factory):
    load_fixture(factory)
    q = quality(client)
    body = client.post("/api/screener/evaluate",
                       json={"strategy_id": q["id"], "rules": q["rules"]}).json()
    assert body["rows"]
    assert body["rows"][0]["symbol"] == "DIPCO"
    assert body["rows"][0]["oversold"] == "yes"


def test_evaluate_rejects_bad_rules_422(client):
    assert client.post("/api/screener/evaluate",
                       json={"strategy_id": None, "rules": [{"id": "nope"}]}).status_code == 422
    assert client.post("/api/screener/evaluate",
                       json={"strategy_id": None, "rules": "x"}).status_code == 422


def test_evaluate_stores_last_strategy(client, factory):
    load_fixture(factory)
    q = quality(client)
    assert client.get("/api/screener/state").json() == {"last_strategy_id": None}
    client.post("/api/screener/evaluate", json={"strategy_id": q["id"], "rules": q["rules"]})
    assert client.get("/api/screener/state").json() == {"last_strategy_id": q["id"]}
    with factory() as db:
        assert "DIPCO" in store.get_state(db, "last_pass_symbols")


def test_strategy_crud_and_errors(client):
    r = client.post("/api/screener/strategies", json={"name": "Mine", "rules": []})
    assert r.status_code == 200
    sid = r.json()["id"]
    assert client.post("/api/screener/strategies", json={"name": "Mine", "rules": []}).status_code == 409
    assert client.put(f"/api/screener/strategies/{sid}", json={"name": "Mine2"}).json()["name"] == "Mine2"
    assert client.put("/api/screener/strategies/9999", json={"name": "x"}).status_code == 404
    assert client.post("/api/screener/strategies", json={"name": "A", "rules": "x"}).status_code == 422
    assert client.delete(f"/api/screener/strategies/{sid}").status_code == 204
    q = quality(client)
    assert client.post(f"/api/screener/strategies/{q['id']}/reset").status_code == 200


def test_refresh_status_and_post(client, monkeypatch):
    monkeypatch.setattr(refresh.manager, "is_booted", lambda: True)
    assert client.get("/api/screener/refresh").json()["running"] is False
    r = client.post("/api/screener/refresh", json={"kind": "prices"})
    assert r.status_code == 202
    assert r.json()["queued"] == ["prices"]
    assert client.post("/api/screener/refresh", json={"kind": "prices"}).status_code == 409
    assert client.post("/api/screener/refresh", json={"kind": "bogus"}).status_code == 422


def test_refresh_post_409_when_running(client, monkeypatch):
    monkeypatch.setattr(refresh.manager, "is_booted", lambda: True)
    monkeypatch.setattr(refresh.manager, "request", lambda kind: False)
    assert client.post("/api/screener/refresh", json={"kind": "financials"}).status_code == 409


def test_old_scan_routes_gone(client):
    assert client.post("/api/scan").status_code == 404
    assert client.get("/api/screener").status_code == 404


def test_refresh_post_503_when_not_booted(client):
    r = client.post("/api/screener/refresh", json={"kind": "prices"})
    assert r.status_code == 503
    assert "not running" in r.json()["detail"]
    assert client.get("/api/screener/refresh").json()["queued"] == []


def test_evaluate_unknown_strategy_404(client):
    r = client.post("/api/screener/evaluate", json={"strategy_id": 9999, "rules": []})
    assert r.status_code == 404
    assert client.get("/api/screener/state").json() == {"last_strategy_id": None}


def test_should_boot_refresh():
    from types import SimpleNamespace as NS
    f = lambda e, p: refresh.should_boot_refresh(NS(enable_screener_refresh=e, screener_provider=p))
    assert f(True, "vnstock") is True
    assert f(True, "fixture") is False
    assert f(False, "vnstock") is False

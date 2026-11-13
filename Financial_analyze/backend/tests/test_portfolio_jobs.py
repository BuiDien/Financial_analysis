"""CSV import job state machine, upload cap, stale-job purge, rebuild serialisation,
and Vietnam-local trade days for manual entries."""
import io
import json
import threading
import time
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db import Base, get_db
from app.main import app
from app.models.portfolio import Portfolio, PortfolioJob, PortfolioTransaction
from app.routes import portfolio as routes
from app.services import portfolio_engine as engine


@pytest.fixture
def env(monkeypatch, tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 't.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    factory = sessionmaker(bind=eng)

    def override():
        s = factory()
        try:
            yield s
        finally:
            s.close()

    monkeypatch.setattr(engine.market, "get_quote", lambda t: {"ticker": t, "price": 10, "change": 0, "ts": 0})
    monkeypatch.setattr(engine.market, "get_history", lambda *a, **k: [])
    app.dependency_overrides[get_db] = override
    yield TestClient(app), factory
    app.dependency_overrides.clear()


CSV = "kind,when,ccy,amount\nDEPOSIT,2026-01-02T03:00:00Z,USD,100\n"
MAPPING = {"mapping": {"kind": "type", "when": "effective_at", "ccy": "currency", "amount": "cash_amount"}}


def _preview(client, text=CSV):
    r = client.post("/api/portfolio/imports/preview",
                    files={"file": ("a.csv", io.BytesIO(text.encode()), "text/csv")})
    return r


def test_completed_import_cannot_be_revalidated_or_recommitted(env):
    client, factory = env
    iid = _preview(client).json()["import_id"]
    assert client.post(f"/api/portfolio/imports/{iid}/validate", json=MAPPING).json()["can_commit"]
    assert client.post(f"/api/portfolio/imports/{iid}/commit").status_code == 200
    with factory() as s:
        assert s.get(PortfolioJob, iid).status == "completed"
    assert client.post(f"/api/portfolio/imports/{iid}/validate", json=MAPPING).status_code == 409
    assert client.post(f"/api/portfolio/imports/{iid}/commit").status_code == 409
    with factory() as s:
        assert s.query(PortfolioTransaction).count() == 1


def test_failed_after_ledger_commit_cannot_be_recommitted(env):
    client, factory = env
    iid = _preview(client).json()["import_id"]
    client.post(f"/api/portfolio/imports/{iid}/validate", json=MAPPING)
    with factory() as s:
        job = s.get(PortfolioJob, iid)
        job.status, job.progress = "failed", 60
        s.commit()
    assert client.post(f"/api/portfolio/imports/{iid}/validate", json=MAPPING).status_code == 409
    assert client.post(f"/api/portfolio/imports/{iid}/commit").status_code == 409


def test_invalid_import_can_be_revalidated(env):
    client, _ = env
    iid = _preview(client).json()["import_id"]
    bad = {"mapping": {"kind": "type", "when": "effective_at", "ccy": "currency"}}
    assert not client.post(f"/api/portfolio/imports/{iid}/validate", json=bad).json()["can_commit"]
    assert client.post(f"/api/portfolio/imports/{iid}/validate", json=MAPPING).json()["can_commit"]


def test_upload_is_capped_while_reading(env, monkeypatch):
    client, _ = env
    monkeypatch.setattr(routes, "MAX_IMPORT_BYTES", 64)
    assert _preview(client, CSV + "DEPOSIT,2026-01-02T03:00:00Z,USD,1\n" * 10).status_code == 413
    assert _preview(client).status_code == 200


def test_stale_import_previews_are_purged(env):
    client, factory = env
    old = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=2)
    with factory() as s:
        p = Portfolio(name="Main", display_currency="USD")
        s.add(p); s.flush()
        for jid, status in [("imp_old_preview", "preview"), ("imp_old_invalid", "invalid"),
                            ("imp_old_done", "completed")]:
            s.add(PortfolioJob(id=jid, portfolio_id=p.id, type="import", status=status,
                               payload="{}", created_at=old))
        s.commit()
    fresh = _preview(client).json()["import_id"]
    _preview(client)
    with factory() as s:
        ids = {j.id for j in s.query(PortfolioJob).all()}
    assert "imp_old_preview" not in ids and "imp_old_invalid" not in ids
    assert "imp_old_done" in ids and fresh in ids


def test_concurrent_rebuilds_are_serialised_and_coalesced(env, monkeypatch):
    _, factory = env
    with factory() as s:
        p = Portfolio(name="Main", display_currency="USD", ledger_revision=3)
        s.add(p); s.commit()
        jobs = [engine.new_job(s, p, "rebuild").id for _ in range(2)]
    state = {"active": 0, "max": 0, "calls": 0}
    guard = threading.Lock()

    def fake_rebuild(db, pid):
        with guard:
            state["active"] += 1
            state["calls"] += 1
            state["max"] = max(state["max"], state["active"])
        time.sleep(0.2)
        p = db.get(Portfolio, pid)
        p.projection_revision, p.projection_status = p.ledger_revision, "ready"
        db.commit()
        with guard:
            state["active"] -= 1

    monkeypatch.setattr(engine, "rebuild", fake_rebuild)
    threads = [threading.Thread(target=engine.run_job, args=(factory, j)) for j in jobs]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert state["max"] == 1 and state["calls"] == 1
    with factory() as s:
        assert [s.get(PortfolioJob, j).status for j in jobs] == ["completed", "completed"]
        assert s.query(Portfolio).one().projection_status == "ready"


def test_manual_trade_day_is_vietnam_local(env):
    client, factory = env
    day = date.today() - timedelta(days=3)
    # 23:30 UTC == 06:30 next morning in Hanoi
    r = client.post("/api/portfolio/transactions", json={
        "type": "DEPOSIT", "effective_at": f"{day.isoformat()}T23:30:00Z",
        "cash_amount": 100, "currency": "USD"})
    assert r.status_code == 201
    items = client.get("/api/portfolio/performance?range=all").json()["items"]
    assert items[0]["date"] == (day + timedelta(days=1)).isoformat()


def test_offset_timestamps_are_stored_as_utc(env):
    client, factory = env
    r = client.post("/api/portfolio/transactions", json={
        "type": "DEPOSIT", "effective_at": "2026-01-10T06:30:00+07:00",
        "cash_amount": 100, "currency": "USD"})
    assert r.status_code == 201
    with factory() as s:
        tx = s.query(PortfolioTransaction).one()
        assert tx.effective_at.replace(tzinfo=None) == datetime(2026, 1, 9, 23, 30)
        assert engine.local_day(tx.effective_at) == date(2026, 1, 10)

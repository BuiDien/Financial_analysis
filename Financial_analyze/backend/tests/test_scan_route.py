import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.main import app
from app.db import Base, get_db
from app.models.scan import ScanRun, ScanResult


@pytest.fixture
def client():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    def override():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = override
    # seed a completed run directly (route test focuses on GET latest)
    s = Session()
    run = ScanRun(mode="manual", universe_size=2)
    s.add(run)
    s.flush()
    s.add(ScanResult(run_id=run.id, symbol="VNM",
                     scores={"fundamentals": 80, "valuation": 60, "technical": 40, "catalysts": 0},
                     total_score=62.0, lean="long", rank=1, verified=False))
    s.add(ScanResult(run_id=run.id, symbol="XYZ",
                     scores={"fundamentals": 20, "valuation": 20, "technical": 20, "catalysts": 0},
                     total_score=20.0, lean="avoid", rank=2, verified=False))
    s.commit()
    s.close()
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_get_latest_returns_ranked_results(client):
    resp = client.get("/api/scan/latest")
    assert resp.status_code == 200
    body = resp.json()
    assert body["results"][0]["symbol"] == "VNM"
    assert body["results"][0]["rank"] == 1
    assert body["results"][0]["lean"] == "long"
    assert body["results"][0]["verified"] is False


def test_post_scan_runs_on_injected_empty_universe(client):
    # limit=0 short-circuits to an empty universe — no network in tests
    resp = client.post("/api/scan", json={"limit": 0})
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 0 and body["run_id"] is not None

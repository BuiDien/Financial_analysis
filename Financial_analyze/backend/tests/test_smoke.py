"""Smoke test — run with `pytest` from backend/ ."""
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_root():
    r = client.get("/")
    assert r.status_code == 200
    assert r.json()["name"] == "Helix Backend"


def test_health():
    assert client.get("/health").json()["status"] == "ok"

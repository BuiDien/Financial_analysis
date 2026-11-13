"""Browser-origin guard: no auth, so foreign pages must not drive the API."""
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import DEFAULT_ALLOWED_ORIGINS, Settings
from app.main import app
from app.ocr_page_contract import OCR_PAGE_RESULT_FORMAT
from app.routes import sync
from app.routes.sync import OCR_PROTOCOL_VERSION, coordinator

HELLO = {
    "type": "hello",
    "name": "Mac OCR (MLX)",
    "protocolVersion": OCR_PROTOCOL_VERSION,
    "resultFormats": [OCR_PAGE_RESULT_FORMAT],
    "capabilities": ["page_ack"],
}


@pytest.fixture
def client(monkeypatch):
    # A paired worker triggers dispatch_next_queued → SessionLocal; keep that
    # on an empty in-memory DB, never the real helix.db.
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    monkeypatch.setattr(sync, "SessionLocal", sessionmaker(bind=engine))
    coordinator.workers.clear()
    yield TestClient(app)
    coordinator.workers.clear()


def test_default_origins_are_the_local_frontend(monkeypatch):
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    origins = Settings(_env_file=None).origins_list
    assert "http://localhost:5500" in origins
    assert "http://127.0.0.1:5500" in origins
    assert "*" not in origins


def test_wildcard_origin_setting_is_not_honoured():
    origins = Settings(_env_file=None, allowed_origins="*").origins_list
    assert origins == DEFAULT_ALLOWED_ORIGINS.split(",")


def test_foreign_origin_is_rejected_for_reads_and_writes(client):
    evil = {"Origin": "https://evil.example"}
    assert client.get("/api/sync/status", headers=evil).status_code == 403
    assert client.post("/api/sync/pair-code", headers=evil).status_code == 403
    assert client.get("/health", headers={"Origin": "null"}).status_code == 403


def test_allowed_origin_and_no_origin_pass(client):
    ok = client.get("/api/sync/status", headers={"Origin": "http://localhost:5500"})
    assert ok.status_code == 200
    assert ok.headers["access-control-allow-origin"] == "http://localhost:5500"
    assert "access-control-allow-credentials" not in ok.headers
    assert client.get("/api/sync/status").status_code == 200


def test_cors_preflight_from_frontend_is_allowed(client):
    resp = client.options(
        "/api/portfolio",
        headers={
            "Origin": "http://127.0.0.1:5500",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] == "http://127.0.0.1:5500"


def test_ocr_socket_rejects_foreign_origin(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            "/ws/ocr", headers={"Origin": "https://evil.example"}
        ) as ws:
            ws.send_json(HELLO)
            ws.receive_json()
    assert not coordinator.workers


def test_loopback_browser_origin_still_needs_pairing(client, monkeypatch):
    """Even an allowlisted page on this Mac must not skip the pairing code."""
    monkeypatch.setattr(sync, "_is_loopback_peer", lambda _host: True)
    with client.websocket_connect(
        "/ws/ocr", headers={"Origin": "http://localhost:5500"}
    ) as ws:
        ws.send_json(HELLO)
        assert ws.receive_json()["type"] == "pair_required"
    assert not coordinator.workers


def test_native_loopback_worker_without_origin_skips_pairing(client, monkeypatch):
    monkeypatch.setattr(sync, "_is_loopback_peer", lambda _host: True)
    with client.websocket_connect("/ws/ocr") as ws:
        ws.send_json(HELLO)
        assert ws.receive_json()["type"] == "welcome"

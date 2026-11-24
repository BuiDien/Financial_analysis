"""Same-machine OCR workers skip the pairing code; remote workers still pair."""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.ocr_page_contract import OCR_PAGE_RESULT_FORMAT
from app.services import ocr_sync_attempts, ocr_sync_network
from app.services.ocr_sync_coordinator import coordinator
from app.services.ocr_sync_network import is_loopback_peer as _is_loopback_peer
from app.services.ocr_sync_protocol import OCR_PROTOCOL_VERSION

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
    monkeypatch.setattr(ocr_sync_attempts, "SessionLocal", sessionmaker(bind=engine))
    coordinator.workers.clear()
    yield TestClient(app)
    coordinator.workers.clear()


@pytest.mark.parametrize("host", ["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1"])
def test_loopback_hosts_are_local(host):
    assert _is_loopback_peer(host)


@pytest.mark.parametrize("host", ["192.168.1.25", "10.0.0.7", "::ffff:192.168.1.25", "testclient", "?", "", None])
def test_other_hosts_are_not_local(host):
    assert not _is_loopback_peer(host)


def test_local_worker_gets_welcome_without_code(client, monkeypatch):
    monkeypatch.setattr(ocr_sync_network, "is_loopback_peer", lambda _host: True)
    with client.websocket_connect("/ws/ocr") as ws:
        ws.send_json(HELLO)
        welcome = ws.receive_json()
        assert welcome["type"] == "welcome"
        assert welcome["selectedResultFormat"] == OCR_PAGE_RESULT_FORMAT
        assert welcome["requiredCapabilities"] == ["page_ack"]
        assert [w["name"] for w in coordinator.workers.values()] == ["Mac OCR (MLX)"]


def test_remote_worker_still_needs_code(client):
    # TestClient's peer host is "testclient", i.e. not loopback.
    with client.websocket_connect("/ws/ocr") as ws:
        ws.send_json(HELLO)
        required = ws.receive_json()
        assert required["type"] == "pair_required"
        ws.send_json({"type": "pair", "pairId": required["pairId"], "code": "WRONG-1"})
        deny = ws.receive_json()
        assert deny["type"] == "deny"
        assert not coordinator.workers

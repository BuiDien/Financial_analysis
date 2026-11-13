"""Dispatch streams the PDF to a paired worker as binary chunks.

Covers the coordinator side of docs/design/OCR_PROTOCOL.md: two-step pairing,
the job/chunks/job_end sequence, and the error frame freeing the worker.
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import app
from app.db import Base, get_db
from app.models.filing import Filing
from app.routes import sync
from app.routes.sync import (
    CHUNK_SIZE,
    OCR_PROTOCOL_VERSION,
    OCR_RESULT_SCHEMA_VERSION,
    _lan_ip,
    _parse_physical_interface_ips,
    _print_worker_message,
    coordinator,
)

PDF_BYTES = b"%PDF-1.4 " + bytes(range(256)) * 3000  # ~768 KB → 2 chunks


def test_physical_interface_ip_prefers_wifi_and_ignores_cloudflare_tunnel():
    ifconfig_output = """
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 192.168.1.26 netmask 0xffffff00 broadcast 192.168.1.255
\tstatus: active
utun6: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280
\tinet 172.16.0.2 --> 172.16.0.2 netmask 0xffffffff
"""

    assert _parse_physical_interface_ips(ifconfig_output) == ["192.168.1.26"]


def test_physical_interface_ip_ignores_inactive_adapter():
    ifconfig_output = """
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 192.168.1.20 netmask 0xffffff00 broadcast 192.168.1.255
\tstatus: inactive
en5: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 192.168.1.30 netmask 0xffffff00 broadcast 192.168.1.255
\tstatus: active
"""

    assert _parse_physical_interface_ips(ifconfig_output) == ["192.168.1.30"]


def test_lan_ip_uses_detected_physical_interface(monkeypatch):
    monkeypatch.setattr(sync.settings, "sync_advertised_host", "")
    monkeypatch.setattr(sync, "_physical_interface_ips", lambda: ["192.168.1.26"])

    assert _lan_ip() == "192.168.1.26"


def test_lan_ip_allows_optional_explicit_override(monkeypatch):
    monkeypatch.setattr(sync.settings, "sync_advertised_host", "core-mac.local")
    monkeypatch.setattr(
        sync,
        "_physical_interface_ips",
        lambda: pytest.fail("automatic detection should not run with an override"),
    )

    assert _lan_ip() == "core-mac.local"


def test_print_worker_message_includes_complete_unicode_payload(capsys):
    message = {
        "type": "result",
        "jobId": "job_1",
        "schemaVersion": 1,
        "rows": [{"code": "270", "metric": "TỔNG CỘNG TÀI SẢN"}],
    }

    _print_worker_message("worker_1", "Dien WSL", message)

    output = capsys.readouterr().out
    assert "OCR WORKER MESSAGE BEGIN" in output
    assert '"jobId": "job_1"' in output
    assert '"metric": "TỔNG CỘNG TÀI SẢN"' in output
    assert "OCR WORKER MESSAGE END" in output


@pytest.fixture
def client(tmp_path, monkeypatch):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    # WebSocket follow-up dispatches open their own session rather than using
    # FastAPI's request dependency, so keep those sessions inside this fixture.
    monkeypatch.setattr(sync, "SessionLocal", Session)

    def override():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = override

    pdf_path = tmp_path / "vnm-q4.pdf"
    pdf_path.write_bytes(PDF_BYTES)
    s = Session()
    s.add(
        Filing(
            id=1,
            ticker="VNM",
            filing_type="10-K",
            period="Q4 2024",
            filename="vnm-q4.pdf",
            storage_path=str(pdf_path),
            size_bytes=len(PDF_BYTES),
        )
    )
    s.commit()
    s.close()
    yield TestClient(app)
    app.dependency_overrides.clear()
    coordinator.jobs.clear()


def pair(ws):
    ws.send_json(
        {
            "type": "hello",
            "name": "Test Worker",
            "protocolVersion": OCR_PROTOCOL_VERSION,
            "resultSchemaVersions": [OCR_RESULT_SCHEMA_VERSION],
            "capabilities": ["bbox"],
        }
    )
    pair_required = ws.receive_json()
    assert pair_required["type"] == "pair_required"
    ws.send_json(
        {
            "type": "pair",
            "pairId": pair_required["pairId"],
            "code": coordinator.pair_code,
        }
    )
    welcome = ws.receive_json()
    assert welcome["type"] == "welcome"


def receive_job(ws):
    """Worker side of one dispatch: job frame, binary chunks, job_end."""
    job = ws.receive_json()
    assert job["type"] == "job"
    buf = bytearray()
    while True:
        frame = ws.receive()
        if frame.get("bytes") is not None:
            buf.extend(frame["bytes"])
            continue
        import json

        end = json.loads(frame["text"])
        assert end == {"type": "job_end", "jobId": job["jobId"]}
        return job, bytes(buf)


def test_dispatch_streams_pdf_in_binary_chunks(client):
    with client.websocket_connect("/ws/ocr") as ws:
        pair(ws)
        resp = client.post("/api/sync/dispatch/1")
        assert resp.status_code == 200
        job_id = resp.json()["jobId"]

        job, pdf = receive_job(ws)
        assert job["jobId"] == job_id
        assert job["bytes"] == len(PDF_BYTES)
        assert job["protocolVersion"] == OCR_PROTOCOL_VERSION
        assert job["resultSchemaVersion"] == OCR_RESULT_SCHEMA_VERSION
        assert job["requiredCapabilities"] == ["bbox"]
        assert "pdf_b64" not in job
        assert pdf == PDF_BYTES
        assert len(PDF_BYTES) > CHUNK_SIZE  # guarantees the multi-chunk path ran

        ws.send_json(
            {
                "type": "result",
                "jobId": job_id,
                "rows": [{"code": "270", "curr": "1", "prev": "2"}],
            }
        )
        ack = ws.receive_json()
        assert ack == {
            "type": "result_ack",
            "jobId": job_id,
            "status": "done",
            "rowCount": 1,
        }
        # result frame processed once the next HTTP call round-trips
        for _ in range(50):
            job_state = client.get(f"/api/sync/result/{job_id}").json()
            if job_state["status"] == "done":
                break
        assert job_state["status"] == "done"
        assert job_state["rows"][0]["code"] == "270"


def test_worker_error_fails_job_and_frees_worker(client):
    with client.websocket_connect("/ws/ocr") as ws:
        pair(ws)
        job_id = client.post("/api/sync/dispatch/1").json()["jobId"]
        receive_job(ws)

        ws.send_json({"type": "error", "jobId": job_id, "error": "no tables found"})
        for _ in range(50):
            job_state = client.get(f"/api/sync/result/{job_id}").json()
            if job_state["status"] == "failed":
                break
        assert job_state["status"] == "failed"
        assert job_state["error"] == "no tables found"
        # worker idle again → a second dispatch succeeds
        assert client.post("/api/sync/dispatch/1").status_code == 200
        receive_job(ws)


def test_obsolete_one_step_worker_gets_upgrade_message(client):
    with client.websocket_connect("/ws/ocr") as ws:
        ws.send_json(
            {"type": "hello", "name": "Old Worker", "code": coordinator.pair_code}
        )

        denied = ws.receive_json()

        assert denied["type"] == "deny"
        assert denied["attemptsLeft"] == 0
        assert "outdated worker" in denied["reason"]


def test_incompatible_worker_is_rejected_before_pairing(client):
    with client.websocket_connect("/ws/ocr") as ws:
        ws.send_json(
            {
                "type": "hello",
                "name": "Legacy OCR Worker",
                "protocolVersion": 1,
                "resultSchemaVersions": [1],
                "capabilities": [],
            }
        )

        denied = ws.receive_json()

        assert denied["type"] == "deny"
        assert denied["attemptsLeft"] == 0
        assert denied["requiredCapabilities"] == ["bbox"]
        assert "incompatible worker" in denied["reason"]


def test_legacy_dispatch_send_failure_frees_worker(client, monkeypatch):
    async def broken(*_args, **_kwargs):
        raise ConnectionError("socket closed mid-stream")

    with client.websocket_connect("/ws/ocr") as ws:
        pair(ws)
        monkeypatch.setattr(sync, "_stream_job", broken)
        resp = client.post("/api/sync/dispatch/1")
        assert resp.status_code == 500
        assert [w["status"] for w in coordinator.workers.values()] == ["idle"]
        assert not coordinator.jobs


def test_finished_jobs_are_pruned_but_active_ones_kept():
    saved = dict(coordinator.jobs)
    coordinator.jobs.clear()
    try:
        coordinator.add_job({"id": "active", "status": "parsing", "sentAt": 0})
        for i in range(sync.MAX_FINISHED_JOBS + 25):
            coordinator.add_job({
                "id": f"done{i}", "status": "done", "sentAt": i,
                "completedAt": i, "rows": [{"code": "1"}] * 10,
            })
        finished = [j for j in coordinator.jobs.values() if j["status"] == "done"]
        assert len(finished) == sync.MAX_FINISHED_JOBS
        assert "active" in coordinator.jobs
        assert "done0" not in coordinator.jobs
        assert f"done{sync.MAX_FINISHED_JOBS + 24}" in coordinator.jobs
    finally:
        coordinator.jobs.clear()
        coordinator.jobs.update(saved)


def test_background_tasks_are_referenced_and_failures_logged(caplog):
    import asyncio
    import logging

    async def boom():
        raise ValueError("label review exploded")

    async def main():
        task = coordinator.spawn(boom())
        assert task in coordinator.background_tasks
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.sleep(0)
        return task

    with caplog.at_level(logging.ERROR, logger=sync.logger.name):
        task = asyncio.run(main())
    assert task not in coordinator.background_tasks
    assert "label review exploded" in caplog.text


def test_get_result_hides_internal_fields():
    coordinator.jobs["job_x"] = {"id": "job_x", "status": "sent", "db_bind": object()}
    try:
        from fastapi.testclient import TestClient as _TC

        body = _TC(app).get("/api/sync/result/job_x").json()
        assert body == {"id": "job_x", "status": "sent"}
    finally:
        coordinator.jobs.pop("job_x", None)

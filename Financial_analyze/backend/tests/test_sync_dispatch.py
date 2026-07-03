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
from app.routes.sync import coordinator, CHUNK_SIZE

PDF_BYTES = b"%PDF-1.4 " + bytes(range(256)) * 3000  # ~768 KB → 2 chunks


@pytest.fixture
def client(tmp_path):
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

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
    s.add(Filing(id=1, ticker="VNM", filing_type="10-K", period="Q4 2024",
                 filename="vnm-q4.pdf", storage_path=str(pdf_path),
                 size_bytes=len(PDF_BYTES)))
    s.commit()
    s.close()
    yield TestClient(app)
    app.dependency_overrides.clear()
    coordinator.jobs.clear()


def pair(ws):
    ws.send_json({"type": "hello", "name": "Test Worker"})
    pair_required = ws.receive_json()
    assert pair_required["type"] == "pair_required"
    ws.send_json({"type": "pair", "pairId": pair_required["pairId"],
                  "code": coordinator.pair_code})
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
        assert "pdf_b64" not in job
        assert pdf == PDF_BYTES
        assert len(PDF_BYTES) > CHUNK_SIZE  # guarantees the multi-chunk path ran

        ws.send_json({"type": "result", "jobId": job_id,
                      "rows": [{"code": "270", "curr": "1", "prev": "2"}]})
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

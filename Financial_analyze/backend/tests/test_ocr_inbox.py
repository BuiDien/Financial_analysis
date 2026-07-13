import json
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from pypdf import PdfWriter

from app.db import Base, get_db
from app.main import app
from app.routes import ocr_inbox
from app.routes.sync import coordinator


def _pdf_bytes():
    output = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.add_blank_page(width=612, height=792)
    writer.write(output)
    return output.getvalue()


PDF_BYTES = _pdf_bytes()


@pytest.fixture
def client(tmp_path, monkeypatch):
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    def override():
        session = Session()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override
    monkeypatch.setattr(ocr_inbox.settings, "upload_dir", str(tmp_path))
    monkeypatch.setattr(ocr_inbox.pdf, "page_count", lambda _path: 2)
    coordinator.jobs.clear()
    coordinator.workers.clear()
    yield TestClient(app)
    app.dependency_overrides.clear()
    coordinator.jobs.clear()
    coordinator.workers.clear()


def upload(client, filename="statement.pdf", allow_duplicate=False):
    return client.post(
        "/api/ocr-inbox",
        files=[("files", (filename, PDF_BYTES, "application/pdf"))],
        data={"allow_duplicate": str(allow_duplicate).lower()},
    )


def pair(ws):
    ws.send_json({"type": "hello", "name": "Inbox Worker"})
    required = ws.receive_json()
    ws.send_json({
        "type": "pair", "pairId": required["pairId"], "code": coordinator.pair_code,
    })
    assert ws.receive_json()["type"] == "welcome"


def receive_job(ws):
    job = ws.receive_json()
    payload = bytearray()
    while True:
        frame = ws.receive()
        if frame.get("bytes") is not None:
            payload.extend(frame["bytes"])
            continue
        end = json.loads(frame["text"])
        assert end == {"type": "job_end", "jobId": job["jobId"]}
        return job, bytes(payload)


def result_rows():
    return [
        {
            "code": "270", "section": "balance", "metric": "Total assets",
            "curr": "100", "prev": "90", "page": 1, "confidence": 96,
            "bbox": {"x": 0.1, "y": 0.2, "width": 0.7, "height": 0.04},
        },
        {
            "code": "300", "section": "balance", "metric": "Total liabilities",
            "curr": "40", "prev": "35", "page": 2, "confidence": 88,
            "bbox": {"x": 0.1, "y": 0.3, "width": 0.7, "height": 0.04},
        },
    ]


def test_upload_lists_serves_and_warns_on_duplicate(client):
    response = upload(client)
    assert response.status_code == 200
    item = response.json()["items"][0]
    assert item["status"] == "uploaded"
    assert item["pages"] == 2

    assert client.get("/api/ocr-inbox").json()[0]["id"] == item["id"]
    source = client.get(f"/api/ocr-inbox/{item['id']}/file")
    assert source.status_code == 200
    assert source.content == PDF_BYTES
    rendered = client.get(f"/api/ocr-inbox/{item['id']}/pages/1")
    assert rendered.status_code == 200
    assert rendered.headers["content-type"] == "image/png"

    duplicate = upload(client)
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["duplicate_id"] == item["id"]
    assert upload(client, allow_duplicate=True).status_code == 200


def test_inbox_dispatch_review_and_publish(client):
    item = upload(client).json()["items"][0]
    with client.websocket_connect("/ws/ocr") as ws:
        pair(ws)
        queued = client.post(f"/api/ocr-inbox/{item['id']}/run")
        assert queued.status_code == 200
        job, payload = receive_job(ws)
        assert job["inboxItemId"] == item["id"]
        assert payload == PDF_BYTES

        ws.send_json({
            "type": "result", "jobId": job["jobId"],
            "schemaVersion": 1, "rows": result_rows(),
        })
        for _ in range(50):
            current = client.get(f"/api/ocr-inbox/{item['id']}").json()
            if current["status"] == "ready_for_review":
                break
        assert current["status"] == "ready_for_review"

        review_id = current["review"]["id"]
        review = client.get(f"/api/ocr-inbox/reviews/{review_id}").json()
        first, second = review["rows"]
        review = client.post(
            f"/api/ocr-inbox/reviews/{review_id}/rows/{first['id']}/approve",
            json={"revision": review["revision"]},
        ).json()
        review = client.post(
            f"/api/ocr-inbox/reviews/{review_id}/rows/{second['id']}/correct",
            json={"revision": review["revision"], "data": {"curr": "41"}},
        ).json()
        assert review["counts"]["pending"] == 0

        verified = client.post(
            f"/api/ocr-inbox/reviews/{review_id}/verify",
            json={"revision": review["revision"]},
        )
        assert verified.status_code == 200
        assert client.get(f"/api/ocr-inbox/{item['id']}").json()["status"] == "verified"

        labels = client.patch(f"/api/ocr-inbox/{item['id']}/labels", json={
            "company": "Vinamilk", "ticker": "VNM", "filing_type": "BCTC",
            "period": "Q4 2025", "currency": "VND", "unit": "million",
        })
        assert labels.status_code == 200
        assert labels.json()["status"] == "ready_to_publish"

        published = client.post(f"/api/ocr-inbox/{item['id']}/publish")
        assert published.status_code == 200
        filing_id = published.json()["filing_id"]
        assert client.post(f"/api/ocr-inbox/{item['id']}/publish").json() == {
            "filing_id": filing_id, "already_published": True,
        }
        assert client.delete(f"/api/ocr-inbox/{item['id']}").status_code == 409
        assert client.delete(f"/api/filings/{filing_id}").status_code == 409
        assert client.patch(f"/api/ocr-inbox/{item['id']}/labels", json={
            "company": "Changed", "ticker": "VNM", "filing_type": "BCTC",
            "period": "Q4 2025", "currency": "VND", "unit": "million",
        }).status_code == 409
        filing = client.get("/api/filings").json()[0]
        assert filing["id"] == filing_id
        assert filing["status"] == "verified"


@pytest.mark.parametrize(("action", "expected_status"), [
    ("hold", "held"),
    ("stop", "uploaded"),
])
def test_active_inbox_job_can_be_controlled_and_run_again(client, action, expected_status):
    item = upload(client).json()["items"][0]
    with client.websocket_connect("/ws/ocr") as ws:
        pair(ws)
        queued = client.post(f"/api/ocr-inbox/{item['id']}/run")
        job, _ = receive_job(ws)

        controlled = client.post(
            f"/api/sync/jobs/{job['jobId']}/control", json={"action": action},
        )
        assert controlled.status_code == 200
        assert ws.receive_json() == {
            "type": "job_control", "jobId": job["jobId"], "action": action,
        }
        ws.send_json({"type": "control_ack", "jobId": job["jobId"], "action": action})
        for _ in range(50):
            current = client.get(f"/api/ocr-inbox/{item['id']}").json()
            if current["status"] == expected_status:
                break
        assert current["status"] == expected_status

    resumed = client.post(f"/api/ocr-inbox/{item['id']}/run")
    assert resumed.status_code == 200
    assert resumed.json()["item"]["status"] == "queued"


def test_review_reject_requires_reason_and_revision_conflicts(client):
    item = upload(client).json()["items"][0]
    with client.websocket_connect("/ws/ocr") as ws:
        pair(ws)
        client.post(f"/api/ocr-inbox/{item['id']}/run")
        job, _ = receive_job(ws)
        ws.send_json({"type": "result", "jobId": job["jobId"],
                      "schemaVersion": 1, "rows": result_rows()[:1]})
        for _ in range(50):
            current = client.get(f"/api/ocr-inbox/{item['id']}").json()
            if current["status"] == "ready_for_review" and current["review"]:
                break
        review_response = client.get(f"/api/ocr-inbox/reviews/{current['review']['id']}")
        assert review_response.status_code == 200
        review = review_response.json()
        row_id = review["rows"][0]["id"]
        missing = client.post(
            f"/api/ocr-inbox/reviews/{review['id']}/rows/{row_id}/reject",
            json={"revision": review["revision"]},
        )
        assert missing.status_code == 422
        accepted = client.post(
            f"/api/ocr-inbox/reviews/{review['id']}/rows/{row_id}/reject",
            json={"revision": review["revision"], "reason": "duplicate"},
        )
        assert accepted.status_code == 200
        assert client.post(
            f"/api/ocr-inbox/reviews/{review['id']}/verify",
            json={"revision": accepted.json()["revision"]},
        ).status_code == 409
        stale = client.post(
            f"/api/ocr-inbox/reviews/{review['id']}/rows/{row_id}/restore",
            json={"revision": review["revision"]},
        )
        assert stale.status_code == 409

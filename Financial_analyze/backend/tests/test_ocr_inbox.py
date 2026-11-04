import json
import threading
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from pypdf import PdfWriter

from app.db import Base, get_db
from app.main import app
from app.routes import ocr_inbox, sync
from app.routes.sync import (
    OCR_PROTOCOL_VERSION,
    OCR_RESULT_SCHEMA_VERSION,
    coordinator,
)
from app.ocr_page_contract import OCR_PAGE_RESULT_FORMAT
from app.services import ocr_label_review
from app.services import ocr_label_library


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
        f"sqlite:///{tmp_path / 'ocr-inbox-test.db'}",
        connect_args={"check_same_thread": False},
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
    monkeypatch.setattr(ocr_inbox.settings, "obsidian_vault_path", str(tmp_path / "vault"))
    monkeypatch.setattr(
        ocr_inbox.settings,
        "obsidian_label_library_path",
        "Financial Analyze/Label Library",
    )
    monkeypatch.setattr(ocr_inbox.pdf, "page_count", lambda _path: 2)
    monkeypatch.setattr(sync, "SessionLocal", Session)
    monkeypatch.setattr(
        sync.settings, "enable_automatic_ocr_label_review", False,
    )
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
    ws.send_json(
        {
            "type": "hello",
            "name": "Inbox Worker",
            "protocolVersion": OCR_PROTOCOL_VERSION,
            "resultSchemaVersions": [OCR_RESULT_SCHEMA_VERSION],
            "capabilities": ["bbox"],
        }
    )
    required = ws.receive_json()
    ws.send_json(
        {
            "type": "pair",
            "pairId": required["pairId"],
            "code": coordinator.pair_code,
        }
    )
    assert ws.receive_json()["type"] == "welcome"


def pair_page_worker(ws):
    ws.send_json(
        {
            "type": "hello",
            "name": "Page Markdown Worker",
            "protocolVersion": OCR_PROTOCOL_VERSION,
            "resultFormats": [OCR_PAGE_RESULT_FORMAT],
            "capabilities": ["page_ack"],
        }
    )
    required = ws.receive_json()
    assert required["type"] == "pair_required"
    ws.send_json(
        {
            "type": "pair",
            "pairId": required["pairId"],
            "code": coordinator.pair_code,
        }
    )
    welcome = ws.receive_json()
    assert welcome["type"] == "welcome"
    assert welcome["selectedResultFormat"] == OCR_PAGE_RESULT_FORMAT
    assert welcome["resultSchemaVersion"] == 2
    assert welcome["requiredCapabilities"] == ["page_ack"]


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


def create_markdown_review(client, markdown: str):
    item = upload(client).json()["items"][0]
    with client.websocket_connect("/ws/ocr") as ws:
        pair_page_worker(ws)
        client.post(f"/api/ocr-inbox/{item['id']}/run")
        job, _ = receive_job(ws)
        for page_number, page_markdown in (
            (1, markdown),
            (2, "# Page 2\n\nNo table"),
        ):
            ws.send_json({
                "type": "page_result",
                "jobId": job["jobId"],
                "schemaVersion": 2,
                "page": page_number,
                "pageCount": 2,
                "markdown": page_markdown,
            })
            assert ws.receive_json()["status"] == "stored"
        ws.send_json({
            "type": "result_end",
            "jobId": job["jobId"],
            "schemaVersion": 2,
            "pageCount": 2,
        })
        review_id = ws.receive_json()["reviewId"]
    review = client.get(f"/api/ocr-inbox/reviews/{review_id}").json()
    return item, review


def result_rows():
    return [
        {
            "code": "270",
            "section": "balance",
            "metric": "Total assets",
            "curr": "100",
            "prev": "90",
            "page": 1,
            "confidence": 96,
            "bbox": {"x": 0.1, "y": 0.2, "width": 0.7, "height": 0.04},
        },
        {
            "code": "300",
            "section": "balance",
            "metric": "Total liabilities",
            "curr": "40",
            "prev": "35",
            "page": 2,
            "confidence": 88,
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
        assert client.post(f"/api/ocr-inbox/{item['id']}/run").status_code == 200
        job, payload = receive_job(ws)
        assert job["inboxItemId"] == item["id"]
        assert payload == PDF_BYTES

        ws.send_json(
            {
                "type": "result",
                "jobId": job["jobId"],
                "schemaVersion": 1,
                "rows": result_rows(),
            }
        )
        ack = ws.receive_json()
        assert ack["type"] == "result_ack"
        assert ack["status"] == "ready_for_review"
        assert ack["rowCount"] == len(result_rows())
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

        labels = client.patch(
            f"/api/ocr-inbox/{item['id']}/labels",
            json={
                "company": "Vinamilk",
                "ticker": "VNM",
                "filing_type": "BCTC",
                "period": "Q4 2025",
                "currency": "VND",
                "unit": "million",
            },
        )
        assert labels.status_code == 200
        assert labels.json()["status"] == "ready_to_publish"

        published = client.post(f"/api/ocr-inbox/{item['id']}/publish")
        assert published.status_code == 200
        filing_id = published.json()["filing_id"]
        assert client.post(f"/api/ocr-inbox/{item['id']}/publish").json() == {
            "filing_id": filing_id,
            "already_published": True,
        }
        assert client.delete(f"/api/ocr-inbox/{item['id']}").status_code == 409
        assert client.delete(f"/api/filings/{filing_id}").status_code == 409
        assert (
            client.patch(
                f"/api/ocr-inbox/{item['id']}/labels",
                json={
                    "company": "Changed",
                    "ticker": "VNM",
                    "filing_type": "BCTC",
                    "period": "Q4 2025",
                    "currency": "VND",
                    "unit": "million",
                },
            ).status_code
            == 409
        )
        filing = client.get("/api/filings").json()[0]
        assert filing["id"] == filing_id
        assert filing["status"] == "verified"


def test_page_markdown_worker_stores_acks_and_finalizes_pages(client, monkeypatch):
    automatic_review_started = threading.Event()
    automatic_review_ids = []

    def automatic_review(_bind, review_id):
        automatic_review_ids.append(review_id)
        automatic_review_started.set()

    monkeypatch.setattr(
        sync.settings, "enable_automatic_ocr_label_review", True,
    )
    monkeypatch.setattr(
        sync, "run_auto_document_label_review", automatic_review,
    )
    item = upload(client).json()["items"][0]
    with client.websocket_connect("/ws/ocr") as ws:
        pair_page_worker(ws)
        assert client.post(f"/api/ocr-inbox/{item['id']}/run").status_code == 200
        job, payload = receive_job(ws)
        assert payload == PDF_BYTES
        assert job["resultFormat"] == OCR_PAGE_RESULT_FORMAT
        assert job["resultSchemaVersion"] == 2
        assert job["requiredCapabilities"] == ["page_ack"]

        page_two = {
            "type": "page_result",
            "jobId": job["jobId"],
            "schemaVersion": 2,
            "page": 2,
            "pageCount": 2,
            "markdown": "# Trang 2\n\nNợ phải trả",
        }
        ws.send_json(page_two)
        assert ws.receive_json() == {
            "type": "page_ack",
            "jobId": job["jobId"],
            "page": 2,
            "status": "stored",
            "receivedPages": 1,
            "pageCount": 2,
        }

        ws.send_json(page_two)
        duplicate_ack = ws.receive_json()
        assert duplicate_ack["status"] == "already_stored"
        assert duplicate_ack["receivedPages"] == 1

        ws.send_json(
            {
                "type": "result_end",
                "jobId": job["jobId"],
                "schemaVersion": 2,
                "pageCount": 2,
            }
        )
        assert ws.receive_json() == {
            "type": "result_incomplete",
            "jobId": job["jobId"],
            "errorCode": "missing_pages",
            "missingPages": [1],
            "retryable": True,
        }

        ws.send_json(
            {
                "type": "page_result",
                "jobId": job["jobId"],
                "schemaVersion": 2,
                "page": 1,
                "pageCount": 2,
                "markdown": "# Trang 1\n\nTổng tài sản",
            }
        )
        assert ws.receive_json()["status"] == "stored"
        ws.send_json(
            {
                "type": "result_end",
                "jobId": job["jobId"],
                "schemaVersion": 2,
                "pageCount": 2,
            }
        )
        final_ack = ws.receive_json()
        assert final_ack["type"] == "result_ack"
        assert final_ack["status"] == "ready_for_review"
        assert final_ack["pageCount"] == 2
        assert automatic_review_started.wait(2)
        assert automatic_review_ids == [final_ack["reviewId"]]

        current = client.get(f"/api/ocr-inbox/{item['id']}").json()
        assert current["status"] == "ready_for_review"
        assert current["attempt"]["result_format"] == OCR_PAGE_RESULT_FORMAT
        assert current["attempt"]["received_pages"] == 2
        assert current["review"]["result_format"] == OCR_PAGE_RESULT_FORMAT

        review_id = final_ack["reviewId"]
        review = client.get(f"/api/ocr-inbox/reviews/{review_id}").json()
        assert review["rows"] == []
        assert [page["page"] for page in review["pages"]] == [1, 2]
        page_one = client.get(
            f"/api/ocr-inbox/reviews/{review_id}/pages/1"
        ).json()
        assert page_one["raw_markdown"] == "# Trang 1\n\nTổng tài sản"
        assert page_one["effective_markdown"] == page_one["raw_markdown"]
        assert page_one["has_previous"] is False
        assert page_one["has_next"] is True

        preview_markdown = """| Label | Value |
| --- | ---: |
| Total assets | 100 |
| Cash | 40 |
| Inventory | 60 |"""
        preview = client.post(
            f"/api/ocr-inbox/reviews/{review_id}/label-level-preview/pages/1",
            json={"revision": review["revision"], "markdown": preview_markdown},
        )
        assert preview.status_code == 200
        assert preview.json()["relationships"] == 1
        assert "ocr-label-level:0;source:auto" in preview.json()["markdown"]
        level_totals = client.post(
            f"/api/ocr-inbox/reviews/{review_id}/level-total-preview/pages/1",
            json={
                "revision": review["revision"],
                "markdown": preview.json()["markdown"],
            },
        )
        assert level_totals.status_code == 200
        assert level_totals.json()["matched"] == 1
        assert level_totals.json()["mismatched"] == 0
        # Detection is a preview; it does not save or advance the review revision.
        unchanged = client.get(f"/api/ocr-inbox/reviews/{review_id}/pages/1").json()
        assert unchanged["effective_markdown"] == "# Trang 1\n\nTổng tài sản"
        assert unchanged["revision"] == review["revision"]

        review = client.post(
            f"/api/ocr-inbox/reviews/{review_id}/pages/1/approve",
            json={"revision": review["revision"]},
        ).json()
        corrected_text = "# Trang 2\n\nNợ phải trả đã sửa"
        review = client.post(
            f"/api/ocr-inbox/reviews/{review_id}/pages/2/correct",
            json={"revision": review["revision"], "markdown": corrected_text},
        ).json()
        assert review["counts"] == {
            "total": 2,
            "pending": 0,
            "approved": 1,
            "corrected": 1,
            "resolved": 2,
        }
        raw_merged = client.get(
            f"/api/ocr-inbox/reviews/{review_id}/markdown?source=raw"
        )
        effective_merged = client.get(
            f"/api/ocr-inbox/reviews/{review_id}/markdown"
        )
        assert raw_merged.status_code == 200
        assert "Nợ phải trả đã sửa" not in raw_merged.text
        assert "Nợ phải trả đã sửa" in effective_merged.text

        verified = client.post(
            f"/api/ocr-inbox/reviews/{review_id}/verify",
            json={"revision": review["revision"]},
        )
        assert verified.status_code == 200
        assert client.get(f"/api/ocr-inbox/{item['id']}").json()["status"] == "verified"
        publish = client.post(f"/api/ocr-inbox/{item['id']}/publish")
        assert publish.status_code == 409
        assert "structurally extracted" in publish.json()["detail"]


def test_ollama_label_suggestions_require_user_decision_and_atomic_apply(
    client, monkeypatch,
):
    markdown = """| Label | Current |
| --- | ---: |
| TỔNG TÀI SẢN CỔ | 100 |
| Cash | 40 |
| Inventory | 60 |"""
    _item, review = create_markdown_review(client, markdown)

    monkeypatch.setattr(
        ocr_label_review.ai,
        "ollama_label_complete",
        lambda *_args, **_kwargs: json.dumps({
            "corrected_label": "TỔNG TÀI SẢN CÓ",
            "confidence": "high",
        }),
    )
    started = client.post(
        f"/api/ocr-inbox/reviews/{review['id']}/pages/1/label-review-runs",
        json={"revision": review["revision"], "targets": [{"table": 1, "row": 2}]},
    )
    assert started.status_code == 200
    run_id = started.json()["id"]
    run = client.get(
        f"/api/ocr-inbox/reviews/{review['id']}/pages/1/"
        f"label-review-runs/{run_id}",
    ).json()
    assert run["status"] == "completed"
    assert len(run["suggestions"]) == 1
    suggestion = run["suggestions"][0]
    assert suggestion["suggestion_kind"] == "label_text"
    assert suggestion["suggested_label"] == "TỔNG TÀI SẢN CÓ"
    assert suggestion["explanation"] == ""

    # Ollama stores a proposal only. The OCR source stays unchanged.
    before_apply = client.get(
        f"/api/ocr-inbox/reviews/{review['id']}/pages/1",
    ).json()
    assert "TỔNG TÀI SẢN CỔ" in before_apply["effective_markdown"]

    decided = client.post(
        f"/api/ocr-inbox/label-suggestions/{suggestion['id']}/decision",
        json={"decision": "accepted"},
    )
    assert decided.status_code == 200
    applied = client.post(
        f"/api/ocr-inbox/reviews/{review['id']}/pages/1/"
        "apply-label-suggestions",
        json={
            "revision": review["revision"],
            "page_content_sha256": run["page_content_sha256"],
            "suggestion_ids": [suggestion["id"]],
        },
    )
    assert applied.status_code == 200
    result = applied.json()
    assert "TỔNG TÀI SẢN CÓ" in result["page"]["effective_markdown"]
    assert "TỔNG TÀI SẢN CỔ" not in result["page"]["effective_markdown"]
    assert result["review"]["revision"] == review["revision"] + 1
    assert result["verification"]["matched"] == 1
    assert result["review"]["events"][-1]["action"] == (
        "ollama_label_suggestions_applied"
    )


def test_applying_one_ollama_label_keeps_other_suggestions_current(
    client, monkeypatch,
):
    markdown = """| Label | Current |
| --- | ---: |
| TỔNG TÀI SẢN CỔ | 100 |
| NƠ PHAI TRA | 60 |"""
    _item, review = create_markdown_review(client, markdown)
    corrections = {
        "TỔNG TÀI SẢN CỔ": "TỔNG TÀI SẢN CÓ",
        "NƠ PHAI TRA": "NỢ PHẢI TRẢ",
    }

    monkeypatch.setattr(
        ocr_label_review.ai,
        "ollama_label_complete",
        lambda _system, label, **_kwargs: json.dumps({
            "corrected_label": corrections[label],
            "confidence": "high",
        }),
    )
    started = client.post(
        f"/api/ocr-inbox/reviews/{review['id']}/pages/1/label-review-runs",
        json={
            "revision": review["revision"],
            "targets": [{"table": 1, "row": 2}, {"table": 1, "row": 3}],
        },
    )
    run = client.get(
        f"/api/ocr-inbox/reviews/{review['id']}/pages/1/"
        f"label-review-runs/{started.json()['id']}",
    ).json()
    first = next(
        item for item in run["suggestions"]
        if item["current_label"] == "TỔNG TÀI SẢN CỔ"
    )
    second = next(
        item for item in run["suggestions"]
        if item["current_label"] == "NƠ PHAI TRA"
    )

    assert client.post(
        f"/api/ocr-inbox/label-suggestions/{first['id']}/decision",
        json={"decision": "accepted"},
    ).status_code == 200
    first_apply = client.post(
        f"/api/ocr-inbox/reviews/{review['id']}/pages/1/"
        "apply-label-suggestions",
        json={
            "revision": review["revision"],
            "page_content_sha256": run["page_content_sha256"],
            "suggestion_ids": [first["id"]],
        },
    )
    assert first_apply.status_code == 200
    first_result = first_apply.json()
    rebased_run = first_result["label_review_run"]
    remaining = next(
        item for item in rebased_run["suggestions"] if item["id"] == second["id"]
    )
    assert remaining["decision"] == "pending"
    assert remaining["applied_revision"] is None

    assert client.post(
        f"/api/ocr-inbox/label-suggestions/{second['id']}/decision",
        json={"decision": "accepted"},
    ).status_code == 200
    second_apply = client.post(
        f"/api/ocr-inbox/reviews/{review['id']}/pages/1/"
        "apply-label-suggestions",
        json={
            "revision": first_result["review"]["revision"],
            "page_content_sha256": rebased_run["page_content_sha256"],
            "suggestion_ids": [second["id"]],
        },
    )
    assert second_apply.status_code == 200
    final_markdown = second_apply.json()["page"]["effective_markdown"]
    assert "TỔNG TÀI SẢN CÓ" in final_markdown
    assert "NỢ PHẢI TRẢ" in final_markdown


def test_ollama_sends_each_user_marked_label_even_without_auto_candidate(
    client, monkeypatch,
):
    markdown = """| Label | Current |
| --- | ---: |
| Section<!--ocr-label-level:L--> | - |"""
    _item, review = create_markdown_review(client, markdown)
    calls = []

    def complete(*args, **kwargs):
        calls.append((args, kwargs))
        return '{"corrected_label":"Section","confidence":"high"}'

    monkeypatch.setattr(
        ocr_label_review.ai, "ollama_label_complete", complete,
    )
    started = client.post(
        f"/api/ocr-inbox/reviews/{review['id']}/pages/1/label-review-runs",
        json={"revision": review["revision"], "targets": [{"table": 1, "row": 2}]},
    )
    assert started.status_code == 200
    run = client.get(
        f"/api/ocr-inbox/reviews/{review['id']}/pages/1/"
        f"label-review-runs/{started.json()['id']}",
    ).json()
    assert len(calls) == 1
    assert run["status"] == "completed"
    assert run["tool_call_count"] == 1
    assert run["processed_count"] == 1
    assert run["total_count"] == 1
    assert run["suggestions"] == []


def test_ollama_processes_marked_labels_one_request_at_a_time(client, monkeypatch):
    markdown = """| Label | Current |
| --- | ---: |
| TOTAL ASSETS | 100 |
| Cash | 40 |
| Inventory | 60 |"""
    _item, review = create_markdown_review(client, markdown)
    sent_labels = []
    system_prompts = []

    def complete(system, message, **_kwargs):
        system_prompts.append(system)
        sent_labels.append(message)
        return json.dumps({
            "corrected_label": message,
            "confidence": "high",
        })

    monkeypatch.setattr(
        ocr_label_review.ai, "ollama_label_complete", complete,
    )
    started = client.post(
        f"/api/ocr-inbox/reviews/{review['id']}/pages/1/label-review-runs",
        json={
            "revision": review["revision"],
            "targets": [{"table": 1, "row": 3}, {"table": 1, "row": 2}],
        },
    )
    assert started.status_code == 200
    run = client.get(
        f"/api/ocr-inbox/reviews/{review['id']}/pages/1/"
        f"label-review-runs/{started.json()['id']}",
    ).json()
    assert sent_labels == ["Cash", "TOTAL ASSETS"]
    assert system_prompts == [ocr_label_review.SYSTEM_PROMPT] * 2
    assert all("financial values" in prompt.lower() for prompt in system_prompts)
    assert all("whole label" in prompt.lower() for prompt in system_prompts)
    assert all("balance sheet" in prompt.lower() for prompt in system_prompts)
    assert all("cash-flow statement" in prompt.lower() for prompt in system_prompts)
    assert all("never add, remove, or reorder words" in prompt.lower() for prompt in system_prompts)
    assert run["status"] == "completed"
    assert run["tool_call_count"] == 2
    assert run["processed_count"] == 2


def test_ollama_label_response_rejects_explanations_and_extra_fields():
    with pytest.raises(ValueError, match="only corrected_label and confidence"):
        ocr_label_review._validated_label_correction(
            json.dumps({
                "corrected_label": "TỔNG TÀI SẢN CÓ",
                "confidence": "high",
                "explanation": "Extra text is not allowed",
            }),
            "TỔNG TÀI SẢN CỔ",
        )


def test_quick_correct_preview_reads_the_obsidian_label_library(client):
    markdown = """| Label | Current |
| --- | ---: |
| TOTAL ASSETS | 100 |
| Cash | 40 |
| Inventory | 60 |"""
    item, review = create_markdown_review(client, markdown)
    library = ocr_label_library.get_label_library(
        ocr_inbox.settings.obsidian_vault_path,
        ocr_inbox.settings.obsidian_label_library_path,
    )
    for document_hash in ("a" * 64, "b" * 64, "c" * 64):
        library.record_verified_page("balance_sheet", markdown, document_hash)

    response = client.post(
        f"/api/ocr-inbox/reviews/{review['id']}/pages/1/quick-correct-preview",
        json={"revision": review["revision"], "statement_type": "balance_sheet"},
    )
    assert response.status_code == 200
    payload = response.json()
    cash = next(item for item in payload["suggestions"] if item["current_label"] == "Cash")
    assert cash["source"] == "quick_correct"
    assert cash["confidence"] == "strong"
    assert cash["suggested_level"] == 1


def test_verified_page_can_seed_the_obsidian_quick_correct_library(client):
    markdown = """| Label | Current |
| --- | ---: |
| TOTAL ASSETS | 100 |
| Cash | 40 |
| Inventory | 60 |"""
    _item, review = create_markdown_review(client, markdown)
    resolved = client.post(
        f"/api/ocr-inbox/reviews/{review['id']}/pages/1/approve",
        json={"revision": review["revision"]},
    ).json()
    resolved = client.post(
        f"/api/ocr-inbox/reviews/{review['id']}/pages/2/approve",
        json={"revision": resolved["revision"]},
    ).json()
    verified = client.post(
        f"/api/ocr-inbox/reviews/{review['id']}/verify",
        json={"revision": resolved["revision"]},
    )
    assert verified.status_code == 200

    seeded = client.post(
        f"/api/ocr-inbox/reviews/{review['id']}/pages/1/quick-correct-library",
        json={
            "revision": verified.json()["revision"],
            "statement_type": "balance_sheet",
        },
    )
    assert seeded.status_code == 200
    assert seeded.json()["notes_updated"] == 3


def test_invalid_worker_contract_fails_without_automatic_retry(client):
    item = upload(client).json()["items"][0]
    with client.websocket_connect("/ws/ocr") as ws:
        pair(ws)
        client.post(f"/api/ocr-inbox/{item['id']}/run")
        job, _ = receive_job(ws)

        invalid_rows = result_rows()
        for row in invalid_rows:
            row.pop("bbox")
        ws.send_json(
            {
                "type": "result",
                "jobId": job["jobId"],
                "rows": invalid_rows,
            }
        )

        rejected = ws.receive_json()
        assert rejected["type"] == "result_rejected"
        assert rejected["errorCode"] == "invalid_result"
        assert rejected["retryable"] is False
        assert "schemaVersion: Field required" in rejected["error"]
        assert "rows.0.bbox: Field required" in rejected["error"]

        current = client.get(f"/api/ocr-inbox/{item['id']}").json()
        assert current["status"] == "failed"
        assert current["attempt"]["automatic"] is False


@pytest.mark.parametrize(
    ("action", "expected_status"),
    [
        ("hold", "held"),
        ("stop", "uploaded"),
    ],
)
def test_active_inbox_job_can_be_controlled_and_run_again(
    client, action, expected_status
):
    item = upload(client).json()["items"][0]
    with client.websocket_connect("/ws/ocr") as ws:
        pair(ws)
        assert client.post(f"/api/ocr-inbox/{item['id']}/run").status_code == 200
        job, _ = receive_job(ws)

        controlled = client.post(
            f"/api/sync/jobs/{job['jobId']}/control",
            json={"action": action},
        )
        assert controlled.status_code == 200
        assert ws.receive_json() == {
            "type": "job_control",
            "jobId": job["jobId"],
            "action": action,
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
        ws.send_json(
            {
                "type": "result",
                "jobId": job["jobId"],
                "schemaVersion": 1,
                "rows": result_rows()[:1],
            }
        )
        ack = ws.receive_json()
        assert ack["type"] == "result_ack"
        assert ack["rowCount"] == 1
        for _ in range(50):
            current = client.get(f"/api/ocr-inbox/{item['id']}").json()
            if current["status"] == "ready_for_review" and current["review"]:
                break
        review_response = client.get(
            f"/api/ocr-inbox/reviews/{current['review']['id']}"
        )
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
        assert (
            client.post(
                f"/api/ocr-inbox/reviews/{review['id']}/verify",
                json={"revision": accepted.json()["revision"]},
            ).status_code
            == 409
        )
        stale = client.post(
            f"/api/ocr-inbox/reviews/{review['id']}/rows/{row_id}/restore",
            json={"revision": review["revision"]},
        )
        assert stale.status_code == 409

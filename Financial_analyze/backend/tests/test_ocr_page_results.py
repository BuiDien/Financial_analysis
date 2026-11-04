import pytest

from app.config import get_settings
from app.models.ocr import (
    OCRAttempt, OCRInboxItem, OCRLabelReviewRun, OCRPageResult,
)
from app.services import ocr_label_review
from app.services.ocr_auto_label_review import run_auto_document_label_review
from app.services.ocr_label_library import get_label_library
from app.services.ocr_page_results import (
    OCRPageConflictError, finalize_page_result, store_page_result,
)


def _attempt(db, tmp_path, pages=2):
    item = OCRInboxItem(
        filename="statement.pdf",
        storage_path=str(tmp_path / "statement.pdf"),
        size_bytes=8,
        pages=pages,
        checksum_sha256="a" * 64,
        status="processing",
    )
    attempt = OCRAttempt(status="processing", job_id="job_test")
    item.attempts.append(attempt)
    db.add(item)
    db.commit()
    return attempt, item


def _message(page, markdown, page_count=2):
    return {
        "type": "page_result",
        "jobId": "job_test",
        "schemaVersion": 2,
        "page": page,
        "pageCount": page_count,
        "markdown": markdown,
    }


def test_pages_store_exactly_and_identical_retry_is_idempotent(db, tmp_path):
    attempt, item = _attempt(db, tmp_path)

    page, status = store_page_result(db, attempt, item, _message(1, "# Một"))
    db.commit()
    retried, retry_status = store_page_result(
        db, attempt, item, _message(1, "# Một")
    )
    db.commit()

    assert status == "stored"
    assert retry_status == "already_stored"
    assert retried.id == page.id
    assert db.query(OCRPageResult).count() == 1
    assert attempt.received_pages == 1
    assert page.raw_markdown == "# Một"


def test_conflicting_retry_preserves_first_page(db, tmp_path):
    attempt, item = _attempt(db, tmp_path)
    store_page_result(db, attempt, item, _message(1, "first"))
    db.commit()

    with pytest.raises(OCRPageConflictError, match="different content"):
        store_page_result(db, attempt, item, _message(1, "changed"))

    db.rollback()
    assert db.query(OCRPageResult).one().raw_markdown == "first"


def test_result_end_reports_missing_pages_without_failing(db, tmp_path):
    attempt, item = _attempt(db, tmp_path)
    store_page_result(db, attempt, item, _message(2, "second"))
    db.commit()

    review, missing = finalize_page_result(
        db,
        attempt,
        item,
        {
            "type": "result_end",
            "jobId": "job_test",
            "schemaVersion": 2,
            "pageCount": 2,
        },
    )

    assert review is None
    assert missing == [1]
    assert attempt.status == "receiving_pages"


def test_out_of_order_pages_are_merged_in_page_order(db, tmp_path):
    attempt, item = _attempt(db, tmp_path)
    store_page_result(db, attempt, item, _message(2, "second"))
    store_page_result(db, attempt, item, _message(1, "first"))
    db.commit()

    review, missing = finalize_page_result(
        db,
        attempt,
        item,
        {
            "type": "result_end",
            "jobId": "job_test",
            "schemaVersion": 2,
            "pageCount": 2,
        },
    )
    db.commit()

    assert missing == []
    assert review.result_format == "page_markdown_v2"
    assert attempt.status == "done"
    assert attempt.received_pages == 2
    assert attempt.merged_markdown.index("PAGE:1") < attempt.merged_markdown.index("PAGE:2")
    assert item.status == "ready_for_review"


def test_completed_document_queues_obsidian_and_ollama_labels_once(
    db, tmp_path, monkeypatch,
):
    settings = get_settings()
    monkeypatch.setattr(settings, "enable_automatic_ocr_label_review", True)
    monkeypatch.setattr(settings, "automatic_ocr_label_limit", 20)
    monkeypatch.setattr(settings, "obsidian_vault_path", str(tmp_path / "vault"))
    monkeypatch.setattr(
        settings,
        "obsidian_label_library_path",
        "Financial Analyze/Label Library",
    )
    library = get_label_library(
        settings.obsidian_vault_path,
        settings.obsidian_label_library_path,
    )
    library.record_verified_page(
        "balance_sheet",
        """| Label | Current |
| --- | ---: |
| NỢ PHẢI TRẢ | 60 |""",
        "b" * 64,
    )
    attempt, item = _attempt(db, tmp_path)
    first, _status = store_page_result(
        db,
        attempt,
        item,
        _message(1, """| Label | Current |
| --- | ---: |
| NƠ PHAI TRA | 60 |"""),
    )
    second, _status = store_page_result(
        db,
        attempt,
        item,
        _message(2, """| Label | Current |
| --- | ---: |
| LƠI NHUÂN SAU THUÊ | 40 |"""),
    )
    review, missing = finalize_page_result(
        db,
        attempt,
        item,
        {
            "type": "result_end",
            "jobId": "job_test",
            "schemaVersion": 2,
            "pageCount": 2,
        },
    )
    db.commit()
    assert missing == []
    assert first.label_check_summary["candidates"][0]["source"] == "obsidian"
    assert second.label_check_summary["candidates"][0]["source"] == "ollama"

    ollama_labels = []

    def complete(_system, label, **_kwargs):
        ollama_labels.append(label)
        return (
            '{"corrected_label":"LỢI NHUẬN SAU THUẾ",'
            '"confidence":"high"}'
        )

    monkeypatch.setattr(ocr_label_review.ai, "ollama_label_complete", complete)
    run_auto_document_label_review(db.get_bind(), review.id)
    db.expire_all()

    runs = (
        db.query(OCRLabelReviewRun)
        .filter_by(review_id=review.id, trigger="worker_auto")
        .order_by(OCRLabelReviewRun.page_number)
        .all()
    )
    assert len(runs) == 2
    assert [run.status for run in runs] == ["completed", "completed"]
    assert [run.tool_call_count for run in runs] == [0, 1]
    assert runs[0].suggestions[0].suggested_label == "NỢ PHẢI TRẢ"
    assert runs[0].suggestions[0].reason_codes == ["obsidian_verified_label"]
    assert runs[1].suggestions[0].suggested_label == "LỢI NHUẬN SAU THUẾ"
    assert ollama_labels == ["LƠI NHUÂN SAU THUÊ"]

    run_auto_document_label_review(db.get_bind(), review.id)
    assert db.query(OCRLabelReviewRun).filter_by(review_id=review.id).count() == 2

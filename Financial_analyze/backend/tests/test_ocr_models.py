from app.models.ocr import (
    OCRAttempt, OCRInboxItem, OCRPageResult, OCRReviewJob, OCRReviewRow,
)


def test_ocr_models_persist_review_relationships(db, tmp_path):
    item = OCRInboxItem(
        filename="statement.pdf",
        storage_path=str(tmp_path / "statement.pdf"),
        size_bytes=8,
        pages=1,
        checksum_sha256="a" * 64,
    )
    attempt = OCRAttempt(status="done", job_id="job_test")
    item.attempts.append(attempt)
    db.add(item)
    db.flush()

    review = OCRReviewJob(inbox_item_id=item.id, attempt=attempt)
    review.rows.append(OCRReviewRow(
        source_index=0,
        raw_data={"code": "270", "curr": "1"},
        page=1,
        bbox={"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.04},
        confidence=95,
    ))
    db.add(review)
    db.commit()

    saved = db.query(OCRInboxItem).one()
    assert saved.status == "uploaded"
    assert saved.attempts[0].job_id == "job_test"
    assert saved.reviews[0].rows[0].status == "pending"
    assert saved.reviews[0].rows[0].raw_data["code"] == "270"


def test_ocr_page_results_are_ordered_and_cascade_with_attempt(db, tmp_path):
    item = OCRInboxItem(
        filename="pages.pdf",
        storage_path=str(tmp_path / "pages.pdf"),
        size_bytes=8,
        pages=2,
        checksum_sha256="b" * 64,
    )
    attempt = OCRAttempt(status="receiving_pages", job_id="job_pages")
    attempt.pages.extend([
        OCRPageResult(
            page_number=2, raw_markdown="two", content_sha256="2" * 64,
            byte_size=3,
        ),
        OCRPageResult(
            page_number=1, raw_markdown="one", content_sha256="1" * 64,
            byte_size=3,
        ),
    ])
    item.attempts.append(attempt)
    db.add(item)
    db.commit()

    assert [page.page_number for page in attempt.pages] == [1, 2]
    db.delete(attempt)
    db.commit()
    assert db.query(OCRPageResult).count() == 0

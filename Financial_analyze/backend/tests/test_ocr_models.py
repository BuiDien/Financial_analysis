from app.models.ocr import OCRAttempt, OCRInboxItem, OCRReviewJob, OCRReviewRow


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

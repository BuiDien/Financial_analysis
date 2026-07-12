import json
from datetime import datetime, timezone

from pydantic import ValidationError
from sqlalchemy.orm import Session

from ..models.ocr import OCRAttempt, OCRAuditEvent, OCRInboxItem, OCRReviewJob, OCRReviewRow
from ..ocr_contract import MAX_RESULT_BYTES, OCRWorkerResult


def validate_worker_result(message: dict, page_count: int) -> OCRWorkerResult:
    encoded_size = len(json.dumps(message, ensure_ascii=False).encode("utf-8"))
    if encoded_size > MAX_RESULT_BYTES:
        raise ValueError("OCR result exceeds the maximum message size")
    try:
        result = OCRWorkerResult.model_validate(message)
    except ValidationError as exc:
        raise ValueError(str(exc)) from exc
    for row in result.rows:
        if page_count and row.page > page_count:
            raise ValueError(f"row page {row.page} exceeds document page count {page_count}")
    return result


def create_review_from_result(
    db: Session, attempt: OCRAttempt, item: OCRInboxItem, message: dict,
) -> OCRReviewJob:
    if attempt.review is not None:
        raise ValueError("attempt already has a completed result")
    result = validate_worker_result(message, item.pages)
    review = OCRReviewJob(
        inbox_item=item,
        attempt=attempt,
        status="ready_for_review",
        schema_version=result.schemaVersion,
    )
    for index, row in enumerate(result.rows):
        data = row.model_dump(mode="json", exclude_none=True)
        review.rows.append(OCRReviewRow(
            source_index=index,
            raw_data=data,
            page=row.page,
            bbox=row.bbox.model_dump(mode="json"),
            confidence=row.confidence,
        ))
    attempt.status = "done"
    attempt.progress = 100
    attempt.schema_version = result.schemaVersion
    attempt.finished_at = datetime.now(timezone.utc)
    item.status = "ready_for_review"
    item.error = None
    db.add(review)
    db.flush()
    review.events.append(OCRAuditEvent(
        action="result_received",
        revision=review.revision,
        after_data={"row_count": len(review.rows), "schema_version": result.schemaVersion},
    ))
    return review


def review_counts(review: OCRReviewJob) -> dict:
    counts = {"total": len(review.rows), "pending": 0, "approved": 0,
              "corrected": 0, "rejected": 0, "manually_added": 0}
    for row in review.rows:
        counts[row.status] = counts.get(row.status, 0) + 1
    counts["resolved"] = counts["total"] - counts["pending"]
    return counts

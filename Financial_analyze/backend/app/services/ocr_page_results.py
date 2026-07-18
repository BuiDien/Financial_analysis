import hashlib
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..models.ocr import (
    OCRAttempt, OCRAuditEvent, OCRInboxItem, OCRPageResult, OCRReviewJob,
)
from ..ocr_page_contract import (
    MAX_DOCUMENT_MARKDOWN_BYTES, OCR_PAGE_RESULT_FORMAT, OCR_PAGE_SCHEMA_VERSION,
    OCRPageContractError, validate_page_message, validate_result_end,
)


class OCRPageConflictError(OCRPageContractError):
    code = "page_conflict"


def store_page_result(
    db: Session, attempt: OCRAttempt, item: OCRInboxItem, message: dict,
) -> tuple[OCRPageResult, str]:
    if not attempt.job_id:
        raise OCRPageContractError("OCR attempt has no active jobId")
    if attempt.status in {"failed", "held", "canceled"}:
        raise OCRPageContractError(
            f"OCR attempt cannot accept pages while it is {attempt.status}"
        )
    result = validate_page_message(
        message, expected_job_id=attempt.job_id, expected_pages=item.pages,
    )
    raw_bytes = result.markdown.encode("utf-8")
    checksum = hashlib.sha256(raw_bytes).hexdigest()
    existing = (
        db.query(OCRPageResult)
        .filter_by(attempt_id=attempt.id, page_number=result.page)
        .first()
    )
    if existing:
        if existing.content_sha256 != checksum or existing.raw_markdown != result.markdown:
            raise OCRPageConflictError(
                f"Page {result.page} was already stored with different content"
            )
        return existing, "already_stored"

    page = OCRPageResult(
        attempt=attempt,
        page_number=result.page,
        raw_markdown=result.markdown,
        content_sha256=checksum,
        byte_size=len(raw_bytes),
    )
    db.add(page)
    db.flush()
    attempt.result_format = OCR_PAGE_RESULT_FORMAT
    attempt.schema_version = OCR_PAGE_SCHEMA_VERSION
    attempt.expected_pages = result.pageCount
    attempt.received_pages = (
        db.query(OCRPageResult).filter_by(attempt_id=attempt.id).count()
    )
    attempt.status = "receiving_pages"
    attempt.error = None
    return page, "stored"


def missing_page_numbers(
    db: Session, attempt: OCRAttempt, page_count: int,
) -> list[int]:
    received = {
        page_number
        for (page_number,) in (
            db.query(OCRPageResult.page_number)
            .filter_by(attempt_id=attempt.id)
            .all()
        )
    }
    return [page for page in range(1, page_count + 1) if page not in received]


def _merge_pages(pages: list[OCRPageResult]) -> str:
    sections = []
    for page in pages:
        sections.append(
            f"<!-- PAGE:{page.page_number} -->\n\n{page.raw_markdown}"
        )
    return "\n\n---\n\n".join(sections)


def finalize_page_result(
    db: Session, attempt: OCRAttempt, item: OCRInboxItem, message: dict,
) -> tuple[OCRReviewJob | None, list[int]]:
    if not attempt.job_id:
        raise OCRPageContractError("OCR attempt has no active jobId")
    if attempt.status in {"failed", "held", "canceled"}:
        raise OCRPageContractError(
            f"OCR attempt cannot be finalized while it is {attempt.status}"
        )
    result = validate_result_end(
        message, expected_job_id=attempt.job_id, expected_pages=item.pages,
    )
    missing = missing_page_numbers(db, attempt, result.pageCount)
    if missing:
        attempt.status = "receiving_pages"
        return None, missing

    if attempt.review is not None:
        if attempt.status == "done" and attempt.review.result_format == OCR_PAGE_RESULT_FORMAT:
            return attempt.review, []
        raise OCRPageContractError("OCR attempt already has a different completed result")

    pages = (
        db.query(OCRPageResult)
        .filter_by(attempt_id=attempt.id)
        .order_by(OCRPageResult.page_number.asc())
        .all()
    )
    total_bytes = sum(page.byte_size for page in pages)
    if total_bytes > MAX_DOCUMENT_MARKDOWN_BYTES:
        raise OCRPageContractError("Document Markdown exceeds the 20 MiB limit")

    attempt.status = "assembling"
    merged = _merge_pages(pages)
    review = OCRReviewJob(
        inbox_item=item,
        attempt=attempt,
        status="ready_for_review",
        schema_version=OCR_PAGE_SCHEMA_VERSION,
        result_format=OCR_PAGE_RESULT_FORMAT,
    )
    db.add(review)
    db.flush()

    attempt.status = "done"
    attempt.progress = 100
    attempt.result_format = OCR_PAGE_RESULT_FORMAT
    attempt.schema_version = OCR_PAGE_SCHEMA_VERSION
    attempt.expected_pages = result.pageCount
    attempt.received_pages = len(pages)
    attempt.merged_markdown = merged
    attempt.result_sha256 = hashlib.sha256(merged.encode("utf-8")).hexdigest()
    attempt.finished_at = datetime.now(timezone.utc)
    item.status = "ready_for_review"
    item.error = None
    review.events.append(OCRAuditEvent(
        action="page_result_received",
        revision=review.revision,
        after_data={
            "page_count": len(pages),
            "schema_version": OCR_PAGE_SCHEMA_VERSION,
            "result_format": OCR_PAGE_RESULT_FORMAT,
            "byte_size": total_bytes,
            "sha256": attempt.result_sha256,
        },
    ))
    return review, []

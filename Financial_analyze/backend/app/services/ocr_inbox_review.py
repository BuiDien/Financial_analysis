"""OCR review content: Markdown pages and structured rows, verification,
reopening, label-level/total previews and company-history answers."""

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..models.ocr import (
    OCRAuditEvent, OCRLabelReviewRun, OCRLabelSuggestion, OCRPageResult,
    OCRReviewJob, OCRReviewRow,
)
from ..ocr_contract import OCRResultRow
from ..ocr_page_contract import MAX_PAGE_MARKDOWN_BYTES, OCR_PAGE_RESULT_FORMAT
from . import history_lines
from . import history_store
from . import ocr_label_review
from .errors import ServiceError
from .ocr_inbox import get_item, latest_review
from .ocr_inbox_schemas import (
    AutoLabelLevelsIn, HistoryAnswersIn, MarkdownReviewActionIn, ReopenReviewIn,
    ReviewActionIn,
)
from .ocr_label_levels import auto_level_markdown, verify_level_totals
from .ocr_review import review_counts
from .ocr_total_checks import page_total_check


def load_review(db: Session, review_id: int) -> OCRReviewJob:
    review = db.query(OCRReviewJob).filter_by(id=review_id).first()
    if not review:
        raise ServiceError(404, "OCR review not found")
    return review


def _serialize_row(row: OCRReviewRow) -> dict:
    return {
        "id": row.id, "source_index": row.source_index, "status": row.status,
        "raw": row.raw_data, "reviewed": row.reviewed_data,
        "page": row.page, "bbox": row.bbox, "confidence": row.confidence,
        "rejection_reason": row.rejection_reason,
    }


def serialize_page(page: OCRPageResult, *, include_markdown: bool = False) -> dict:
    effective = (
        page.reviewed_markdown if page.reviewed_markdown is not None else page.raw_markdown
    )
    data = {
        "id": page.id,
        "page": page.page_number,
        "status": page.review_status,
        "byte_size": page.byte_size,
        "content_sha256": page.content_sha256,
        "has_correction": page.reviewed_markdown is not None,
        "label_check": {
            "status": page.label_check_status,
            "label_count": (page.label_check_summary or {}).get("label_count", 0),
            "known_count": (page.label_check_summary or {}).get("known_count", 0),
            "candidate_count": (page.label_check_summary or {}).get(
                "candidate_count", 0,
            ),
            "error": page.label_check_error,
            "checked_at": (
                page.label_checked_at.isoformat() if page.label_checked_at else None
            ),
        },
        # Computed on read from the current text, so it follows every correction.
        "total_check": page_total_check(effective),
    }
    if include_markdown:
        data.update({
            "raw_markdown": page.raw_markdown,
            "reviewed_markdown": page.reviewed_markdown,
            "effective_markdown": effective,
        })
    return data


def serialize_review(review: OCRReviewJob) -> dict:
    return {
        "id": review.id, "inbox_item_id": review.inbox_item_id,
        "status": review.status, "revision": review.revision,
        "schema_version": review.schema_version,
        "result_format": review.result_format,
        "counts": review_counts(review),
        "rows": (
            [_serialize_row(row) for row in review.rows]
            if review.result_format != OCR_PAGE_RESULT_FORMAT else []
        ),
        "pages": (
            [serialize_page(page) for page in review.attempt.pages]
            if review.result_format == OCR_PAGE_RESULT_FORMAT else []
        ),
        "merged_markdown_sha256": review.attempt.result_sha256,
        "events": [{
            "id": event.id, "row_id": event.row_id, "action": event.action,
            "actor": event.actor, "revision": event.revision,
            "before": event.before_data,
            "after": event.after_data,
            "created_at": event.created_at.isoformat() if event.created_at else None,
        } for event in review.events],
    }


def review_view(db: Session, review_id: int) -> dict:
    return serialize_review(load_review(db, review_id))


def load_review_page(
    db: Session, review: OCRReviewJob, page_number: int,
) -> OCRPageResult:
    if review.result_format != OCR_PAGE_RESULT_FORMAT:
        raise ServiceError(409, "This review contains structured rows, not Markdown pages")
    page = (
        db.query(OCRPageResult)
        .filter_by(attempt_id=review.attempt_id, page_number=page_number)
        .first()
    )
    if not page:
        raise ServiceError(404, "OCR review page not found")
    return page


def review_page_view(db: Session, review_id: int, page_number: int) -> dict:
    review = load_review(db, review_id)
    page = load_review_page(db, review, page_number)
    result = serialize_page(page, include_markdown=True)
    result.update({
        "review_id": review.id,
        "revision": review.revision,
        "page_count": review.attempt.expected_pages,
        "has_previous": page_number > 1,
        "has_next": page_number < (review.attempt.expected_pages or 0),
    })
    return result


def _effective_merged_markdown(review: OCRReviewJob) -> str:
    sections = []
    for page in review.attempt.pages:
        markdown = (
            page.reviewed_markdown
            if page.reviewed_markdown is not None
            else page.raw_markdown
        )
        sections.append(f"<!-- PAGE:{page.page_number} -->\n\n{markdown}")
    return "\n\n---\n\n".join(sections)


def review_markdown(db: Session, review_id: int, source: str = "effective") -> str:
    review = load_review(db, review_id)
    if review.result_format != OCR_PAGE_RESULT_FORMAT:
        raise ServiceError(409, "This review does not contain Markdown pages")
    if source == "raw":
        return review.attempt.merged_markdown or ""
    if source != "effective":
        raise ServiceError(422, "source must be raw or effective")
    return _effective_merged_markdown(review)


def _mutate_page(
    review: OCRReviewJob, page: OCRPageResult, action: str,
    payload: MarkdownReviewActionIn, db: Session,
):
    if payload.revision != review.revision:
        raise ServiceError(409, "Review changed; refresh before saving")
    if review.status in {"verified", "published"}:
        raise ServiceError(409, "Verified reviews must be reopened before editing")
    before = serialize_page(page, include_markdown=True)
    if action == "approve":
        page.review_status = "approved"
        page.reviewed_markdown = None
    elif action == "correct":
        if payload.markdown is None:
            raise ServiceError(422, "Corrected Markdown is required")
        if len(payload.markdown.encode("utf-8")) > MAX_PAGE_MARKDOWN_BYTES:
            raise ServiceError(422, "Corrected Markdown exceeds the 1 MiB page limit")
        page.review_status = "corrected"
        page.reviewed_markdown = payload.markdown
    elif action == "restore":
        page.review_status = "pending"
        page.reviewed_markdown = None
    else:
        raise ServiceError(404, "Unknown page review action")
    review.status = "reviewing"
    review.revision += 1
    review.events.append(OCRAuditEvent(
        action=f"page_{action}",
        revision=review.revision,
        before_data=before,
        after_data=serialize_page(page, include_markdown=True),
    ))
    db.commit()
    db.refresh(review)
    return serialize_review(review)


def preview_label_levels(
    db: Session, review_id: int, page_number: int, payload: AutoLabelLevelsIn,
) -> dict:
    review = load_review(db, review_id)
    load_review_page(db, review, page_number)
    if payload.revision != review.revision:
        raise ServiceError(409, "Review changed; refresh before detecting label levels")
    if review.status in {"verified", "published"}:
        raise ServiceError(409, "Verified reviews must be reopened before editing")
    if len(payload.markdown.encode("utf-8")) > MAX_PAGE_MARKDOWN_BYTES:
        raise ServiceError(422, "Corrected Markdown exceeds the 1 MiB page limit")
    result = auto_level_markdown(payload.markdown)
    if not result["tables"]:
        raise ServiceError(422, "No table was found on this page")
    return result


def preview_level_totals(
    db: Session, review_id: int, page_number: int, payload: AutoLabelLevelsIn,
) -> dict:
    review = load_review(db, review_id)
    load_review_page(db, review, page_number)
    if payload.revision != review.revision:
        raise ServiceError(409, "Review changed; refresh before verifying level totals")
    if len(payload.markdown.encode("utf-8")) > MAX_PAGE_MARKDOWN_BYTES:
        raise ServiceError(422, "Corrected Markdown exceeds the 1 MiB page limit")
    result = verify_level_totals(payload.markdown)
    if not result["tables"]:
        raise ServiceError(422, "No table was found on this page")
    return result


def mutate_review_page(
    db: Session, review_id: int, page_number: int, action: str,
    payload: MarkdownReviewActionIn,
) -> dict:
    review = load_review(db, review_id)
    page = load_review_page(db, review, page_number)
    return _mutate_page(review, page, action, payload, db)


def _mutate_row(review: OCRReviewJob, row: OCRReviewRow, action: str,
                payload: ReviewActionIn, db: Session):
    if payload.revision != review.revision:
        raise ServiceError(409, "Review changed; refresh before saving")
    if review.status in {"verified", "published"}:
        raise ServiceError(409, "Verified reviews must be reopened before editing")
    before = _serialize_row(row)
    if action == "approve":
        row.status, row.reviewed_data, row.rejection_reason = "approved", None, None
    elif action == "correct":
        if not payload.data:
            raise ServiceError(422, "Corrected row data is required")
        merged = dict(row.raw_data)
        merged.update(payload.data)
        try:
            corrected = OCRResultRow.model_validate(merged)
        except Exception as exc:
            raise ServiceError(422, f"Invalid corrected row: {exc}") from exc
        if corrected.page > review.inbox_item.pages:
            raise ServiceError(422, "Corrected page exceeds document page count")
        row.status = "corrected"
        row.reviewed_data = corrected.model_dump(mode="json", exclude_none=True)
        row.page = corrected.page
        row.bbox = corrected.bbox.model_dump(mode="json")
        row.confidence = corrected.confidence
        row.rejection_reason = None
    elif action == "reject":
        reason = (payload.reason or "").strip()
        if not reason:
            raise ServiceError(422, "A rejection reason is required")
        row.status, row.rejection_reason = "rejected", reason
        row.reviewed_data = None
    elif action == "restore":
        row.status, row.reviewed_data, row.rejection_reason = "pending", None, None
    review.status = "reviewing"
    review.revision += 1
    review.events.append(OCRAuditEvent(
        row=row, action=action, revision=review.revision,
        before_data=before, after_data=_serialize_row(row),
    ))
    db.commit()
    db.refresh(review)
    return serialize_review(review)


def mutate_review_row(
    db: Session, review_id: int, row_id: int, action: str, payload: ReviewActionIn,
) -> dict:
    if action not in {"approve", "correct", "reject", "restore"}:
        raise ServiceError(404, "Unknown review action")
    review = load_review(db, review_id)
    row = db.query(OCRReviewRow).filter_by(id=row_id, review_id=review.id).first()
    if not row:
        raise ServiceError(404, "OCR review row not found")
    return _mutate_row(review, row, action, payload, db)


def add_manual_row(db: Session, review_id: int, payload: ReviewActionIn) -> dict:
    review = load_review(db, review_id)
    if review.result_format == OCR_PAGE_RESULT_FORMAT:
        raise ServiceError(409, "Markdown page reviews cannot contain structured rows")
    if payload.revision != review.revision:
        raise ServiceError(409, "Review changed; refresh before saving")
    if review.status in {"verified", "published"}:
        raise ServiceError(409, "Verified reviews must be reopened before editing")
    if not payload.data:
        raise ServiceError(422, "Manual row data is required")
    try:
        data = OCRResultRow.model_validate(payload.data)
    except Exception as exc:
        raise ServiceError(422, f"Invalid manual row: {exc}") from exc
    if data.page > review.inbox_item.pages:
        raise ServiceError(422, "Manual row page exceeds document page count")
    next_index = max((row.source_index for row in review.rows), default=-1) + 1
    row = OCRReviewRow(
        source_index=next_index, status="manually_added", raw_data={},
        reviewed_data=data.model_dump(mode="json", exclude_none=True),
        page=data.page, bbox=data.bbox.model_dump(mode="json"),
        confidence=data.confidence,
    )
    review.rows.append(row)
    review.status = "reviewing"
    review.revision += 1
    review.events.append(OCRAuditEvent(
        row=row, action="manual_add", revision=review.revision,
        after_data=data.model_dump(mode="json", exclude_none=True),
    ))
    db.commit()
    db.refresh(review)
    return serialize_review(review)


def verify_review(db: Session, review_id: int, payload: ReviewActionIn) -> dict:
    review = load_review(db, review_id)
    if payload.revision != review.revision:
        raise ServiceError(409, "Review changed; refresh before verifying")
    if review.status in {"verified", "published"}:
        raise ServiceError(409, "Review is already verified")
    if review.result_format == OCR_PAGE_RESULT_FORMAT:
        if not review.attempt.pages or any(
            page.review_status == "pending" for page in review.attempt.pages
        ):
            raise ServiceError(
                409, "Every OCR Markdown page must be resolved before verification"
            )
        unresolved_suggestions = (
            db.query(OCRLabelSuggestion)
            .join(OCRLabelReviewRun)
            .filter(
                OCRLabelReviewRun.review_id == review.id,
                OCRLabelSuggestion.applied_revision.is_(None),
                OCRLabelSuggestion.decision.in_(("pending", "accepted", "edited")),
            )
            .all()
        )
        current_page_hashes = {
            page.page_number: ocr_label_review.content_sha256(
                ocr_label_review.page_markdown(page),
            )
            for page in review.attempt.pages
        }
        if any(
            suggestion.run.page_content_sha256
            == current_page_hashes.get(suggestion.run.page_number)
            for suggestion in unresolved_suggestions
        ):
            raise ServiceError(
                409,
                "Resolve or reject current Ollama label suggestions before verification",
            )
    else:
        if not review.rows or any(row.status == "pending" for row in review.rows):
            raise ServiceError(409, "Every OCR row must be resolved before verification")
        if all(row.status == "rejected" for row in review.rows):
            raise ServiceError(409, "At least one approved, corrected, or manual row is required")
    review.status = "verified"
    review.verified_at = datetime.now(timezone.utc)
    review.revision += 1
    item = review.inbox_item
    labels_complete = all((item.company, item.ticker, item.filing_type, item.period,
                           item.currency, item.unit))
    item.status = (
        "verified"
        if review.result_format == OCR_PAGE_RESULT_FORMAT
        else ("ready_to_publish" if labels_complete else "verified")
    )
    review.events.append(OCRAuditEvent(
        action="verified", revision=review.revision,
        after_data=review_counts(review),
    ))
    db.commit()
    db.refresh(review)
    return serialize_review(review)


def _history_review(db: Session, review_id: int, payload: HistoryAnswersIn):
    review = load_review(db, review_id)
    if payload.revision != review.revision:
        raise ServiceError(409, "Review changed; refresh before adding to history")
    if latest_review(review.inbox_item) is not review:
        raise ServiceError(409, "A newer OCR review exists for this document; use that one")
    answers = payload.model_dump(mode="json", exclude={"revision"})
    return review, answers


def _history_catalog():
    try:
        return history_store.default_catalog()
    except history_lines.LabelLibraryError as exc:
        raise ServiceError(503, str(exc)) from exc


def preview_history(db: Session, review_id: int, payload: HistoryAnswersIn) -> dict:
    review, answers = _history_review(db, review_id, payload)
    try:
        return history_store.history_preview(db, review, answers, catalog=_history_catalog())
    except history_lines.LabelLibraryError as exc:
        raise ServiceError(422, str(exc)) from exc


def write_history(db: Session, review_id: int, payload: HistoryAnswersIn) -> dict:
    review, answers = _history_review(db, review_id, payload)
    try:
        return history_store.history_write(db, review, answers, catalog=_history_catalog())
    except history_store.HistoryBlocked as exc:
        raise ServiceError(409, {
            "message": "Answer the open questions before adding to history",
            "blocking": exc.blocking,
        }) from exc
    except (history_store.HistoryError, history_lines.LabelLibraryError) as exc:
        db.rollback()
        raise ServiceError(422, str(exc)) from exc


def reopen_review(db: Session, item_id: int, payload: ReopenReviewIn) -> dict:
    """Return a verified (unpublished) review to editing.

    The edit guards say "Verified reviews must be reopened before editing";
    this is that reopen. Published reviews stay frozen (a Filing exists), and
    a document already written to company history must be removed from it
    first so history never holds facts from a review that is being edited.
    """
    item = get_item(db, item_id)
    review = latest_review(item)
    if not review:
        raise ServiceError(409, "This document has no OCR review to reopen")
    if payload.revision != review.revision:
        raise ServiceError(409, "Review changed; refresh before reopening")
    if review.status == "published" or item.published_filing_id:
        raise ServiceError(409, "Published reviews cannot be reopened")
    if review.status != "verified":
        raise ServiceError(409, "Only verified reviews can be reopened")
    if history_store.is_in_history(db, item):
        raise ServiceError(
            409, "Remove this document from company history before reopening it",
        )
    before = {"status": review.status, "item_status": item.status}
    review.status = "reviewing"
    review.verified_at = None
    review.revision += 1
    item.status = "ready_for_review"
    reason = (payload.reason or "").strip() or None
    review.events.append(OCRAuditEvent(
        action="reopened", revision=review.revision,
        before_data=before,
        after_data={"status": review.status, "item_status": item.status, "reason": reason},
    ))
    db.commit()
    db.refresh(review)
    return serialize_review(review)

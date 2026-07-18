import hashlib
import io
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models.filing import Filing
from ..models.ocr import (
    OCRAttempt, OCRAuditEvent, OCRInboxItem, OCRPageResult, OCRReviewJob,
    OCRReviewRow,
)
from ..ocr_page_contract import MAX_PAGE_MARKDOWN_BYTES, OCR_PAGE_RESULT_FORMAT
from ..ocr_contract import OCRResultRow
from ..services import pdf
from ..services.ocr_review import review_counts

router = APIRouter(prefix="/ocr-inbox")
settings = get_settings()
UPLOAD_CHUNK_SIZE = 1024 * 1024
MAX_BATCH_FILES = 20
TICKER_RE = re.compile(r"^[A-Z0-9.^_-]{1,20}$")


def _latest_attempt(item: OCRInboxItem):
    return item.attempts[-1] if item.attempts else None


def _latest_review(item: OCRInboxItem):
    return item.reviews[-1] if item.reviews else None


def _serialize_item(item: OCRInboxItem) -> dict:
    attempt = _latest_attempt(item)
    review = _latest_review(item)
    return {
        "id": item.id,
        "filename": item.filename,
        "size_bytes": item.size_bytes,
        "pages": item.pages,
        "checksum_sha256": item.checksum_sha256,
        "status": item.status,
        "error": item.error,
        "labels": {
            "company": item.company, "ticker": item.ticker,
            "filing_type": item.filing_type, "period": item.period,
            "currency": item.currency, "unit": item.unit,
        },
        "published_filing_id": item.published_filing_id,
        "attempt": None if not attempt else {
            "id": attempt.id, "job_id": attempt.job_id, "status": attempt.status,
            "progress": attempt.progress, "worker": attempt.worker_name,
            "error": attempt.error, "automatic": bool(attempt.automatic),
            "result_format": attempt.result_format,
            "expected_pages": attempt.expected_pages,
            "received_pages": attempt.received_pages,
            "result_sha256": attempt.result_sha256,
        },
        "review": None if not review else {
            "id": review.id, "status": review.status, "revision": review.revision,
            "result_format": review.result_format,
            "counts": review_counts(review),
        },
        "created_at": item.created_at.isoformat() if item.created_at else None,
        "updated_at": item.updated_at.isoformat() if item.updated_at else None,
    }


def _get_item(db: Session, item_id: int) -> OCRInboxItem:
    item = db.query(OCRInboxItem).filter_by(id=item_id).first()
    if not item:
        raise HTTPException(404, "OCR inbox item not found")
    return item


@router.post("")
async def upload_inbox_files(
    files: list[UploadFile] = File(...),
    allow_duplicate: bool = Form(False),
    db: Session = Depends(get_db),
):
    if not files or len(files) > MAX_BATCH_FILES:
        raise HTTPException(422, f"Upload between 1 and {MAX_BATCH_FILES} PDFs")
    inbox_dir = Path(settings.upload_dir) / "ocr-inbox"
    inbox_dir.mkdir(parents=True, exist_ok=True)
    max_bytes = settings.max_upload_mb * 1024 * 1024
    saved_paths: list[Path] = []
    items: list[OCRInboxItem] = []
    try:
        for upload in files:
            filename = Path((upload.filename or "").replace("\\", "/")).name
            if not filename or not filename.lower().endswith(".pdf"):
                raise HTTPException(400, "Every uploaded file must be a PDF")
            temp_path = inbox_dir / f".{uuid.uuid4().hex}.upload"
            final_path = inbox_dir / f"{uuid.uuid4().hex}_{filename}"
            digest = hashlib.sha256()
            size = 0
            with temp_path.open("wb") as output:
                while chunk := await upload.read(UPLOAD_CHUNK_SIZE):
                    size += len(chunk)
                    if size > max_bytes:
                        raise HTTPException(413, f"File exceeds {settings.max_upload_mb} MB limit")
                    digest.update(chunk)
                    output.write(chunk)
            saved_paths.append(temp_path)
            with temp_path.open("rb") as source:
                if b"%PDF-" not in source.read(1024):
                    raise HTTPException(400, f"{filename} content is not a PDF")
            try:
                pages = pdf.page_count(str(temp_path))
            except Exception as exc:
                raise HTTPException(422, f"{filename} is unreadable or corrupted") from exc
            checksum = digest.hexdigest()
            duplicate = db.query(OCRInboxItem).filter_by(checksum_sha256=checksum).first()
            if duplicate and not allow_duplicate:
                raise HTTPException(409, {
                    "message": "PDF already exists in the OCR Inbox",
                    "duplicate_id": duplicate.id,
                })
            temp_path.replace(final_path)
            saved_paths[-1] = final_path
            item = OCRInboxItem(
                filename=filename, storage_path=str(final_path), size_bytes=size,
                pages=pages, checksum_sha256=checksum,
            )
            db.add(item)
            items.append(item)
        db.commit()
        for item in items:
            db.refresh(item)
        return {"items": [_serialize_item(item) for item in items]}
    except Exception:
        db.rollback()
        for path in saved_paths:
            path.unlink(missing_ok=True)
        raise


@router.get("")
def list_inbox(status: str | None = None, db: Session = Depends(get_db)):
    query = db.query(OCRInboxItem).order_by(OCRInboxItem.created_at.desc(), OCRInboxItem.id.desc())
    if status:
        query = query.filter(OCRInboxItem.status == status)
    return [_serialize_item(item) for item in query.all()]


@router.get("/{item_id}")
def get_inbox_item(item_id: int, db: Session = Depends(get_db)):
    return _serialize_item(_get_item(db, item_id))


@router.get("/{item_id}/file")
def get_inbox_file(item_id: int, db: Session = Depends(get_db)):
    item = _get_item(db, item_id)
    if not Path(item.storage_path).is_file():
        raise HTTPException(404, "OCR source PDF is missing")
    return FileResponse(item.storage_path, media_type="application/pdf", filename=item.filename)


@router.get("/{item_id}/pages/{page_number}")
def render_inbox_page(item_id: int, page_number: int, db: Session = Depends(get_db)):
    item = _get_item(db, item_id)
    if page_number < 1 or page_number > item.pages:
        raise HTTPException(404, "PDF page not found")
    try:
        import pdfplumber
        with pdfplumber.open(item.storage_path) as document:
            image = document.pages[page_number - 1].to_image(resolution=144).original
            output = io.BytesIO()
            image.save(output, format="PNG")
            output.seek(0)
    except Exception as exc:
        raise HTTPException(422, "PDF page could not be rendered") from exc
    return StreamingResponse(output, media_type="image/png")


@router.post("/{item_id}/run")
async def run_ocr(item_id: int, db: Session = Depends(get_db)):
    item = _get_item(db, item_id)
    if item.status not in {"uploaded", "held"}:
        raise HTTPException(409, f"Cannot run OCR while item is {item.status}")
    attempt = OCRAttempt(inbox_item=item, status="queued", automatic=0)
    db.add(attempt)
    item.status = "queued"
    item.error = None
    db.commit()
    db.refresh(attempt)
    from .sync import dispatch_next_queued
    job_id = await dispatch_next_queued(bind=db.get_bind())
    db.refresh(item)
    return {"attempt_id": attempt.id, "job_id": job_id, "item": _serialize_item(item)}


@router.post("/{item_id}/retry")
async def retry_ocr(item_id: int, db: Session = Depends(get_db)):
    item = _get_item(db, item_id)
    if item.status != "failed":
        raise HTTPException(409, "Manual retry is available only after OCR fails")
    parent = _latest_attempt(item)
    attempt = OCRAttempt(
        inbox_item=item, parent_attempt=parent, status="queued", automatic=0,
    )
    db.add(attempt)
    item.status = "queued"
    item.error = None
    db.commit()
    db.refresh(attempt)
    from .sync import dispatch_next_queued
    job_id = await dispatch_next_queued(bind=db.get_bind())
    db.refresh(item)
    return {"attempt_id": attempt.id, "job_id": job_id, "item": _serialize_item(item)}


@router.post("/{item_id}/cancel")
def cancel_ocr(item_id: int, db: Session = Depends(get_db)):
    item = _get_item(db, item_id)
    attempt = _latest_attempt(item)
    if not attempt or attempt.status != "queued":
        raise HTTPException(409, "Only queued OCR work can be canceled")
    attempt.status = "canceled"
    attempt.finished_at = datetime.now(timezone.utc)
    item.status = "uploaded"
    db.commit()
    db.refresh(item)
    return _serialize_item(item)


@router.delete("/{item_id}")
def delete_inbox_item(item_id: int, db: Session = Depends(get_db)):
    item = _get_item(db, item_id)
    if item.published_filing_id or item.status == "published":
        raise HTTPException(409, "Published OCR sources cannot be deleted from the inbox")
    if item.status in {"queued", "processing"}:
        raise HTTPException(409, "Cancel or finish OCR before deleting this item")
    path = Path(item.storage_path)
    db.delete(item)
    db.commit()
    path.unlink(missing_ok=True)
    return {"ok": True}


class LabelsIn(BaseModel):
    company: str = Field(min_length=1, max_length=160)
    ticker: str = Field(min_length=1, max_length=20)
    filing_type: str = Field(min_length=1, max_length=80)
    period: str = Field(min_length=1, max_length=80)
    currency: str = Field(min_length=1, max_length=12)
    unit: str = Field(min_length=1, max_length=40)


@router.patch("/{item_id}/labels")
def update_labels(item_id: int, labels: LabelsIn, db: Session = Depends(get_db)):
    item = _get_item(db, item_id)
    if item.status == "published":
        raise HTTPException(409, "Published labels require a new review revision")
    ticker = labels.ticker.strip().upper()
    if not TICKER_RE.fullmatch(ticker):
        raise HTTPException(422, "Ticker contains unsupported characters")
    item.company = labels.company.strip()
    item.ticker = ticker
    item.filing_type = labels.filing_type.strip()
    item.period = labels.period.strip()
    item.currency = labels.currency.strip().upper()
    item.unit = labels.unit.strip()
    review = _latest_review(item)
    if (
        item.status == "verified"
        and (not review or review.result_format != OCR_PAGE_RESULT_FORMAT)
    ):
        item.status = "ready_to_publish"
    if review:
        review.revision += 1
        review.events.append(OCRAuditEvent(
            action="labels_updated", revision=review.revision,
            after_data=labels.model_dump() | {"ticker": ticker},
        ))
    db.commit()
    db.refresh(item)
    return _serialize_item(item)


class ReviewActionIn(BaseModel):
    revision: int = Field(ge=1)
    data: dict | None = None
    reason: str | None = Field(default=None, max_length=1000)


class MarkdownReviewActionIn(BaseModel):
    revision: int = Field(ge=1)
    markdown: str | None = None


def _get_review(db: Session, review_id: int) -> OCRReviewJob:
    review = db.query(OCRReviewJob).filter_by(id=review_id).first()
    if not review:
        raise HTTPException(404, "OCR review not found")
    return review


def _serialize_row(row: OCRReviewRow) -> dict:
    return {
        "id": row.id, "source_index": row.source_index, "status": row.status,
        "raw": row.raw_data, "reviewed": row.reviewed_data,
        "page": row.page, "bbox": row.bbox, "confidence": row.confidence,
        "rejection_reason": row.rejection_reason,
    }


def _serialize_page(page: OCRPageResult, *, include_markdown: bool = False) -> dict:
    data = {
        "id": page.id,
        "page": page.page_number,
        "status": page.review_status,
        "byte_size": page.byte_size,
        "content_sha256": page.content_sha256,
        "has_correction": page.reviewed_markdown is not None,
    }
    if include_markdown:
        data.update({
            "raw_markdown": page.raw_markdown,
            "reviewed_markdown": page.reviewed_markdown,
            "effective_markdown": (
                page.reviewed_markdown
                if page.reviewed_markdown is not None
                else page.raw_markdown
            ),
        })
    return data


def _serialize_review(review: OCRReviewJob) -> dict:
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
            [_serialize_page(page) for page in review.attempt.pages]
            if review.result_format == OCR_PAGE_RESULT_FORMAT else []
        ),
        "merged_markdown_sha256": review.attempt.result_sha256,
        "events": [{
            "id": event.id, "row_id": event.row_id, "action": event.action,
            "revision": event.revision, "before": event.before_data,
            "after": event.after_data,
            "created_at": event.created_at.isoformat() if event.created_at else None,
        } for event in review.events],
    }


@router.get("/reviews/{review_id}")
def get_review(review_id: int, db: Session = Depends(get_db)):
    return _serialize_review(_get_review(db, review_id))


def _get_review_page(
    db: Session, review: OCRReviewJob, page_number: int,
) -> OCRPageResult:
    if review.result_format != OCR_PAGE_RESULT_FORMAT:
        raise HTTPException(409, "This review contains structured rows, not Markdown pages")
    page = (
        db.query(OCRPageResult)
        .filter_by(attempt_id=review.attempt_id, page_number=page_number)
        .first()
    )
    if not page:
        raise HTTPException(404, "OCR review page not found")
    return page


@router.get("/reviews/{review_id}/pages/{page_number}")
def get_review_page(
    review_id: int, page_number: int, db: Session = Depends(get_db),
):
    review = _get_review(db, review_id)
    page = _get_review_page(db, review, page_number)
    result = _serialize_page(page, include_markdown=True)
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


@router.get("/reviews/{review_id}/markdown", response_class=PlainTextResponse)
def get_review_markdown(
    review_id: int, source: str = "effective", db: Session = Depends(get_db),
):
    review = _get_review(db, review_id)
    if review.result_format != OCR_PAGE_RESULT_FORMAT:
        raise HTTPException(409, "This review does not contain Markdown pages")
    if source == "raw":
        return PlainTextResponse(
            review.attempt.merged_markdown or "", media_type="text/markdown"
        )
    if source != "effective":
        raise HTTPException(422, "source must be raw or effective")
    return PlainTextResponse(
        _effective_merged_markdown(review), media_type="text/markdown"
    )


def _mutate_page(
    review: OCRReviewJob, page: OCRPageResult, action: str,
    payload: MarkdownReviewActionIn, db: Session,
):
    if payload.revision != review.revision:
        raise HTTPException(409, "Review changed; refresh before saving")
    if review.status in {"verified", "published"}:
        raise HTTPException(409, "Verified reviews must be reopened before editing")
    before = _serialize_page(page, include_markdown=True)
    if action == "approve":
        page.review_status = "approved"
        page.reviewed_markdown = None
    elif action == "correct":
        if payload.markdown is None:
            raise HTTPException(422, "Corrected Markdown is required")
        if len(payload.markdown.encode("utf-8")) > MAX_PAGE_MARKDOWN_BYTES:
            raise HTTPException(422, "Corrected Markdown exceeds the 1 MiB page limit")
        page.review_status = "corrected"
        page.reviewed_markdown = payload.markdown
    elif action == "restore":
        page.review_status = "pending"
        page.reviewed_markdown = None
    else:
        raise HTTPException(404, "Unknown page review action")
    review.status = "reviewing"
    review.revision += 1
    review.events.append(OCRAuditEvent(
        action=f"page_{action}",
        revision=review.revision,
        before_data=before,
        after_data=_serialize_page(page, include_markdown=True),
    ))
    db.commit()
    db.refresh(review)
    return _serialize_review(review)


@router.post("/reviews/{review_id}/pages/{page_number}/{action}")
def mutate_review_page(
    review_id: int, page_number: int, action: str,
    payload: MarkdownReviewActionIn, db: Session = Depends(get_db),
):
    review = _get_review(db, review_id)
    page = _get_review_page(db, review, page_number)
    return _mutate_page(review, page, action, payload, db)


def _mutate_row(review: OCRReviewJob, row: OCRReviewRow, action: str,
                payload: ReviewActionIn, db: Session):
    if payload.revision != review.revision:
        raise HTTPException(409, "Review changed; refresh before saving")
    if review.status in {"verified", "published"}:
        raise HTTPException(409, "Verified reviews must be reopened before editing")
    before = _serialize_row(row)
    if action == "approve":
        row.status, row.reviewed_data, row.rejection_reason = "approved", None, None
    elif action == "correct":
        if not payload.data:
            raise HTTPException(422, "Corrected row data is required")
        merged = dict(row.raw_data)
        merged.update(payload.data)
        try:
            corrected = OCRResultRow.model_validate(merged)
        except Exception as exc:
            raise HTTPException(422, f"Invalid corrected row: {exc}") from exc
        if corrected.page > review.inbox_item.pages:
            raise HTTPException(422, "Corrected page exceeds document page count")
        row.status = "corrected"
        row.reviewed_data = corrected.model_dump(mode="json", exclude_none=True)
        row.page = corrected.page
        row.bbox = corrected.bbox.model_dump(mode="json")
        row.confidence = corrected.confidence
        row.rejection_reason = None
    elif action == "reject":
        reason = (payload.reason or "").strip()
        if not reason:
            raise HTTPException(422, "A rejection reason is required")
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
    return _serialize_review(review)


@router.post("/reviews/{review_id}/rows/{row_id}/{action}")
def mutate_review_row(review_id: int, row_id: int, action: str,
                      payload: ReviewActionIn, db: Session = Depends(get_db)):
    if action not in {"approve", "correct", "reject", "restore"}:
        raise HTTPException(404, "Unknown review action")
    review = _get_review(db, review_id)
    row = db.query(OCRReviewRow).filter_by(id=row_id, review_id=review.id).first()
    if not row:
        raise HTTPException(404, "OCR review row not found")
    return _mutate_row(review, row, action, payload, db)


@router.post("/reviews/{review_id}/rows")
def add_manual_row(review_id: int, payload: ReviewActionIn, db: Session = Depends(get_db)):
    review = _get_review(db, review_id)
    if review.result_format == OCR_PAGE_RESULT_FORMAT:
        raise HTTPException(409, "Markdown page reviews cannot contain structured rows")
    if payload.revision != review.revision:
        raise HTTPException(409, "Review changed; refresh before saving")
    if review.status in {"verified", "published"}:
        raise HTTPException(409, "Verified reviews must be reopened before editing")
    if not payload.data:
        raise HTTPException(422, "Manual row data is required")
    try:
        data = OCRResultRow.model_validate(payload.data)
    except Exception as exc:
        raise HTTPException(422, f"Invalid manual row: {exc}") from exc
    if data.page > review.inbox_item.pages:
        raise HTTPException(422, "Manual row page exceeds document page count")
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
    return _serialize_review(review)


@router.post("/reviews/{review_id}/verify")
def verify_review(review_id: int, payload: ReviewActionIn, db: Session = Depends(get_db)):
    review = _get_review(db, review_id)
    if payload.revision != review.revision:
        raise HTTPException(409, "Review changed; refresh before verifying")
    if review.status in {"verified", "published"}:
        raise HTTPException(409, "Review is already verified")
    if review.result_format == OCR_PAGE_RESULT_FORMAT:
        if not review.attempt.pages or any(
            page.review_status == "pending" for page in review.attempt.pages
        ):
            raise HTTPException(
                409, "Every OCR Markdown page must be resolved before verification"
            )
    else:
        if not review.rows or any(row.status == "pending" for row in review.rows):
            raise HTTPException(409, "Every OCR row must be resolved before verification")
        if all(row.status == "rejected" for row in review.rows):
            raise HTTPException(409, "At least one approved, corrected, or manual row is required")
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
    return _serialize_review(review)


@router.post("/{item_id}/publish")
def publish_item(item_id: int, db: Session = Depends(get_db)):
    item = _get_item(db, item_id)
    if item.published_filing_id:
        return {"filing_id": item.published_filing_id, "already_published": True}
    review = _latest_review(item)
    if not review or review.status != "verified":
        raise HTTPException(409, "A verified review is required before publication")
    if review.result_format == OCR_PAGE_RESULT_FORMAT:
        raise HTTPException(
            409,
            "Verified Markdown must be structurally extracted before publication",
        )
    if not all((item.company, item.ticker, item.filing_type, item.period,
                item.currency, item.unit)):
        raise HTTPException(409, "Company, ticker, type, period, currency, and unit are required")
    collision = db.query(Filing).filter_by(
        ticker=item.ticker, filing_type=item.filing_type, period=item.period,
    ).first()
    if collision:
        raise HTTPException(409, {"message": "A matching filing already exists", "filing_id": collision.id})
    tracker = {"income": [], "balance": [], "cashflow": [], "flags": [],
               "meta": {"company": item.company, "currency": item.currency, "unit": item.unit}}
    final_rows = []
    for row in review.rows:
        if row.status == "rejected":
            continue
        data = row.reviewed_data if row.status in {"corrected", "manually_added"} else row.raw_data
        final_rows.append(data)
        section = data.get("section") or "flags"
        tracker.setdefault(section, []).append(data)
    filing = Filing(
        ticker=item.ticker, filing_type=item.filing_type, period=item.period,
        filename=item.filename, storage_path=item.storage_path,
        size_bytes=item.size_bytes, pages=item.pages, status="verified",
        extracted={"ocr_rows": final_rows, "ocr_review_id": review.id},
        tracker=tracker,
    )
    db.add(filing)
    db.flush()
    item.published_filing_id = filing.id
    item.status = "published"
    review.status = "published"
    review.published_at = datetime.now(timezone.utc)
    review.revision += 1
    review.events.append(OCRAuditEvent(
        action="published", revision=review.revision,
        after_data={"filing_id": filing.id, "row_count": len(final_rows)},
    ))
    db.commit()
    return {"filing_id": filing.id, "already_published": False}

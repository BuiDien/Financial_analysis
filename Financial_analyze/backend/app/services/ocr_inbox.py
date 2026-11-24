"""OCR Inbox items: upload, OCR queueing, labels, reopen, history removal, publish.

Review content (pages/rows, verification, history answers) lives in
``ocr_inbox_review``; Ollama/Quick Correct label work in ``ocr_inbox_labels``.
"""

import asyncio
import hashlib
import io
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from ..config import get_settings, resolve_backend_path, to_storage_path
from ..models.filing import Filing
from ..models.ocr import OCRAttempt, OCRAuditEvent, OCRInboxItem
from ..ocr_page_contract import OCR_PAGE_RESULT_FORMAT
from . import history_store
from . import ocr_sync_coordinator
from . import pdf
from .errors import ServiceError
from .ocr_inbox_schemas import LabelsIn
from .ocr_review import review_counts

settings = get_settings()
UPLOAD_CHUNK_SIZE = 1024 * 1024
MAX_BATCH_FILES = 20
TICKER_RE = re.compile(r"^[A-Z0-9.^_-]{1,20}$")


def latest_attempt(item: OCRInboxItem):
    return item.attempts[-1] if item.attempts else None


def latest_review(item: OCRInboxItem):
    return item.reviews[-1] if item.reviews else None


def serialize_item(item: OCRInboxItem) -> dict:
    attempt = latest_attempt(item)
    review = latest_review(item)
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
            "scope": item.scope, "fiscal_year": item.fiscal_year,
            "period_code": item.period_code,
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


def get_item(db: Session, item_id: int) -> OCRInboxItem:
    item = db.query(OCRInboxItem).filter_by(id=item_id).first()
    if not item:
        raise ServiceError(404, "OCR inbox item not found")
    return item


def _looks_like_pdf(path: Path) -> bool:
    with path.open("rb") as source:
        return b"%PDF-" in source.read(1024)


async def upload_files(
    db: Session,
    files: list,
    *,
    allow_duplicate: bool = False,
    ticker: str | None = None,
    scope: str | None = None,
    fiscal_year: int | None = None,
    period_code: str | None = None,
) -> dict:
    """Stream PDFs (FastAPI UploadFile objects) into the inbox, all-or-nothing.

    Optional target labels are sent when the upload starts from a company's
    Financial Statements page. Unit stays unset: it is read from the PDF.
    """
    if not files or len(files) > MAX_BATCH_FILES:
        raise ServiceError(422, f"Upload between 1 and {MAX_BATCH_FILES} PDFs")
    ticker = (ticker or "").strip().upper() or None
    if ticker is not None and not TICKER_RE.fullmatch(ticker):
        raise ServiceError(422, "Ticker contains unsupported characters")
    if scope is not None and scope not in ("consolidated", "separate"):
        raise ServiceError(422, "Scope must be consolidated or separate")
    if period_code is not None and period_code not in ("Q1", "Q2", "Q3", "Q4", "H1", "FY"):
        raise ServiceError(422, "Period must be Q1-Q4, H1 or FY")
    if fiscal_year is not None and not 2000 <= fiscal_year <= 2100:
        raise ServiceError(422, "Fiscal year must be between 2000 and 2100")
    target = {"scope": scope, "fiscal_year": fiscal_year, "period_code": period_code}
    if ticker:
        target |= {"ticker": ticker, "company": ticker}
    if period_code and fiscal_year:
        target["period"] = f"{period_code} {fiscal_year}"
    inbox_dir = resolve_backend_path(settings.upload_dir) / "ocr-inbox"
    inbox_dir.mkdir(parents=True, exist_ok=True)
    max_bytes = settings.max_upload_mb * 1024 * 1024
    saved_paths: list[Path] = []
    items: list[OCRInboxItem] = []
    try:
        for upload in files:
            filename = Path((upload.filename or "").replace("\\", "/")).name
            if not filename or not filename.lower().endswith(".pdf"):
                raise ServiceError(400, "Every uploaded file must be a PDF")
            temp_path = inbox_dir / f".{uuid.uuid4().hex}.upload"
            final_path = inbox_dir / f"{uuid.uuid4().hex}_{filename}"
            digest = hashlib.sha256()
            size = 0
            # Track the temp file before it exists so a 413/abort mid-write
            # still removes it in the cleanup below.
            saved_paths.append(temp_path)
            output = await asyncio.to_thread(temp_path.open, "wb")
            try:
                while chunk := await upload.read(UPLOAD_CHUNK_SIZE):
                    size += len(chunk)
                    if size > max_bytes:
                        raise ServiceError(413, f"File exceeds {settings.max_upload_mb} MB limit")
                    digest.update(chunk)
                    await asyncio.to_thread(output.write, chunk)
            finally:
                await asyncio.to_thread(output.close)
            if not await asyncio.to_thread(_looks_like_pdf, temp_path):
                raise ServiceError(400, f"{filename} content is not a PDF")
            try:
                pages = await asyncio.to_thread(pdf.page_count, str(temp_path))
            except Exception as exc:
                raise ServiceError(422, f"{filename} is unreadable or corrupted") from exc
            checksum = digest.hexdigest()
            duplicate = db.query(OCRInboxItem).filter_by(checksum_sha256=checksum).first()
            if duplicate and not allow_duplicate:
                raise ServiceError(409, {
                    "message": "PDF already exists in the OCR Inbox",
                    "duplicate_id": duplicate.id,
                })
            await asyncio.to_thread(temp_path.replace, final_path)
            saved_paths[-1] = final_path
            item = OCRInboxItem(
                filename=filename, storage_path=to_storage_path(final_path),
                size_bytes=size,
                pages=pages, checksum_sha256=checksum,
                **{k: v for k, v in target.items() if v is not None},
            )
            db.add(item)
            items.append(item)
        db.commit()
        for item in items:
            db.refresh(item)
        return {"items": [serialize_item(item) for item in items]}
    except Exception:
        db.rollback()
        for path in saved_paths:
            path.unlink(missing_ok=True)
        raise


def list_items(db: Session, status: str | None = None) -> list[dict]:
    query = db.query(OCRInboxItem).order_by(OCRInboxItem.created_at.desc(), OCRInboxItem.id.desc())
    if status:
        query = query.filter(OCRInboxItem.status == status)
    return [serialize_item(item) for item in query.all()]


def get_item_view(db: Session, item_id: int) -> dict:
    return serialize_item(get_item(db, item_id))


def source_pdf(db: Session, item_id: int) -> tuple[Path, str]:
    """Return (path, filename) of the item's source PDF."""
    item = get_item(db, item_id)
    path = resolve_backend_path(item.storage_path)
    if not path.is_file():
        raise ServiceError(404, "OCR source PDF is missing")
    return path, item.filename


def render_page_png(db: Session, item_id: int, page_number: int) -> io.BytesIO:
    item = get_item(db, item_id)
    if page_number < 1 or page_number > item.pages:
        raise ServiceError(404, "PDF page not found")
    try:
        import pdfplumber
        with pdfplumber.open(resolve_backend_path(item.storage_path)) as document:
            image = document.pages[page_number - 1].to_image(resolution=144).original
            output = io.BytesIO()
            image.save(output, format="PNG")
            output.seek(0)
    except Exception as exc:
        raise ServiceError(422, "PDF page could not be rendered") from exc
    return output


async def run_ocr(db: Session, item_id: int) -> dict:
    item = get_item(db, item_id)
    if item.status not in {"uploaded", "held"}:
        raise ServiceError(409, f"Cannot run OCR while item is {item.status}")
    attempt = OCRAttempt(inbox_item=item, status="queued", automatic=0)
    db.add(attempt)
    item.status = "queued"
    item.error = None
    db.commit()
    db.refresh(attempt)
    job_id = await ocr_sync_coordinator.dispatch_next_queued(bind=db.get_bind())
    db.refresh(item)
    return {"attempt_id": attempt.id, "job_id": job_id, "item": serialize_item(item)}


async def retry_ocr(db: Session, item_id: int) -> dict:
    item = get_item(db, item_id)
    if item.status != "failed":
        raise ServiceError(409, "Manual retry is available only after OCR fails")
    parent = latest_attempt(item)
    attempt = OCRAttempt(
        inbox_item=item, parent_attempt=parent, status="queued", automatic=0,
    )
    db.add(attempt)
    item.status = "queued"
    item.error = None
    db.commit()
    db.refresh(attempt)
    job_id = await ocr_sync_coordinator.dispatch_next_queued(bind=db.get_bind())
    db.refresh(item)
    return {"attempt_id": attempt.id, "job_id": job_id, "item": serialize_item(item)}


def cancel_ocr(db: Session, item_id: int) -> dict:
    item = get_item(db, item_id)
    attempt = latest_attempt(item)
    if not attempt or attempt.status != "queued":
        raise ServiceError(409, "Only queued OCR work can be canceled")
    attempt.status = "canceled"
    attempt.finished_at = datetime.now(timezone.utc)
    item.status = "uploaded"
    db.commit()
    db.refresh(item)
    return serialize_item(item)


def delete_item(db: Session, item_id: int) -> dict:
    item = get_item(db, item_id)
    if item.published_filing_id or item.status == "published":
        raise ServiceError(409, "Published OCR sources cannot be deleted from the inbox")
    if item.status in {"queued", "processing"}:
        raise ServiceError(409, "Cancel or finish OCR before deleting this item")
    path = resolve_backend_path(item.storage_path)
    history_store.delete_item_facts(db, item)
    db.delete(item)
    db.commit()
    path.unlink(missing_ok=True)
    return {"ok": True}


def update_labels(db: Session, item_id: int, labels: LabelsIn) -> dict:
    item = get_item(db, item_id)
    if item.status == "published":
        raise ServiceError(409, "Published labels require a new review revision")
    if history_store.is_in_history(db, item):
        raise ServiceError(409, "Remove this document from history first")
    ticker = labels.ticker.strip().upper()
    if not TICKER_RE.fullmatch(ticker):
        raise ServiceError(422, "Ticker contains unsupported characters")
    item.company = labels.company.strip()
    item.ticker = ticker
    item.filing_type = labels.filing_type.strip()
    item.period = labels.period.strip()
    item.currency = labels.currency.strip().upper()
    item.unit = labels.unit.strip()
    # New history labels are optional: only overwrite what the caller sent.
    for name in ("scope", "fiscal_year", "period_code"):
        if name in labels.model_fields_set:
            setattr(item, name, getattr(labels, name))
    review = latest_review(item)
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
    return serialize_item(item)


def remove_from_history(db: Session, item_id: int) -> dict:
    item = get_item(db, item_id)
    return {"superseded": history_store.history_remove(db, item)}


def publish_item(db: Session, item_id: int) -> dict:
    item = get_item(db, item_id)
    if item.published_filing_id:
        return {"filing_id": item.published_filing_id, "already_published": True}
    review = latest_review(item)
    if not review or review.status != "verified":
        raise ServiceError(409, "A verified review is required before publication")
    if review.result_format == OCR_PAGE_RESULT_FORMAT:
        raise ServiceError(
            409,
            "Verified Markdown must be structurally extracted before publication",
        )
    if not all((item.company, item.ticker, item.filing_type, item.period,
                item.currency, item.unit)):
        raise ServiceError(409, "Company, ticker, type, period, currency, and unit are required")
    collision = db.query(Filing).filter_by(
        ticker=item.ticker, filing_type=item.filing_type, period=item.period,
    ).first()
    if collision:
        raise ServiceError(409, {"message": "A matching filing already exists", "filing_id": collision.id})
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

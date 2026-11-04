"""Automatic label checks for page-based OCR worker results."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session, sessionmaker

from ..config import get_settings
from ..models.ocr import OCRAuditEvent, OCRLabelReviewRun, OCRPageResult, OCRReviewJob
from . import ocr_label_review
from .ocr_label_levels import extract_label_rows
from .ocr_label_library import LabelLibraryError, get_label_library


logger = logging.getLogger("uvicorn.error")


def _ollama_candidates(markdown: str) -> dict:
    labels = extract_label_rows(markdown)
    return {
        "label_count": len(labels),
        "known_count": 0,
        "candidate_count": len(labels),
        "candidates": [
            {
                "table": label["table"],
                "row": label["row"],
                "label": label["label"],
                "level": label["level"],
                "source": "ollama",
            }
            for label in labels
        ],
    }


def check_page_labels(page: OCRPageResult) -> dict:
    """Run the fast Obsidian classification and store an idempotent summary."""
    settings = get_settings()
    page.label_check_status = "checking"
    page.label_check_error = None
    try:
        try:
            library = get_label_library(
                settings.obsidian_vault_path,
                settings.obsidian_label_library_path,
            )
            summary = library.match_label_texts(page.raw_markdown)
            summary["library_available"] = True
        except LabelLibraryError as exc:
            # An empty/unconfigured library must not stop OCR ingestion. Ollama
            # can still review each collected label after the document ends.
            summary = _ollama_candidates(page.raw_markdown)
            summary.update({
                "library_available": False,
                "library_error": str(exc),
            })
        summary["content_sha256"] = page.content_sha256
        page.label_check_status = "checked"
        page.label_check_summary = summary
        page.label_checked_at = datetime.now(timezone.utc)
        return summary
    except Exception as exc:
        page.label_check_status = "failed"
        page.label_check_error = str(exc)[:1000] or exc.__class__.__name__
        page.label_checked_at = datetime.now(timezone.utc)
        logger.exception("Automatic OCR label check failed for page %s", page.id)
        return {
            "label_count": 0,
            "known_count": 0,
            "candidate_count": 0,
            "candidates": [],
            "error": page.label_check_error,
        }


def run_auto_document_label_review(bind, review_id: int) -> None:
    """Queue and run one label-at-a-time checks after all pages arrive."""
    settings = get_settings()
    if not settings.enable_automatic_ocr_label_review:
        return

    SessionFactory = sessionmaker(bind=bind)
    db: Session = SessionFactory()
    run_ids: list[int] = []
    try:
        review = db.get(OCRReviewJob, review_id)
        if not review or review.result_format != "page_markdown_v2":
            return
        existing = (
            db.query(OCRLabelReviewRun)
            .filter_by(review_id=review.id, trigger="worker_auto")
            .first()
        )
        if existing:
            return

        remaining_limit = max(0, settings.automatic_ocr_label_limit)
        total_candidates = 0
        queued_candidates = 0
        skipped_candidates = 0
        for page in review.attempt.pages:
            summary = page.label_check_summary
            if (
                page.label_check_status != "checked"
                or not isinstance(summary, dict)
                or summary.get("content_sha256") != page.content_sha256
            ):
                summary = check_page_labels(page)
            candidates = list(summary.get("candidates") or [])
            total_candidates += len(candidates)
            selected = candidates[:remaining_limit]
            skipped_candidates += len(candidates) - len(selected)
            remaining_limit -= len(selected)
            if not selected:
                continue
            sources = {candidate.get("source", "ollama") for candidate in selected}
            model = (
                "obsidian"
                if sources == {"obsidian"}
                else settings.ollama_ocr_model
                if sources == {"ollama"}
                else f"obsidian+{settings.ollama_ocr_model}"
            )
            run = OCRLabelReviewRun(
                review=review,
                page_number=page.page_number,
                base_revision=review.revision,
                page_content_sha256=ocr_label_review.content_sha256(
                    ocr_label_review.page_markdown(page),
                ),
                trigger="worker_auto",
                skill_name=ocr_label_review.SKILL_NAME,
                skill_version=ocr_label_review.SKILL_VERSION,
                requested_rows=selected,
                model=model,
            )
            db.add(run)
            db.flush()
            run_ids.append(run.id)
            queued_candidates += len(selected)

        review.events.append(OCRAuditEvent(
            action="automatic_label_review_queued",
            actor="automatic-label-checker",
            revision=review.revision,
            after_data={
                "candidate_count": total_candidates,
                "queued_count": queued_candidates,
                "skipped_count": skipped_candidates,
                "run_ids": run_ids,
            },
        ))
        db.commit()
    except Exception:
        db.rollback()
        logger.exception(
            "Could not queue automatic OCR label review %s", review_id,
        )
        return
    finally:
        db.close()

    for run_id in run_ids:
        ocr_label_review.run_label_review(bind, run_id)

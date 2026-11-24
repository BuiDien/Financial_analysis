"""OCR review label work: Obsidian Quick Correct and Ollama label-review runs,
suggestion decisions, and applying accepted suggestions to a page."""

from sqlalchemy.orm import Session

from ..config import get_settings
from ..jobs.ocr import run_label_review_job
from ..models.ocr import OCRAuditEvent, OCRLabelReviewRun, OCRLabelSuggestion
from . import ocr_label_library
from . import ocr_label_review
from .errors import ServiceError
from .ocr_inbox_review import (
    load_review, load_review_page, serialize_page, serialize_review,
)
from .ocr_inbox_schemas import (
    ApplyLabelSuggestionsIn, LabelSuggestionDecisionIn, QuickCorrectIn,
    StartLabelReviewIn,
)
from .ocr_label_levels import (
    apply_label_level_suggestions,
    apply_label_text_suggestions,
    extract_label_rows,
    parse_financial_number,
    verify_level_totals,
)

settings = get_settings()


def _obsidian_label_library():
    try:
        return ocr_label_library.get_label_library(
            settings.obsidian_vault_path,
            settings.obsidian_label_library_path,
        )
    except ocr_label_library.LabelLibraryError as exc:
        raise ServiceError(503, str(exc)) from exc


def preview_quick_correct(
    db: Session,
    review_id: int,
    page_number: int,
    payload: QuickCorrectIn,
) -> dict:
    """Return non-mutating Obsidian Quick Correct suggestions for one page."""
    review = load_review(db, review_id)
    page = load_review_page(db, review, page_number)
    if payload.revision != review.revision:
        raise ServiceError(409, "Review changed; refresh before Quick Correct")
    markdown = ocr_label_review.page_markdown(page)
    try:
        result = _obsidian_label_library().suggest(payload.statement_type, markdown)
    except ocr_label_library.LabelLibraryError as exc:
        raise ServiceError(422, str(exc)) from exc
    result.update({
        "review_id": review.id,
        "page": page_number,
        "revision": review.revision,
        "page_content_sha256": ocr_label_review.content_sha256(markdown),
    })
    return result


def seed_quick_correct_library(
    db: Session,
    review_id: int,
    page_number: int,
    payload: QuickCorrectIn,
) -> dict:
    """Write one explicitly user-selected verified page to the label library."""
    review = load_review(db, review_id)
    page = load_review_page(db, review, page_number)
    if payload.revision != review.revision:
        raise ServiceError(409, "Review changed; refresh before saving labels")
    if review.status not in {"verified", "published"}:
        raise ServiceError(
            409, "Verify the full review before saving labels to Quick Correct",
        )
    markdown = ocr_label_review.page_markdown(page)
    try:
        result = _obsidian_label_library().record_verified_page(
            payload.statement_type,
            markdown,
            review.inbox_item.checksum_sha256,
        )
    except ocr_label_library.LabelLibraryError as exc:
        raise ServiceError(422, str(exc)) from exc
    review.events.append(OCRAuditEvent(
        action="quick_correct_library_seeded",
        actor="local-user",
        revision=review.revision,
        after_data={
            "page": page_number,
            "statement_type": payload.statement_type.strip().lower(),
            **result,
        },
    ))
    db.commit()
    return result | {"review_id": review.id, "page": page_number}


def start_label_review_run(
    db: Session,
    review_id: int,
    page_number: int,
    payload: StartLabelReviewIn,
    background_tasks,
) -> dict:
    """Queue an Ollama label review. ``background_tasks`` (FastAPI
    BackgroundTasks) starts it on the job runner after the response."""
    review = load_review(db, review_id)
    page = load_review_page(db, review, page_number)
    if payload.revision != review.revision:
        raise ServiceError(409, "Review changed; refresh before asking Ollama")
    if review.status in {"verified", "published"}:
        raise ServiceError(409, "Verified reviews must be reopened before editing")
    requested_rows = [target.model_dump() for target in payload.targets]
    coordinates = [(target["table"], target["row"]) for target in requested_rows]
    if len(set(coordinates)) != len(coordinates):
        raise ServiceError(422, "Mark each label only once before asking Ollama")
    markdown = ocr_label_review.page_markdown(page)
    page_hash = ocr_label_review.content_sha256(markdown)
    active = (
        db.query(OCRLabelReviewRun)
        .filter_by(
            review_id=review.id,
            page_number=page_number,
            page_content_sha256=page_hash,
        )
        .filter(OCRLabelReviewRun.status.in_(("queued", "running")))
        .first()
    )
    if active:
        return ocr_label_review.serialize_run(active)
    run = OCRLabelReviewRun(
        review=review,
        page_number=page_number,
        base_revision=review.revision,
        page_content_sha256=page_hash,
        skill_name=ocr_label_review.SKILL_NAME,
        skill_version=ocr_label_review.SKILL_VERSION,
        requested_rows=requested_rows,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    background_tasks.add_task(run_label_review_job, db.get_bind(), run.id)
    return ocr_label_review.serialize_run(run)


def latest_label_review_run(
    db: Session,
    review_id: int,
    page_number: int,
) -> dict:
    review = load_review(db, review_id)
    load_review_page(db, review, page_number)
    run = (
        db.query(OCRLabelReviewRun)
        .filter_by(review_id=review.id, page_number=page_number)
        .order_by(OCRLabelReviewRun.id.desc())
        .first()
    )
    return {"run": ocr_label_review.serialize_run(run) if run else None}


def get_label_review_run(
    db: Session,
    review_id: int,
    page_number: int,
    run_id: int,
) -> dict:
    run = (
        db.query(OCRLabelReviewRun)
        .filter_by(id=run_id, review_id=review_id, page_number=page_number)
        .first()
    )
    if not run:
        raise ServiceError(404, "Ollama label review run not found")
    return ocr_label_review.serialize_run(run)


def decide_label_suggestion(
    db: Session,
    suggestion_id: int,
    payload: LabelSuggestionDecisionIn,
) -> dict:
    suggestion = db.get(OCRLabelSuggestion, suggestion_id)
    if not suggestion:
        raise ServiceError(404, "Ollama label suggestion not found")
    review = suggestion.run.review
    page = load_review_page(db, review, suggestion.run.page_number)
    if suggestion.applied_revision is not None:
        raise ServiceError(409, "This Ollama suggestion has already been applied")
    if review.status in {"verified", "published"}:
        raise ServiceError(409, "Verified reviews must be reopened before editing")
    if (
        review.revision != suggestion.run.base_revision
        or ocr_label_review.content_sha256(
            ocr_label_review.page_markdown(page)
        ) != suggestion.run.page_content_sha256
    ):
        suggestion.decision = "stale"
        db.commit()
        raise ServiceError(409, "This suggestion is stale; ask Ollama to review again")
    if payload.decision not in {"accepted", "rejected", "edited"}:
        raise ServiceError(422, "Decision must be accepted, rejected, or edited")
    if suggestion.suggested_label is not None and payload.decision == "edited":
        raise ServiceError(
            422, "Edit the label cell directly, or accept/reject Ollama",
        )
    if payload.decision == "edited" and payload.user_edited_level is None:
        raise ServiceError(422, "An edited suggestion requires a label level")
    if (
        payload.decision == "edited"
        and payload.user_edited_level == -1
        and any(
            parse_financial_number(str(value)) is not None
            or str(value).strip() in {"-", "–", "—"}
            for value in (suggestion.evidence or {}).get("values", [])
        )
    ):
        raise ServiceError(422, "L is only for a text-only row")
    suggestion.decision = payload.decision
    suggestion.user_edited_level = (
        payload.user_edited_level if payload.decision == "edited" else None
    )
    db.commit()
    db.refresh(suggestion.run)
    return ocr_label_review.serialize_run(suggestion.run)


def apply_label_suggestions(
    db: Session,
    review_id: int,
    page_number: int,
    payload: ApplyLabelSuggestionsIn,
) -> dict:
    review = load_review(db, review_id)
    page = load_review_page(db, review, page_number)
    if payload.revision != review.revision:
        raise ServiceError(409, "Review changed; refresh before applying suggestions")
    if review.status in {"verified", "published"}:
        raise ServiceError(409, "Verified reviews must be reopened before editing")
    markdown = ocr_label_review.page_markdown(page)
    current_hash = ocr_label_review.content_sha256(markdown)
    if current_hash != payload.page_content_sha256:
        raise ServiceError(409, "Page changed; ask Ollama to review again")
    if len(set(payload.suggestion_ids)) != len(payload.suggestion_ids):
        raise ServiceError(422, "Suggestion IDs must be unique")

    suggestions = (
        db.query(OCRLabelSuggestion)
        .join(OCRLabelReviewRun)
        .filter(
            OCRLabelSuggestion.id.in_(payload.suggestion_ids),
            OCRLabelReviewRun.review_id == review.id,
            OCRLabelReviewRun.page_number == page_number,
        )
        .all()
    )
    if len(suggestions) != len(payload.suggestion_ids):
        raise ServiceError(404, "One or more Ollama suggestions were not found")
    if any(
        suggestion.run.page_content_sha256 != current_hash
        or suggestion.decision not in {"accepted", "edited"}
        or suggestion.applied_revision is not None
        for suggestion in suggestions
    ):
        raise ServiceError(
            409, "Only current, accepted, unapplied suggestions can be applied",
        )

    level_changes = [{
        "table": suggestion.table_number,
        "row": suggestion.row_number,
        "level": (
            suggestion.user_edited_level
            if suggestion.decision == "edited"
            else suggestion.suggested_level
        ),
    } for suggestion in suggestions if suggestion.suggested_label is None]
    text_changes = [{
        "table": suggestion.table_number,
        "row": suggestion.row_number,
        "current_label": suggestion.current_label,
        "label": suggestion.suggested_label,
    } for suggestion in suggestions if suggestion.suggested_label is not None]
    try:
        corrected = (
            apply_label_level_suggestions(markdown, level_changes)
            if level_changes else markdown
        )
        if text_changes:
            corrected = apply_label_text_suggestions(corrected, text_changes)
    except ValueError as exc:
        raise ServiceError(422, str(exc)) from exc

    before = serialize_page(page, include_markdown=True)
    page.review_status = "corrected"
    page.reviewed_markdown = corrected
    review.status = "reviewing"
    review.revision += 1
    for suggestion in suggestions:
        suggestion.applied_revision = review.revision
    applied_ids = {suggestion.id for suggestion in suggestions}
    applied_run = suggestions[0].run
    other_suggestions = (
        db.query(OCRLabelSuggestion)
        .join(OCRLabelReviewRun)
        .filter(
            OCRLabelReviewRun.review_id == review.id,
            OCRLabelSuggestion.applied_revision.is_(None),
            OCRLabelSuggestion.id.notin_(applied_ids),
        )
        .all()
    )
    remaining_page_labels = {
        candidate_page.page_number: {
            (label["table"], label["row"]): label
            for label in extract_label_rows(
                ocr_label_review.page_markdown(candidate_page),
            )
        }
        for candidate_page in review.attempt.pages
    }
    remaining_page_hashes = {
        candidate_page.page_number: ocr_label_review.content_sha256(
            ocr_label_review.page_markdown(candidate_page),
        )
        for candidate_page in review.attempt.pages
    }
    active_runs = (
        db.query(OCRLabelReviewRun)
        .filter(
            OCRLabelReviewRun.review_id == review.id,
            OCRLabelReviewRun.status.in_(("queued", "running")),
        )
        .all()
    )
    for active_run in active_runs:
        current_run_hash = remaining_page_hashes.get(active_run.page_number)
        if active_run.page_content_sha256 == current_run_hash:
            active_run.base_revision = review.revision
    for suggestion in other_suggestions:
        remaining = remaining_page_labels.get(
            suggestion.run.page_number, {},
        ).get(
            (suggestion.table_number, suggestion.row_number),
        )
        if (
            remaining
            and ocr_label_review.label_cell_sha256(
                remaining["label"], remaining["level"],
            ) == suggestion.label_cell_hash
        ):
            # Applying one accepted label must not invalidate untouched labels
            # elsewhere in the same Ollama document review.
            suggestion.run.base_revision = review.revision
            suggestion.run.page_content_sha256 = remaining_page_hashes[
                suggestion.run.page_number
            ]
        else:
            suggestion.decision = "stale"
    verification = verify_level_totals(corrected)
    review.events.append(OCRAuditEvent(
        action="ollama_label_suggestions_applied",
        actor="local-user",
        revision=review.revision,
        before_data=before,
        after_data={
            "page": page_number,
            "suggestion_ids": sorted(applied_ids),
            "verification": {
                "matched": verification["matched"],
                "mismatched": verification["mismatched"],
                "unverifiable": len(verification["unverifiable"]),
            },
        },
    ))
    db.commit()
    db.refresh(review)
    return {
        "review": serialize_review(review),
        "page": serialize_page(page, include_markdown=True),
        "verification": verification,
        "label_review_run": ocr_label_review.serialize_run(applied_run),
    }
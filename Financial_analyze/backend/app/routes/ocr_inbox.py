"""OCR Inbox HTTP layer.

Logic lives in app/services/: ``ocr_inbox`` (items, upload, OCR queue,
labels, publish), ``ocr_inbox_review`` (pages/rows, verify, reopen, history)
and ``ocr_inbox_labels`` (Quick Correct, Ollama label review). Route order
matters: the catch-all ``/reviews/{id}/pages/{n}/{action}`` stays after the
specific page routes.
"""

from fastapi import (
    APIRouter, BackgroundTasks, Depends, File, Form, UploadFile,
)
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from sqlalchemy.orm import Session

from ..db import get_db
from ..services import ocr_inbox as inbox
from ..services import ocr_inbox_labels as labels_service
from ..services import ocr_inbox_review as reviews
from ..services.ocr_inbox_schemas import (
    ApplyLabelSuggestionsIn,
    AutoLabelLevelsIn,
    HistoryAnswersIn,
    LabelsIn,
    LabelSuggestionDecisionIn,
    MarkdownReviewActionIn,
    QuickCorrectIn,
    ReopenReviewIn,
    ReviewActionIn,
    StartLabelReviewIn,
)

router = APIRouter(prefix="/ocr-inbox")


@router.post("")
async def upload_inbox_files(
    files: list[UploadFile] = File(...),
    allow_duplicate: bool = Form(False),
    # Optional target labels, sent when the upload starts from a company's
    # Financial Statements page. Unit stays unset: it is read from the PDF.
    ticker: str | None = Form(None),
    scope: str | None = Form(None),
    fiscal_year: int | None = Form(None),
    period_code: str | None = Form(None),
    db: Session = Depends(get_db),
):
    return await inbox.upload_files(
        db, files, allow_duplicate=allow_duplicate, ticker=ticker, scope=scope,
        fiscal_year=fiscal_year, period_code=period_code,
    )


@router.get("")
def list_inbox(status: str | None = None, db: Session = Depends(get_db)):
    return inbox.list_items(db, status)


@router.get("/{item_id}")
def get_inbox_item(item_id: int, db: Session = Depends(get_db)):
    return inbox.get_item_view(db, item_id)


@router.get("/{item_id}/file")
def get_inbox_file(item_id: int, db: Session = Depends(get_db)):
    path, filename = inbox.source_pdf(db, item_id)
    return FileResponse(path, media_type="application/pdf", filename=filename)


@router.get("/{item_id}/pages/{page_number}")
def render_inbox_page(item_id: int, page_number: int, db: Session = Depends(get_db)):
    png = inbox.render_page_png(db, item_id, page_number)
    return StreamingResponse(png, media_type="image/png")


@router.post("/{item_id}/run")
async def run_ocr(item_id: int, db: Session = Depends(get_db)):
    return await inbox.run_ocr(db, item_id)


@router.post("/{item_id}/retry")
async def retry_ocr(item_id: int, db: Session = Depends(get_db)):
    return await inbox.retry_ocr(db, item_id)


@router.post("/{item_id}/cancel")
def cancel_ocr(item_id: int, db: Session = Depends(get_db)):
    return inbox.cancel_ocr(db, item_id)


@router.delete("/{item_id}")
def delete_inbox_item(item_id: int, db: Session = Depends(get_db)):
    return inbox.delete_item(db, item_id)


@router.patch("/{item_id}/labels")
def update_labels(item_id: int, labels: LabelsIn, db: Session = Depends(get_db)):
    return inbox.update_labels(db, item_id, labels)


@router.get("/reviews/{review_id}")
def get_review(review_id: int, db: Session = Depends(get_db)):
    return reviews.review_view(db, review_id)


@router.get("/reviews/{review_id}/pages/{page_number}")
def get_review_page(review_id: int, page_number: int, db: Session = Depends(get_db)):
    return reviews.review_page_view(db, review_id, page_number)


@router.get("/reviews/{review_id}/markdown", response_class=PlainTextResponse)
def get_review_markdown(
    review_id: int, source: str = "effective", db: Session = Depends(get_db),
):
    markdown = reviews.review_markdown(db, review_id, source)
    return PlainTextResponse(markdown, media_type="text/markdown")


@router.post("/reviews/{review_id}/label-level-preview/pages/{page_number}")
def preview_review_page_label_levels(
    review_id: int, page_number: int, payload: AutoLabelLevelsIn,
    db: Session = Depends(get_db),
):
    return reviews.preview_label_levels(db, review_id, page_number, payload)


@router.post("/reviews/{review_id}/level-total-preview/pages/{page_number}")
def preview_review_page_level_totals(
    review_id: int, page_number: int, payload: AutoLabelLevelsIn,
    db: Session = Depends(get_db),
):
    return reviews.preview_level_totals(db, review_id, page_number, payload)


@router.post("/reviews/{review_id}/pages/{page_number}/quick-correct-preview")
def preview_review_page_quick_correct(
    review_id: int, page_number: int, payload: QuickCorrectIn,
    db: Session = Depends(get_db),
):
    """Return non-mutating Obsidian Quick Correct suggestions for one page."""
    return labels_service.preview_quick_correct(db, review_id, page_number, payload)


@router.post("/reviews/{review_id}/pages/{page_number}/quick-correct-library")
def seed_review_page_quick_correct_library(
    review_id: int, page_number: int, payload: QuickCorrectIn,
    db: Session = Depends(get_db),
):
    """Write one explicitly user-selected verified page to the label library."""
    return labels_service.seed_quick_correct_library(db, review_id, page_number, payload)


@router.post("/reviews/{review_id}/pages/{page_number}/label-review-runs")
def start_label_review_run(
    review_id: int, page_number: int, payload: StartLabelReviewIn,
    background_tasks: BackgroundTasks, db: Session = Depends(get_db),
):
    return labels_service.start_label_review_run(
        db, review_id, page_number, payload, background_tasks,
    )


@router.get("/reviews/{review_id}/pages/{page_number}/label-review-runs/latest")
def latest_label_review_run(
    review_id: int, page_number: int, db: Session = Depends(get_db),
):
    return labels_service.latest_label_review_run(db, review_id, page_number)


@router.get("/reviews/{review_id}/pages/{page_number}/label-review-runs/{run_id}")
def get_label_review_run(
    review_id: int, page_number: int, run_id: int, db: Session = Depends(get_db),
):
    return labels_service.get_label_review_run(db, review_id, page_number, run_id)


@router.post("/label-suggestions/{suggestion_id}/decision")
def decide_label_suggestion(
    suggestion_id: int, payload: LabelSuggestionDecisionIn,
    db: Session = Depends(get_db),
):
    return labels_service.decide_label_suggestion(db, suggestion_id, payload)


@router.post("/reviews/{review_id}/pages/{page_number}/apply-label-suggestions")
def apply_review_page_label_suggestions(
    review_id: int, page_number: int, payload: ApplyLabelSuggestionsIn,
    db: Session = Depends(get_db),
):
    return labels_service.apply_label_suggestions(db, review_id, page_number, payload)


@router.post("/reviews/{review_id}/pages/{page_number}/{action}")
def mutate_review_page(
    review_id: int, page_number: int, action: str,
    payload: MarkdownReviewActionIn, db: Session = Depends(get_db),
):
    return reviews.mutate_review_page(db, review_id, page_number, action, payload)


@router.post("/reviews/{review_id}/rows/{row_id}/{action}")
def mutate_review_row(review_id: int, row_id: int, action: str,
                      payload: ReviewActionIn, db: Session = Depends(get_db)):
    return reviews.mutate_review_row(db, review_id, row_id, action, payload)


@router.post("/reviews/{review_id}/rows")
def add_manual_row(review_id: int, payload: ReviewActionIn, db: Session = Depends(get_db)):
    return reviews.add_manual_row(db, review_id, payload)


@router.post("/reviews/{review_id}/verify")
def verify_review(review_id: int, payload: ReviewActionIn, db: Session = Depends(get_db)):
    return reviews.verify_review(db, review_id, payload)


@router.post("/{item_id}/review/reopen")
def reopen_review(item_id: int, payload: ReopenReviewIn, db: Session = Depends(get_db)):
    """Return a verified (unpublished) review to editing.

    The edit guards say "Verified reviews must be reopened before editing";
    this is that reopen. Published reviews stay frozen (a Filing exists), and
    a document already written to company history must be removed from it
    first so history never holds facts from a review that is being edited.
    """
    return reviews.reopen_review(db, item_id, payload)


@router.post("/reviews/{review_id}/history-preview")
def preview_history(
    review_id: int, payload: HistoryAnswersIn, db: Session = Depends(get_db),
):
    return reviews.preview_history(db, review_id, payload)


@router.post("/reviews/{review_id}/history")
def write_history(
    review_id: int, payload: HistoryAnswersIn, db: Session = Depends(get_db),
):
    return reviews.write_history(db, review_id, payload)


@router.delete("/{item_id}/history")
def remove_from_history(item_id: int, db: Session = Depends(get_db)):
    return inbox.remove_from_history(db, item_id)


@router.post("/{item_id}/publish")
def publish_item(item_id: int, db: Session = Depends(get_db)):
    return inbox.publish_item(db, item_id)

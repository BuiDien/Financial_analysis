"""Auditable, local-first portfolio ledger and projections (HTTP layer).

Business logic lives in ``app/services/portfolio_{ledger,imports,valuation}.py``.
"""

from __future__ import annotations

from datetime import date

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    HTTPException,
    Query,
    UploadFile,
)
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..db import get_db
from ..services import portfolio_imports as imports
from ..services import portfolio_ledger as ledger
from ..services import portfolio_paste as paste
from ..services import portfolio_valuation as valuation
from ..services.portfolio_schemas import (
    HoldingIn,
    ImportMapping,
    PasteCommitIn,
    PasteIn,
    PreferenceIn,
    TransactionIn,
)

router = APIRouter()


def _csv_download(text: str, filename: str, media_type: str = "text/csv"):
    return StreamingResponse(
        iter([text]),
        media_type=media_type,
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.get("/portfolio")
def get_portfolio(
    currency: str | None = Query(default=None, min_length=3, max_length=3),
    db: Session = Depends(get_db),
):
    return valuation.portfolio_view(db, currency)


@router.get("/portfolio/transactions")
def list_transactions(
    type: str | None = None,
    ticker: str | None = None,
    status: str | None = None,
    search: str | None = Query(default=None, alias="q", max_length=100),
    date_from: date | None = None,
    date_to: date | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    return ledger.list_transactions(
        db,
        type=type,
        ticker=ticker,
        status=status,
        search=search,
        date_from=date_from,
        date_to=date_to,
        page=page,
        page_size=page_size,
    )


@router.post("/portfolio/transactions", status_code=201)
def add_transaction(
    payload: TransactionIn, background: BackgroundTasks, db: Session = Depends(get_db)
):
    return ledger.add_transaction(db, background, payload)


@router.patch("/portfolio/transactions/{transaction_id}")
def replace_transaction(
    transaction_id: int,
    payload: TransactionIn,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
):
    return ledger.replace_transaction(db, background, transaction_id, payload)


@router.delete("/portfolio/transactions/{transaction_id}")
def void_transaction(
    transaction_id: int, background: BackgroundTasks, db: Session = Depends(get_db)
):
    return ledger.void_transaction(db, background, transaction_id)


@router.patch("/portfolio/preferences")
def update_preferences(
    payload: PreferenceIn, background: BackgroundTasks, db: Session = Depends(get_db)
):
    return ledger.update_preferences(db, background, payload.display_currency)


@router.get("/portfolio/performance")
def performance(range: str = "1y", db: Session = Depends(get_db)):
    return ledger.performance(db, range)


@router.get("/portfolio/tickers")
def tickers(db: Session = Depends(get_db)):
    """Per-ticker investment summary with every order/share event (newest first)."""
    return ledger.ticker_breakdown(db)


@router.get("/portfolio/realized")
def realized(db: Session = Depends(get_db)):
    """FIFO realized P/L: per ticker and per sale, with the buy lots each sale used."""
    return ledger.realized_fifo(db)


@router.get("/portfolio/jobs/{job_id}")
def job_status(job_id: str, db: Session = Depends(get_db)):
    return ledger.job_status(db, job_id)


@router.post("/portfolio/imports/preview")
async def import_preview(file: UploadFile = File(...), db: Session = Depends(get_db)):
    ledger.get_or_create(db)
    chunks, size = [], 0
    while chunk := await file.read(1024 * 1024):
        size += len(chunk)
        if size > imports.MAX_IMPORT_BYTES:
            raise HTTPException(
                413, f"CSV exceeds {imports.MAX_IMPORT_BYTES // (1024 * 1024)} MB"
            )
        chunks.append(chunk)
    return imports.create_preview(db, b"".join(chunks))


@router.post("/portfolio/imports/{import_id}/validate")
def validate_import(
    import_id: str, payload: ImportMapping, db: Session = Depends(get_db)
):
    return imports.validate_import(db, import_id, payload.mapping)


@router.post("/portfolio/imports/{import_id}/commit")
def commit_import(
    import_id: str, background: BackgroundTasks, db: Session = Depends(get_db)
):
    return imports.commit_import(db, background, import_id)


@router.get("/portfolio/imports/{import_id}/errors")
def import_errors(import_id: str, db: Session = Depends(get_db)):
    return _csv_download(imports.errors_csv(db, import_id), f"{import_id}_errors.csv")


@router.post("/portfolio/paste/preview")
def paste_preview(payload: PasteIn, db: Session = Depends(get_db)):
    """Parse pasted SSI order rows; flag rows already in the ledger. No writes."""
    return paste.preview(db, payload.text)


@router.post("/portfolio/paste/commit")
def paste_commit(
    payload: PasteCommitIn, background: BackgroundTasks, db: Session = Depends(get_db)
):
    """Re-parse server-side and add the selected non-duplicate rows (source manual)."""
    return paste.commit(db, background, payload.text, payload.keys)


@router.get("/portfolio/transactions/export")
def export_transactions(db: Session = Depends(get_db)):
    return _csv_download(ledger.export_csv(db), "portfolio_transactions.csv")


@router.get("/portfolio/statement")
def portfolio_statement(db: Session = Depends(get_db)):
    return _csv_download(
        valuation.statement_text(db), "portfolio_statement.txt", "text/plain"
    )


# Legacy adapters retained for one release. New UI uses ledger endpoints.
@router.post("/portfolio/holdings")
def add_holding(
    payload: HoldingIn, background: BackgroundTasks, db: Session = Depends(get_db)
):
    return ledger.add_legacy_holding(db, background, payload)


@router.delete("/portfolio/holdings/{holding_id}", status_code=410)
def remove_holding(holding_id: int):
    raise HTTPException(
        410,
        "Holdings are derived from transactions; void or replace the originating transaction",
    )

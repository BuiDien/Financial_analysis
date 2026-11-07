"""Auditable, local-first portfolio ledger and projections."""

from __future__ import annotations

import csv
import io
import json
import threading
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Literal

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
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import or_
from sqlalchemy.orm import Session, sessionmaker

from ..db import get_db
from ..models.portfolio import (
    CashProjection,
    DailyPortfolioSnapshot,
    Portfolio,
    PortfolioJob,
    PortfolioTransaction,
    PositionProjection,
    ProjectionSummary,
)
from ..services import portfolio_engine as engine

router = APIRouter()


class TransactionIn(BaseModel):
    type: Literal["BUY", "SELL", "DIVIDEND", "DEPOSIT", "WITHDRAWAL", "FEE", "TAX"]
    effective_at: datetime
    ticker: str | None = Field(
        default=None, max_length=32, pattern=r"^[A-Za-z0-9.^:_=-]+$"
    )
    quantity: Decimal | None = Field(default=None, gt=0)
    unit_price: Decimal | None = Field(default=None, ge=0)
    cash_amount: Decimal | None = Field(default=None, gt=0)
    currency: str = Field(min_length=3, max_length=3, pattern=r"^[A-Za-z]{3}$")
    fees: Decimal = Field(default=Decimal("0"), ge=0)
    taxes: Decimal = Field(default=Decimal("0"), ge=0)
    note: str | None = Field(default=None, max_length=2000)
    source: str = Field(default="manual", max_length=32)
    external_id: str | None = Field(default=None, max_length=160)

    @field_validator("ticker", mode="before")
    @classmethod
    def normalize_ticker(cls, value):
        return str(value).strip().upper() if value else None

    @field_validator("currency", mode="before")
    @classmethod
    def normalize_currency(cls, value):
        return str(value).strip().upper()

    @model_validator(mode="after")
    def validate_shape(self):
        if self.type in {"BUY", "SELL"} and (
            not self.ticker or self.quantity is None or self.unit_price is None
        ):
            raise ValueError("Trades require ticker, quantity, and unit_price")
        if (
            self.type in {"DIVIDEND", "DEPOSIT", "WITHDRAWAL", "FEE", "TAX"}
            and self.cash_amount is None
        ):
            raise ValueError(f"{self.type} requires cash_amount")
        return self


class HoldingIn(BaseModel):
    ticker: str = Field(min_length=1, max_length=20, pattern=r"^[A-Z0-9.^_-]+$")
    shares: float = Field(gt=0)
    cost_basis: float = Field(ge=0)

    @field_validator("ticker", mode="before")
    @classmethod
    def normalize_ticker(cls, value):
        return str(value).strip().upper()


class PreferenceIn(BaseModel):
    display_currency: str = Field(min_length=3, max_length=3, pattern=r"^[A-Za-z]{3}$")

    @field_validator("display_currency", mode="before")
    @classmethod
    def normalize(cls, value):
        return str(value).strip().upper()


class ImportMapping(BaseModel):
    mapping: dict[str, str]


IMPORT_REQUIRED = {"type", "effective_at", "currency"}
IMPORT_FIELDS = {
    "type",
    "effective_at",
    "ticker",
    "quantity",
    "unit_price",
    "cash_amount",
    "currency",
    "fees",
    "taxes",
    "note",
    "external_id",
}


def _get_or_create(db: Session) -> Portfolio:
    p = db.query(Portfolio).first()
    if not p:
        p = Portfolio(name="Main", display_currency="USD")
        db.add(p)
        db.commit()
        db.refresh(p)
    return p


def _tx_dict(tx: PortfolioTransaction) -> dict:
    return {
        "id": tx.id,
        "type": tx.type,
        "effective_at": tx.effective_at,
        "ticker": tx.ticker,
        "quantity": float(tx.quantity) if tx.quantity is not None else None,
        "unit_price": float(tx.unit_price) if tx.unit_price is not None else None,
        "cash_amount": float(tx.cash_amount) if tx.cash_amount is not None else None,
        "currency": tx.currency,
        "fees": float(tx.fees or 0),
        "taxes": float(tx.taxes or 0),
        "note": tx.note,
        "source": tx.source,
        "external_id": tx.external_id,
        "status": tx.status,
        "replaces_transaction_id": tx.replaces_transaction_id,
        "currency_assumed": tx.currency_assumed,
        "created_at": tx.created_at,
    }


def _schedule_rebuild(
    db: Session, background: BackgroundTasks, p: Portfolio, kind="rebuild"
) -> PortfolioJob:
    job = engine.new_job(db, p, kind)
    factory = sessionmaker(bind=db.get_bind())
    background.add_task(engine.run_job, factory, job.id)
    return job


def _create_tx(
    db: Session,
    p: Portfolio,
    payload: TransactionIn,
    *,
    replaces=None,
    assumed=False,
    validate=True,
    flush=True,
) -> PortfolioTransaction:
    values = payload.model_dump()
    if validate:
        engine.validate_transaction(db, p, values, exclude_id=replaces)
    tx = PortfolioTransaction(
        **values,
        portfolio_id=p.id,
        replaces_transaction_id=replaces,
        currency_assumed=assumed,
    )
    db.add(tx)
    p.ledger_revision += 1
    if flush:
        db.flush()
    return tx


def _run_import_job(factory, import_id: str) -> None:
    db = factory()
    try:
        job = db.get(PortfolioJob, import_id)
        if not job or job.status not in {"queued", "interrupted"}:
            return
        ledger_committed = job.progress >= 60
        job.status, job.progress, job.started_at = (
            "running",
            job.progress if ledger_committed else 15,
            datetime.now(timezone.utc),
        )
        db.commit()
        p = db.get(Portfolio, job.portfolio_id)
        entry = json.loads(job.payload or "{}")
        valid, errors = _mapped_transactions(entry, entry["mapping"])
        if errors:
            raise ValueError(f"Import contains {len(errors)} invalid rows")
        if not ledger_committed:
            engine.validate_ledger_sequence(db, p, valid)
            for payload in valid:
                _create_tx(db, p, payload, validate=False, flush=False)
            job.progress = 60
            job.result = json.dumps({"imported": len(valid), "phase": "ledger"})
            # Transactions and the durable phase marker commit atomically.
            db.commit()
        engine.rebuild(db, p.id)
        job = db.get(PortfolioJob, import_id)
        job.status, job.progress = "completed", 100
        job.result = json.dumps({"imported": len(valid)})
        job.completed_at = datetime.now(timezone.utc)
        db.commit()
    except Exception as exc:
        db.rollback()
        job = db.get(PortfolioJob, import_id)
        if job:
            job.status, job.error = "failed", str(exc)
            job.completed_at = datetime.now(timezone.utc)
            db.commit()
    finally:
        db.close()


def recover_jobs():
    """Resume durable portfolio work after a backend restart."""
    from ..db import SessionLocal

    db = SessionLocal()
    try:
        jobs = (
            db.query(PortfolioJob)
            .filter(PortfolioJob.status.in_(["queued", "running", "interrupted"]))
            .all()
        )
        for job in jobs:
            if job.status == "running":
                job.status = "interrupted"
        db.commit()
        for job in jobs:
            target = _run_import_job if job.type == "import" else engine.run_job
            threading.Thread(
                target=target, args=(SessionLocal, job.id), daemon=True
            ).start()
    finally:
        db.close()


@router.get("/portfolio")
def get_portfolio(
    currency: str | None = Query(default=None, min_length=3, max_length=3),
    db: Session = Depends(get_db),
):
    p = _get_or_create(db)
    if currency and currency.upper() != p.display_currency:
        raise HTTPException(
            409,
            f"Portfolio projection is in {p.display_currency}; update preferences before requesting {currency.upper()}",
        )
    positions = db.query(PositionProjection).filter_by(portfolio_id=p.id).all()
    cash_rows = db.query(CashProjection).filter_by(portfolio_id=p.id).all()
    summary = db.get(ProjectionSummary, p.id)
    holdings, missing, stale = [], [], []
    position_value = Decimal("0")
    today_change = Decimal("0")
    for row in positions:
        item, freshness = engine.quote(db, row.ticker, row.currency)
        if not item:
            missing.append({"kind": "quote", "key": row.ticker})
            price = value_native = value_display = None
        else:
            price = engine.dec(item["price"])
            value_native = price * engine.dec(row.quantity)
            try:
                rate, fx_meta = engine.fx_rate(db, row.currency, p.display_currency)
                value_display = value_native * rate
                if fx_meta["stale"]:
                    stale.append(
                        {
                            "kind": "fx",
                            "key": f"{row.currency}/{p.display_currency}",
                            **fx_meta,
                        }
                    )
                position_value += value_display
                today_change += (
                    engine.dec(item.get("change", 0)) * engine.dec(row.quantity) * rate
                )
            except ValueError:
                value_display = None
                missing.append(
                    {"kind": "fx", "key": f"{row.currency}/{p.display_currency}"}
                )
            if freshness["stale"]:
                stale.append({"kind": "quote", "key": row.ticker, **freshness})
        cost = engine.dec(row.cost_basis_display)
        gain = value_display - cost if value_display is not None else None
        holdings.append(
            {
                "ticker": row.ticker,
                "currency": row.currency,
                "shares": float(row.quantity),
                "avg_cost": float(
                    engine.dec(row.cost_basis_native) / engine.dec(row.quantity)
                ),
                "price": float(price) if price is not None else None,
                "value_native": float(value_native)
                if value_native is not None
                else None,
                "value": float(value_display) if value_display is not None else None,
                "cost_basis": float(cost),
                "gain": float(gain) if gain is not None else None,
                "gain_pct": float(gain / cost * 100)
                if gain is not None and cost
                else 0,
            }
        )
    cash_total = Decimal("0")
    cash = []
    for row in cash_rows:
        try:
            rate, meta = engine.fx_rate(db, row.currency, p.display_currency)
            converted = engine.dec(row.balance) * rate
            cash_total += converted
            if meta["stale"]:
                stale.append(
                    {
                        "kind": "fx",
                        "key": f"{row.currency}/{p.display_currency}",
                        **meta,
                    }
                )
        except ValueError:
            converted = None
            missing.append(
                {"kind": "fx", "key": f"{row.currency}/{p.display_currency}"}
            )
        cash.append(
            {
                "currency": row.currency,
                "balance": float(row.balance),
                "converted": float(converted) if converted is not None else None,
                "warning": "negative_cash" if row.balance < 0 else None,
            }
        )
    total = position_value + cash_total
    realized = engine.dec(summary.realized_gain) if summary else Decimal("0")
    income = engine.dec(summary.income) if summary else Decimal("0")
    contributions = engine.dec(summary.net_contributions) if summary else Decimal("0")
    # Total return includes market, income, expenses, and FX effects while
    # external deposits/withdrawals remain excluded.
    total_gain = total - contributions
    for h in holdings:
        h["weight"] = (
            (h["value"] / float(total) * 100) if h["value"] is not None and total else 0
        )
    db.commit()  # persist fresh cache points
    return {
        "id": p.id,
        "name": p.name,
        "display_currency": p.display_currency,
        "total_value": float(total),
        "position_value": float(position_value),
        "cash_value": float(cash_total),
        "today_change": float(today_change),
        "today_change_pct": float(today_change / (total - today_change) * 100)
        if total != today_change
        else 0,
        "total_gain": float(total_gain),
        "total_gain_pct": float(total_gain / abs(contributions) * 100)
        if contributions
        else 0,
        "realized_gain": float(realized),
        "income": float(income),
        "holdings": holdings,
        "cash": cash,
        "complete": not missing,
        "missing": missing,
        "stale": stale,
        "as_of": datetime.now(timezone.utc),
        "ledger_revision": p.ledger_revision,
        "projection_revision": p.projection_revision,
        "projection_status": p.projection_status,
    }


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
    p = _get_or_create(db)
    query = db.query(PortfolioTransaction).filter_by(portfolio_id=p.id)
    if type:
        query = query.filter(PortfolioTransaction.type == type.upper())
    if ticker:
        query = query.filter(PortfolioTransaction.ticker == ticker.upper())
    if status:
        query = query.filter(PortfolioTransaction.status == status.lower())
    if date_from:
        query = query.filter(
            PortfolioTransaction.effective_at
            >= datetime.combine(date_from, datetime.min.time())
        )
    if date_to:
        query = query.filter(
            PortfolioTransaction.effective_at
            < datetime.combine(date_to + timedelta(days=1), datetime.min.time())
        )
    if search:
        term = f"%{search.strip()}%"
        query = query.filter(
            or_(
                PortfolioTransaction.ticker.ilike(term),
                PortfolioTransaction.note.ilike(term),
            )
        )
    total = query.count()
    rows = (
        query.order_by(
            PortfolioTransaction.effective_at.desc(), PortfolioTransaction.id.desc()
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return {
        "items": [_tx_dict(x) for x in rows],
        "page": page,
        "page_size": page_size,
        "total": total,
    }


@router.post("/portfolio/transactions", status_code=201)
def add_transaction(
    payload: TransactionIn, background: BackgroundTasks, db: Session = Depends(get_db)
):
    p = _get_or_create(db)
    try:
        tx = _create_tx(db, p, payload)
        db.commit()
        db.refresh(tx)
        job = _schedule_rebuild(db, background, p)
        return {"transaction": _tx_dict(tx), "job_id": job.id}
    except ValueError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc


@router.patch("/portfolio/transactions/{transaction_id}")
def replace_transaction(
    transaction_id: int,
    payload: TransactionIn,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
):
    p = _get_or_create(db)
    old = (
        db.query(PortfolioTransaction)
        .filter_by(id=transaction_id, portfolio_id=p.id)
        .first()
    )
    if not old:
        raise HTTPException(404, "Transaction not found")
    if old.status != "active":
        raise HTTPException(409, "Only active transactions can be replaced")
    try:
        old.status, old.voided_at = "replaced", datetime.now(timezone.utc)
        tx = _create_tx(db, p, payload, replaces=old.id)
        db.commit()
        db.refresh(tx)
        job = _schedule_rebuild(db, background, p)
        return {"transaction": _tx_dict(tx), "job_id": job.id}
    except ValueError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc


@router.delete("/portfolio/transactions/{transaction_id}")
def void_transaction(
    transaction_id: int, background: BackgroundTasks, db: Session = Depends(get_db)
):
    p = _get_or_create(db)
    tx = (
        db.query(PortfolioTransaction)
        .filter_by(id=transaction_id, portfolio_id=p.id)
        .first()
    )
    if not tx:
        raise HTTPException(404, "Transaction not found")
    if tx.status != "active":
        raise HTTPException(409, "Transaction is already inactive")
    tx.status, tx.voided_at = "void", datetime.now(timezone.utc)
    p.ledger_revision += 1
    db.commit()
    job = _schedule_rebuild(db, background, p)
    return {"ok": True, "job_id": job.id}


@router.patch("/portfolio/preferences")
def update_preferences(
    payload: PreferenceIn, background: BackgroundTasks, db: Session = Depends(get_db)
):
    p = _get_or_create(db)
    try:
        engine.fx_rate(db, p.display_currency, payload.display_currency)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    p.display_currency = payload.display_currency
    p.ledger_revision += 1
    db.commit()
    job = _schedule_rebuild(db, background, p, "currency_rebuild")
    return {"display_currency": p.display_currency, "job_id": job.id}


@router.get("/portfolio/performance")
def performance(range: str = "1y", db: Session = Depends(get_db)):
    p = _get_or_create(db)
    q = db.query(DailyPortfolioSnapshot).filter_by(
        portfolio_id=p.id, display_currency=p.display_currency
    )
    starts = {
        "1m": 31,
        "3m": 93,
        "ytd": (date.today() - date(date.today().year, 1, 1)).days + 1,
        "1y": 366,
    }
    if range in starts:
        from datetime import timedelta

        q = q.filter(
            DailyPortfolioSnapshot.date >= date.today() - timedelta(days=starts[range])
        )
    rows = q.order_by(DailyPortfolioSnapshot.date).all()
    return {
        "currency": p.display_currency,
        "range": range,
        "items": [
            {
                "date": r.date,
                "value": float(r.value),
                "net_flow": float(r.net_flow),
                "twr": float(r.twr),
            }
            for r in rows
        ],
        "projection_revision": p.projection_revision,
    }


@router.get("/portfolio/jobs/{job_id}")
def job_status(job_id: str, db: Session = Depends(get_db)):
    p = _get_or_create(db)
    job = db.query(PortfolioJob).filter_by(id=job_id, portfolio_id=p.id).first()
    if not job:
        raise HTTPException(404, "Job not found")
    return {
        "id": job.id,
        "type": job.type,
        "status": job.status,
        "progress": job.progress,
        "result": json.loads(job.result) if job.result else None,
        "error": job.error,
    }


@router.post("/portfolio/imports/preview")
async def import_preview(file: UploadFile = File(...), db: Session = Depends(get_db)):
    p = _get_or_create(db)
    raw = await file.read()
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(413, "CSV exceeds 20 MB")
    try:
        text = raw.decode("utf-8-sig")
        reader = csv.DictReader(io.StringIO(text))
        rows = list(reader)
    except Exception as exc:
        raise HTTPException(422, f"Invalid CSV: {exc}") from exc
    if not reader.fieldnames:
        raise HTTPException(422, "CSV has no header row")
    import_id = "imp_" + __import__("secrets").token_hex(10)
    db.add(
        PortfolioJob(
            id=import_id,
            portfolio_id=p.id,
            type="import",
            status="preview",
            progress=0,
            payload=json.dumps(
                {"headers": reader.fieldnames, "rows": rows, "mapping": None}
            ),
        )
    )
    db.commit()
    return {
        "import_id": import_id,
        "headers": reader.fieldnames,
        "sample": rows[:20],
        "row_count": len(rows),
        "canonical_fields": sorted(IMPORT_FIELDS),
        "required_fields": sorted(IMPORT_REQUIRED),
    }


def _mapped_transactions(
    entry: dict, mapping: dict[str, str]
) -> tuple[list[TransactionIn], list[dict]]:
    reverse = {
        canonical: source
        for source, canonical in mapping.items()
        if canonical in IMPORT_FIELDS
    }
    missing = IMPORT_REQUIRED - set(reverse)
    if missing:
        raise HTTPException(
            422, f"Missing required mappings: {', '.join(sorted(missing))}"
        )
    valid, errors = [], []
    for index, raw in enumerate(entry["rows"], start=2):
        values = {field: raw.get(source, "") for field, source in reverse.items()}
        for optional in ("quantity", "unit_price", "cash_amount", "fees", "taxes"):
            if values.get(optional) == "":
                values[optional] = None if optional not in {"fees", "taxes"} else 0
        values["source"] = "csv"
        try:
            valid.append(TransactionIn.model_validate(values))
        except Exception as exc:
            errors.append({"row": index, "message": str(exc), "values": values})
    return valid, errors


@router.post("/portfolio/imports/{import_id}/validate")
def validate_import(
    import_id: str, payload: ImportMapping, db: Session = Depends(get_db)
):
    p = _get_or_create(db)
    job = (
        db.query(PortfolioJob)
        .filter_by(id=import_id, portfolio_id=p.id, type="import")
        .first()
    )
    if not job:
        raise HTTPException(404, "Import preview expired")
    entry = json.loads(job.payload or "{}")
    valid, errors = _mapped_transactions(entry, payload.mapping)
    entry["mapping"] = payload.mapping
    job.payload = json.dumps(entry)
    job.status = "validated" if valid and not errors else "invalid"
    job.progress = 10
    job.error = json.dumps(errors[:500]) if errors else None
    db.commit()
    return {
        "import_id": import_id,
        "valid_rows": len(valid),
        "error_rows": len(errors),
        "errors": errors[:500],
        "can_commit": bool(valid) and not errors,
    }


@router.post("/portfolio/imports/{import_id}/commit")
def commit_import(
    import_id: str, background: BackgroundTasks, db: Session = Depends(get_db)
):
    p = _get_or_create(db)
    import_job = (
        db.query(PortfolioJob)
        .filter_by(id=import_id, portfolio_id=p.id, type="import")
        .first()
    )
    if not import_job or import_job.status != "validated":
        raise HTTPException(409, "Validate the import first")
    entry = json.loads(import_job.payload or "{}")
    valid, errors = _mapped_transactions(entry, entry["mapping"])
    if errors:
        raise HTTPException(
            422, {"message": "Import contains errors", "errors": errors[:500]}
        )
    import_job.status = "queued"
    import_job.progress = 10
    import_job.error = None
    db.commit()
    factory = sessionmaker(bind=db.get_bind())
    background.add_task(_run_import_job, factory, import_job.id)
    return {"imported": len(valid), "job_id": import_job.id}


@router.get("/portfolio/imports/{import_id}/errors")
def import_errors(import_id: str, db: Session = Depends(get_db)):
    p = _get_or_create(db)
    job = (
        db.query(PortfolioJob)
        .filter_by(id=import_id, portfolio_id=p.id, type="import")
        .first()
    )
    if not job:
        raise HTTPException(404, "Import not found")
    errors = json.loads(job.error or "[]")
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["row", "message", "values"])
    for error in errors:
        writer.writerow(
            [error.get("row"), error.get("message"), json.dumps(error.get("values"))]
        )
    return StreamingResponse(
        iter([out.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={import_id}_errors.csv"},
    )


@router.get("/portfolio/transactions/export")
def export_transactions(db: Session = Depends(get_db)):
    p = _get_or_create(db)
    rows = (
        db.query(PortfolioTransaction)
        .filter_by(portfolio_id=p.id)
        .order_by(PortfolioTransaction.effective_at)
        .all()
    )
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(
        [
            "id",
            "type",
            "effective_at",
            "ticker",
            "quantity",
            "unit_price",
            "cash_amount",
            "currency",
            "fees",
            "taxes",
            "source",
            "status",
            "note",
        ]
    )
    for tx in rows:
        writer.writerow(
            [
                tx.id,
                tx.type,
                tx.effective_at.isoformat(),
                tx.ticker or "",
                tx.quantity or "",
                tx.unit_price or "",
                tx.cash_amount or "",
                tx.currency,
                tx.fees,
                tx.taxes,
                tx.source,
                tx.status,
                tx.note or "",
            ]
        )
    return StreamingResponse(
        iter([out.getvalue()]),
        media_type="text/csv",
        headers={
            "Content-Disposition": "attachment; filename=portfolio_transactions.csv"
        },
    )


@router.get("/portfolio/statement")
def portfolio_statement(db: Session = Depends(get_db)):
    data = get_portfolio(currency=None, db=db)
    currency = data["display_currency"]
    lines = [
        "PORTFOLIO STATEMENT",
        f"Generated: {datetime.now(timezone.utc).isoformat()}",
        f"Ledger revision: {data['ledger_revision']}",
        f"Valuation complete: {'yes' if data['complete'] else 'no'}",
        "",
        f"Total value ({currency}): {data['total_value']:.2f}",
        f"Cash ({currency}): {data['cash_value']:.2f}",
        f"Investment gain ({currency}): {data['total_gain']:.2f} ({data['total_gain_pct']:.2f}%)",
        "",
        "HOLDINGS",
        "Ticker,Currency,Shares,Avg FIFO Cost,Last,Converted Value,Gain,Gain %,Weight %",
    ]
    for holding in data["holdings"]:
        lines.append(
            ",".join(
                str(value if value is not None else "")
                for value in (
                    holding["ticker"],
                    holding["currency"],
                    holding["shares"],
                    holding["avg_cost"],
                    holding["price"],
                    holding["value"],
                    holding["gain"],
                    holding["gain_pct"],
                    holding["weight"],
                )
            )
        )
    return StreamingResponse(
        iter(["\n".join(lines)]),
        media_type="text/plain",
        headers={"Content-Disposition": "attachment; filename=portfolio_statement.txt"},
    )


# Legacy adapters retained for one release. New UI uses ledger endpoints.
@router.post("/portfolio/holdings")
def add_holding(
    payload: HoldingIn, background: BackgroundTasks, db: Session = Depends(get_db)
):
    p = _get_or_create(db)
    tx_in = TransactionIn(
        type="BUY",
        effective_at=datetime.now(timezone.utc),
        ticker=payload.ticker,
        quantity=Decimal(str(payload.shares)),
        unit_price=Decimal(str(payload.cost_basis)) / Decimal(str(payload.shares)),
        currency=p.display_currency,
    )
    tx = _create_tx(db, p, tx_in)
    db.commit()
    db.refresh(tx)
    job = _schedule_rebuild(db, background, p)
    return {
        "id": tx.id,
        "ticker": tx.ticker,
        "shares": float(tx.quantity),
        "cost_basis": float(tx.quantity * tx.unit_price),
        "job_id": job.id,
        "deprecated": True,
    }


@router.delete("/portfolio/holdings/{holding_id}", status_code=410)
def remove_holding(holding_id: int):
    raise HTTPException(
        410,
        "Holdings are derived from transactions; void or replace the originating transaction",
    )

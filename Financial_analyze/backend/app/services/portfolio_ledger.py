"""Portfolio ledger: transactions, preferences, performance and job status.

The ledger is append-only: edits replace a transaction, deletes void it, and
every change bumps ``ledger_revision`` and schedules a projection rebuild.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import or_
from sqlalchemy.orm import Session, sessionmaker

from ..jobs.portfolio import run_portfolio_job
from ..models.portfolio import (
    DailyPortfolioSnapshot,
    Portfolio,
    PortfolioJob,
    PortfolioTransaction,
)
from . import portfolio_engine as engine
from .errors import ServiceError
from .portfolio_schemas import HoldingIn, TransactionIn


def get_or_create(db: Session) -> Portfolio:
    p = db.query(Portfolio).first()
    if not p:
        p = Portfolio(name="Main", display_currency="USD")
        db.add(p)
        db.commit()
        db.refresh(p)
    return p


def tx_dict(tx: PortfolioTransaction) -> dict:
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


def schedule_rebuild(db: Session, background, p: Portfolio, kind="rebuild") -> PortfolioJob:
    """Queue a projection rebuild. ``background`` (FastAPI BackgroundTasks)
    starts it on the job runner after the response."""
    job = engine.new_job(db, p, kind)
    factory = sessionmaker(bind=db.get_bind())
    background.add_task(run_portfolio_job, factory, job.id, job.type)
    return job


def create_tx(
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


def _day_start_utc(day: date) -> datetime:
    local = datetime.combine(day, datetime.min.time(), tzinfo=engine.VN_TZ)
    return local.astimezone(timezone.utc).replace(tzinfo=None)


def list_transactions(
    db: Session,
    *,
    type: str | None,
    ticker: str | None,
    status: str | None,
    search: str | None,
    date_from: date | None,
    date_to: date | None,
    page: int,
    page_size: int,
) -> dict:
    p = get_or_create(db)
    query = db.query(PortfolioTransaction).filter_by(portfolio_id=p.id)
    if type:
        query = query.filter(PortfolioTransaction.type == type.upper())
    if ticker:
        query = query.filter(PortfolioTransaction.ticker == ticker.upper())
    if status:
        query = query.filter(PortfolioTransaction.status == status.lower())
    if date_from:
        query = query.filter(PortfolioTransaction.effective_at >= _day_start_utc(date_from))
    if date_to:
        query = query.filter(
            PortfolioTransaction.effective_at < _day_start_utc(date_to + timedelta(days=1))
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
        "items": [tx_dict(x) for x in rows],
        "page": page,
        "page_size": page_size,
        "total": total,
    }


def add_transaction(db: Session, background, payload: TransactionIn) -> dict:
    p = get_or_create(db)
    try:
        tx = create_tx(db, p, payload)
        db.commit()
        db.refresh(tx)
        job = schedule_rebuild(db, background, p)
        return {"transaction": tx_dict(tx), "job_id": job.id}
    except ValueError as exc:
        db.rollback()
        raise ServiceError(422, str(exc)) from exc


def _find_transaction(db: Session, p: Portfolio, transaction_id: int) -> PortfolioTransaction:
    tx = (
        db.query(PortfolioTransaction)
        .filter_by(id=transaction_id, portfolio_id=p.id)
        .first()
    )
    if not tx:
        raise ServiceError(404, "Transaction not found")
    return tx


def replace_transaction(
    db: Session, background, transaction_id: int, payload: TransactionIn
) -> dict:
    p = get_or_create(db)
    old = _find_transaction(db, p, transaction_id)
    if old.status != "active":
        raise ServiceError(409, "Only active transactions can be replaced")
    try:
        old.status, old.voided_at = "replaced", datetime.now(timezone.utc)
        if payload.external_id and (payload.source, payload.external_id) == (old.source, old.external_id):
            # The edited version takes over the import id (uq_portfolio_import_external
            # covers every status); the chain keeps exactly one holder, so importers
            # still see the trade as known and a pasted row stays marked as pasted.
            old.external_id = None
            db.flush()
        tx = create_tx(db, p, payload, replaces=old.id)
        db.commit()
        db.refresh(tx)
        job = schedule_rebuild(db, background, p)
        return {"transaction": tx_dict(tx), "job_id": job.id}
    except ValueError as exc:
        db.rollback()
        raise ServiceError(422, str(exc)) from exc


def void_transaction(db: Session, background, transaction_id: int) -> dict:
    p = get_or_create(db)
    tx = _find_transaction(db, p, transaction_id)
    if tx.status != "active":
        raise ServiceError(409, "Transaction is already inactive")
    tx.status, tx.voided_at = "void", datetime.now(timezone.utc)
    p.ledger_revision += 1
    db.commit()
    job = schedule_rebuild(db, background, p)
    return {"ok": True, "job_id": job.id}


def update_preferences(db: Session, background, display_currency: str) -> dict:
    p = get_or_create(db)
    try:
        engine.fx_rate(db, p.display_currency, display_currency)
    except ValueError as exc:
        raise ServiceError(422, str(exc)) from exc
    p.display_currency = display_currency
    p.ledger_revision += 1
    db.commit()
    job = schedule_rebuild(db, background, p, "currency_rebuild")
    return {"display_currency": p.display_currency, "job_id": job.id}


def performance(db: Session, range: str) -> dict:
    p = get_or_create(db)
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


def ticker_breakdown(db: Session) -> dict:
    p = get_or_create(db)
    try:
        return engine.ticker_breakdown(db, p)
    except ValueError as exc:
        raise ServiceError(422, str(exc)) from exc


def realized_fifo(db: Session) -> dict:
    p = get_or_create(db)
    try:
        return engine.realized_fifo(db, p)
    except ValueError as exc:
        raise ServiceError(422, str(exc)) from exc


def job_status(db: Session, job_id: str) -> dict:
    p = get_or_create(db)
    job = db.query(PortfolioJob).filter_by(id=job_id, portfolio_id=p.id).first()
    if not job:
        raise ServiceError(404, "Job not found")
    return {
        "id": job.id,
        "type": job.type,
        "status": job.status,
        "progress": job.progress,
        "result": json.loads(job.result) if job.result else None,
        "error": job.error,
    }


EXPORT_COLUMNS = [
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


def export_csv(db: Session) -> str:
    p = get_or_create(db)
    rows = (
        db.query(PortfolioTransaction)
        .filter_by(portfolio_id=p.id)
        .order_by(PortfolioTransaction.effective_at)
        .all()
    )
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(EXPORT_COLUMNS)
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
    return out.getvalue()


def add_legacy_holding(db: Session, background, payload: HoldingIn) -> dict:
    """Legacy /portfolio/holdings adapter: a holding becomes a BUY transaction."""
    p = get_or_create(db)
    tx_in = TransactionIn(
        type="BUY",
        effective_at=datetime.now(timezone.utc),
        ticker=payload.ticker,
        quantity=Decimal(str(payload.shares)),
        unit_price=Decimal(str(payload.cost_basis)) / Decimal(str(payload.shares)),
        currency=p.display_currency,
    )
    tx = create_tx(db, p, tx_in)
    db.commit()
    db.refresh(tx)
    job = schedule_rebuild(db, background, p)
    return {
        "id": tx.id,
        "ticker": tx.ticker,
        "shares": float(tx.quantity),
        "cost_basis": float(tx.quantity * tx.unit_price),
        "job_id": job.id,
        "deprecated": True,
    }

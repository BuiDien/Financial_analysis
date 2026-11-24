"""CSV transaction import: preview → validate mapping → commit as a durable job.

The import job row (``PortfolioJob`` with type "import") holds the CSV in its
payload. Committing writes the ledger and a ``progress=60`` phase marker in one
transaction, so a restart resumes at the rebuild instead of re-importing.
"""

from __future__ import annotations

import csv
import io
import json
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session, sessionmaker

from ..jobs.portfolio import run_portfolio_job, submit_portfolio_job
from ..models.portfolio import Portfolio, PortfolioJob
from . import portfolio_engine as engine
from .errors import ServiceError
from .portfolio_ledger import create_tx, get_or_create
from .portfolio_schemas import TransactionIn

IMPORT_REQUIRED = {"type", "effective_at", "currency"}
MAX_IMPORT_BYTES = 20 * 1024 * 1024
STALE_IMPORT_AGE = timedelta(hours=24)
# Only an import that has not touched the ledger may be (re)validated.
REVALIDATABLE = {"preview", "validated", "invalid"}
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


def mapped_transactions(
    entry: dict, mapping: dict[str, str]
) -> tuple[list[TransactionIn], list[dict]]:
    reverse = {
        canonical: source
        for source, canonical in mapping.items()
        if canonical in IMPORT_FIELDS
    }
    missing = IMPORT_REQUIRED - set(reverse)
    if missing:
        raise ServiceError(
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


def run_import_job(factory, import_id: str) -> None:
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
        valid, errors = mapped_transactions(entry, entry["mapping"])
        if errors:
            raise ValueError(f"Import contains {len(errors)} invalid rows")
        if not ledger_committed:
            engine.validate_ledger_sequence(db, p, valid)
            for payload in valid:
                create_tx(db, p, payload, validate=False, flush=False)
            job.progress = 60
            job.result = json.dumps({"imported": len(valid), "phase": "ledger"})
            # Transactions and the durable phase marker commit atomically.
            db.commit()
        engine.rebuild(db, p.id)  # takes the per-portfolio rebuild lock
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
            submit_portfolio_job(SessionLocal, job.id, job.type)
    finally:
        db.close()


def create_preview(db: Session, raw: bytes) -> dict:
    """Parse an uploaded CSV and store it as an import preview job."""
    p = get_or_create(db)
    try:
        text = raw.decode("utf-8-sig")
        reader = csv.DictReader(io.StringIO(text))
        rows = list(reader)
    except Exception as exc:
        raise ServiceError(422, f"Invalid CSV: {exc}") from exc
    if not reader.fieldnames:
        raise ServiceError(422, "CSV has no header row")
    import_id = "imp_" + secrets.token_hex(10)
    # Abandoned previews hold the whole CSV in their payload: drop them.
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - STALE_IMPORT_AGE
    db.query(PortfolioJob).filter(
        PortfolioJob.portfolio_id == p.id,
        PortfolioJob.type == "import",
        PortfolioJob.status.in_(REVALIDATABLE),
        PortfolioJob.created_at < cutoff,
    ).delete(synchronize_session=False)
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


def _import_job(db: Session, import_id: str) -> PortfolioJob | None:
    p = get_or_create(db)
    return (
        db.query(PortfolioJob)
        .filter_by(id=import_id, portfolio_id=p.id, type="import")
        .first()
    )


def validate_import(db: Session, import_id: str, mapping: dict[str, str]) -> dict:
    job = _import_job(db, import_id)
    if not job:
        raise ServiceError(404, "Import preview expired")
    if job.status not in REVALIDATABLE:
        raise ServiceError(
            409, f"Import is {job.status}; upload the CSV again to start a new import"
        )
    entry = json.loads(job.payload or "{}")
    valid, errors = mapped_transactions(entry, mapping)
    entry["mapping"] = mapping
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


def commit_import(db: Session, background, import_id: str) -> dict:
    """Queue a validated import; ``background`` is a FastAPI BackgroundTasks."""
    import_job = _import_job(db, import_id)
    if not import_job or import_job.status != "validated":
        raise ServiceError(409, "Validate the import first")
    entry = json.loads(import_job.payload or "{}")
    valid, errors = mapped_transactions(entry, entry["mapping"])
    if errors:
        raise ServiceError(
            422, {"message": "Import contains errors", "errors": errors[:500]}
        )
    import_job.status = "queued"
    import_job.progress = 10
    import_job.error = None
    db.commit()
    factory = sessionmaker(bind=db.get_bind())
    background.add_task(run_portfolio_job, factory, import_job.id, "import")
    return {"imported": len(valid), "job_id": import_job.id}


def errors_csv(db: Session, import_id: str) -> str:
    job = _import_job(db, import_id)
    if not job:
        raise ServiceError(404, "Import not found")
    errors = json.loads(job.error or "[]")
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["row", "message", "values"])
    for error in errors:
        writer.writerow(
            [error.get("row"), error.get("message"), json.dumps(error.get("values"))]
        )
    return out.getvalue()

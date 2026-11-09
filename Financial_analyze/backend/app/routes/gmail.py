"""Gmail import settings + manual check. The app password is write-only:
it goes to macOS Keychain and is never returned by any endpoint."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..models.gmail import GmailReport
from ..services import gmail_pull
from ..services.secret_store import SecretStoreError

router = APIRouter()


class GmailSettingsIn(BaseModel):
    address: str | None = Field(default=None, max_length=254)
    query: str | None = Field(default=None, max_length=500)
    enabled: bool | None = None
    interval_minutes: int | None = Field(default=None, ge=5, le=1440)
    password: str | None = Field(default=None, max_length=128)


def _iso(dt):
    return dt.isoformat() if dt else None


def _settings_dict(cfg) -> dict:
    return {
        "address": cfg.address,
        "query": cfg.query or gmail_pull.DEFAULT_QUERY,
        "default_query": gmail_pull.DEFAULT_QUERY,
        "enabled": cfg.enabled,
        "interval_minutes": cfg.interval_minutes,
        "password_saved": bool(gmail_pull.get_password()),
        "last_checked_at": _iso(cfg.last_checked_at),
        "last_status": cfg.last_status,
        "last_error": cfg.last_error,
        "last_summary": cfg.last_summary,
    }


@router.get("/gmail/settings")
def read_gmail_settings(db: Session = Depends(get_db)):
    return _settings_dict(gmail_pull.get_config(db))


@router.put("/gmail/settings")
def update_gmail_settings(body: GmailSettingsIn, db: Session = Depends(get_db)):
    cfg = gmail_pull.get_config(db)
    if body.address is not None:
        address = body.address.strip()
        if address and "@" not in address:
            raise HTTPException(400, "Enter a valid Gmail address.")
        cfg.address = address or None
    if body.query is not None:
        cfg.query = body.query.strip() or gmail_pull.DEFAULT_QUERY
    if body.interval_minutes is not None:
        cfg.interval_minutes = body.interval_minutes
    if body.password:
        password = body.password.replace(" ", "")
        if not password.isalnum() or not 8 <= len(password) <= 64:
            raise HTTPException(400, "App password should be the 16-letter code from Google.")
        try:
            gmail_pull.set_password(password)
        except SecretStoreError as e:
            raise HTTPException(500, f"Could not save to Keychain: {e}")
    if body.enabled is not None:
        if body.enabled and (not cfg.address or not gmail_pull.get_password()):
            raise HTTPException(400, "Save the Gmail address and app password before turning on auto-check.")
        cfg.enabled = body.enabled
    db.commit()
    return _settings_dict(cfg)


@router.delete("/gmail/password")
def remove_password(db: Session = Depends(get_db)):
    gmail_pull.delete_password()
    cfg = gmail_pull.get_config(db)
    cfg.enabled = False
    db.commit()
    return _settings_dict(cfg)


def _call(fn, db):
    try:
        return fn(db)
    except gmail_pull.GmailBusy as e:
        raise HTTPException(409, str(e))
    except gmail_pull.GmailError as e:
        raise HTTPException(400, str(e))


@router.post("/gmail/test")
def test_connection(db: Session = Depends(get_db)):
    return _call(gmail_pull.test_connection, db)


@router.post("/gmail/check")
def check_now(db: Session = Depends(get_db)):
    summary = _call(gmail_pull.run_check, db)
    return {"summary": summary, "settings": _settings_dict(gmail_pull.get_config(db))}


@router.post("/gmail/import")
def import_downloaded(db: Session = Depends(get_db)):
    """Import every downloaded-but-not-imported report into the portfolio."""
    from ..services import ssi_import
    try:
        return ssi_import.import_pending(db)
    except ValueError as e:
        db.rollback()
        raise HTTPException(422, str(e))


@router.get("/gmail/reports")
def list_reports(limit: int = 50, db: Session = Depends(get_db)):
    limit = max(1, min(limit, 200))
    rows = (db.query(GmailReport)
            .order_by(GmailReport.received_at.desc().nullslast(), GmailReport.id.desc())
            .limit(limit).all())
    return {"reports": [{
        "id": r.id,
        "received_at": _iso(r.received_at),
        "sender": r.sender,
        "subject": r.subject,
        "status": r.status,
        "error": r.error,
        "attachments": [{k: a.get(k) for k in ("filename", "size", "encrypted")} for a in (r.attachments or [])],
    } for r in rows]}

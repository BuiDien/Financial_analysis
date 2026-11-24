"""Price alerts store: CRUD plus idempotent import of the legacy localStorage array.

Wire format is the frontend's camelCase alert object
(id, ticker, type, value, note, active, channels, currency, created,
triggered, triggeredAt, triggeredPrice); unknown keys round-trip via `extra`.
"""

from __future__ import annotations

import math
import secrets
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from ..models.alerts import PriceAlert
from .errors import ServiceError

# wire key -> column (identity for single-word keys)
_FIELDS = {
    "ticker": "ticker", "type": "type", "value": "value", "currency": "currency",
    "note": "note", "channels": "channels", "active": "active",
    "triggered": "triggered", "triggeredAt": "triggered_at",
    "triggeredPrice": "triggered_price", "created": "created",
}
_NUMERIC = {"value", "triggeredPrice"}
_INT = {"triggeredAt"}
_BOOL = {"active", "triggered"}


def _json_safe(v):
    """Non-finite floats (a row written before _coerce rejected them, or a
    NaN/Infinity literal in `extra`) read back as null instead of a 500."""
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, dict):
        return {k: _json_safe(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_json_safe(x) for x in v]
    return v


def serialize(a: PriceAlert) -> dict:
    out = {
        "id": a.id, "ticker": a.ticker, "type": a.type, "value": a.value,
        "currency": a.currency, "note": a.note or "", "channels": a.channels,
        "active": bool(a.active), "triggered": bool(a.triggered),
        "triggeredAt": a.triggered_at, "triggeredPrice": a.triggered_price,
        "created": a.created,
    }
    for k, v in (a.extra or {}).items():
        out.setdefault(k, v)
    return _json_safe(out)


def _coerce(key: str, v):
    if key in _BOOL:
        return bool(v)
    if v is None:
        return None
    try:
        if key in _NUMERIC:
            f = float(v)
            if not math.isfinite(f):  # float() accepts "Infinity"/"NaN"
                raise ServiceError(422, f"{key} must be a finite number")
            return f
        if key in _INT:
            return int(v)
    except (TypeError, ValueError, OverflowError):
        raise ServiceError(422, f"{key} must be a number")
    if key == "ticker":
        v = str(v).strip().upper()
    return v


def _split(payload: dict) -> tuple[dict, dict]:
    cols, extra = {}, {}
    for k, v in payload.items():
        if k == "id":
            continue
        if k in _FIELDS:
            cols[_FIELDS[k]] = _coerce(k, v)
        else:
            extra[k] = v
    return cols, extra


def _new_id() -> str:
    return f"a_{int(time.time() * 1000)}_{secrets.token_hex(2)}"


def list_alerts(db: Session) -> list[dict]:
    rows = db.query(PriceAlert).order_by(PriceAlert.created_ts.desc(), PriceAlert.id.desc()).all()
    return [serialize(a) for a in rows]


def create_alert(db: Session, payload: dict) -> dict:
    cols, extra = _split(payload)
    if not cols.get("ticker"):
        raise ServiceError(422, "ticker is required")
    if not cols.get("type"):
        raise ServiceError(422, "type is required")
    now = datetime.now(timezone.utc)
    cols.setdefault("active", True)
    cols.setdefault("triggered", False)
    cols.setdefault("created", now.date().isoformat())
    alert_id = str(payload.get("id") or _new_id())
    if db.get(PriceAlert, alert_id):
        raise ServiceError(409, "alert id already exists")
    a = PriceAlert(id=alert_id, extra=extra or None, created_ts=now, **cols)
    db.add(a)
    db.commit()
    return serialize(a)


def update_alert(db: Session, alert_id: str, patch: dict) -> dict:
    a = db.get(PriceAlert, alert_id)
    if a is None:
        raise ServiceError(404, "alert not found")
    cols, extra = _split(patch)
    if "ticker" in cols and not cols["ticker"]:
        raise ServiceError(422, "ticker cannot be empty")
    if "type" in cols and not cols["type"]:
        raise ServiceError(422, "type cannot be empty")
    for k, v in cols.items():
        setattr(a, k, v)
    if extra:
        a.extra = {**(a.extra or {}), **extra}
    db.commit()
    return serialize(a)


def delete_alert(db: Session, alert_id: str) -> None:
    a = db.get(PriceAlert, alert_id)
    if a is None:
        raise ServiceError(404, "alert not found")
    db.delete(a)
    db.commit()


def clear_alerts(db: Session) -> int:
    n = db.query(PriceAlert).delete()
    db.commit()
    return n


def import_alerts(db: Session, items: list) -> dict:
    """Insert alerts whose client id is unseen; existing ids are left untouched.

    `items` is the localStorage array (newest first); order is preserved.
    """
    base = datetime.now(timezone.utc)
    existing = {i for (i,) in db.query(PriceAlert.id).all()}
    imported = skipped = 0
    for idx, raw in enumerate(items):
        if not isinstance(raw, dict):
            skipped += 1
            continue
        cols, extra = _split(raw)
        alert_id = str(raw["id"]) if raw.get("id") else _new_id()
        if alert_id in existing or not cols.get("ticker") or not cols.get("type"):
            skipped += 1
            continue
        cols.setdefault("active", True)
        cols.setdefault("triggered", False)
        db.add(PriceAlert(id=alert_id, extra=extra or None,
                          created_ts=base - timedelta(microseconds=idx), **cols))
        existing.add(alert_id)
        imported += 1
    db.commit()
    return {"imported": imported, "skipped": skipped}

"""Price alerts CRUD (replaces browser localStorage `helix_alerts_v1`)."""
from typing import Any

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from ..db import get_db
from ..services import alerts as svc

router = APIRouter(prefix="/alerts")


class AlertBody(BaseModel):
    """Frontend camelCase alert; unknown fields are kept (stored in `extra`)."""
    model_config = ConfigDict(extra="allow")


class ImportBody(BaseModel):
    alerts: list[Any]


@router.get("")
def list_alerts(db: Session = Depends(get_db)):
    return svc.list_alerts(db)


@router.post("", status_code=201)
def create_alert(body: AlertBody, db: Session = Depends(get_db)):
    return svc.create_alert(db, body.model_dump())


@router.post("/import")
def import_alerts(body: ImportBody | list[Any], db: Session = Depends(get_db)):
    items = body.alerts if isinstance(body, ImportBody) else body
    return svc.import_alerts(db, items)


@router.patch("/{alert_id}")
def update_alert(alert_id: str, body: AlertBody, db: Session = Depends(get_db)):
    return svc.update_alert(db, alert_id, body.model_dump())


@router.delete("/{alert_id}", status_code=204)
def delete_alert(alert_id: str, db: Session = Depends(get_db)):
    svc.delete_alert(db, alert_id)
    return Response(status_code=204)


@router.delete("")
def clear_alerts(db: Session = Depends(get_db)):
    return {"deleted": svc.clear_alerts(db)}

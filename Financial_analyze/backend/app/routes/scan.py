from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models.scan import ScanRun, ScanResult
from ..scanner.runner import run_scan

router = APIRouter()


class ScanIn(BaseModel):
    limit: int | None = None


@router.post("/scan")
def trigger_scan(body: ScanIn | None = None, db: Session = Depends(get_db)):
    limit = body.limit if body else None
    # limit=0 -> empty universe (used by tests to avoid the network)
    universe = [] if limit == 0 else None
    return run_scan(db, mode="manual", universe=universe, limit=limit)


@router.get("/scan/latest")
def latest(db: Session = Depends(get_db)):
    run = db.query(ScanRun).order_by(ScanRun.id.desc()).first()
    if not run:
        return {"run_id": None, "started_at": None, "results": []}
    rows = (db.query(ScanResult)
              .filter(ScanResult.run_id == run.id)
              .order_by(ScanResult.rank).all())
    return {
        "run_id": run.id,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "results": [{"symbol": r.symbol, "total_score": r.total_score, "lean": r.lean,
                     "rank": r.rank, "verified": r.verified, "scores": r.scores} for r in rows],
    }

"""Filings — upload PDF, list, OCR-parse, analyze, Q&A, tracker persistence.

Endpoint mapping to the frontend:
  Filings tab table        → GET    /api/filings
  Upload dialog            → POST   /api/filings/upload          (multipart)
  "Analyze with AI" button → POST   /api/filings/{id}/analyze
  Reader "OCR Parse"       → POST   /api/filings/{id}/ocr-parse
  Reader AI companion ask  → POST   /api/filings/{id}/ask
  Data Tracker save        → PUT    /api/filings/{id}/tracker
  Data Tracker load        → GET    /api/filings/{id}/tracker
  Open PDF                 → GET    /api/filings/{id}/file
"""
import os
import uuid
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel

from ..config import get_settings
from ..db import get_db
from ..models.filing import Filing
from ..services import pdf, ai

router = APIRouter()
settings = get_settings()


def _serialize(f: Filing) -> dict:
    return {
        "id": f.id, "ticker": f.ticker, "filing_type": f.filing_type, "period": f.period,
        "filename": f.filename, "size_bytes": f.size_bytes, "pages": f.pages,
        "status": f.status, "extracted": f.extracted or {},
        "uploaded_at": f.uploaded_at.isoformat() if f.uploaded_at else None,
    }


@router.get("/filings")
def list_filings(ticker: str | None = None, db: Session = Depends(get_db)):
    q = db.query(Filing).order_by(Filing.uploaded_at.desc())
    if ticker:
        q = q.filter(Filing.ticker == ticker.upper())
    return [_serialize(f) for f in q.all()]


@router.post("/filings/upload")
async def upload_filing(
    file: UploadFile = File(...),
    ticker: str = Form(...),
    filing_type: str = Form(...),
    period: str = Form(...),
    db: Session = Depends(get_db),
):
    content = await file.read()
    if len(content) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f"File exceeds {settings.max_upload_mb} MB limit")
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "PDF required")

    Path(settings.upload_dir).mkdir(parents=True, exist_ok=True)
    storage_path = os.path.join(settings.upload_dir, f"{uuid.uuid4().hex}_{file.filename}")
    with open(storage_path, "wb") as fp:
        fp.write(content)

    try:
        meta = pdf.quick_meta(storage_path)
    except Exception:
        meta = {"pages": 0, "extracted": {}}

    f = Filing(
        ticker=ticker.upper(), filing_type=filing_type, period=period,
        filename=file.filename, storage_path=storage_path,
        size_bytes=len(content), pages=meta.get("pages", 0),
        status="pending", extracted=meta.get("extracted", {}),
    )
    db.add(f); db.commit(); db.refresh(f)
    return _serialize(f)


@router.post("/filings/{filing_id}/ocr-parse")
def ocr_parse(filing_id: int, db: Session = Depends(get_db)):
    """Extract statement tables → tracker-shaped rows with confidence.

    Mirrors the frontend OCR dialog's review schema:
      [{id, section, metric, curr, prev, page, confidence}, ...]
    """
    f = db.query(Filing).filter_by(id=filing_id).first()
    if not f:
        raise HTTPException(404)
    try:
        rows = pdf.parse_statements(f.storage_path)
        return {"filing_id": f.id, "rows": rows}
    except Exception as e:
        raise HTTPException(500, f"OCR parse failed: {e}")


@router.post("/filings/{filing_id}/analyze")
def analyze_filing(filing_id: int, db: Session = Depends(get_db)):
    f = db.query(Filing).filter_by(id=filing_id).first()
    if not f:
        raise HTTPException(404)
    try:
        text = pdf.extract_text(f.storage_path)
        result = ai.analyze_filing(text=text, ticker=f.ticker,
                                   filing_type=f.filing_type, period=f.period)
        f.analysis = result
        f.status = "analyzed"
        db.commit()
        return {"id": f.id, "analysis": result}
    except Exception as e:
        f.status = "failed"
        db.commit()
        raise HTTPException(500, f"Analysis failed: {e}")


class AskIn(BaseModel):
    question: str
    section: str | None = None  # which reader section the user is viewing


@router.post("/filings/{filing_id}/ask")
def ask_filing(filing_id: int, payload: AskIn, db: Session = Depends(get_db)):
    f = db.query(Filing).filter_by(id=filing_id).first()
    if not f:
        raise HTTPException(404)
    text = pdf.extract_text(f.storage_path)
    answer = ai.ask_about_filing(text=text, question=payload.question,
                                 ticker=f.ticker, section=payload.section)
    return {"answer": answer}


class TrackerIn(BaseModel):
    tracker: dict


@router.get("/filings/{filing_id}/tracker")
def get_tracker(filing_id: int, db: Session = Depends(get_db)):
    f = db.query(Filing).filter_by(id=filing_id).first()
    if not f:
        raise HTTPException(404)
    return {"filing_id": f.id, "tracker": f.tracker or {}}


@router.put("/filings/{filing_id}/tracker")
def save_tracker(filing_id: int, payload: TrackerIn, db: Session = Depends(get_db)):
    f = db.query(Filing).filter_by(id=filing_id).first()
    if not f:
        raise HTTPException(404)
    f.tracker = payload.tracker
    db.commit()
    return {"ok": True}


@router.get("/filings/{filing_id}/file")
def download_filing(filing_id: int, db: Session = Depends(get_db)):
    f = db.query(Filing).filter_by(id=filing_id).first()
    if not f:
        raise HTTPException(404)
    return FileResponse(f.storage_path, media_type="application/pdf", filename=f.filename)


@router.delete("/filings/{filing_id}")
def delete_filing(filing_id: int, db: Session = Depends(get_db)):
    f = db.query(Filing).filter_by(id=filing_id).first()
    if not f:
        raise HTTPException(404)
    try:
        os.remove(f.storage_path)
    except OSError:
        pass
    db.delete(f); db.commit()
    return {"ok": True}

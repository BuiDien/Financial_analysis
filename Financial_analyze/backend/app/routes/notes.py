"""Dated notes log per ticker."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models.screener import TickerNote
from .screener import _iso as iso

router = APIRouter(prefix="/notes")


class NoteBody(BaseModel):
    body: str = ""


def norm_symbol(s: str) -> str:
    s = s.strip().upper()
    s = s[3:] if s.startswith("VN:") else s
    if not s:
        raise HTTPException(422, "symbol is empty")
    return s


def _out(n: TickerNote) -> dict:
    return {"id": n.id, "symbol": n.symbol, "body": n.body,
            "created_at": iso(n.created_at), "updated_at": iso(n.updated_at)}


def _clean(body: NoteBody) -> str:
    text = body.body.strip()
    if not text:
        raise HTTPException(422, "note body is empty")
    return text


@router.get("/{symbol}")
def list_notes(symbol: str, db: Session = Depends(get_db)):
    rows = (db.query(TickerNote).filter(TickerNote.symbol == norm_symbol(symbol))
            .order_by(TickerNote.created_at.desc(), TickerNote.id.desc()).all())
    return [_out(n) for n in rows]


@router.post("/{symbol}", status_code=201)
def add_note(symbol: str, body: NoteBody, db: Session = Depends(get_db)):
    sym = norm_symbol(symbol)
    text = _clean(body)
    n = TickerNote(symbol=sym, body=text, created_at=datetime.now(timezone.utc))
    db.add(n)
    db.commit()
    db.refresh(n)
    return _out(n)


@router.put("/item/{note_id}")
def edit_note(note_id: int, body: NoteBody, db: Session = Depends(get_db)):
    text = _clean(body)
    n = db.get(TickerNote, note_id)
    if n is None:
        raise HTTPException(404, "note not found")
    n.body = text
    n.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(n)
    return _out(n)


@router.delete("/item/{note_id}", status_code=204)
def delete_note(note_id: int, db: Session = Depends(get_db)):
    n = db.get(TickerNote, note_id)
    if n is None:
        raise HTTPException(404, "note not found")
    db.delete(n)
    db.commit()
    return Response(status_code=204)

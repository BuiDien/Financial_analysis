"""Portfolio CRUD. Uses a single dev portfolio; add auth for multi-user."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

from ..db import get_db
from ..models.portfolio import Portfolio, Holding
from ..services import market

router = APIRouter()


class HoldingIn(BaseModel):
    ticker: str
    shares: float
    cost_basis: float


def _get_or_create(db: Session) -> Portfolio:
    p = db.query(Portfolio).first()
    if not p:
        p = Portfolio(name="Main")
        db.add(p); db.commit(); db.refresh(p)
    return p


@router.get("/portfolio")
def get_portfolio(db: Session = Depends(get_db)):
    p = _get_or_create(db)
    rows, total_value, total_cost = [], 0.0, 0.0
    for h in p.holdings:
        try:
            price = market.get_quote(h.ticker).get("price") or 0
        except Exception:
            price = 0
        value = price * h.shares
        rows.append({
            "id": h.id, "ticker": h.ticker, "shares": h.shares,
            "cost_basis": h.cost_basis, "price": price, "value": value,
            "gain": value - h.cost_basis,
            "gain_pct": ((value - h.cost_basis) / h.cost_basis * 100) if h.cost_basis else 0,
        })
        total_value += value
        total_cost += h.cost_basis
    return {
        "name": p.name,
        "total_value": total_value,
        "total_cost": total_cost,
        "total_gain": total_value - total_cost,
        "total_gain_pct": ((total_value - total_cost) / total_cost * 100) if total_cost else 0,
        "holdings": rows,
    }


@router.post("/portfolio/holdings")
def add_holding(payload: HoldingIn, db: Session = Depends(get_db)):
    p = _get_or_create(db)
    h = Holding(portfolio_id=p.id, ticker=payload.ticker.upper(),
                shares=payload.shares, cost_basis=payload.cost_basis)
    db.add(h); db.commit(); db.refresh(h)
    return {"id": h.id, "ticker": h.ticker, "shares": h.shares, "cost_basis": h.cost_basis}


@router.delete("/portfolio/holdings/{holding_id}")
def remove_holding(holding_id: int, db: Session = Depends(get_db)):
    h = db.query(Holding).filter_by(id=holding_id).first()
    if not h:
        raise HTTPException(404, "Holding not found")
    db.delete(h); db.commit()
    return {"ok": True}

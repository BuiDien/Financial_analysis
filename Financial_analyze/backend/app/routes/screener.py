"""Rule-based screener: rules catalog, strategies, evaluation, refresh control."""
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db import get_db
from ..models.screener import TickerNote
from ..screener import refresh, store, strategies
from ..screener.evaluate import evaluate_universe
from ..screener.rules import CATALOG, RuleConfigError
from ..screener.strategies import StrategyError

router = APIRouter(prefix="/screener")


class StrategyCreate(BaseModel):
    name: str
    rules: list


class StrategyPatch(BaseModel):
    name: str | None = None
    rules: list | None = None


class EvaluateBody(BaseModel):
    strategy_id: int | None = None
    rules: list


class RefreshBody(BaseModel):
    kind: Literal["prices", "financials"]


def _iso(v):
    """Freshness stamps: SQLite hands back naive datetimes — emit them as UTC ISO."""
    if isinstance(v, datetime):
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.isoformat()
    return v


def _call(fn, *args):
    try:
        return fn(*args)
    except StrategyError as e:
        raise HTTPException(e.status, str(e))
    except RuleConfigError as e:
        raise HTTPException(422, str(e))


@router.get("/rules")
def get_rules():
    return {"catalog": CATALOG}


@router.get("/strategies")
def list_strategies(db: Session = Depends(get_db)):
    strategies.seed_starters(db)
    return strategies.list_strategies(db)


@router.post("/strategies")
def create_strategy(body: StrategyCreate, db: Session = Depends(get_db)):
    return _call(strategies.create_strategy, db, body.name, body.rules)


@router.put("/strategies/{sid}")
def update_strategy(sid: int, body: StrategyPatch, db: Session = Depends(get_db)):
    return _call(strategies.update_strategy, db, sid, body.name, body.rules)


@router.delete("/strategies/{sid}", status_code=204)
def delete_strategy(sid: int, db: Session = Depends(get_db)):
    _call(strategies.delete_strategy, db, sid)
    return Response(status_code=204)


@router.post("/strategies/{sid}/reset")
def reset_strategy(sid: int, db: Session = Depends(get_db)):
    return _call(strategies.reset_strategy, db, sid)


@router.post("/evaluate")
def evaluate(body: EvaluateBody, db: Session = Depends(get_db)):
    if body.strategy_id is not None:
        _call(strategies._get, db, body.strategy_id)  # 404 before anything is stored
    now = datetime.now(timezone.utc)
    result = _call(evaluate_universe, store.load_views(db, now), body.rules)
    latest = {sym: _iso(max(c for c in (ca, ua) if c is not None))
              for sym, ca, ua in db.query(TickerNote.symbol, func.max(TickerNote.created_at),
                                          func.max(TickerNote.updated_at))
                                   .group_by(TickerNote.symbol).all()
              if ca is not None or ua is not None}
    for r in result["rows"]:
        r["note_latest_at"] = latest.get(r["symbol"])
    result["freshness"] = {"prices_as_of": _iso(store.get_state(db, "prices_as_of")),
                           "financials_as_of": _iso(store.get_state(db, "financials_as_of"))}
    if body.strategy_id is not None:
        store.set_state(db, "last_strategy_id", body.strategy_id)
        store.set_state(db, "last_pass_symbols", [r["symbol"] for r in result["rows"]])
    return result


@router.get("/state")
def get_state(db: Session = Depends(get_db)):
    return {"last_strategy_id": store.get_state(db, "last_strategy_id")}


@router.get("/refresh")
def refresh_status():
    return refresh.manager.status()


@router.post("/refresh", status_code=202)
def refresh_request(body: RefreshBody):
    if not refresh.manager.is_booted():
        raise HTTPException(503, "screener refresh worker is not running "
                                 "(ENABLE_SCREENER_REFRESH off or screener_provider is 'fixture')")
    if not refresh.manager.request(body.kind):
        raise HTTPException(409, f"{body.kind} refresh already running or queued")
    return refresh.manager.status()

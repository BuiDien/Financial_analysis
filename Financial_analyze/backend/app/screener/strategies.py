"""Named screener strategies: shipped starters plus user strategies."""
from __future__ import annotations

import copy
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..models.screener import Strategy
from .rules import RuleConfigError, validate_rules
from .store import get_state, set_state


class StrategyError(ValueError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


# Thresholds calibrated on the Vietnam market (2026-11-11, ~200 stocks trading
# >= 3 bn VND/day): median worst-of-3-years ROE ~8%, P/B ~1.2, borrowings/equity
# ~0.6, bank NIM ~2.8% and NPL ~2.2%. "All 3 oversold signals" fires on ~1-2 of
# those stocks a day at these levels.
_OVERSOLD = [
    {"id": "rsi", "on": True, "x": 35},
    {"id": "price_drop", "on": True, "x": 7, "d": 5},
    {"id": "volume_spike", "on": True, "x": 1.3},
]


def _r(rid, **kw):
    return {"id": rid, "on": True, **kw}


STARTERS: dict[str, dict] = {
    "quality": {"name": "Quality", "rules": [
        {"id": "scope", "on": True, "banks": "no_financials", "flagged": "exclude"},
        _r("roe_years", x=12, n=3), _r("profit_growth", x=5, n=3),
        _r("debt_to_equity", x=1.0), _r("ocf_to_profit", x=70, n=3),
        _r("pe_vs_industry", x=120), _r("traded_value", x=3),
        # quality of earnings (2026-11-11, liquid stocks: median worst-year profit
        # growth -13%, receivable/inventory days ~flat, gross margin p10 -12.6 pts)
        _r("profit_growth_min", x=-10, n=3), _r("receivable_days_change", x=15, n=3),
        _r("inventory_days_change", x=30, n=3), _r("gross_margin_change", x=-5, n=3),
        *_OVERSOLD]},
    "deep_value": {"name": "Deep value", "rules": [
        {"id": "scope", "on": True, "banks": "no_financials", "flagged": "exclude"},
        _r("roe_years", x=8, n=3), _r("debt_to_equity", x=1.0),
        _r("pe_vs_industry", x=80), _r("pb", x=1.5), _r("traded_value", x=3),
        _r("receivable_days_change", x=15, n=3), *_OVERSOLD]},
    "dividend": {"name": "Dividend", "rules": [
        {"id": "scope", "on": True, "banks": "no_financials", "flagged": "exclude"},
        _r("dividend_yield", x=3), _r("roe_years", x=10, n=3),
        _r("debt_to_equity", x=1.0), _r("ocf_to_profit", x=70, n=3),
        _r("traded_value", x=3), *_OVERSOLD]},
    "banks": {"name": "Banks", "rules": [
        {"id": "scope", "on": True, "banks": "only", "flagged": "exclude"},
        _r("roe_years", x=12, n=3), _r("bank_npl", x=3), _r("bank_nim", x=2.5),
        _r("bank_cir", x=40), _r("pb", x=2.0), _r("traded_value", x=3), *_OVERSOLD]},
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _dump(s: Strategy) -> dict:
    ts = s.updated_at
    if ts is not None and ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return {"id": s.id, "name": s.name, "starter_key": s.starter_key,
            "rules": s.rules, "updated_at": ts.isoformat() if ts else None}


def _validated(rules) -> list:
    try:
        return validate_rules(rules)
    except RuleConfigError as e:
        raise StrategyError(422, str(e)) from e


def _get(db: Session, sid: int) -> Strategy:
    s = db.get(Strategy, sid)
    if s is None:
        raise StrategyError(404, f"strategy {sid} not found")
    return s


def _name_taken(db: Session, name: str, exclude_id: int | None = None) -> bool:
    q = db.query(Strategy).filter(Strategy.name == name)
    if exclude_id is not None:
        q = q.filter(Strategy.id != exclude_id)
    return db.query(q.exists()).scalar()


def _clean_name(name) -> str:
    if not isinstance(name, str) or not name.strip():
        raise StrategyError(422, "name must be a non-empty string")
    return name.strip()


def seed_starters(db: Session) -> None:
    have = {k for (k,) in db.query(Strategy.starter_key).filter(Strategy.starter_key.isnot(None))}
    for key, spec in STARTERS.items():
        if key in have:
            continue
        db.add(Strategy(name=spec["name"], starter_key=key,
                        rules=_validated(copy.deepcopy(spec["rules"])), updated_at=_now()))
    db.commit()


def list_strategies(db: Session) -> list[dict]:
    rows = db.query(Strategy).all()
    order = list(STARTERS)
    starters = sorted((r for r in rows if r.starter_key),
                      key=lambda r: order.index(r.starter_key) if r.starter_key in order else len(order))
    users = sorted((r for r in rows if not r.starter_key), key=lambda r: r.name)
    return [_dump(r) for r in starters + users]


def create_strategy(db: Session, name: str, rules: list) -> dict:
    name = _clean_name(name)
    rules = _validated(rules)
    if _name_taken(db, name):
        raise StrategyError(409, f"a strategy named '{name}' already exists")
    s = Strategy(name=name, starter_key=None, rules=rules, updated_at=_now())
    db.add(s)
    db.commit()
    return _dump(s)


def update_strategy(db: Session, id: int, name: str | None, rules: list | None) -> dict:
    s = _get(db, id)
    if name is not None:
        name = _clean_name(name)
        if _name_taken(db, name, exclude_id=id):
            raise StrategyError(409, f"a strategy named '{name}' already exists")
    if rules is not None:
        rules = _validated(rules)
    if name is not None:
        s.name = name
    if rules is not None:
        s.rules = rules
    s.updated_at = _now()
    db.commit()
    return _dump(s)


def delete_strategy(db: Session, id: int) -> None:
    s = _get(db, id)
    if s.starter_key:
        raise StrategyError(409, "starter strategies cannot be deleted, only reset")
    db.delete(s)
    db.commit()
    if get_state(db, "last_strategy_id") == id:
        set_state(db, "last_strategy_id", None)


def reset_strategy(db: Session, id: int) -> dict:
    s = _get(db, id)
    spec = STARTERS.get(s.starter_key or "")
    if spec is None:
        raise StrategyError(409, "only starter strategies can be reset")
    s.rules = _validated(copy.deepcopy(spec["rules"]))
    s.updated_at = _now()
    db.commit()
    return _dump(s)

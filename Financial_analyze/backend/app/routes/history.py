"""Company history: facts stored from verified OCR statements."""

from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..models.ocr import FactResolution, OCRInboxItem, StatementFact
from ..services import history_store
from ..services.history_facts import point_states
from ..services.history_lines import line_code, line_name

router = APIRouter(prefix="/history")


class ResolutionIn(BaseModel):
    statement_kind: Literal["balance", "income", "cashflow"]
    fact_key: str = Field(min_length=1, max_length=255)
    chosen_fact_id: int = Field(ge=1)


@router.post("/{ticker}/{scope}/resolutions")
def resolve_conflict(
    ticker: str, scope: str, payload: ResolutionIn, db: Session = Depends(get_db),
):
    try:
        return history_store.resolve_fact(
            db, ticker.strip().upper(), scope.strip().lower(),
            payload.statement_kind, payload.fact_key, payload.chosen_fact_id,
        )
    except history_store.HistoryError as exc:
        raise HTTPException(422, str(exc)) from exc


# --- read API for charts -------------------------------------------------------


def _active_facts(db: Session, ticker: str, scope: str) -> list[StatementFact]:
    return (
        db.query(StatementFact)
        .filter(
            StatementFact.ticker == ticker, StatementFact.scope == scope,
            StatementFact.status == "active",
        )
        .order_by(StatementFact.id)
        .all()
    )


@router.get("/companies")
def list_companies(db: Session = Depends(get_db)):
    groups: dict[tuple[str, str], dict] = {}
    rows = db.query(
        StatementFact.ticker, StatementFact.scope, StatementFact.statement_kind,
        StatementFact.inbox_item_id, StatementFact.period_end,
    ).filter(StatementFact.status == "active")
    for ticker, scope, kind, item_id, period_end in rows:
        group = groups.setdefault(
            (ticker, scope), {"kinds": set(), "items": set(), "last": period_end},
        )
        group["kinds"].add(kind)
        group["items"].add(item_id)
        group["last"] = max(group["last"], period_end)
    return [
        {
            "ticker": ticker, "scope": scope, "kinds": sorted(group["kinds"]),
            "documents": len(group["items"]), "last_period_end": group["last"].isoformat(),
        }
        for (ticker, scope), group in sorted(groups.items())
    ]


def _line_groups(facts: list[StatementFact]) -> dict[tuple[str, str], list[StatementFact]]:
    groups: dict[tuple[str, str], list[StatementFact]] = {}
    for fact in facts:
        groups.setdefault((fact.statement_kind, fact.line_key), []).append(fact)
    return groups


def _catalog_or_none():
    try:
        return history_store.default_catalog()
    except Exception:  # catalogue unavailable: names fall back to row labels
        return None


class _NoCatalog:
    def get(self, *_args):
        return None


@router.get("/{ticker}/{scope}/lines")
def list_lines(ticker: str, scope: str, db: Session = Depends(get_db)):
    ticker, scope = ticker.strip().upper(), scope.strip().lower()
    catalog = _catalog_or_none() or _NoCatalog()
    result = []
    for (kind, key), facts in sorted(_line_groups(_active_facts(db, ticker, scope)).items()):
        line = catalog.get(ticker, scope, kind, key)
        result.append({
            "key": key, "kind": kind,
            "name": line_name(catalog, ticker, scope, kind, key, facts),
            "parent_key": line.parent_key if line else None,
            "code": line_code(line),
        })
    return result


def _in_grain(fact: StatementFact, grain: str) -> bool:
    if grain == "quarter":
        return fact.period_type in ("quarter", "instant")
    if fact.period_type == "year":
        return True
    return (
        fact.period_type == "instant"
        and fact.period_end.month == 12 and fact.period_end.day == 31
    )


def _source(fact: StatementFact, filenames: dict[int, str]) -> dict:
    printed = fact.origin == "printed"
    return {
        "fact_id": fact.id, "inbox_item_id": fact.inbox_item_id,
        "filename": filenames.get(fact.inbox_item_id) if printed else None,
        "page": fact.page_number if printed else None,
        "row": fact.row_number if printed else None,
        "row_label": fact.row_label if printed else None,
        "value": fact.value, "origin": fact.origin,
        "inputs": fact.inputs if not printed else None,
        "reviewed": printed,
    }


@router.get("/{ticker}/{scope}/series")
def line_series(
    ticker: str,
    scope: str,
    lines: str = "",
    grain: Literal["quarter", "year"] = "quarter",
    from_: date | None = Query(None, alias="from"),
    to: date | None = None,
    db: Session = Depends(get_db),
):
    ticker, scope = ticker.strip().upper(), scope.strip().lower()
    wanted = {k.strip() for k in lines.split(",") if k.strip()}
    catalog = _catalog_or_none() or _NoCatalog()
    groups = {
        group_key: facts
        for group_key, facts in _line_groups(_active_facts(db, ticker, scope)).items()
        if group_key[1] in wanted
    }
    item_ids = {f.inbox_item_id for facts in groups.values() for f in facts}
    filenames = dict(
        db.query(OCRInboxItem.id, OCRInboxItem.filename).filter(OCRInboxItem.id.in_(item_ids))
    ) if item_ids else {}

    out = []
    for (kind, key), facts in sorted(groups.items()):
        resolutions = {
            r.fact_key: {"chosen_fact_id": r.chosen_fact_id, "chosen_value": r.chosen_value}
            for r in db.query(FactResolution).filter(
                FactResolution.ticker == ticker, FactResolution.scope == scope,
                FactResolution.statement_kind == kind,
            )
        }
        states = point_states(history_store._fact_dict_list(facts), resolutions)
        by_id = {f.id: f for f in facts}
        points = []
        for state in states.values():
            sources = [by_id[i] for i in state.source_ids if i in by_id]
            if not sources:
                continue
            head = sources[0]
            if not _in_grain(head, grain):
                continue
            if (from_ and head.period_end < from_) or (to and head.period_end > to):
                continue
            inputs = next((f.inputs for f in sources if f.origin == "calculated" and f.inputs), None)
            points.append({
                "fact_key": state.fact_key, "period_type": head.period_type,
                "period_start": head.period_start.isoformat() if head.period_start else None,
                "period_end": head.period_end.isoformat(),
                "value": state.value, "status": state.status, "origin": state.origin,
                "inputs": inputs,
                "sources": [_source(f, filenames) for f in sources],
            })
        points.sort(key=lambda p: (p["period_end"], p["fact_key"]))
        out.append({
            "key": key, "kind": kind,
            "name": line_name(catalog, ticker, scope, kind, key, facts),
            "points": points,
        })
    return {"lines": out}

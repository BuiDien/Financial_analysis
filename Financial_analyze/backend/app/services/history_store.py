"""'Add to history': the bridge from verified OCR pages to statement facts.

Preview proposes kinds, periods, units and line matches for every table of a
verified review and lists what still needs the owner's answer (``blocking``).
Write stores the facts in one transaction: one PDF owns one active set of
facts, derived quarters are recalculated for every touched line, and the code
never picks between disagreeing values (conflicts stay open until resolved).
"""

from __future__ import annotations

from dataclasses import asdict
from datetime import date, datetime, timezone

from sqlalchemy.orm import Session

from ..config import get_settings
from ..models.ocr import (
    FactResolution, OCRAuditEvent, OCRInboxItem, OCRReviewJob, StatementFact,
)
from ..ocr_page_contract import OCR_PAGE_RESULT_FORMAT
from .history_extract import ExtractedTable, cell_value, extract_tables, is_unreadable_cell
from .history_facts import derive_missing_quarters, fact_key, point_states
from .history_lines import LineCatalog, code_alias, get_line_catalog, label_alias
from .history_periods import Period, columns_cover_label, label_period, parse_unit_multiplier
from .ocr_label_review import content_sha256, page_markdown
from .ocr_total_checks import page_total_check

REQUIRED_LABELS = ("ticker", "scope", "fiscal_year", "period_code")
UNIT_NAMES = {1: "đồng", 1_000: "nghìn đồng", 1_000_000: "triệu đồng", 1_000_000_000: "tỷ đồng"}
# Period types a statement kind can hold: a balance sheet is a position at a
# date; income and cash flow are flows over a period.
KIND_PERIOD_TYPES = {
    "balance": {"instant"},
    "income": {"quarter", "ytd", "year"},
    "cashflow": {"quarter", "ytd", "year"},
}
TRUSTED_PERIOD_SOURCES = {"header", "answer"}  # dated in the PDF, or set by the owner


class HistoryError(Exception):
    """An answer that cannot be applied (unknown fact id, foreign key, ...)."""


class HistoryBlocked(Exception):
    def __init__(self, blocking: list[dict]):
        super().__init__("Add to history is blocked")
        self.blocking = blocking


def default_catalog() -> LineCatalog:
    settings = get_settings()
    return get_line_catalog(settings.obsidian_vault_path, settings.obsidian_line_catalog_path)


# --- answers -----------------------------------------------------------------


def _as_date(value) -> date | None:
    if value is None or isinstance(value, date):
        return value
    return date.fromisoformat(str(value))


def _index_answers(answers: dict) -> dict:
    tables = {}
    for table in answers.get("tables") or []:
        columns = {c["column"]: c for c in table.get("columns") or []}
        tables[(table["page"], table["table"])] = table | {"columns": columns}
    lines = {(l["page"], l["table"], l["row"]): l for l in answers.get("lines") or []}
    accepted = {
        (m["page"], m["content_sha256"], m["table"], m["parent_row"], m["column_label"])
        for m in answers.get("accepted_misreads") or []
    }
    return {"tables": tables, "lines": lines, "accepted": accepted}


def _answered_period(answer: dict) -> Period:
    return Period(answer["period_type"], _as_date(answer.get("period_start")), _as_date(answer["period_end"]))


# --- JSON --------------------------------------------------------------------


def _period_json(period: Period | None) -> dict | None:
    if period is None:
        return None
    return {
        "type": period.type,
        "start": period.start.isoformat() if period.start else None,
        "end": period.end.isoformat(),
    }


def _fact_dict(fact: StatementFact) -> dict:
    return {
        "id": fact.id, "line_key": fact.line_key, "period_type": fact.period_type,
        "period_start": fact.period_start, "period_end": fact.period_end,
        "value": fact.value, "origin": fact.origin, "status": fact.status,
        "inbox_item_id": fact.inbox_item_id,
    }


def _fact_dict_list(facts: list[StatementFact]) -> list[dict]:
    return [_fact_dict(f) for f in facts]


def _block(blocking: list[dict], code: str, message: str, **where) -> None:
    blocking.append({"code": code, "message": message} | where)


# --- planning (shared by preview and write) ----------------------------------


def _plan_table(
    table: ExtractedTable, answer: dict, item: OCRInboxItem, catalog: LineCatalog,
    index: dict, blocking: list[dict],
) -> tuple[dict, list[dict]]:
    """Table JSON for the preview and the row plans that will become facts."""
    where = {"page": table.page, "table": table.table}
    kind = answer.get("kind") or table.kind
    data = {
        "page": table.page, "table": table.table, "kind": kind,
        "proposed_kind": table.kind, "unit_multiplier": None,
        "proposed_unit_multiplier": table.unit_multiplier, "columns": [], "rows": [],
    }

    def skipped_rows(reason: str) -> None:
        data["rows"] = [
            asdict(row) | {
                "status": "skipped", "line_key": None, "line_name": None,
                "suggestions": [], "skip_reason": reason, "unreadable_cells": [],
            }
            for row in table.rows
        ]

    if kind == "skip":
        skipped_rows("table skipped")
        return data, []
    if kind is None:
        _block(blocking, "table_kind_unknown", "Choose the statement kind of this table (or skip it)", **where)
        skipped_rows("statement kind unknown")
        return data, []

    # Unit: the owner's answer, else the table/page, else the upload label.
    label_unit = parse_unit_multiplier(item.unit or "")
    if answer.get("unit_multiplier"):
        unit = answer["unit_multiplier"]
    elif table.unit_multiplier and label_unit and table.unit_multiplier != label_unit:
        unit = None
        _block(blocking, "unit_unknown", "The table unit and the upload label unit disagree", **where)
    else:
        unit = table.unit_multiplier or label_unit
        if unit is None:
            _block(blocking, "unit_unknown", "Set the unit of this table", **where)
    data["unit_multiplier"] = unit

    columns: list[tuple[int, int, Period | None]] = []  # (cell index, grid column, period)
    trusted: list[Period] = []
    for position, column in enumerate(table.columns):
        column_answer = answer.get("columns", {}).get(column.column)
        if column_answer and column_answer.get("skip"):
            data["columns"].append({
                "column": column.column, "header": column.header, "period": None,
                "period_source": None, "skipped": True,
            })
            continue
        if column_answer:
            period, source = _answered_period(column_answer), "answer"
        else:
            period, source = column.period, column.period_source
        if period is None:
            _block(
                blocking, "column_period_unknown",
                f"Set the period of column {column.header or column.column!r}",
                column=column.column, **where,
            )
        elif period.type not in KIND_PERIOD_TYPES.get(kind, set()):
            _block(
                blocking, "period_kind_mismatch",
                f"Column {column.header or column.column!r} is a {period.type} period, which a "
                f"{kind} table cannot hold: fix its period, the table kind, or skip the column",
                column=column.column, **where,
            )
        if period is not None and source in TRUSTED_PERIOD_SOURCES:
            trusted.append(period)
        data["columns"].append({
            "column": column.column, "header": column.header, "period": _period_json(period),
            "period_source": source, "skipped": False,
        })
        columns.append((position, column.column, period))

    # The label check uses only dated (header) or owner-answered periods: a
    # relative period is derived from the label itself, so it cannot confirm it.
    periods = [period for _position, _column, period in columns]
    if (
        trusted and all(periods)
        and not columns_cover_label(trusted, item.fiscal_year, item.period_code)
    ):
        _block(
            blocking, "period_mismatch",
            f"No column ends at the labelled period {item.period_code} {item.fiscal_year}; "
            "fix the upload label or the column periods",
            **where,
        )

    plans: list[dict] = []
    for row in table.rows:
        row_data = asdict(row) | {
            "status": "skipped", "line_key": None, "line_name": None,
            "suggestions": [], "skip_reason": None, "unreadable_cells": [],
        }
        data["rows"].append(row_data)
        if not row.is_amount:
            row_data["skip_reason"] = "not an amount"
            continue
        # Non-blank cells that cannot be read are not stored; list them (a note).
        row_data["unreadable_cells"] = [
            c for p, c, _period in columns if is_unreadable_cell(row.cells[p], unit or 1)
        ]
        if not any(cell_value(row.cells[p], unit or 1) is not None for p, _c, _period in columns):
            row_data["skip_reason"] = "no values"
            continue
        row_where = where | {"row": row.row}
        line_answer = index["lines"].get((table.page, table.table, row.row)) or {}
        match = catalog.match(item.ticker, item.scope, kind, row.label, row.parent_label, row.code)
        row_data["suggestions"] = [
            {"line_key": key, "line_name": name, "score": score}
            for key, name, score in match.suggestions
        ]
        plan = {
            "kind": kind, "row": row, "page": table.page, "table": table.table,
            "line_key": None, "line_name": None, "new_line_name": None, "answered_key": False,
            "unit": unit, "columns": columns,
        }
        if line_answer.get("line_key"):
            line = catalog.get(item.ticker, item.scope, kind, line_answer["line_key"])
            if line is None:
                row_data["status"] = "unknown"
                _block(blocking, "line_unanswered", f"Unknown line {line_answer['line_key']!r}", **row_where)
                continue
            plan.update(line_key=line.key, line_name=line.name, answered_key=True)
            row_data.update(status="matched", line_key=line.key, line_name=line.name)
        elif match.key:
            line = catalog.get(item.ticker, item.scope, kind, match.key)
            plan.update(line_key=match.key, line_name=line.name if line else None)
            row_data.update(status="matched", line_key=match.key, line_name=line.name if line else None)
        elif (line_answer.get("new_line_name") or "").strip():
            name = line_answer["new_line_name"].strip()
            plan.update(new_line_name=name, line_name=name)
            row_data.update(status="matched", line_name=name, new_line=True)
        else:
            row_data["status"] = "unknown"
            _block(
                blocking, "line_unanswered",
                f"Is {row.label!r} the same as an existing line, or a new line?",
                **row_where,
            )
            continue
        plans.append(plan)
    return data, plans


def _plan(db: Session, review: OCRReviewJob, answers: dict, catalog: LineCatalog) -> dict:
    item = review.inbox_item
    blocking: list[dict] = []
    plan = {"blocking": blocking, "tables": [], "misreads": [], "conflicts": [], "rows": []}
    if review.result_format != OCR_PAGE_RESULT_FORMAT or review.status not in {"verified", "published"}:
        _block(blocking, "review_not_verified", "Verify every page of this review first")
        return plan
    missing = [name for name in REQUIRED_LABELS if not getattr(item, name)]
    if missing:
        _block(blocking, "labels_missing", "Set the upload labels first: " + ", ".join(missing))
        return plan

    index = _index_answers(answers)
    previous_kind = None
    for page in sorted(review.attempt.pages, key=lambda p: p.page_number):
        markdown = page_markdown(page)
        tables = extract_tables(page.page_number, markdown, previous_kind, item.fiscal_year)
        page_rows: list[dict] = []
        for table in tables:
            answer = index["tables"].get((table.page, table.table), {})
            data, rows = _plan_table(table, answer, item, catalog, index, blocking)
            plan["tables"].append(data)
            page_rows.extend(rows)
            previous_kind = data["kind"] if data["kind"] != "skip" else None
        plan["rows"].extend(page_rows)
        if not page_rows:
            continue
        # Subtotal gate: each likely misread must be accepted for this exact page text.
        sha = content_sha256(markdown)
        for misread in page_total_check(markdown)["likely_misreads"]:
            accepted = (
                page.page_number, sha, misread["table"], misread["parent_row"],
                misread["column_label"],
            ) in index["accepted"]
            plan["misreads"].append(
                {"page": page.page_number, "content_sha256": sha, "accepted": accepted} | misread,
            )
            if not accepted:
                _block(
                    blocking, "misread_unaccepted",
                    f"{misread['parent_label']!r} ({misread['column_label']}) does not add up: "
                    "correct the page or mark the value correct as printed",
                    page=page.page_number, table=misread["table"], row=misread["parent_row"],
                )

    _check_fiscal_year(plan["tables"], item, blocking)
    plan["incoming"] = _unique_in_document(_incoming_facts(plan["rows"]), blocking)
    plan["conflicts"] = _conflicts(db, item, plan["incoming"])
    return plan


def _check_fiscal_year(tables: list[dict], item: OCRInboxItem, blocking: list[dict]) -> None:
    """Some dated or answered column of the document must end at the label period."""
    used = [
        column for table in tables if table["kind"] not in (None, "skip")
        for column in table["columns"] if not column["skipped"]
    ]
    if not used or not all(c["period"] for c in used):
        return  # unknown periods are already asked for
    if any(p["code"] == "period_mismatch" for p in blocking):
        return
    _start, end = label_period(item.fiscal_year, item.period_code)
    if not any(
        c["period_source"] in TRUSTED_PERIOD_SOURCES and c["period"]["end"] == end.isoformat()
        for c in used
    ):
        _block(
            blocking, "period_mismatch",
            f"Confirm the fiscal year: no dated column ends at {end.isoformat()}",
        )


def _location(fact: dict) -> str:
    plan = fact["plan"]
    return (
        f"page {plan['page']} table {plan['table']} row {plan['row'].row} "
        f"column {fact['column']} ({fact['raw_text']!r})"
    )


def _unique_in_document(incoming: list[dict], blocking: list[dict]) -> list[dict]:
    """One fact per key per document; two different values for a key block.

    Equal values printed twice in one PDF are one source (the first location is
    kept), so "sources agree" only ever means two documents.
    """
    groups: dict[tuple, list[dict]] = {}
    for fact in incoming:
        plan = fact["plan"]
        line = plan["line_key"] or ("new", id(plan))  # each new line is its own key
        groups.setdefault((plan["kind"], line, fact["period"]), []).append(fact)
    unique = []
    for facts in groups.values():
        first = facts[0]
        if len({f["value"] for f in facts}) > 1:
            period = first["period"]
            span = f"{period.start.isoformat()}–" if period.start else ""
            _block(
                blocking, "duplicate_in_document",
                f"{first['plan']['line_name'] or first['plan']['row'].label!r} "
                f"({period.type} {span}{period.end.isoformat()}) has different values in this "
                "document: " + "; ".join(_location(f) for f in facts)
                + ". Skip a table or column, or map a row to another line",
                page=first["plan"]["page"], table=first["plan"]["table"], row=first["plan"]["row"].row,
            )
        unique.append(first)
    return unique


def _incoming_facts(rows: list[dict]) -> list[dict]:
    """Printed facts a write would store (line_key None for lines not yet created)."""
    facts = []
    for plan in rows:
        if plan["unit"] is None:
            continue
        for position, column, period in plan["columns"]:
            if period is None:
                continue
            text = plan["row"].cells[position]
            value = cell_value(text, plan["unit"])
            if value is None:
                continue  # blank or unreadable cell: nothing is stored
            facts.append({"plan": plan, "column": column, "period": period, "value": value, "raw_text": text})
    return facts


def _conflicts(db: Session, item: OCRInboxItem, incoming: list[dict]) -> list[dict]:
    keyed: dict[tuple[str, str], list[dict]] = {}
    for fact in incoming:
        line_key = fact["plan"]["line_key"]
        if line_key:
            keyed.setdefault((fact["plan"]["kind"], fact_key(line_key, fact["period"])), []).append(fact)
    if not keyed:
        return []
    existing_rows = (
        db.query(StatementFact)
        .filter(
            StatementFact.ticker == item.ticker,
            StatementFact.scope == item.scope,
            StatementFact.status == "active",
            StatementFact.inbox_item_id != item.id,
            StatementFact.fact_key.in_({key for _kind, key in keyed}),
        )
        .order_by(StatementFact.id)
        .all()
    )
    existing: dict[tuple[str, str], list[StatementFact]] = {}
    for fact in existing_rows:
        existing.setdefault((fact.statement_kind, fact.fact_key), []).append(fact)
    conflicts = []
    for (kind, key), facts in keyed.items():
        others = existing.get((kind, key), [])
        if len({f["value"] for f in facts} | {f.value for f in others}) <= 1:
            continue
        first = facts[0]
        conflicts.append({
            "fact_key": key,
            "statement_kind": kind,
            "line_name": first["plan"]["line_name"],
            "period": _period_json(first["period"]),
            "existing": [
                {
                    "fact_id": f.id, "value": f.value, "origin": f.origin,
                    "filename": f"inbox item {f.inbox_item_id}", "page": f.page_number,
                    "inbox_item_id": f.inbox_item_id,
                }
                for f in others
            ],
            "incoming": {"value": first["value"], "page": first["plan"]["page"], "row": first["plan"]["row"].row},
        })
    if conflicts:
        names = {
            i.id: i.filename
            for i in db.query(OCRInboxItem).filter(
                OCRInboxItem.id.in_({e["inbox_item_id"] for c in conflicts for e in c["existing"]}),
            )
        }
        for conflict in conflicts:
            for entry in conflict["existing"]:
                entry["filename"] = names.get(entry["inbox_item_id"], entry["filename"])
    return conflicts


# --- public API --------------------------------------------------------------


def history_preview(
    db: Session, review: OCRReviewJob, answers: dict, *, catalog: LineCatalog | None = None,
) -> dict:
    plan = _plan(db, review, answers or {}, catalog or default_catalog())
    return {key: plan[key] for key in ("blocking", "tables", "misreads", "conflicts")}


def _recompute_derived(db: Session, ticker: str, scope: str, kind: str, line_key: str) -> None:
    """Replace the line's calculated quarters; unchanged ones keep their id."""
    facts = (
        db.query(StatementFact)
        .filter_by(ticker=ticker, scope=scope, statement_kind=kind, line_key=line_key, status="active")
        .order_by(StatementFact.id)
        .all()
    )
    printed = [f for f in facts if f.origin == "printed"]
    calculated = [f for f in facts if f.origin == "calculated"]
    derived: list[dict] = []
    if kind != "balance" and printed:
        resolutions = _resolution_dicts(db, ticker, scope, kind, {f.fact_key for f in printed})
        states = point_states([_fact_dict(f) for f in printed], resolutions)
        inputs = []
        for fact in printed:
            state = states.get(fact.fact_key)
            if state and state.status == "resolved":
                # A resolved disagreement feeds only the chosen value into the maths.
                if fact.id != resolutions[fact.fact_key]["chosen_fact_id"]:
                    continue
            inputs.append(_fact_dict(fact))
        derived = derive_missing_quarters(inputs)
    by_id = {f.id: f for f in printed}
    unused = list(calculated)
    for calc in derived:
        period = Period(calc["period_type"], calc["period_start"], calc["period_end"])
        key = fact_key(line_key, period)
        # A calculated fact belongs to the document of its main input.
        owner = by_id[calc["inputs"][0]].inbox_item_id
        kept = next((f for f in unused if f.fact_key == key and f.value == calc["value"]), None)
        if kept is not None:
            unused.remove(kept)
            kept.inputs = calc["inputs"]
            kept.inbox_item_id = owner
            continue
        db.add(StatementFact(
            inbox_item_id=owner, ticker=ticker, scope=scope, statement_kind=kind,
            line_key=line_key, fact_key=key, period_type=period.type,
            period_start=period.start, period_end=period.end, value=calc["value"],
            origin="calculated", inputs=calc["inputs"], status="active",
        ))
    for fact in unused:
        db.delete(fact)
    db.flush()


def _resolution_dicts(db: Session, ticker: str, scope: str, kind: str, keys: set[str]) -> dict[str, dict]:
    if not keys:
        return {}
    rows = db.query(FactResolution).filter(
        FactResolution.ticker == ticker, FactResolution.scope == scope,
        FactResolution.statement_kind == kind, FactResolution.fact_key.in_(keys),
    )
    return {r.fact_key: {"chosen_fact_id": r.chosen_fact_id, "chosen_value": r.chosen_value} for r in rows}


def _open_conflicts(db: Session, ticker: str, scope: str, lines: set[tuple[str, str]]) -> int:
    count = 0
    for kind, line_key in lines:
        facts = (
            db.query(StatementFact)
            .filter_by(ticker=ticker, scope=scope, statement_kind=kind, line_key=line_key, status="active")
            .all()
        )
        resolutions = _resolution_dicts(db, ticker, scope, kind, {f.fact_key for f in facts})
        states = point_states([_fact_dict(f) for f in facts], resolutions)
        count += sum(1 for state in states.values() if state.status == "conflict")
    return count


def _upsert_resolution(db: Session, ticker: str, scope: str, fact: StatementFact) -> FactResolution:
    resolution = db.query(FactResolution).filter_by(
        ticker=ticker, scope=scope, statement_kind=fact.statement_kind, fact_key=fact.fact_key,
    ).first()
    if resolution is None:
        resolution = FactResolution(
            ticker=ticker, scope=scope, statement_kind=fact.statement_kind, fact_key=fact.fact_key,
            chosen_fact_id=fact.id, chosen_value=fact.value,
        )
        db.add(resolution)
    else:
        resolution.chosen_fact_id = fact.id
        resolution.chosen_value = fact.value
        resolution.resolved_at = datetime.now(timezone.utc)
    db.flush()
    return resolution


def _create_lines(item: OCRInboxItem, rows: list[dict], catalog: LineCatalog) -> None:
    """Create answered new lines and record answered aliases (only in a write)."""
    known: dict[tuple[str, int, int, str], str] = {}  # (kind, page, table, label) -> key
    for plan in rows:
        if plan["line_key"]:
            known[(plan["kind"], plan["page"], plan["table"], plan["row"].label)] = plan["line_key"]
    for plan in rows:
        row = plan["row"]
        aliases = ([code_alias(row.code.strip())] if row.code and row.code.strip() else [])
        aliases.append(label_alias(row.label, row.parent_label))
        if plan["new_line_name"]:
            parent_key = known.get((plan["kind"], plan["page"], plan["table"], row.parent_label))
            plan["line_key"] = catalog.add_line(
                item.ticker, item.scope, plan["kind"], plan["new_line_name"], parent_key, aliases,
            )
            known[(plan["kind"], plan["page"], plan["table"], row.label)] = plan["line_key"]
        elif plan["answered_key"]:
            for alias in aliases:
                catalog.add_alias(item.ticker, item.scope, plan["kind"], plan["line_key"], alias)


def history_write(
    db: Session, review: OCRReviewJob, answers: dict, *, catalog: LineCatalog | None = None,
) -> dict:
    answers = answers or {}
    catalog = catalog or default_catalog()
    plan = _plan(db, review, answers, catalog)
    if plan["blocking"]:
        raise HistoryBlocked(plan["blocking"])
    item = review.inbox_item
    ticker, scope = item.ticker, item.scope

    resolutions = answers.get("resolutions") or []
    incoming_keys = {
        fact_key(f["plan"]["line_key"], f["period"])
        for f in plan["incoming"] if f["plan"]["line_key"]
    }
    for resolution in resolutions:
        chosen = resolution["chosen"]
        if chosen == "incoming":
            if resolution["fact_key"] not in incoming_keys:
                raise HistoryError(f"This document has no value for {resolution['fact_key']}")
            continue
        fact = db.get(StatementFact, chosen)
        if (
            fact is None or fact.status != "active" or fact.ticker != ticker
            or fact.scope != scope or fact.fact_key != resolution["fact_key"]
            or fact.inbox_item_id == item.id
        ):
            raise HistoryError(f"Fact {chosen} is not an active source of {resolution['fact_key']}")

    _create_lines(item, plan["rows"], catalog)

    touched: set[tuple[str, str]] = set()
    own = db.query(StatementFact).filter_by(inbox_item_id=item.id, status="active").all()
    for fact in own:
        fact.status = "superseded"
        touched.add((fact.statement_kind, fact.line_key))

    written: list[StatementFact] = []
    for incoming in plan["incoming"]:  # new lines got their keys in _create_lines
        row_plan, period = incoming["plan"], incoming["period"]
        fact = StatementFact(
            inbox_item_id=item.id, review_id=review.id, review_revision=review.revision,
            ticker=ticker, scope=scope, statement_kind=row_plan["kind"],
            line_key=row_plan["line_key"], fact_key=fact_key(row_plan["line_key"], period),
            period_type=period.type, period_start=period.start, period_end=period.end,
            value=incoming["value"], origin="printed", page_number=row_plan["page"],
            table_number=row_plan["table"], row_number=row_plan["row"].row,
            column_number=incoming["column"],
            row_label=row_plan["row"].label, raw_text=incoming["raw_text"],
            raw_unit=UNIT_NAMES.get(row_plan["unit"], str(row_plan["unit"])), status="active",
        )
        db.add(fact)
        written.append(fact)
        touched.add((row_plan["kind"], row_plan["line_key"]))
    db.flush()

    for resolution in resolutions:
        if resolution["chosen"] == "incoming":
            fact = next(f for f in written if f.fact_key == resolution["fact_key"])
        else:
            fact = db.get(StatementFact, resolution["chosen"])
        _upsert_resolution(db, ticker, scope, fact)

    for kind, line_key in sorted(touched):
        _recompute_derived(db, ticker, scope, kind, line_key)

    result = {
        "written": len(written),
        "superseded": len(own),
        "conflicts_open": _open_conflicts(db, ticker, scope, touched),
    }
    review.events.append(OCRAuditEvent(
        action="history_written", revision=review.revision,
        after_data=result | {"answers": answers},
    ))
    db.commit()
    return result


def history_remove(db: Session, item: OCRInboxItem) -> int:
    """Supersede the document's facts (it leaves the history) and recalculate."""
    facts = db.query(StatementFact).filter_by(inbox_item_id=item.id, status="active").all()
    touched = set()
    for fact in facts:
        fact.status = "superseded"
        touched.add((fact.statement_kind, fact.line_key))
    db.flush()
    for kind, line_key in sorted(touched):
        _recompute_derived(db, item.ticker or "", item.scope or "", kind, line_key)
    review = _review_of(item, facts)
    if review is not None:
        review.events.append(OCRAuditEvent(
            action="history_removed", revision=review.revision,
            after_data={"superseded": len(facts)},
        ))
    db.commit()
    return len(facts)


def _review_of(item: OCRInboxItem, facts: list[StatementFact]) -> OCRReviewJob | None:
    """The review the removed facts were written from, else the latest review."""
    ids = {f.review_id for f in facts if f.review_id is not None}
    for review in reversed(item.reviews):
        if review.id in ids:
            return review
    return item.reviews[-1] if item.reviews else None


def delete_item_facts(db: Session, item: OCRInboxItem) -> None:
    """Hard-delete a document's facts and resolutions choosing them (no commit).

    SQLite does not enforce ON DELETE CASCADE here, so the inbox delete calls this.
    """
    facts = db.query(StatementFact).filter_by(inbox_item_id=item.id).all()
    if not facts:
        return
    ids = [f.id for f in facts]
    touched = {(f.ticker, f.scope, f.statement_kind, f.line_key) for f in facts if f.status == "active"}
    db.query(FactResolution).filter(FactResolution.chosen_fact_id.in_(ids)).delete(synchronize_session=False)
    for fact in facts:
        db.delete(fact)
    db.flush()
    for ticker, scope, kind, line_key in sorted(touched):
        _recompute_derived(db, ticker, scope, kind, line_key)


def is_in_history(db: Session, item: OCRInboxItem) -> bool:
    return db.query(StatementFact.id).filter_by(inbox_item_id=item.id, status="active").first() is not None


def resolve_fact(
    db: Session, ticker: str, scope: str, statement_kind: str, key: str, chosen_fact_id: int,
) -> dict:
    """Owner picks one active source for a disagreeing key; derived lines follow."""
    fact = db.get(StatementFact, chosen_fact_id)
    if (
        fact is None or fact.status != "active" or fact.ticker != ticker or fact.scope != scope
        or fact.statement_kind != statement_kind or fact.fact_key != key
    ):
        raise HistoryError(f"Fact {chosen_fact_id} is not an active source of {key}")
    resolution = _upsert_resolution(db, ticker, scope, fact)
    _recompute_derived(db, ticker, scope, statement_kind, fact.line_key)
    db.commit()
    facts = (
        db.query(StatementFact)
        .filter_by(ticker=ticker, scope=scope, statement_kind=statement_kind, fact_key=key, status="active")
        .all()
    )
    states = point_states(
        [_fact_dict(f) for f in facts], _resolution_dicts(db, ticker, scope, statement_kind, {key}),
    )
    state = states.get(key)
    return {
        "resolution": {
            "id": resolution.id, "fact_key": key, "statement_kind": statement_kind,
            "chosen_fact_id": resolution.chosen_fact_id, "chosen_value": resolution.chosen_value,
        },
        "state": asdict(state) if state else None,
    }

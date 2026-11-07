"""Pure extraction of statement tables from verified OCR page Markdown.

Turns HTML or pipe-Markdown tables into rows with a period per value column.
Nothing here guesses: an unreadable kind, period or unit stays None for the
owner to confirm. No DB access.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal

from app.services.history_periods import (
    Period,
    detect_statement_kind,
    parse_column_period,
    parse_relative_period,
    parse_unit_cue,
    parse_unit_multiplier,
)
from app.services.ocr_label_levels import (
    CELL_RE,
    LEVEL_MARKER_RE,
    ROW_RE,
    TABLE_RE,
    _level_value,
    _levels_for_cells,
    _markdown_separator,
    _plain_text,
    _verify_table_levels,
    _split_markdown_row,
    parse_financial_number,
)
from app.services.ocr_label_library import normalize_label

_DASHES = {"-", "–", "—"}
_SPLIT_DIGITS_RE = re.compile(r"\d\s+\d")  # "37.792.619 22.265.897": two numbers merged
_BIGINT_LIMIT = 2**63
_DATE_RE = re.compile(r"\d{1,2}/\d{1,2}/\d{4}")
_YEAR_HEADER_RE = re.compile(r"(?:nam\s*)?(?:19|20)\d{2}")
_SPAN_RE = {
    "rowspan": re.compile(r"\browspan\s*=\s*[\"']?(\d+)", re.I),
    "colspan": re.compile(r"\bcolspan\s*=\s*[\"']?(\d+)", re.I),
}
_LEVEL_ATTR_RE = re.compile(r"data-ocr-label-level\s*=\s*[\"']?(L|[0-3])", re.I)
_NON_AMOUNT_RE = re.compile(
    r"tren (?:mot )?co phieu|\beps\b|so luong|\bty le\b|\bty suat\b|per share"
)


@dataclass
class ExtractedRow:
    row: int  # 1-based source row within the table (same coordinates as review rows)
    label: str
    parent_label: str | None
    code: str | None  # Mã số
    cells: list[str]  # original text, one per ExtractedTable.columns entry
    is_amount: bool


@dataclass
class ExtractedColumn:
    column: int  # 0-based column in the span-expanded table grid
    header: str
    period: Period | None
    # "header": parsed from the header's own dates/quarter; "relative": a
    # year-less header proposed from the labelled fiscal year (owner confirms).
    period_source: str | None = None


@dataclass
class ExtractedTable:
    page: int
    table: int  # 1-based: HTML tables first, then pipe tables (review numbering)
    kind: str | None
    columns: list[ExtractedColumn]
    unit_multiplier: int | None
    rows: list[ExtractedRow]


def cell_value(text: str, multiplier: int) -> int | None:
    """Integer đồng for a cell: dash is 0, blank/unparseable/fractional is None.

    Digit groups separated by whitespace are unreadable (often two merged
    cells, never silently joined), and so is a value that does not fit BIGINT.
    """
    plain = _plain_text(text or "").replace("**", "").replace("__", "").strip()
    if not plain:
        return None
    if plain in _DASHES:
        return 0
    if _SPLIT_DIGITS_RE.search(plain):
        return None
    number = parse_financial_number(plain)
    if number is None:
        return None
    scaled = number * Decimal(multiplier)
    if scaled != scaled.to_integral_value() or abs(scaled) >= _BIGINT_LIMIT:
        return None
    return int(scaled)


def is_unreadable_cell(text: str, multiplier: int) -> bool:
    """A non-blank cell whose value cannot be read (listed for the owner, not stored)."""
    plain = _plain_text(text or "").replace("**", "").replace("__", "").strip()
    return bool(plain) and cell_value(plain, multiplier) is None


def is_amount_row(label: str) -> bool:
    """False for per-share, ratio and count rows that are not money in the table unit."""
    if "%" in (label or ""):
        return False
    return not _NON_AMOUNT_RE.search(normalize_label(label or ""))


# --- grid building -----------------------------------------------------------


@dataclass
class _Grid:
    rows: list[list[str]]  # plain text per expanded column
    raw_first: list[str]  # raw first-cell markup (for explicit level metadata)
    source_rows: list[int]  # 1-based source row number per grid row
    forced_header: int  # rows that are headers regardless of content


def _html_grid(table: str) -> _Grid:
    rows: list[list[str]] = []
    raw_first: list[str] = []
    source_rows: list[int] = []
    covered: dict[int, tuple[int, str]] = {}  # column -> (rows still covered, text)
    for source_index, row_match in enumerate(ROW_RE.finditer(table), start=1):
        cells = list(CELL_RE.finditer(row_match.group(0)))
        if not cells:
            continue
        out = {column: text for column, (_left, text) in covered.items()}
        covered = {c: (left - 1, text) for c, (left, text) in covered.items() if left > 1}
        first_raw = ""
        column = 0
        for cell in cells:
            while column in out:
                column += 1
            attrs = cell.group(2)
            rowspan = int(m.group(1)) if (m := _SPAN_RE["rowspan"].search(attrs)) else 1
            colspan = int(m.group(1)) if (m := _SPAN_RE["colspan"].search(attrs)) else 1
            text = _plain_text(cell.group(3))
            if column == 0:
                first_raw = cell.group(0)
            for offset in range(max(1, colspan)):
                out[column + offset] = text
                if rowspan > 1:
                    covered[column + offset] = (rowspan - 1, text)
            column += max(1, colspan)
        width = max(out) + 1
        rows.append([out.get(i, "") for i in range(width)])
        raw_first.append(first_raw)
        source_rows.append(source_index)
    return _Grid(rows, raw_first, source_rows, 0)


def _markdown_tables(markdown: str) -> tuple[list[_Grid], str]:
    """Pipe tables in text with HTML tables already blanked, plus the remaining text."""
    lines = markdown.splitlines()
    grids: list[_Grid] = []
    outside: list[str] = []
    index = 0
    while index < len(lines):
        if (
            index + 1 >= len(lines)
            or "|" not in lines[index]
            or not _markdown_separator(lines[index + 1])
        ):
            outside.append(lines[index])
            index += 1
            continue
        body_start = index + 2
        body_end = body_start
        while body_end < len(lines) and "|" in lines[body_end] and lines[body_end].strip():
            body_end += 1
        raw_rows = [_split_markdown_row(lines[index])] + [
            _split_markdown_row(line) for line in lines[body_start:body_end]
        ]
        grids.append(_Grid(
            rows=[[_plain_text(cell) for cell in cells] for cells in raw_rows],
            raw_first=[cells[0] if cells else "" for cells in raw_rows],
            source_rows=[1] + [offset + 2 for offset in range(body_end - body_start)],
            forced_header=1,
        ))
        index = body_end
    return grids, "\n".join(outside)


# --- table interpretation ----------------------------------------------------


def _is_numeric_cell(text: str) -> bool:
    if text in _DASHES:
        return True
    if _YEAR_HEADER_RE.fullmatch(normalize_label(text)):
        return False  # a bare "2025" / "Năm 2025" is header text, not an amount
    return parse_financial_number(text) is not None and not _DATE_RE.search(text)


def _is_header_row(cells: list[str]) -> bool:
    values = [cell for cell in cells[1:] if cell]
    return bool(values) and not any(_is_numeric_cell(cell) for cell in values)


def _column_role(header: str) -> str:
    norm = normalize_label(header)
    if "thuyet minh" in norm:
        return "note"
    if "ma so" in norm:
        return "code"
    return "value"


def _single_unit(texts: list[str]) -> tuple[bool, int | None]:
    """(found any unit, the unit when exactly one distinct unit was found)."""
    units = {unit for text in texts if (unit := parse_unit_multiplier(text)) is not None}
    if not units:
        return False, None
    return True, units.pop() if len(units) == 1 else None


def _explicit_level(raw_first: str) -> int | None:
    marker = LEVEL_MARKER_RE.search(raw_first)
    if marker:
        return _level_value(marker.group(1))
    opening = raw_first[: raw_first.find(">") + 1] if raw_first.startswith("<") else ""
    attr = _LEVEL_ATTR_RE.search(opening)
    return _level_value(attr.group(1)) if attr else None


def _interpret(
    grid: _Grid,
    page: int,
    number: int,
    kind: str | None,
    page_lines: list[str],
    fiscal_year: int | None,
) -> ExtractedTable:
    width = max((len(row) for row in grid.rows), default=0)
    rows = [row + [""] * (width - len(row)) for row in grid.rows]
    header_count = min(grid.forced_header, len(rows))
    while header_count < len(rows) and _is_header_row(rows[header_count]):
        header_count += 1
    header_rows, body = rows[:header_count], rows[header_count:]

    headers: list[str] = []
    for column in range(width):
        pieces: list[str] = []
        for row in header_rows:
            text = row[column].strip()
            if text and (not pieces or pieces[-1] != text):
                pieces.append(text)
        headers.append(" ".join(pieces))

    code_column = next(
        (c for c in range(1, width) if _column_role(headers[c]) == "code"), None,
    )
    columns: list[ExtractedColumn] = []
    for column in range(1, width):
        if _column_role(headers[column]) != "value":
            continue
        period = parse_column_period(headers[column])
        source = "header" if period is not None else None
        if period is None and fiscal_year is not None:
            # Year-less header ("Quý III Năm nay"): a proposal the owner confirms.
            period = parse_relative_period(headers[column], fiscal_year)
            source = "relative" if period is not None else None
        if period is None and not any(_is_numeric_cell(row[column]) for row in body):
            continue
        columns.append(ExtractedColumn(column, headers[column], period, source))

    header_cells = list(dict.fromkeys(cell for row in header_rows for cell in row if cell))
    found, unit = _single_unit(header_cells)
    if not found:
        # Page text only counts with an explicit "Đơn vị [tính]" cue; prose
        # such as "vốn điều lệ 50.000 tỷ đồng" must not set the unit.
        # Only the unit named right after the cue counts ("Đơn vị kiểm toán:
        # ... 50 tỷ đồng" names an auditor, not the unit).
        cue_units = {u for line in page_lines if (u := parse_unit_cue(line)) is not None}
        unit = cue_units.pop() if len(cue_units) == 1 else None

    body_raw_first = grid.raw_first[header_count:]
    level_rows = [[row[0]] + [row[c.column] for c in columns] for row in body]
    inferred, _relationships = _levels_for_cells(level_rows, [None] * len(level_rows))
    levels: dict[int, int] = {}
    explicit_levels: list[int | None] = []
    for index, row in enumerate(body):
        explicit = _explicit_level(body_raw_first[index]) if row[0] else None
        explicit_levels.append(explicit)
        if not row[0]:
            continue
        level = explicit if explicit is not None else inferred.get(index)
        if level is not None:
            levels[index] = level
    # Parent from the level hierarchy: an arithmetically verified group gives
    # the true parent whether it sits above or below its children.
    checks, _unverifiable = _verify_table_levels(
        level_rows,
        explicit_levels,
        [""] + [c.header for c in columns],
        list(range(len(level_rows))),
        number,
    )
    verified_parent: dict[int, str] = {}
    for check in checks:
        if check["matches"]:
            for child in check["child_rows"]:
                verified_parent[child] = check["parent_label"]

    extracted: list[ExtractedRow] = []
    for index, row in enumerate(body):
        cells = [row[c.column] for c in columns]
        code = row[code_column] if code_column is not None and row[code_column] else None
        if not row[0] and not code and not any(cells):
            continue
        parent = verified_parent.get(index)
        level = levels.get(index)
        if parent is None and level is not None:
            for previous in range(index - 1, -1, -1):
                if previous in levels and levels[previous] < level:
                    parent = body[previous][0]
                    break
        extracted.append(ExtractedRow(
            row=grid.source_rows[header_count + index],
            label=row[0],
            parent_label=parent,
            code=code,
            cells=cells,
            is_amount=is_amount_row(row[0]),
        ))
    return ExtractedTable(page, number, kind, columns, unit, extracted)


def extract_tables(
    page: int,
    markdown: str,
    previous_kind: str | None,
    fiscal_year: int | None = None,
) -> list[ExtractedTable]:
    """Structured tables of one OCR page; HTML tables first, then pipe tables."""
    markdown = markdown or ""
    html_grids = [_html_grid(match.group(0)) for match in TABLE_RE.finditer(markdown)]
    without_html = TABLE_RE.sub(lambda m: "\n" * m.group(0).count("\n"), markdown)
    pipe_grids, outside = _markdown_tables(without_html)
    grids = html_grids + pipe_grids

    kind = detect_statement_kind(outside)
    if kind is None and "tiep theo" in normalize_label(outside):
        kind = previous_kind
    page_lines = [line for line in (_plain_text(text) for text in outside.splitlines()) if line]
    return [
        _interpret(grid, page, number, kind, page_lines, fiscal_year)
        for number, grid in enumerate(grids, start=1)
        if grid.rows
    ]

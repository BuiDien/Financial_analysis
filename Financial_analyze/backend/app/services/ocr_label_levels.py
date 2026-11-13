"""Deterministic label hierarchy inference for OCR financial tables.

This module intentionally has no LLM dependency. It finds parent/child rows by
exact arithmetic, then writes explicit label-level metadata back into Markdown.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation


LEVEL_MARKER_RE = re.compile(
    r"<!--\s*ocr-label-level:(L|[0-3])(?:;source:(auto))?\s*-->", re.I
)
TABLE_RE = re.compile(r"<table\b[^>]*>.*?</table\s*>", re.I | re.S)
ROW_RE = re.compile(r"<tr\b[^>]*>.*?</tr\s*>", re.I | re.S)
CELL_RE = re.compile(r"<(td|th)\b([^>]*)>(.*?)</\1\s*>", re.I | re.S)
LEVEL_ATTR_RE = re.compile(
    r"\sdata-ocr-label-level\s*=\s*(?:\"(?:L|[0-3])\"|'(?:L|[0-3])'|L|[0-3])",
    re.I,
)
LEVEL_SOURCE_ATTR_RE = re.compile(
    r"\sdata-ocr-label-level-source\s*=\s*(?:\"auto\"|'auto'|auto)", re.I
)
TAG_RE = re.compile(r"<[^>]+>")


@dataclass
class TableRow:
    source_index: int
    label: str
    values: tuple[Decimal | None, ...]
    explicit_level: int | None = None


@dataclass
class Node:
    row: TableRow
    children: list["Node"] = field(default_factory=list)
    children_direction: int | None = None


@dataclass
class Inference:
    levels: dict[int, int]
    relationships: int
    arithmetic_rows: set[int]


def _plain_text(value: str) -> str:
    value = LEVEL_MARKER_RE.sub("", value)
    return html.unescape(TAG_RE.sub(" ", value)).replace("\xa0", " ").strip()


def _level_value(token: str) -> int:
    return -1 if token.upper() == "L" else int(token)


def _level_token(level: int) -> str:
    return "L" if level < 0 else str(level)


def _is_summary_label(label: str) -> bool:
    text = _plain_text(label)
    if re.match(r"^(TỔNG|TOTAL|GRAND TOTAL)\b", text, re.I):
        return True
    letters = re.sub(r"[^A-Za-zÀ-ỹĐđ]", "", text)
    return len(letters) >= 3 and letters == letters.upper()


def _valid_digit_grouping(integer_part: str) -> bool:
    """Thousands groups must be well formed: "1.234.567" yes, "1.234.56" or
    "1.2345" no (an OCR-dropped/merged digit must not become a new number)."""
    separators = {character for character in integer_part if character in ".,"}
    if not separators:
        return True
    if len(separators) > 1:
        return False
    first, *rest = re.split(r"[.,]", integer_part)
    return (
        first.isdigit()
        and all(len(group) == 3 and group.isdigit() for group in rest)
    )


def parse_financial_number(value: str) -> Decimal | None:
    """Parse common Vietnamese statement numbers without binary floats."""
    value = _plain_text(value).replace("**", "").replace("__", "").strip()
    if (
        not value
        or value in {"-", "–", "—"}
        or "%" in value
        or re.search(r"[A-Za-zÀ-ỹĐđ]", value)
    ):
        return None
    negative = value.startswith("(") and value.endswith(")")
    if negative:
        value = value[1:-1]
    value = re.sub(r"\s+", "", value).replace("−", "-").replace("–", "-")
    value = re.sub(r"[^0-9.,+\-]", "", value)
    if not value or not re.search(r"\d", value):
        return None
    if value.startswith("-"):
        negative = not negative
        value = value[1:]
    elif value.startswith("+"):
        value = value[1:]

    comma, dot = value.rfind(","), value.rfind(".")
    decimal_at = -1
    if comma >= 0 and dot >= 0:
        last = max(comma, dot)
        if 0 < len(value) - last - 1 <= 2:
            decimal_at = last
    elif comma >= 0 or dot >= 0:
        separator = "," if comma >= 0 else "."
        last = value.rfind(separator)
        if value.count(separator) == 1 and 0 < len(value) - last - 1 <= 2:
            decimal_at = last

    integer_part = value[:decimal_at] if decimal_at >= 0 else value
    if not _valid_digit_grouping(integer_part):
        return None

    normalized = "".join(
        character
        for index, character in enumerate(value)
        if character.isdigit() or index == decimal_at
    )
    if decimal_at >= 0:
        digits_after = len(value) - decimal_at - 1
        digits = normalized.replace(value[decimal_at], "")
        normalized = f"{digits[:-digits_after] or '0'}.{digits[-digits_after:]}"
    try:
        parsed = Decimal(normalized)
    except InvalidOperation:
        return None
    return -parsed if negative and parsed else parsed


def _value_match_score(parent: Node, children: list[Node]) -> tuple[int, int] | None:
    """Return exact and inconsistent column counts for a possible relationship.

    One exact financial column is enough to establish the hierarchy. Other
    populated columns may disagree because the purpose of this review surface
    is to find precisely those OCR or source-statement inconsistencies.
    """
    matched = 0
    inconsistent = 0
    for column, expected in enumerate(parent.row.values):
        if expected is None:
            continue
        parts = [child.row.values[column] for child in children]
        if any(value is None for value in parts):
            continue
        if sum(parts, Decimal(0)) == expected:
            matched += 1
        else:
            inconsistent += 1
    return (matched, inconsistent) if matched else None


def infer_levels(rows: list[TableRow]) -> Inference:
    """Infer a hierarchy by repeatedly collapsing exact adjacent sums."""
    forest = [Node(row) for row in rows if any(value is not None for value in row.values)]
    relationships = 0
    arithmetic_rows: set[int] = set()

    while True:
        matches: list[tuple[int, int, int, list[Node], int, int]] = []
        for parent_index, parent in enumerate(forest):
            # A repeated value directly below a row is a one-child detail group.
            if parent_index + 1 < len(forest):
                child = forest[parent_index + 1]
                score = _value_match_score(parent, [child])
                if (
                    any(value not in {None, Decimal(0)} for value in parent.row.values)
                    and score
                ):
                    matches.append((1, parent_index, 1, [child], *score))
            for direction in (1, -1):
                available = (
                    forest[parent_index + 1 :]
                    if direction == 1
                    else list(reversed(forest[:parent_index]))
                )
                for count in range(2, len(available) + 1):
                    children = available[:count]
                    score = _value_match_score(parent, children)
                    if score:
                        matches.append((count, parent_index, direction, children, *score))
                        break
        if not matches:
            break
        count, parent_index, direction, children, _matched, _inconsistent = min(
            matches,
            key=lambda match: (
                match[5] > 0,
                match[5],
                -match[4],
                # Collapse parent-above groups from the bottom upward, then
                # parent-below subtotals from the top downward. This preserves
                # inner income-statement subtotals before later rolling totals
                # consume them as children.
                0 if match[2] == 1 else 1,
                -match[1] if match[2] == 1 else match[1],
                match[0],
            ),
        )
        parent = forest[parent_index]
        parent.children = (children if direction == 1 else list(reversed(children)))
        parent.children_direction = direction
        arithmetic_rows.add(parent.row.source_index)
        arithmetic_rows.update(child.row.source_index for child in children)
        relationships += 1
        child_ids = {id(child) for child in children}
        forest = [node for node in forest if id(node) not in child_ids]

    levels: dict[int, int] = {}

    def assign(node: Node, level: int) -> None:
        resolved_level = 0 if _is_summary_label(node.row.label) else min(3, level)
        levels[node.row.source_index] = resolved_level
        for child in node.children:
            if _is_summary_label(child.row.label):
                child_level = 0
            elif node.children_direction == -1 and child.children:
                # A previously calculated subtotal remains a summary line when
                # it feeds a later rolling total. Raw recursive depth would
                # otherwise turn an entire income statement into L3 details.
                child_level = 1
            else:
                child_level = resolved_level + 1
            assign(child, child_level)

    single_arithmetic_tree = len(forest) == 1
    for root in forest:
        if root.children:
            # A local subtotal can be disconnected from the page-wide total by
            # an OCR discrepancy. It remains a primary L1 statement line; L0
            # is reserved for an actual grand total or a standalone hierarchy.
            assign(root, 0 if single_arithmetic_tree or _is_summary_label(root.row.label) else 1)
    return Inference(levels, relationships, arithmetic_rows)


def _fallback_level(label: str, has_number: bool) -> int:
    text = _plain_text(label)
    letters = re.sub(r"[^A-Za-zÀ-ỹĐđ]", "", text)
    uppercase = len(letters) >= 3 and letters == letters.upper()
    if not has_number:
        return -1
    if _is_summary_label(text):
        return 0
    if uppercase:
        return 1 if has_number else 0
    if re.match(r"^[-–—•+]", text):
        return 3
    # Without an arithmetic parent, a numeric row is a primary statement
    # line under the nearest section. Deeper L2/L3 levels require evidence
    # from a detected parent/child relationship or an explicit manual level.
    return 1 if has_number else 2


def _financial_column_indexes(
    cell_rows: list[list[str]], parsed_grid: list[list[Decimal | None]],
) -> list[int]:
    """Return value-column indexes while excluding notes and row codes."""
    value_width = max((len(row) for row in parsed_grid), default=0)
    financial_counts = [
        sum(
            1
            for row_index, cells in enumerate(cell_rows)
            if parsed_grid[row_index][column] is not None
            and (
                abs(parsed_grid[row_index][column]) >= 1000
                or bool(re.search(r"[().,]", _plain_text(cells[column + 1])))
            )
        )
        for column in range(value_width)
    ]
    populated_counts = [
        sum(
            parsed_grid[row_index][column] is not None
            for row_index in range(len(cell_rows))
        )
        for column in range(value_width)
    ]
    minimum_financial_rows = max(1, len(cell_rows) // 4)
    financial = [
        column
        for column, count in enumerate(financial_counts)
        if count >= minimum_financial_rows
    ]
    if financial:
        return financial
    if populated_counts and max(populated_counts) > 0:
        return [populated_counts.index(max(populated_counts))]
    return []


def _levels_for_cells(cell_rows: list[list[str]], explicit: list[int | None]) -> tuple[dict[int, int], int]:
    width = max((len(cells) for cells in cell_rows), default=0)
    value_width = max(0, width - 1)
    parsed_grid = [
        [
            parse_financial_number(cells[column + 1])
            if column + 1 < len(cells) else None
            for column in range(value_width)
        ]
        for cells in cell_rows
    ]
    financial_columns = _financial_column_indexes(cell_rows, parsed_grid)
    primary_column = financial_columns[0] if financial_columns else None

    rows = []
    for index, cells in enumerate(cell_rows):
        if primary_column is None:
            values = tuple()
        else:
            primary_value = parsed_grid[index][primary_column]
            primary_text = (
                _plain_text(cells[primary_column + 1])
                if primary_column + 1 < len(cells) else ""
            )
            # A printed dash is an explicit financial zero. Include it in
            # contiguous subtotal ranges, while blank cells remain missing.
            if primary_value is None and primary_text in {"-", "–", "—"}:
                primary_value = Decimal(0)
            values = (primary_value,)
        rows.append(TableRow(index, _plain_text(cells[0]) if cells else "", values, explicit[index]))
    inference = infer_levels(rows)
    levels = {
        row.source_index: inference.levels.get(
            row.source_index,
            _fallback_level(
                row.label,
                any(
                    value is not None
                    or (
                        column + 1 < len(cell_rows[row.source_index])
                        and _plain_text(cell_rows[row.source_index][column + 1])
                        in {"-", "–", "—"}
                    )
                    for column, value in enumerate(parsed_grid[row.source_index])
                ),
            ),
        )
        for row in rows
        if row.label
    }
    return levels, inference.relationships


def _split_markdown_row(line: str) -> list[str]:
    placeholder = "\x00OCR_PIPE\x00"
    value = line.strip().replace(r"\|", placeholder)
    if value.startswith("|"):
        value = value[1:]
    if value.endswith("|"):
        value = value[:-1]
    return [cell.replace(placeholder, "|").strip() for cell in value.split("|")]


def _markdown_separator(line: str) -> bool:
    cells = _split_markdown_row(line)
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", re.sub(r"\s", "", cell)) for cell in cells)


def _serialize_markdown_row(cells: list[str]) -> str:
    return "| " + " | ".join(cell.replace("|", r"\|") for cell in cells) + " |"


def _apply_markdown_tables(markdown: str) -> tuple[str, int, int, int]:
    lines = markdown.splitlines()
    tables = relationships = changed = 0
    index = 0
    while index + 1 < len(lines):
        if "|" not in lines[index] or not _markdown_separator(lines[index + 1]):
            index += 1
            continue
        body_start = index + 2
        body_end = body_start
        while body_end < len(lines) and "|" in lines[body_end] and lines[body_end].strip():
            body_end += 1
        cell_rows = [_split_markdown_row(line) for line in lines[body_start:body_end]]
        explicit = [
            _level_value(match.group(1))
            if (match := LEVEL_MARKER_RE.search(cells[0] if cells else "")) and not match.group(2)
            else None
            for cells in cell_rows
        ]
        levels, found = _levels_for_cells(cell_rows, explicit)
        for row_index, cells in enumerate(cell_rows):
            if not cells or explicit[row_index] is not None or row_index not in levels:
                continue
            token = _level_token(levels[row_index])
            cells[0] = f"<!--ocr-label-level:{token};source:auto-->{LEVEL_MARKER_RE.sub('', cells[0]).strip()}"
            lines[body_start + row_index] = _serialize_markdown_row(cells)
            changed += 1
        tables += 1
        relationships += found
        index = body_end
    return "\n".join(lines), tables, relationships, changed


def _apply_html_table(table: str) -> tuple[str, int, int]:
    rows = list(ROW_RE.finditer(table))
    data_rows: list[tuple[re.Match[str], list[re.Match[str]]]] = []
    cell_rows: list[list[str]] = []
    explicit: list[int | None] = []
    for row_match in rows:
        cells = list(CELL_RE.finditer(row_match.group(0)))
        if not cells or cells[0].group(1).lower() == "th":
            continue
        data_rows.append((row_match, cells))
        cell_rows.append([cell.group(3) for cell in cells])
        attr = re.search(r"data-ocr-label-level\s*=\s*[\"']?(L|[0-3])", cells[0].group(2), re.I)
        automatic = bool(re.search(r"data-ocr-label-level-source\s*=\s*[\"']?auto", cells[0].group(2), re.I))
        explicit.append(_level_value(attr.group(1)) if attr and not automatic else None)
    levels, relationships = _levels_for_cells(cell_rows, explicit)
    replacements: list[tuple[int, int, str]] = []
    changed = 0
    for index, (row_match, cells) in enumerate(data_rows):
        if explicit[index] is not None or index not in levels:
            continue
        cell = cells[0]
        opening_end = cell.group(0).find(">") + 1
        opening = cell.group(0)[:opening_end]
        clean_opening = LEVEL_SOURCE_ATTR_RE.sub("", LEVEL_ATTR_RE.sub("", opening[:-1]))
        token = _level_token(levels[index])
        updated = clean_opening + f' data-ocr-label-level="{token}" data-ocr-label-level-source="auto">'
        start = row_match.start() + cell.start()
        replacements.append((start, start + opening_end, updated))
        changed += 1
    for start, end, replacement in reversed(replacements):
        table = table[:start] + replacement + table[end:]
    return table, relationships, changed


def auto_level_markdown(markdown: str) -> dict:
    """Return a non-persisted Markdown preview with inferred label metadata."""
    html_tables = relationships = changed = 0

    def replace_html(match: re.Match[str]) -> str:
        nonlocal html_tables, relationships, changed
        html_tables += 1
        updated, found, updates = _apply_html_table(match.group(0))
        relationships += found
        changed += updates
        return updated

    updated = TABLE_RE.sub(replace_html, markdown)
    updated, markdown_tables, markdown_relationships, markdown_changed = _apply_markdown_tables(updated)
    return {
        "markdown": updated,
        "tables": html_tables + markdown_tables,
        "relationships": relationships + markdown_relationships,
        "leveled_rows": changed + markdown_changed,
    }


def _number_or_explicit_zero(value: str) -> Decimal | None:
    parsed = parse_financial_number(value)
    if parsed is None and _plain_text(value) in {"-", "–", "—"}:
        return Decimal(0)
    return parsed


def _format_financial_decimal(value: Decimal) -> str:
    negative = value < 0
    whole, _, fraction = format(abs(value), "f").partition(".")
    grouped = f"{int(whole or '0'):,}".replace(",", ".")
    rendered = f"{grouped},{fraction.rstrip('0')}" if fraction.rstrip("0") else grouped
    return f"({rendered})" if negative else rendered


def _verify_table_levels(
    cell_rows: list[list[str]],
    explicit: list[int | None],
    headers: list[str],
    row_numbers: list[int],
    table_number: int,
) -> tuple[list[dict], list[dict]]:
    if not cell_rows:
        return [], []
    width = max((len(cells) for cells in cell_rows), default=0)
    value_width = max(0, width - 1)
    parsed_grid = [
        [
            _number_or_explicit_zero(cells[column + 1])
            if column + 1 < len(cells) else None
            for column in range(value_width)
        ]
        for cells in cell_rows
    ]
    financial_columns = _financial_column_indexes(cell_rows, parsed_grid)
    if not financial_columns:
        return [], []

    inferred, _relationships = _levels_for_cells(
        cell_rows, [None for _cells in cell_rows]
    )
    levels = {
        index: explicit[index] if explicit[index] is not None else inferred.get(index)
        for index in range(len(cell_rows))
    }

    candidates: list[dict] = []
    for parent_index, parent_level in levels.items():
        # L is a text-only section label, not an arithmetic parent.
        if parent_level is None or parent_level < 0 or parent_level >= 3:
            continue
        for step, children_position in ((1, "below"), (-1, "above")):
            children = []
            cursor = parent_index + step
            while 0 <= cursor < len(cell_rows):
                level = levels.get(cursor)
                if level is not None and level <= parent_level:
                    break
                if level == parent_level + 1:
                    children.append(cursor)
                cursor += step
            if step < 0:
                children.reverse()
            if not children:
                continue

            column_results = []
            for column in financial_columns:
                parent_value = parsed_grid[parent_index][column]
                parts = [parsed_grid[child][column] for child in children]
                if parent_value is None or any(part is None for part in parts):
                    continue
                children_sum = sum(parts, Decimal(0))
                difference = parent_value - children_sum
                column_results.append({
                    "column": column + 2,
                    "column_label": (
                        _plain_text(headers[column + 1])
                        if column + 1 < len(headers) and _plain_text(headers[column + 1])
                        else f"Column {column + 2}"
                    ),
                    "parent": _format_financial_decimal(parent_value),
                    "children_sum": _format_financial_decimal(children_sum),
                    "difference": _format_financial_decimal(difference),
                    "matches": difference == 0,
                })
            if column_results:
                candidates.append({
                    "table": table_number,
                    "parent_index": parent_index,
                    "parent_row": row_numbers[parent_index],
                    "parent_label": _plain_text(cell_rows[parent_index][0]),
                    "parent_level": parent_level,
                    "child_level": parent_level + 1,
                    "child_indexes": children,
                    "child_rows": [row_numbers[index] for index in children],
                    "children_position": children_position,
                    "columns": column_results,
                    "matches": all(result["matches"] for result in column_results),
                })

    # A deeper block can sit between a preceding and following parent. Keep
    # one interpretation, preferring exact arithmetic and then the customary
    # parent-above layout when both are equally plausible.
    grouped: dict[tuple[int, tuple[int, ...]], list[dict]] = {}
    for candidate in candidates:
        key = (candidate["parent_level"], tuple(candidate["child_indexes"]))
        grouped.setdefault(key, []).append(candidate)

    checks = []
    unverifiable = []
    primary_column = financial_columns[0] + 2
    for alternatives in grouped.values():
        primary_matches = [
            candidate
            for candidate in alternatives
            if any(
                result["column"] == primary_column and result["matches"]
                for result in candidate["columns"]
            )
        ]
        if len(alternatives) > 1 and not primary_matches:
            exemplar = alternatives[0]
            unverifiable.append({
                "table": table_number,
                "child_level": exemplar["child_level"],
                "child_rows": exemplar["child_rows"],
                "possible_parent_rows": sorted({
                    candidate["parent_row"] for candidate in alternatives
                }),
                "reason": "children_between_possible_parents",
            })
            continue
        selected = max(
            primary_matches or alternatives,
            key=lambda candidate: (
                any(
                    result["column"] == primary_column and result["matches"]
                    for result in candidate["columns"]
                ),
                sum(result["matches"] for result in candidate["columns"]),
                -sum(not result["matches"] for result in candidate["columns"]),
                candidate["children_position"] == "below",
            ),
        )
        selected.pop("parent_index")
        selected.pop("child_indexes")
        checks.append(selected)
    return (
        sorted(checks, key=lambda check: (check["table"], check["parent_row"])),
        unverifiable,
    )


def verify_level_totals(markdown: str) -> dict:
    """Verify that each L0-L2 parent equals its direct next-level children."""
    checks: list[dict] = []
    unverifiable: list[dict] = []
    html_tables = 0

    def inspect_html(match: re.Match[str]) -> str:
        nonlocal html_tables
        html_tables += 1
        rows = list(ROW_RE.finditer(match.group(0)))
        headers: list[str] = []
        cell_rows: list[list[str]] = []
        explicit: list[int | None] = []
        row_numbers: list[int] = []
        for source_index, row_match in enumerate(rows):
            cells = list(CELL_RE.finditer(row_match.group(0)))
            if not cells:
                continue
            if cells[0].group(1).lower() == "th":
                if not headers:
                    headers = [cell.group(3) for cell in cells]
                continue
            cell_rows.append([cell.group(3) for cell in cells])
            row_numbers.append(source_index + 1)
            attr = re.search(
                r'data-ocr-label-level\s*=\s*["\']?(L|[0-3])',
                cells[0].group(2),
                re.I,
            )
            explicit.append(_level_value(attr.group(1)) if attr else None)
        table_checks, table_unverifiable = _verify_table_levels(
            cell_rows, explicit, headers, row_numbers, html_tables,
        )
        checks.extend(table_checks)
        unverifiable.extend(table_unverifiable)
        return "\n" * match.group(0).count("\n")

    markdown_without_html = TABLE_RE.sub(inspect_html, markdown)
    lines = markdown_without_html.splitlines()
    markdown_tables = 0
    index = 0
    while index + 1 < len(lines):
        if "|" not in lines[index] or not _markdown_separator(lines[index + 1]):
            index += 1
            continue
        headers = _split_markdown_row(lines[index])
        body_start = index + 2
        body_end = body_start
        while body_end < len(lines) and "|" in lines[body_end] and lines[body_end].strip():
            body_end += 1
        cell_rows = [_split_markdown_row(line) for line in lines[body_start:body_end]]
        explicit = [
            _level_value(match.group(1))
            if cells and (match := LEVEL_MARKER_RE.search(cells[0]))
            else None
            for cells in cell_rows
        ]
        markdown_tables += 1
        table_checks, table_unverifiable = _verify_table_levels(
            cell_rows,
            explicit,
            headers,
            [row_index + 2 for row_index in range(len(cell_rows))],
            html_tables + markdown_tables,
        )
        checks.extend(table_checks)
        unverifiable.extend(table_unverifiable)
        index = body_end

    matched = sum(check["matches"] for check in checks)
    return {
        "tables": html_tables + markdown_tables,
        "checks": checks,
        "matched": matched,
        "mismatched": len(checks) - matched,
        "unverifiable": unverifiable,
    }


def strip_label_level_metadata(markdown: str) -> str:
    """Remove manual and automatic label metadata without changing cell text."""
    cleaned = LEVEL_MARKER_RE.sub("", markdown)
    cleaned = LEVEL_SOURCE_ATTR_RE.sub("", cleaned)
    return LEVEL_ATTR_RE.sub("", cleaned)


def _extract_label_rows(markdown: str) -> list[dict]:
    """Return stable table/row coordinates used by review suggestions."""
    extracted: list[dict] = []
    html_tables = list(TABLE_RE.finditer(markdown))
    for table_number, table_match in enumerate(html_tables, start=1):
        for source_index, row_match in enumerate(
            ROW_RE.finditer(table_match.group(0)), start=1,
        ):
            cells = list(CELL_RE.finditer(row_match.group(0)))
            if not cells or cells[0].group(1).lower() == "th":
                continue
            label = _plain_text(cells[0].group(3))
            if not label:
                continue
            attr = re.search(
                r'data-ocr-label-level\s*=\s*["\']?(L|[0-3])',
                cells[0].group(2),
                re.I,
            )
            values = [_plain_text(cell.group(3)) for cell in cells[1:]]
            extracted.append({
                "table": table_number,
                "row": source_index,
                "label": label,
                "level": _level_value(attr.group(1)) if attr else None,
                "values": values,
                "has_financial_value": any(
                    parse_financial_number(value) is not None
                    or value in {"-", "–", "—"}
                    for value in values
                ),
            })

    markdown_without_html = TABLE_RE.sub(
        lambda match: "\n" * match.group(0).count("\n"), markdown,
    )
    lines = markdown_without_html.splitlines()
    table_number = len(html_tables)
    index = 0
    while index + 1 < len(lines):
        if "|" not in lines[index] or not _markdown_separator(lines[index + 1]):
            index += 1
            continue
        table_number += 1
        body_start = index + 2
        body_end = body_start
        while (
            body_end < len(lines)
            and "|" in lines[body_end]
            and lines[body_end].strip()
        ):
            body_end += 1
        for row_offset, line in enumerate(lines[body_start:body_end]):
            cells = _split_markdown_row(line)
            label = _plain_text(cells[0]) if cells else ""
            if not label:
                continue
            marker = LEVEL_MARKER_RE.search(cells[0])
            values = [_plain_text(value) for value in cells[1:]]
            extracted.append({
                "table": table_number,
                "row": row_offset + 2,
                "label": label,
                "level": _level_value(marker.group(1)) if marker else None,
                "values": values,
                "has_financial_value": any(
                    parse_financial_number(value) is not None
                    or value in {"-", "–", "—"}
                    for value in values
                ),
            })
        index = body_end
    return extracted


def extract_label_rows(markdown: str) -> list[dict]:
    """Return OCR label rows with stable table and row coordinates.

    This public wrapper lets Quick Correct build a bounded local context without
    duplicating the Markdown/HTML table parser used by the hierarchy engine.
    """
    return _extract_label_rows(markdown)


def build_label_review_evidence(
    markdown: str,
    selected_rows: list[dict] | None = None,
) -> dict:
    """Build a bounded, deterministic evidence packet for Hermes.

    Manual levels are removed only in the temporary inference copy. The
    original Markdown remains untouched and is returned only through row-sized
    evidence, not as a document-sized model prompt.
    """
    current_rows = _extract_label_rows(markdown)
    proposed = auto_level_markdown(strip_label_level_metadata(markdown))
    proposed_rows = {
        (row["table"], row["row"]): row
        for row in _extract_label_rows(proposed["markdown"])
    }
    verification = verify_level_totals(proposed["markdown"])
    checks_by_row: dict[tuple[int, int], list[dict]] = {}
    for check in verification["checks"]:
        compact = {
            "parent_row": check["parent_row"],
            "parent_level": check["parent_level"],
            "child_rows": check["child_rows"],
            "child_level": check["child_level"],
            "children_position": check["children_position"],
            "matches": check["matches"],
            "columns": check["columns"],
        }
        checks_by_row.setdefault(
            (check["table"], check["parent_row"]), [],
        ).append(compact)
        for child_row in check["child_rows"]:
            checks_by_row.setdefault(
                (check["table"], child_row), [],
            ).append(compact)

    selected = None
    if selected_rows is not None:
        selected = {
            (int(row["table"]), int(row["row"])) for row in selected_rows
        }
        available = {(row["table"], row["row"]) for row in current_rows}
        missing = sorted(selected - available)
        if missing:
            formatted = ", ".join(
                f"table {table} row {row}" for table, row in missing
            )
            raise ValueError(f"Selected label row does not exist: {formatted}")

    candidates = []
    for row in current_rows:
        key = (row["table"], row["row"])
        if selected is not None and key not in selected:
            continue
        proposed_row = proposed_rows.get((row["table"], row["row"]))
        if not proposed_row:
            continue
        changed = proposed_row["level"] != row["level"]
        if selected is None and not changed:
            continue
        checks = checks_by_row.get((row["table"], row["row"]), [])
        reason_codes = ["deterministic_structure"]
        if selected is not None:
            reason_codes.insert(0, "user_marked")
        if proposed_row["level"] == -1:
            reason_codes.append("text_only_row")
        if any(check["matches"] for check in checks):
            reason_codes.append("exact_total_relationship")
        candidates.append({
            **row,
            "suggested_level": proposed_row["level"],
            "reason_codes": reason_codes,
            "total_evidence": checks,
        })

    return {
        "tables": proposed["tables"],
        "relationships": proposed["relationships"],
        "verification": {
            "matched": verification["matched"],
            "mismatched": verification["mismatched"],
            "unverifiable": verification["unverifiable"],
        },
        "candidates": candidates,
    }


def apply_label_level_suggestions(markdown: str, changes: list[dict]) -> str:
    """Apply validated level-only changes to Markdown and HTML tables."""
    requested = {
        (int(change["table"]), int(change["row"])): int(change["level"])
        for change in changes
    }
    if len(requested) != len(changes):
        raise ValueError("Only one label-level suggestion is allowed per row")
    if any(level < -1 or level > 3 for level in requested.values()):
        raise ValueError("Label level must be L or L0-L3")
    current_rows = {
        (row["table"], row["row"]): row for row in _extract_label_rows(markdown)
    }
    for key, level in requested.items():
        if (
            level == -1
            and key in current_rows
            and current_rows[key]["has_financial_value"]
        ):
            raise ValueError(
                f"Table {key[0]} row {key[1]} contains a financial value; "
                "L is text-only"
            )

    applied: set[tuple[int, int]] = set()
    html_table_number = 0

    def update_html_table(match: re.Match[str]) -> str:
        nonlocal html_table_number
        html_table_number += 1
        table = match.group(0)
        replacements: list[tuple[int, int, str]] = []
        for row_number, row_match in enumerate(ROW_RE.finditer(table), start=1):
            key = (html_table_number, row_number)
            if key not in requested:
                continue
            cells = list(CELL_RE.finditer(row_match.group(0)))
            if not cells or cells[0].group(1).lower() == "th":
                raise ValueError(f"Table {key[0]} row {key[1]} is not a label row")
            cell = cells[0]
            opening_end = cell.group(0).find(">") + 1
            opening = cell.group(0)[:opening_end]
            clean_opening = LEVEL_SOURCE_ATTR_RE.sub(
                "", LEVEL_ATTR_RE.sub("", opening[:-1]),
            )
            token = _level_token(requested[key])
            updated = clean_opening + f' data-ocr-label-level="{token}">'
            start = row_match.start() + cell.start()
            replacements.append((start, start + opening_end, updated))
            applied.add(key)
        for start, end, replacement in reversed(replacements):
            table = table[:start] + replacement + table[end:]
        return table

    updated = TABLE_RE.sub(update_html_table, markdown)
    lines = updated.splitlines()
    table_number = html_table_number
    index = 0
    while index + 1 < len(lines):
        if "|" not in lines[index] or not _markdown_separator(lines[index + 1]):
            index += 1
            continue
        table_number += 1
        body_start = index + 2
        body_end = body_start
        while (
            body_end < len(lines)
            and "|" in lines[body_end]
            and lines[body_end].strip()
        ):
            body_end += 1
        for row_offset in range(body_end - body_start):
            key = (table_number, row_offset + 2)
            if key not in requested:
                continue
            cells = _split_markdown_row(lines[body_start + row_offset])
            if not cells or not _plain_text(cells[0]):
                raise ValueError(f"Table {key[0]} row {key[1]} is not a label row")
            token = _level_token(requested[key])
            cells[0] = (
                f"<!--ocr-label-level:{token}-->"
                f"{LEVEL_MARKER_RE.sub('', cells[0]).strip()}"
            )
            lines[body_start + row_offset] = _serialize_markdown_row(cells)
            applied.add(key)
        index = body_end

    missing = sorted(set(requested) - applied)
    if missing:
        coordinates = ", ".join(f"table {table} row {row}" for table, row in missing)
        raise ValueError(f"Label rows could not be located: {coordinates}")
    return "\n".join(lines)


def apply_label_text_suggestions(markdown: str, changes: list[dict]) -> str:
    """Replace only user-accepted label text at stable table/row coordinates."""
    requested: dict[tuple[int, int], dict] = {}
    for change in changes:
        key = (int(change["table"]), int(change["row"]))
        if key in requested:
            raise ValueError("Only one label-text suggestion is allowed per row")
        label = str(change["label"]).strip()
        if not label or "\n" in label or "\r" in label or len(label) > 500:
            raise ValueError("Corrected label must be one non-empty line")
        requested[key] = {
            "label": label,
            "current_label": str(change["current_label"]).strip(),
        }

    applied: set[tuple[int, int]] = set()
    html_table_number = 0

    def update_html_table(match: re.Match[str]) -> str:
        nonlocal html_table_number
        html_table_number += 1
        table = match.group(0)
        replacements: list[tuple[int, int, str]] = []
        for row_number, row_match in enumerate(ROW_RE.finditer(table), start=1):
            key = (html_table_number, row_number)
            if key not in requested:
                continue
            cells = list(CELL_RE.finditer(row_match.group(0)))
            if not cells or cells[0].group(1).lower() == "th":
                raise ValueError(f"Table {key[0]} row {key[1]} is not a label row")
            cell = cells[0]
            if _plain_text(cell.group(3)) != requested[key]["current_label"]:
                raise ValueError(f"Table {key[0]} row {key[1]} label changed")
            start = row_match.start() + cell.start(3)
            end = row_match.start() + cell.end(3)
            replacements.append(
                (start, end, html.escape(requested[key]["label"], quote=False)),
            )
            applied.add(key)
        for start, end, replacement in reversed(replacements):
            table = table[:start] + replacement + table[end:]
        return table

    updated = TABLE_RE.sub(update_html_table, markdown)
    lines = updated.splitlines()
    table_number = html_table_number
    index = 0
    while index + 1 < len(lines):
        if "|" not in lines[index] or not _markdown_separator(lines[index + 1]):
            index += 1
            continue
        table_number += 1
        body_start = index + 2
        body_end = body_start
        while (
            body_end < len(lines)
            and "|" in lines[body_end]
            and lines[body_end].strip()
        ):
            body_end += 1
        for row_offset in range(body_end - body_start):
            key = (table_number, row_offset + 2)
            if key not in requested:
                continue
            cells = _split_markdown_row(lines[body_start + row_offset])
            if not cells or not _plain_text(cells[0]):
                raise ValueError(f"Table {key[0]} row {key[1]} is not a label row")
            if _plain_text(cells[0]) != requested[key]["current_label"]:
                raise ValueError(f"Table {key[0]} row {key[1]} label changed")
            marker = LEVEL_MARKER_RE.search(cells[0])
            prefix = marker.group(0) if marker else ""
            cells[0] = f"{prefix}{requested[key]['label']}"
            lines[body_start + row_offset] = _serialize_markdown_row(cells)
            applied.add(key)
        index = body_end

    missing = sorted(set(requested) - applied)
    if missing:
        coordinates = ", ".join(
            f"table {table} row {row}" for table, row in missing
        )
        raise ValueError(f"Label rows could not be located: {coordinates}")
    return "\n".join(lines)

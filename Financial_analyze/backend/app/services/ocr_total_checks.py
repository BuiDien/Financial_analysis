"""Automatic subtotal checks for OCR pages.

Runs the existing deterministic level-total verification on a page and picks out
the mismatches that look like one misread digit: the difference between a parent
and the sum of its children is a single non-zero digit times a power of ten
(e.g. 500 when 222.813 was read as 222.313). Larger, irregular differences
usually mean the row hierarchy was guessed wrong, so they are counted but not
flagged.
"""

from __future__ import annotations

from decimal import Decimal

from .ocr_label_levels import parse_financial_number, verify_level_totals


def is_single_digit_difference(value: Decimal) -> bool:
    value = abs(value)
    if value == 0 or value != value.to_integral_value():
        return False
    digits = str(int(value))
    return digits[1:].strip("0") == ""


def page_total_check(markdown: str) -> dict:
    result = verify_level_totals(markdown)
    likely_misreads = []
    for check in result["checks"]:
        for column in check["columns"]:
            if column["matches"]:
                continue
            difference = parse_financial_number(column["difference"])
            if difference is None or not is_single_digit_difference(difference):
                continue
            likely_misreads.append({
                "table": check["table"],
                "parent_row": check["parent_row"],
                "parent_label": check["parent_label"],
                "child_rows": check["child_rows"],
                "column_label": column["column_label"],
                "parent": column["parent"],
                "children_sum": column["children_sum"],
                "difference": column["difference"],
            })
    return {
        "checked": len(result["checks"]),
        "mismatched": result["mismatched"],
        "likely_misreads": likely_misreads,
    }

"""Automatic subtotal checks that flag likely OCR digit misreads."""
from decimal import Decimal

from app.services.ocr_total_checks import is_single_digit_difference, page_total_check


def _table(rows):
    body = "".join(
        "<tr>" + "".join(f"<td>{cell}</td>" for cell in row) + "</tr>" for row in rows
    )
    return f"<table>{body}</table>"


# Investment property block from MBB Q3 2026 p3: a stamp over "222.813" was read as 222.313.
MISREAD_PAGE = _table([
    ["Bất động sản đầu tư", "213.258", "222.313"],
    ["Nguyên giá bất động sản đầu tư", "250.155", "255.126"],
    ["Hao mòn bất động sản đầu tư", "(36.897)", "(32.313)"],
])


def test_single_digit_difference_signature():
    for value in ("500", "1000", "-9", "70000"):
        assert is_single_digit_difference(Decimal(value)), value
    for value in ("0", "16895", "510", "1.5", "11"):
        assert not is_single_digit_difference(Decimal(value)), value


def test_flags_digit_misread_in_subtotal():
    result = page_total_check(MISREAD_PAGE)

    assert result["checked"] == 1
    assert result["mismatched"] == 1
    [flag] = result["likely_misreads"]
    assert flag["parent_label"] == "Bất động sản đầu tư"
    assert flag["parent"] == "222.313"
    assert flag["children_sum"] == "222.813"
    assert flag["difference"] == "(500)"
    assert flag["table"] == 1 and flag["parent_row"] == 1


def test_matching_totals_produce_no_flags():
    page = MISREAD_PAGE.replace("222.313", "222.813")
    result = page_total_check(page)
    assert result == {"checked": 1, "mismatched": 0, "likely_misreads": []}


def test_large_structural_mismatch_is_not_a_likely_misread():
    page = _table([
        ["Tổng tài sản", "605.278.494"],
        ["Tiền mặt", "100.000"],
        ["Cho vay", "202.188.477"],
    ])
    result = page_total_check(page)
    assert result["mismatched"] == 1
    assert result["likely_misreads"] == []


def test_page_without_tables():
    assert page_total_check("Plain text only") == {
        "checked": 0, "mismatched": 0, "likely_misreads": [],
    }

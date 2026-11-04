import pytest

from app.services.ocr_label_levels import (
    apply_label_level_suggestions,
    auto_level_markdown,
    build_label_review_evidence,
    parse_financial_number,
    verify_level_totals,
)


def test_parses_vietnamese_financial_numbers_exactly():
    assert parse_financial_number("24.251.407") == 24_251_407
    assert parse_financial_number("(11.258.455)") == -11_258_455
    assert parse_financial_number("1.234,50") == parse_financial_number("1,234.50")
    assert parse_financial_number("-") is None


def test_detects_nested_totals_above_and_below_children():
    markdown = """| Label | Value |
| --- | ---: |
| Grand total | 100 |
| Cash | 40 |
| Fixed assets | 60 |
| Tangible assets | 25 |
| Intangible assets | 35 |
| Software | 15 |
| Licences | 20 |"""

    result = auto_level_markdown(markdown)

    assert result["relationships"] == 3
    assert "<!--ocr-label-level:0;source:auto-->Grand total" in result["markdown"]
    assert "<!--ocr-label-level:1;source:auto-->Fixed assets" in result["markdown"]
    assert "<!--ocr-label-level:2;source:auto-->Intangible assets" in result["markdown"]
    assert "<!--ocr-label-level:3;source:auto-->Software" in result["markdown"]


def test_keeps_hierarchy_when_one_year_exposes_an_ocr_difference():
    markdown = """| Label | Current | Previous |
| --- | ---: | ---: |
| Fixed assets | 3.228.629 | 3.306.227 |
| Cost | 8.312.118 | 8.275.967 |
| Depreciation | (5.083.489) | (4.969.749) |"""

    result = auto_level_markdown(markdown)

    assert result["relationships"] == 1
    assert "<!--ocr-label-level:0;source:auto-->Fixed assets" in result["markdown"]
    assert "<!--ocr-label-level:1;source:auto-->Cost" in result["markdown"]
    assert "<!--ocr-label-level:1;source:auto-->Depreciation" in result["markdown"]


def test_disconnected_numeric_groups_do_not_become_grand_totals():
    markdown = """| Label | Value |
| --- | ---: |
| Cash | 5 |
| Bank deposits | 13 |
| Institutional loans | 155 |
| Loan A | 100 |
| Loan B | 55 |
| Trading securities | 3 |
| Listed securities | 3 |"""

    result = auto_level_markdown(markdown)

    assert "<!--ocr-label-level:1;source:auto-->Cash" in result["markdown"]
    assert "<!--ocr-label-level:1;source:auto-->Bank deposits" in result["markdown"]
    assert "<!--ocr-label-level:1;source:auto-->Institutional loans" in result["markdown"]
    assert "<!--ocr-label-level:2;source:auto-->Loan A" in result["markdown"]
    assert "<!--ocr-label-level:1;source:auto-->Trading securities" in result["markdown"]
    assert "<!--ocr-label-level:2;source:auto-->Listed securities" in result["markdown"]


def test_first_financial_column_controls_competing_year_relationships():
    markdown = """| Label | Note | Current | Previous |
| --- | --- | ---: | ---: |
| First line | III.1 | 10 | 30 |
| Second line | III.2 | 20 | 10 |
| Current-year total | III.3 | 30 | 20 |"""

    result = auto_level_markdown(markdown)

    assert "<!--ocr-label-level:0;source:auto-->Current-year total" in result["markdown"]
    assert "<!--ocr-label-level:1;source:auto-->First line" in result["markdown"]
    assert "<!--ocr-label-level:1;source:auto-->Second line" in result["markdown"]


def test_reverse_income_statement_subtotals_collapse_inside_out():
    values = [
        "26.127.526", "(13.603.847)", "12.523.679",
        "2.255.819", "(839.529)", "1.416.290",
        "(33.079)", "27.153", "(388.552)", "1.011.057", "-",
        "14.556.548", "(3.361.707)", "11.194.841",
        "(2.328.616)", "8.866.225", "(1.772.429)",
        "(1.772.429)", "7.093.796",
    ]
    labels = [
        "Interest income", "Interest expense", "Net interest income",
        "Service income", "Service expense", "Net service income",
        "Foreign exchange", "Trading securities", "Investment securities",
        "Other operating income", "Dividend income",
        "TỔNG THU NHẬP HOẠT ĐỘNG", "TỔNG CHI PHÍ HOẠT ĐỘNG",
        "Profit before provisions", "Provision expense",
        "TỔNG LỢI NHUẬN TRƯỚC THUẾ", "Current income tax",
        "Income tax expense", "LỢI NHUẬN SAU THUẾ",
    ]
    body = "\n".join(
        f"| {label} | {value} |"
        for label, value in zip(labels, values)
    )

    result = auto_level_markdown(
        f"| Label | Current |\n| --- | ---: |\n{body}"
    )

    assert result["relationships"] == 7
    assert "<!--ocr-label-level:2;source:auto-->Interest income" in result["markdown"]
    assert "<!--ocr-label-level:1;source:auto-->Net interest income" in result["markdown"]
    assert "<!--ocr-label-level:1;source:auto-->Net service income" in result["markdown"]
    assert "<!--ocr-label-level:0;source:auto-->TỔNG THU NHẬP HOẠT ĐỘNG" in result["markdown"]
    assert "<!--ocr-label-level:1;source:auto-->Profit before provisions" in result["markdown"]
    assert "<!--ocr-label-level:0;source:auto-->TỔNG LỢI NHUẬN TRƯỚC THUẾ" in result["markdown"]
    assert "<!--ocr-label-level:1;source:auto-->Current income tax" in result["markdown"]
    assert "<!--ocr-label-level:2;source:auto-->Income tax expense" in result["markdown"]
    assert "<!--ocr-label-level:0;source:auto-->LỢI NHUẬN SAU THUẾ" in result["markdown"]


def test_preserves_manual_level_and_recalculates_automatic_level():
    markdown = """| Label | Value |
| --- | ---: |
| <!--ocr-label-level:2-->Manual total | 100 |
| <!--ocr-label-level:3;source:auto-->Old automatic level | 40 |
| Inventory | 60 |"""

    result = auto_level_markdown(markdown)

    assert "<!--ocr-label-level:2-->Manual total" in result["markdown"]
    assert "<!--ocr-label-level:1;source:auto-->Old automatic level" in result["markdown"]


def test_levels_html_table_without_reformatting_cells():
    source = (
        '<table><tr><th>Label</th><th>Value</th></tr>'
        '<tr><td>Total</td><td>100</td></tr>'
        '<tr><td>Cash</td><td>40</td></tr>'
        '<tr><td>Stock</td><td>60</td></tr></table>'
    )

    result = auto_level_markdown(source)

    assert result["tables"] == 1
    assert result["relationships"] == 1
    assert '<td data-ocr-label-level="0" data-ocr-label-level-source="auto">Total</td>' in result["markdown"]
    assert '<td data-ocr-label-level="1" data-ocr-label-level-source="auto">Cash</td>' in result["markdown"]


def test_assigns_text_only_section_rows_to_l_above_l0():
    markdown = """| Label | Current |
| --- | ---: |
| ASSETS | |
| Grand total | 100 |
| Cash | 40 |
| Inventory | 60 |
| No activity | - |"""

    result = auto_level_markdown(markdown)

    assert "<!--ocr-label-level:L;source:auto-->ASSETS" in result["markdown"]
    assert "<!--ocr-label-level:0;source:auto-->Grand total" in result["markdown"]
    assert "<!--ocr-label-level:1;source:auto-->No activity" in result["markdown"]
    verification = verify_level_totals(result["markdown"])
    assert verification["matched"] == 1
    assert verification["mismatched"] == 0


def test_levels_text_only_html_section_as_l():
    source = (
        '<table><tr><th>Label</th><th>Value</th></tr>'
        '<tr><td>ASSETS</td><td></td></tr>'
        '<tr><td>Total</td><td>100</td></tr>'
        '<tr><td>Cash</td><td>40</td></tr>'
        '<tr><td>Stock</td><td>60</td></tr></table>'
    )

    result = auto_level_markdown(source)

    assert '<td data-ocr-label-level="L" data-ocr-label-level-source="auto">ASSETS</td>' in result["markdown"]


def test_verifies_parent_above_direct_next_level_children_in_every_year():
    markdown = """| Label | Current | Previous |
| --- | ---: | ---: |
| <!--ocr-label-level:1-->Fixed assets | 3.228.629 | 3.306.227 |
| <!--ocr-label-level:2-->Cost | 8.312.118 | 8.275.967 |
| <!--ocr-label-level:2-->Depreciation | (5.083.489) | (4.969.740) |"""

    result = verify_level_totals(markdown)

    assert result["tables"] == 1
    assert result["matched"] == 1
    assert result["mismatched"] == 0
    assert result["checks"][0]["parent_row"] == 2
    assert result["checks"][0]["child_rows"] == [3, 4]
    assert result["checks"][0]["children_position"] == "below"
    assert [column["matches"] for column in result["checks"][0]["columns"]] == [
        True,
        True,
    ]


def test_verifies_parent_below_children_and_reports_exact_difference():
    markdown = """| Label | Current |
| --- | ---: |
| <!--ocr-label-level:2-->Interest income | 26.127.526 |
| <!--ocr-label-level:2-->Interest expense | (13.603.847) |
| <!--ocr-label-level:1-->Net interest income | 12.500.000 |"""

    result = verify_level_totals(markdown)

    assert result["matched"] == 0
    assert result["mismatched"] == 1
    check = result["checks"][0]
    assert check["parent_row"] == 4
    assert check["children_position"] == "above"
    assert check["columns"][0] == {
        "column": 2,
        "column_label": "Current",
        "parent": "12.500.000",
        "children_sum": "12.523.679",
        "difference": "(23.679)",
        "matches": False,
    }


def test_verifies_html_level_attributes():
    source = (
        '<table><tr><th>Label</th><th>Value</th></tr>'
        '<tr><td data-ocr-label-level="1">Net</td><td>100</td></tr>'
        '<tr><td data-ocr-label-level="2">Income</td><td>140</td></tr>'
        '<tr><td data-ocr-label-level="2">Expense</td><td>(40)</td></tr></table>'
    )

    result = verify_level_totals(source)

    assert result["matched"] == 1
    assert result["mismatched"] == 0
    assert result["checks"][0]["parent_label"] == "Net"


def test_does_not_report_ambiguous_rolling_total_as_a_mismatch():
    markdown = """| Label | Current |
| --- | ---: |
| <!--ocr-label-level:0-->Profit before tax | 8.866.225 |
| <!--ocr-label-level:1-->Income tax | (1.772.429) |
| <!--ocr-label-level:0-->Profit after tax | 7.093.796 |"""

    result = verify_level_totals(markdown)

    assert result["matched"] == 0
    assert result["mismatched"] == 0
    assert result["unverifiable"] == [{
        "table": 1,
        "child_level": 1,
        "child_rows": [3],
        "possible_parent_rows": [2, 4],
        "reason": "children_between_possible_parents",
    }]


def test_builds_bounded_hermes_evidence_without_changing_markdown():
    markdown = """| Label | Current |
| --- | ---: |
| TOTAL ASSETS | 100 |
| Cash | 40 |
| Inventory | 60 |"""

    evidence = build_label_review_evidence(markdown)

    assert evidence["relationships"] == 1
    assert evidence["verification"]["matched"] == 1
    assert [
        (row["row"], row["suggested_level"])
        for row in evidence["candidates"]
    ] == [(2, 0), (3, 1), (4, 1)]
    assert "ocr-label-level" not in markdown


def test_applies_label_suggestions_and_rejects_l_on_financial_row():
    markdown = """| Label | Current |
| --- | ---: |
| ASSETS | |
| TOTAL ASSETS | 100 |
| Cash | 100 |"""

    corrected = apply_label_level_suggestions(markdown, [
        {"table": 1, "row": 2, "level": -1},
        {"table": 1, "row": 3, "level": 0},
    ])

    assert "<!--ocr-label-level:L-->ASSETS" in corrected
    assert "<!--ocr-label-level:0-->TOTAL ASSETS" in corrected
    with pytest.raises(ValueError, match="contains a financial value"):
        apply_label_level_suggestions(markdown, [
            {"table": 1, "row": 3, "level": -1},
        ])

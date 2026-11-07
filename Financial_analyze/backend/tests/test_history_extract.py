from datetime import date
from pathlib import Path

from app.services.history_extract import cell_value, extract_tables, is_amount_row
from app.services.history_periods import Period

FIXTURES = Path(__file__).parent / "fixtures" / "history"


def _fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _row(table, label):
    return next(row for row in table.rows if row.label == label)


def test_balance_sheet_page_columns():
    markdown = _fixture("mbb_q3_2026_p03.md")
    tables = extract_tables(3, markdown, None)
    assert len(tables) == 1
    table = tables[0]
    assert table.page == 3 and table.table == 1
    # The OCR heading reads "Dear CÁO TÍNH HIHN TÀI CHÍNH HỢP NHẤT": no kind is
    # guessed from the garbled text; the owner confirms it in the wizard.
    assert table.kind is None
    assert [c.period for c in table.columns] == [
        Period("instant", None, date(2026, 9, 30)),
        Period("instant", None, date(2025, 12, 31)),
    ]
    assert all("Thuyết minh" not in c.header for c in table.columns)
    assert table.unit_multiplier == 1_000_000

    parent = _row(table, "Bắt động sản đầu tư")
    assert parent.parent_label in (None, "TÀI SAN")
    assert parent.cells == ["213.258", "222.313"]
    assert parent.is_amount
    for label in ("Nguyên giá bất động sản đầu tư", "Hao món bất động sản đầu tư"):
        assert _row(table, label).parent_label == "Bắt động sản đầu tư"


def test_balance_sheet_kind_from_clean_heading():
    markdown = _fixture("mbb_q3_2026_p03.md").replace(
        "Dear CÁO TÍNH HIHN TÀI CHÍNH", "BÁO CÁO TÌNH HÌNH TÀI CHÍNH"
    )
    assert extract_tables(3, markdown, None)[0].kind == "balance"


def test_cash_flow_page_multi_row_header():
    tables = extract_tables(7, _fixture("mbb_q3_2026_p07.md"), None)
    assert len(tables) == 1
    table = tables[0]
    assert table.kind == "cashflow"
    assert table.unit_multiplier == 1_000_000
    assert [c.period for c in table.columns] == [
        Period("ytd", date(2026, 1, 1), date(2026, 9, 30)),
        Period("ytd", date(2025, 1, 1), date(2025, 9, 30)),
    ]
    # Header rows are not data rows; the first data row is the section label.
    assert table.rows[0].label == "LUU CHUYẾN TIỀN TỪ HOẠT ĐỒNG KINH DOANH"
    assert _row(table, "Thu lãi và các khoản thu tương tự nhận được").cells == [
        "94.508.911", "60.560.839",
    ]


def test_income_page_colspan_header():
    tables = extract_tables(6, _fixture("mbb_q3_2026_p06.md"), "cashflow")
    table = tables[0]
    assert table.kind == "income"
    assert len(table.columns) == 4
    assert table.columns[0].header == "Số phát sinh quý III Năm nay triệu đồng"
    assert table.columns[3].header == "LUY KẾ TỪ DAU NAIL ĐEN CUOI QUY Năm trước triệu đồng"
    # No year in the column headers: periods are left for the owner.
    assert all(c.period is None for c in table.columns)
    assert table.unit_multiplier == 1_000_000
    assert _row(table, "LOI NHUAN SAU THUÉ").cells == [
        "8.251.873", "5.800.441", "24.400.066", "18.480.026",
    ]
    # Parents come from the verified hierarchy, also when they sit below.
    parents = {r.row: r.parent_label for r in table.rows}
    assert parents[4] == parents[5] == "Thu nhập lãi thuần"
    assert parents[7] == parents[8] == "Lãi thuần từ hoạt động dịch vụ"
    assert parents[20] == parents[21] == "Chi phí thuế TNDN trong kỳ"


def test_dash_is_zero_blank_is_none():
    assert cell_value("-", 10**6) == 0
    assert cell_value("", 10**6) is None
    assert cell_value("(352.741)", 10**6) == -352_741_000_000
    assert cell_value("1.234,5", 1) is None
    assert cell_value("1.234,5", 1_000) == 1_234_500
    assert cell_value("n/a", 10**6) is None


def test_non_amount_rows_skipped():
    for label in (
        "Lãi cơ bản trên cổ phiếu",
        "EPS",
        "Tỷ lệ an toàn vốn (%)",
        "Số lượng cổ phiếu",
    ):
        assert not is_amount_row(label), label
    assert is_amount_row("Cho vay khách hàng")
    assert is_amount_row("Cổ phiếu quỹ")


def test_continued_table_inherits_kind():
    markdown = (
        "Ngân hàng X\n\n(tiếp theo)\n\n"
        "| Chỉ tiêu | 30/09/2026 |\n|---|---|\n| Cho vay khách hàng | 1.000 |\n"
    )
    assert extract_tables(4, markdown, "balance")[0].kind == "balance"
    assert extract_tables(4, markdown.replace("(tiếp theo)", ""), "balance")[0].kind is None


def test_ma_so_column_detected():
    markdown = (
        "Đơn vị tính: đồng\n\n"
        "| Chỉ tiêu | Mã số | 31/12/2025 |\n"
        "|---|---|---|\n"
        "| TỔNG CỘNG TÀI SẢN | 270 | 1.234.567 |\n"
    )
    table = extract_tables(1, markdown, None)[0]
    assert [c.header for c in table.columns] == ["31/12/2025"]
    assert table.columns[0].period == Period("instant", None, date(2025, 12, 31))
    assert table.rows[0].code == "270"
    assert table.rows[0].cells == ["1.234.567"]
    assert table.unit_multiplier == 1


def test_unit_missing_is_none():
    markdown = "| Chỉ tiêu | 31/12/2025 |\n|---|---|\n| Tiền | 1.000 |\n"
    assert extract_tables(1, markdown, None)[0].unit_multiplier is None


def test_explicit_level_metadata_sets_parent():
    markdown = (
        "<table><tr><td></td><td>31/12/2025</td></tr>"
        '<tr><td data-ocr-label-level="1">A</td><td>10</td></tr>'
        '<tr><td data-ocr-label-level="1">B</td><td>7</td></tr>'
        '<tr><td data-ocr-label-level="2">C</td><td>3</td></tr></table>'
    )
    rows = extract_tables(1, markdown, None)[0].rows
    assert [(r.row, r.label, r.parent_label) for r in rows] == [
        (2, "A", None), (3, "B", None), (4, "C", "B"),
    ]


def test_income_page_relative_periods_with_fiscal_year():
    table = extract_tables(6, _fixture("mbb_q3_2026_p06.md"), None, fiscal_year=2026)[0]
    assert [c.period for c in table.columns] == [
        Period("quarter", date(2026, 7, 1), date(2026, 9, 30)),
        Period("quarter", date(2025, 7, 1), date(2025, 9, 30)),
        # "LUY KẾ ... CUOI QUY" names no quarter: left for the owner.
        None,
        None,
    ]
    assert [c.period_source for c in table.columns] == ["relative", "relative", None, None]
    p03 = extract_tables(3, _fixture("mbb_q3_2026_p03.md"), None, fiscal_year=2026)[0]
    assert [c.period_source for c in p03.columns] == ["header", "header"]


def test_bare_year_header_row_is_header():
    markdown = (
        "<table><tr><td>Chỉ tiêu</td><td>2025</td><td>Năm 2024</td></tr>"
        "<tr><td>Tiền</td><td>1.000</td><td>900</td></tr></table>"
    )
    table = extract_tables(1, markdown, None)[0]
    assert [c.header for c in table.columns] == ["2025", "Năm 2024"]
    assert [(r.label, r.cells) for r in table.rows] == [("Tiền", ["1.000", "900"])]


def test_page_prose_unit_without_cue_is_ignored():
    table = "| Chỉ tiêu | 31/12/2025 |\n|---|---|\n| Tiền | 1.000 |\n"
    prose = "Vốn điều lệ của Ngân hàng là 50.000 tỷ đồng\n\n"
    assert extract_tables(1, prose + table, None)[0].unit_multiplier is None
    cue = "Đơn vị tính: triệu đồng\n\n"
    assert extract_tables(1, prose + cue + table, None)[0].unit_multiplier == 1_000_000


# --- final review I2 / M2 / C1 ---


def test_cell_value_rejects_merged_numbers_and_overflow():
    assert cell_value("37.792.619 22.265.897", 10**6) is None
    assert cell_value("1 234", 1) is None
    assert cell_value("( 1.234 )", 1) == -1234  # spaces inside brackets are fine
    assert cell_value("9.223.372.036.854.775.808", 1) is None  # 2**63 does not fit BIGINT
    assert cell_value("9.223.372.036.854.775.807", 1) == 2**63 - 1
    assert cell_value("9.300.000", 10**12) is None  # scaled past 2**63


def test_page_unit_cue_must_name_a_unit_right_after_it():
    table = "| Chỉ tiêu | 31/12/2025 |\n|---|---|\n| Tiền | 1.000 |\n"
    auditor = "Đơn vị kiểm toán: Công ty TNHH Kiểm toán X, vốn điều lệ 50 tỷ đồng\n\n"
    assert extract_tables(1, auditor + table, None)[0].unit_multiplier is None
    cue = "Đơn vị tính: triệu đồng\n\n"
    assert extract_tables(1, auditor + cue + table, None)[0].unit_multiplier == 1_000_000


def test_cumulative_quarter_header_is_a_relative_ytd_not_a_header_quarter():
    markdown = (
        "| Chỉ tiêu | Quý 3 năm 2026 | Lũy kế từ đầu năm đến cuối quý 3 năm 2026 |\n"
        "|---|---|---|\n| Doanh thu | 100 | 300 |\n"
    )
    [table] = extract_tables(1, markdown, None, 2026)
    quarter, cumulative = table.columns
    assert (quarter.period.type, quarter.period_source) == ("quarter", "header")
    assert cumulative.period == Period("ytd", date(2026, 1, 1), date(2026, 9, 30))
    assert cumulative.period_source == "relative"

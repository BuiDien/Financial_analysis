from datetime import date

import pytest

from app.services.history_periods import (
    Period,
    columns_cover_label,
    detect_statement_kind,
    label_period,
    parse_column_period,
    parse_relative_period,
    parse_unit_multiplier,
)


def test_instant_periods():
    assert parse_column_period("30/09/2026") == Period("instant", None, date(2026, 9, 30))
    assert parse_column_period("Tại ngày 31/12/2025") == Period("instant", None, date(2025, 12, 31))


def test_range_periods():
    q3 = Period("quarter", date(2026, 7, 1), date(2026, 9, 30))
    assert parse_column_period("Giai đoạn từ 01/07/2026 đến 30/09/2026") == q3
    assert parse_column_period("Giai đoạn từ 01/01/2026 đến 30/09/2026") == Period(
        "ytd", date(2026, 1, 1), date(2026, 9, 30)
    )
    assert parse_column_period("từ 01/01/2025 đến 31/12/2025") == Period(
        "year", date(2025, 1, 1), date(2025, 12, 31)
    )
    assert parse_column_period("Quý 3 năm 2026") == q3


@pytest.mark.parametrize("text", ["Thuyết minh", "Mã số", "Số cuối kỳ", ""])
def test_non_period_headers(text):
    assert parse_column_period(text) is None


def test_period_hashable():
    assert len({Period("instant", None, date(2026, 9, 30)), Period("instant", None, date(2026, 9, 30))}) == 1


@pytest.mark.parametrize(
    "text,expected",
    [
        ("triệu đồng", 1_000_000),
        ("Đơn vị: triệu VND", 1_000_000),
        ("đồng", 1),
        ("nghìn đồng", 1_000),
        ("tỷ đồng", 1_000_000_000),
        ("VND", 1),
        ("Công ty cổ phần X - Đơn vị: triệu đồng", 1_000_000),
        ("Đơn vị tính: triệu", 1_000_000),
        ("triệu đồng và nghìn đồng", None),
        ("Công ty cổ phần X", None),
        ("Ngân hàng TMCP Đông Á", None),
        ("Công ty cổ phần Đồng Tâm", None),
        ("Công ty cổ phần Đồng Tâm - Đơn vị: triệu đồng", 1_000_000),
        ("Đơn vị tính: nghìn đồng, tỷ", None),
        ("Đơn vị: VND", 1),
        ("Đơn vị tính: đồng, triệu", None),
        ("Đơn vị tính: VND, triệu", None),
        ("Đơn vị tính: triệu đồng", 1_000_000),
        ("Đơn vị: triệu VND", 1_000_000),
        ("blah", None),
        ("", None),
    ],
)
def test_units(text, expected):
    assert parse_unit_multiplier(text) == expected


@pytest.mark.parametrize(
    "text,expected",
    [
        ("BÁO CÁO TÌNH HÌNH TÀI CHÍNH HỢP NHẤT", "balance"),
        ("BẢNG CÂN ĐỐI KẾ TOÁN", "balance"),
        ("BAO CAO TINH HINH TAI CHINH", "balance"),
        ("BÁO CÁO KẾT QUẢ HOẠT ĐỘNG KINH DOANH", "income"),
        ("BÁO CÁO KẾT QUẢ HOẠT ĐỘNG HỢP NHẤT", "income"),
        ("BÁO CÁO LƯU CHUYỂN TIỀN TỆ", "cashflow"),
        ("LUU CHUYEN TIEN TE", "cashflow"),
        ("BÁO CÁO LUỦ CHUYỂN TIÊN TỆ", "cashflow"),
        ("Thuyết minh", None),
    ],
)
def test_kinds(text, expected):
    assert detect_statement_kind(text) == expected


def test_label_period():
    assert label_period(2026, "Q3") == (date(2026, 7, 1), date(2026, 9, 30))
    assert label_period(2026, "H1") == (date(2026, 1, 1), date(2026, 6, 30))
    assert label_period(2026, "FY") == (date(2026, 1, 1), date(2026, 12, 31))
    with pytest.raises(ValueError):
        label_period(2026, "X")


def test_columns_cover_label():
    cols = [Period("instant", None, date(2026, 9, 30)), Period("instant", None, date(2025, 12, 31))]
    assert columns_cover_label(cols, 2026, "Q3") is True
    assert columns_cover_label([Period("instant", None, date(2025, 12, 31))], 2026, "Q3") is False


@pytest.mark.parametrize(
    "header,expected",
    [
        # Actual MBB Q3/2026 p06 header strings.
        ("Số phát sinh quý III Năm nay triệu đồng",
         Period("quarter", date(2026, 7, 1), date(2026, 9, 30))),
        ("Số phát sinh quý III Năm trước triệu đồng",
         Period("quarter", date(2025, 7, 1), date(2025, 9, 30))),
        # OCR dropped the quarter number: no quarter named, so no period.
        ("LUY KẾ TỪ DAU NAIL ĐEN CUOI QUY Năm nay triệu đồng", None),
        ("LUY KẾ TỪ DAU NAIL ĐEN CUOI QUY Năm trước triệu đồng", None),
        ("Quý 1 Năm nay", Period("quarter", date(2026, 1, 1), date(2026, 3, 31))),
        ("quý IV năm trước", Period("quarter", date(2025, 10, 1), date(2025, 12, 31))),
        ("Lũy kế từ đầu năm đến cuối quý III Năm nay",
         Period("ytd", date(2026, 1, 1), date(2026, 9, 30))),
        ("Lũy kế từ đầu năm đến cuối quý 2 Năm trước",
         Period("ytd", date(2025, 1, 1), date(2025, 6, 30))),
        ("Lũy kế từ đầu năm đến cuối quý này Năm nay", None),
        ("Lũy kế từ đầu năm đến cuối quý IV Năm trước",
         Period("year", date(2025, 1, 1), date(2025, 12, 31))),
        ("Quý III", None),
        ("Năm nay", None),
        ("Quý V Năm nay", None),
        ("Quý III Năm nay Năm trước", None),
        ("Thuyết minh", None),
    ],
)
def test_relative_periods(header, expected):
    assert parse_relative_period(header, 2026) == expected


# --- final review C1(a): cumulative / flow headers are never quarters or instants ---


@pytest.mark.parametrize(
    "text",
    [
        "Lũy kế từ đầu năm đến cuối quý 3 năm 2026",
        "Lũy kế đến quý 3/2026",
        "Số cuối quý 3 năm 2026",
        "Từ đầu năm đến quý 3 năm 2026",
    ],
)
def test_cumulative_or_closing_quarter_header_is_not_a_quarter(text):
    period = parse_column_period(text)
    assert period is None or period.type != "quarter"


@pytest.mark.parametrize(
    "text",
    [
        "Cho kỳ kế toán chín tháng kết thúc ngày 30/09/2026",
        "Năm tài chính kết thúc ngày 31/12/2025",
        "Giai đoạn đến 30/09/2026",
        "Sáu tháng kết thúc 30/06/2026",
        "Ba tháng đến 30/09/2026",
        "Lũy kế đến 30/09/2026",
    ],
)
def test_flow_header_with_one_date_is_not_an_instant(text):
    assert parse_column_period(text) is None


def test_cumulative_header_with_explicit_jan1_range_is_ytd():
    assert parse_column_period("Lũy kế từ 01/01/2026 đến 30/09/2026") == Period(
        "ytd", date(2026, 1, 1), date(2026, 9, 30)
    )
    # Jan 1 → Mar 31 printed as cumulative is year-to-date, never a quarter.
    assert parse_column_period("Lũy kế từ 01/01/2026 đến 31/03/2026") == Period(
        "ytd", date(2026, 1, 1), date(2026, 3, 31)
    )
    # A cumulative range that does not start on Jan 1 is not interpreted.
    assert parse_column_period("Lũy kế từ 01/07/2026 đến 30/09/2026") is None


def test_more_than_two_dates_is_not_interpreted():
    assert parse_column_period("01/01/2026 30/06/2026 30/09/2026") is None


def test_cumulative_quarter_with_year_is_a_relative_ytd_proposal():
    assert parse_relative_period("Lũy kế từ đầu năm đến cuối quý 3 năm 2026", 2026) == Period(
        "ytd", date(2026, 1, 1), date(2026, 9, 30)
    )
    assert parse_relative_period("Lũy kế đến quý 3/2026", 2026) == Period(
        "ytd", date(2026, 1, 1), date(2026, 9, 30)
    )


# --- final review M2: page-text unit cue ---


def test_unit_cue_uses_only_the_tokens_right_after_the_cue():
    from app.services.history_periods import parse_unit_cue

    assert parse_unit_cue("Đơn vị kiểm toán: Công ty X, vốn điều lệ 50 tỷ đồng") is None
    assert parse_unit_cue("Đơn vị tính: triệu đồng") == 1_000_000
    assert parse_unit_cue("Công ty X - Đơn vị: triệu VND   Mẫu B02") == 1_000_000
    assert parse_unit_cue("Đơn vị: VND") == 1
    assert parse_unit_cue("Đơn vị tính: nghìn đồng, tỷ") is None
    assert parse_unit_cue("vốn điều lệ 50 tỷ đồng") is None

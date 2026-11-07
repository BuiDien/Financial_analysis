"""history_store: the ORM bridge between verified OCR pages and statement facts."""

from datetime import date

import pytest

from app.models.ocr import (
    FactResolution, OCRAttempt, OCRInboxItem, OCRPageResult, OCRReviewJob, StatementFact,
)
from app.ocr_page_contract import OCR_PAGE_RESULT_FORMAT
from app.services import history_store
from app.services.history_facts import point_states
from app.services.history_lines import LineCatalog

INCOME = """# BÁO CÁO KẾT QUẢ HOẠT ĐỘNG HỢP NHẤT

Đơn vị tính: triệu đồng

<table><tr><td>Chỉ tiêu</td><td>Từ 01/01/2025 đến 31/12/2025</td><td>Từ 01/01/2025 đến 30/09/2025</td>{q4_head}</tr>
<tr><td>Thu nhập lãi thuần</td><td>1.000</td><td>700</td>{q4_cell}</tr></table>
"""


def make_review(db, markdown, *, period_code="FY", fiscal_year=2025, status="verified", n=0):
    item = OCRInboxItem(
        filename=f"fy{n}.pdf", storage_path=f"/tmp/history-store-{n}.pdf", size_bytes=1,
        checksum_sha256=str(n) * 64, ticker="MBB", scope="consolidated",
        fiscal_year=fiscal_year, period_code=period_code, unit="million",
    )
    attempt = OCRAttempt(inbox_item=item, status="completed", result_format=OCR_PAGE_RESULT_FORMAT)
    attempt.pages.append(OCRPageResult(
        page_number=1, raw_markdown=markdown, review_status="approved",
        content_sha256="0" * 64, byte_size=len(markdown.encode()),
    ))
    review = OCRReviewJob(
        inbox_item=item, attempt=attempt, status=status, revision=3,
        result_format=OCR_PAGE_RESULT_FORMAT,
    )
    db.add_all([item, attempt, review])
    db.commit()
    return item, review


@pytest.fixture
def catalog(tmp_path):
    return LineCatalog(tmp_path / "vault", "Lines")


def _facts(db):
    return [
        {
            "id": f.id, "line_key": f.line_key, "period_type": f.period_type,
            "period_start": f.period_start, "period_end": f.period_end, "value": f.value,
            "origin": f.origin, "status": f.status, "inbox_item_id": f.inbox_item_id,
        }
        for f in db.query(StatementFact).all()
    ]


ANSWER = {"lines": [{"page": 1, "table": 1, "row": 2, "new_line_name": "Thu nhập lãi thuần"}]}


def test_write_derives_missing_quarter(db, catalog):
    _item, review = make_review(db, INCOME.format(q4_head="", q4_cell=""))
    result = history_store.history_write(db, review, ANSWER, catalog=catalog)
    assert result == {"written": 2, "superseded": 0, "conflicts_open": 0}

    [calculated] = db.query(StatementFact).filter_by(origin="calculated").all()
    assert calculated.period_type == "quarter"
    assert (calculated.period_start, calculated.period_end) == (date(2025, 10, 1), date(2025, 12, 31))
    assert calculated.value == 300 * 1_000_000
    printed_ids = {f.id for f in db.query(StatementFact).filter_by(origin="printed")}
    assert set(calculated.inputs) == printed_ids

    # Re-writing keeps one calculated fact for the key (old printed superseded).
    history_store.history_write(db, review, {}, catalog=catalog)
    active_calculated = db.query(StatementFact).filter_by(origin="calculated", status="active").all()
    assert len(active_calculated) == 1
    assert set(active_calculated[0].inputs) == {
        f.id for f in db.query(StatementFact).filter_by(origin="printed", status="active")
    }


def test_derived_value_disagreeing_with_printed_is_a_conflict(db, catalog):
    markdown = INCOME.format(
        q4_head="<td>Từ 01/10/2025 đến 31/12/2025</td>", q4_cell="<td>250</td>",
    )
    _item, review = make_review(db, markdown)
    result = history_store.history_write(db, review, ANSWER, catalog=catalog)
    assert result["written"] == 3 and result["conflicts_open"] == 1
    states = point_states(_facts(db), {})
    q4 = [s for s in states.values() if "|quarter|2025-10-01|" in s.fact_key]
    assert [s.status for s in q4] == ["conflict"]


def test_remove_supersedes_and_drops_derived(db, catalog):
    item, review = make_review(db, INCOME.format(q4_head="", q4_cell=""))
    history_store.history_write(db, review, ANSWER, catalog=catalog)
    assert history_store.history_remove(db, item) == 3
    assert db.query(StatementFact).filter_by(status="active").count() == 0


def test_write_refuses_blocked_preview(db, catalog):
    _item, review = make_review(db, INCOME.format(q4_head="", q4_cell=""), status="reviewing")
    with pytest.raises(history_store.HistoryBlocked) as raised:
        history_store.history_write(db, review, ANSWER, catalog=catalog)
    assert [p["code"] for p in raised.value.blocking] == ["review_not_verified"]
    assert db.query(StatementFact).count() == 0


def test_labels_missing_blocks(db, catalog):
    _item, review = make_review(db, INCOME.format(q4_head="", q4_cell=""), period_code=None)
    result = history_store.history_preview(db, review, {}, catalog=catalog)
    assert [p["code"] for p in result["blocking"]] == ["labels_missing"]


def test_unknown_kind_period_and_unit_block(db, catalog):
    markdown = (
        "<table><tr><td>Chỉ tiêu</td><td>Cột A</td></tr>"
        "<tr><td>Tiền</td><td>100</td></tr></table>"
    )
    _item, review = make_review(db, markdown)
    result = history_store.history_preview(db, review, {}, catalog=catalog)
    assert [p["code"] for p in result["blocking"]] == ["table_kind_unknown"]

    answers = {"tables": [{"page": 1, "table": 1, "kind": "balance"}]}
    result = history_store.history_preview(db, review, answers, catalog=catalog)
    assert sorted(p["code"] for p in result["blocking"]) == [
        "column_period_unknown", "line_unanswered", "unit_unknown",
    ]

    answers = {
        "tables": [{
            "page": 1, "table": 1, "kind": "balance", "unit_multiplier": 1_000_000,
            "columns": [{"column": 1, "period_type": "instant", "period_end": "2025-12-31"}],
        }],
        "lines": [{"page": 1, "table": 1, "row": 2, "new_line_name": "Tiền"}],
    }
    assert history_store.history_preview(db, review, answers, catalog=catalog)["blocking"] == []
    history_store.history_write(db, review, answers, catalog=catalog)
    [fact] = db.query(StatementFact).all()
    assert fact.value == 100_000_000 and fact.period_end == date(2025, 12, 31)


def test_incoming_resolution_answer_is_stored(db, catalog):
    _a, review_a = make_review(db, INCOME.format(q4_head="", q4_cell=""), n=1)
    history_store.history_write(db, review_a, ANSWER, catalog=catalog)
    _b, review_b = make_review(db, INCOME.format(q4_head="", q4_cell="").replace("1.000", "1.100"), n=2)
    preview = history_store.history_preview(db, review_b, {}, catalog=catalog)
    year_conflict = next(c for c in preview["conflicts"] if "|year|" in c["fact_key"])
    result = history_store.history_write(
        db, review_b,
        {"resolutions": [{"fact_key": year_conflict["fact_key"], "chosen": "incoming"}]},
        catalog=catalog,
    )
    [resolution] = db.query(FactResolution).all()
    chosen = db.get(StatementFact, resolution.chosen_fact_id)
    assert chosen.inbox_item_id == _b.id and resolution.chosen_value == 1_100_000_000
    # The year point is resolved, and Q4 is recalculated from the chosen year value.
    assert result["conflicts_open"] == 0
    [q4] = db.query(StatementFact).filter_by(origin="calculated", status="active").all()
    assert q4.value == 400 * 1_000_000 and resolution.chosen_fact_id in q4.inputs


# --- final review fixes --------------------------------------------------------

from app.models.ocr import OCRAuditEvent  # noqa: E402


def _codes(result):
    return [p["code"] for p in result["blocking"]]


def _table(kind_heading, head, cells):
    return (
        f"# {kind_heading}\n\nĐơn vị tính: triệu đồng\n\n"
        f"<table><tr><td>Chỉ tiêu</td>{''.join(f'<td>{h}</td>' for h in head)}</tr>"
        f"<tr><td>Thu nhập lãi thuần</td>{''.join(f'<td>{c}</td>' for c in cells)}</tr></table>\n"
    )


def test_balance_table_with_flow_period_is_a_kind_mismatch(db, catalog):
    markdown = _table(
        "BÁO CÁO TÌNH HÌNH TÀI CHÍNH", ["31/12/2025", "Từ 01/01/2025 đến 31/12/2025"], ["5", "6"],
    )
    _item, review = make_review(db, markdown)
    result = history_store.history_preview(db, review, ANSWER, catalog=catalog)
    [mismatch] = [p for p in result["blocking"] if p["code"] == "period_kind_mismatch"]
    assert mismatch["column"] == 2 and mismatch["table"] == 1


def test_income_table_with_instant_period_is_a_kind_mismatch(db, catalog):
    markdown = _table("BÁO CÁO KẾT QUẢ HOẠT ĐỘNG", ["Từ 01/01/2025 đến 31/12/2025", "31/12/2025"], ["5", "6"])
    _item, review = make_review(db, markdown)
    assert "period_kind_mismatch" in _codes(history_store.history_preview(db, review, ANSWER, catalog=catalog))
    # An answered period is checked too.
    answers = ANSWER | {"tables": [{"page": 1, "table": 1, "columns": [
        {"column": 2, "period_type": "instant", "period_end": "2025-12-31"},
    ]}]}
    assert "period_kind_mismatch" in _codes(history_store.history_preview(db, review, answers, catalog=catalog))
    answers = ANSWER | {"tables": [{"page": 1, "table": 1, "columns": [{"column": 2, "skip": True}]}]}
    assert _codes(history_store.history_preview(db, review, answers, catalog=catalog)) == []


def test_two_values_for_one_key_in_one_document_block(db, catalog):
    year = "Từ 01/01/2025 đến 31/12/2025"
    markdown = _table("BÁO CÁO KẾT QUẢ HOẠT ĐỘNG", [year, year], ["1.000", "1.100"])
    _item, review = make_review(db, markdown)
    result = history_store.history_preview(db, review, ANSWER, catalog=catalog)
    [dup] = [p for p in result["blocking"] if p["code"] == "duplicate_in_document"]
    assert "column 1" in dup["message"] and "column 2" in dup["message"]
    assert "1.000" in dup["message"] and "1.100" in dup["message"]
    with pytest.raises(history_store.HistoryBlocked):
        history_store.history_write(db, review, ANSWER, catalog=catalog)
    # Skipping one column resolves it.
    answers = ANSWER | {"tables": [{"page": 1, "table": 1, "columns": [{"column": 2, "skip": True}]}]}
    assert _codes(history_store.history_preview(db, review, answers, catalog=catalog)) == []


def test_equal_values_for_one_key_in_one_document_store_one_fact(db, catalog):
    year = "Từ 01/01/2025 đến 31/12/2025"
    markdown = _table("BÁO CÁO KẾT QUẢ HOẠT ĐỘNG", [year, year], ["1.000", "1.000"])
    item, review = make_review(db, markdown)
    assert _codes(history_store.history_preview(db, review, ANSWER, catalog=catalog)) == []
    result = history_store.history_write(db, review, ANSWER, catalog=catalog)
    assert result["written"] == 1
    [fact] = db.query(StatementFact).filter_by(status="active").all()
    assert fact.column_number == 1  # the first location is kept
    [state] = point_states(_facts(db), {}).values()
    assert state.status == "single"


def test_same_existing_line_twice_in_one_document_with_different_values_blocks(db, catalog):
    item, review = make_review(db, INCOME.format(q4_head="", q4_cell=""), n=1)
    history_store.history_write(db, review, ANSWER, catalog=catalog)
    key = db.query(StatementFact).first().line_key
    markdown = (
        "# BÁO CÁO KẾT QUẢ HOẠT ĐỘNG\n\nĐơn vị tính: triệu đồng\n\n"
        "<table><tr><td>Chỉ tiêu</td><td>Từ 01/01/2025 đến 31/12/2025</td></tr>"
        "<tr><td>Thu nhập lãi thuần</td><td>1.000</td></tr>"
        "<tr><td>Lãi thuần khác</td><td>1.200</td></tr></table>\n"
    )
    _b, review_b = make_review(db, markdown, n=2)
    answers = {"lines": [{"page": 1, "table": 1, "row": 3, "line_key": key}]}
    result = history_store.history_preview(db, review_b, answers, catalog=catalog)
    [dup] = [p for p in result["blocking"] if p["code"] == "duplicate_in_document"]
    assert "row 2" in dup["message"] and "row 3" in dup["message"]
    # The conflict payload's incoming stays single.
    for conflict in result["conflicts"]:
        assert isinstance(conflict["incoming"], dict)


RELATIVE_INCOME = (
    "# BÁO CÁO KẾT QUẢ HOẠT ĐỘNG\n\nĐơn vị tính: triệu đồng\n\n"
    "<table><tr><td>Chỉ tiêu</td><td>Quý III Năm nay</td><td>Quý III Năm trước</td></tr>"
    "<tr><td>Thu nhập lãi thuần</td><td>100</td><td>90</td></tr></table>\n"
)


def test_relative_columns_alone_do_not_confirm_the_fiscal_year(db, catalog):
    _item, review = make_review(db, RELATIVE_INCOME, period_code="Q3", fiscal_year=2026)
    result = history_store.history_preview(db, review, ANSWER, catalog=catalog)
    [mismatch] = [p for p in result["blocking"] if p["code"] == "period_mismatch"]
    assert mismatch["message"] == "Confirm the fiscal year: no dated column ends at 2026-09-30"
    answers = ANSWER | {"tables": [{"page": 1, "table": 1, "columns": [
        {"column": 1, "period_type": "quarter", "period_start": "2026-07-01", "period_end": "2026-09-30"},
    ]}]}
    assert _codes(history_store.history_preview(db, review, answers, catalog=catalog)) == []


def test_relative_table_is_confirmed_by_a_dated_column_elsewhere_in_the_document(db, catalog):
    balance = (
        "# BÁO CÁO TÌNH HÌNH TÀI CHÍNH\n\nĐơn vị tính: triệu đồng\n\n"
        "<table><tr><td>Chỉ tiêu</td><td>30/09/2026</td></tr>"
        "<tr><td>Tiền mặt</td><td>5</td></tr></table>\n\n"
    )
    _item, review = make_review(db, balance + RELATIVE_INCOME, period_code="Q3", fiscal_year=2026)
    # One page holds both tables here, so the page heading proposes "balance"
    # for both (and the quarter columns are flagged); the owner sets the kind.
    proposed = history_store.history_preview(db, review, {}, catalog=catalog)
    assert "period_kind_mismatch" in _codes(proposed)
    answers = {"tables": [{"page": 1, "table": 2, "kind": "income"}], "lines": [
        {"page": 1, "table": 1, "row": 2, "new_line_name": "Tiền mặt"},
        {"page": 1, "table": 2, "row": 2, "new_line_name": "Thu nhập lãi thuần"},
    ]}
    result = history_store.history_preview(db, review, answers, catalog=catalog)
    assert _codes(result) == [], result["blocking"]


def test_unreadable_cells_are_listed_per_row(db, catalog):
    markdown = INCOME.format(q4_head="", q4_cell="").replace(
        "<td>700</td>", "<td>37.792.619 22.265.897</td>",
    )
    _item, review = make_review(db, markdown)
    result = history_store.history_preview(db, review, ANSWER, catalog=catalog)
    [row] = result["tables"][0]["rows"]
    assert row["unreadable_cells"] == [2]
    assert _codes(result) == []  # a note, not a blocker


def test_remove_writes_an_audit_event(db, catalog):
    item, review = make_review(db, INCOME.format(q4_head="", q4_cell=""))
    history_store.history_write(db, review, ANSWER, catalog=catalog)
    history_store.history_remove(db, item)
    actions = [e.action for e in db.query(OCRAuditEvent).order_by(OCRAuditEvent.id)]
    assert actions == ["history_written", "history_removed"]
    removed = db.query(OCRAuditEvent).filter_by(action="history_removed").one()
    assert removed.after_data == {"superseded": 3} and removed.review_id == review.id

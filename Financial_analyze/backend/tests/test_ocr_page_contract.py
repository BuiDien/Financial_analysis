import pytest

from app.ocr_page_contract import (
    OCRPageContractError, validate_page_message, validate_result_end,
)


def test_page_message_accepts_unicode_markdown_without_financial_fields():
    result = validate_page_message(
        {
            "type": "page_result",
            "jobId": "job_test",
            "schemaVersion": 2,
            "page": 1,
            "pageCount": 2,
            "markdown": "# Trang 1\n\nTỔNG CỘNG TÀI SẢN",
        },
        expected_job_id="job_test",
        expected_pages=2,
    )

    assert result.page == 1
    assert result.markdown.endswith("TỔNG CỘNG TÀI SẢN")


def test_page_message_allows_a_blank_page():
    result = validate_page_message(
        {
            "type": "page_result",
            "jobId": "job_test",
            "schemaVersion": 2,
            "page": 2,
            "pageCount": 2,
            "markdown": "",
        },
        expected_job_id="job_test",
        expected_pages=2,
    )

    assert result.markdown == ""


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        ({"jobId": "wrong"}, "jobId does not match"),
        ({"schemaVersion": 1}, "schemaVersion"),
        ({"page": 3}, "page exceeds pageCount"),
        ({"pageCount": 3}, "does not match document page count"),
    ],
)
def test_page_message_rejects_contract_mismatches(change, expected):
    message = {
        "type": "page_result",
        "jobId": "job_test",
        "schemaVersion": 2,
        "page": 1,
        "pageCount": 2,
        "markdown": "ok",
    }
    message.update(change)

    with pytest.raises(OCRPageContractError, match=expected):
        validate_page_message(
            message, expected_job_id="job_test", expected_pages=2,
        )


def test_result_end_is_separately_validated():
    result = validate_result_end(
        {
            "type": "result_end",
            "jobId": "job_test",
            "schemaVersion": 2,
            "pageCount": 2,
        },
        expected_job_id="job_test",
        expected_pages=2,
    )

    assert result.pageCount == 2

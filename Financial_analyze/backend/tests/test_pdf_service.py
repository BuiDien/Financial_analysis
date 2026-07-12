from app.services import pdf


class _Page:
    def __init__(self, text):
        self._text = text

    def extract_text(self):
        return self._text


class _Document:
    def __init__(self, text):
        self.pages = [_Page(text)]

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def test_parse_statements_preserves_each_period_sign(monkeypatch):
    monkeypatch.setattr(
        pdf.pdfplumber,
        "open",
        lambda path: _Document("Net income 100 (50)"),
    )

    rows = pdf.parse_statements("report.pdf")

    net_income = next(row for row in rows if row["id"] == "ni")
    assert net_income["curr"] == "100"
    assert net_income["prev"] == "-50"


def test_parse_statements_handles_negative_current_positive_previous(monkeypatch):
    monkeypatch.setattr(
        pdf.pdfplumber,
        "open",
        lambda path: _Document("Net income (1,234) 900"),
    )

    rows = pdf.parse_statements("report.pdf")

    net_income = next(row for row in rows if row["id"] == "ni")
    assert net_income["curr"] == "-1234"
    assert net_income["prev"] == "900"


def test_first_amount_preserves_parenthesized_loss():
    assert pdf._first_amount("Net income (1,234)", r"net\s+income") == "-1.2K"

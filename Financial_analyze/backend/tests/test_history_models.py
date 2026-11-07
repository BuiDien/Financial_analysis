from datetime import date

import pytest
from sqlalchemy.exc import IntegrityError

from app.models.ocr import FactResolution, OCRInboxItem, StatementFact


def test_fact_and_resolution_round_trip(db):
    item = OCRInboxItem(
        filename="a.pdf", storage_path="/tmp/a.pdf", size_bytes=1,
        checksum_sha256="0" * 64, scope="consolidated", fiscal_year=2026,
        period_code="Q3",
    )
    db.add(item)
    db.commit()
    fact = StatementFact(
        inbox_item_id=item.id, review_id=1, review_revision=2, ticker="MBB",
        scope="consolidated", statement_kind="balance", line_key="total_assets",
        fact_key="MBB|consolidated|balance|total_assets|2026-09-30",
        period_type="instant", period_end=date(2026, 9, 30),
        value=1_837_857_452_000_000, origin="printed", page_number=3,
        table_number=1, row_number=4, column_number=2, row_label="TỔNG TÀI SẢN",
        raw_text="1.837.857.452", raw_unit="million", inputs=None, status="active",
    )
    db.add(fact)
    db.commit()
    db.refresh(fact)
    assert fact.value == 1_837_857_452_000_000
    assert fact.row_label == "TỔNG TÀI SẢN"
    assert fact.created_at is not None
    assert db.get(OCRInboxItem, item.id).fiscal_year == 2026

    def resolution():
        return FactResolution(
            ticker="MBB", scope="consolidated", statement_kind="balance",
            fact_key=fact.fact_key, chosen_fact_id=fact.id,
            chosen_value=fact.value, note="picked",
        )

    db.add(resolution())
    db.commit()
    got = db.query(FactResolution).one()
    assert got.chosen_value == fact.value and got.resolved_at is not None
    db.add(resolution())
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()

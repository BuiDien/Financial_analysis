from datetime import date, datetime, timezone
from decimal import Decimal

import pytest

from app.models.gmail import GmailReport
from app.models.portfolio import Portfolio, PortfolioTransaction
from app.services import ssi_import, ssi_trade_report as srt
from app.services.ssi_trade_report import Report, _parse_row


BUY = "1 06/11/2026 10/11/2026 Mua VCB 200 53,600 10,720,000 16,080 10,736,080".split()
SELL = "1 04/01/2024 08/01/2024 Bán MBB 100 20,200 2,020,000 3,030 2,020 15 10,000 150,000 7,500 2,007,450".split()
SELL_PLAIN = "2 05/01/2024 09/01/2024 Bán MBB 15 20,000 300,000 450 300 299,250".split()
OLD_2023 = "1 03/10/2023 05/10/2023 Mua TPB 200 17,000 3,400,000 5,100 0 10,000 3,405,100".split()


def test_parse_buy():
    t = _parse_row(BUY)
    assert (t.side, t.ticker, t.quantity, t.price, t.fee, t.taxes, t.amount) == (
        "BUY", "VCB", 200, 53600, 16080, 0, 10736080)
    assert t.settle_date == date(2026, 11, 10)


def test_parse_sell_with_dividend_share_pit():
    t = _parse_row(SELL)
    assert t.side == "SELL" and t.sell_tax == 2020 and t.pit_quantity == 15 and t.pit_tax == 7500
    assert t.taxes == 9520 and t.amount == 2007450


def test_parse_2023_layout_with_empty_pit_cells():
    t = _parse_row(OLD_2023)
    assert t.quantity == 200 and t.amount == 3405100 and t.taxes == 0


def test_parse_rejects_bad_arithmetic():
    bad = BUY[:-1] + ["10,746,080"]
    with pytest.raises(ValueError):
        _parse_row(bad)


@pytest.fixture
def fake_reports(monkeypatch, tmp_path):
    """Map attachment path -> list of token rows, bypassing PDF reading."""
    table = {}

    def parse(path):
        rows = table[str(path)]
        return Report(account="003C178644", trades=[_parse_row(r) for r in rows])
    monkeypatch.setattr(ssi_import, "parse_report", parse)
    monkeypatch.setattr(ssi_import, "_rebuild_async", lambda db, p: None)

    def add(db, name, rows):
        name = f"TK1786441_{name}_Ket_Qua_Giao_Dich.PDF"
        path = tmp_path / name
        path.write_bytes(b"%PDF")
        table[str(path)] = rows
        rep = GmailReport(gm_msgid=name, status="downloaded",
                          attachments=[{"filename": name, "path": str(path)}])
        db.add(rep)
        db.commit()
        return rep
    return add


def _active(db):
    return db.query(PortfolioTransaction).filter_by(status="active").order_by(PortfolioTransaction.effective_at).all()


def test_import_is_idempotent_and_marks_reports(db, fake_reports):
    fake_reports(db, "a.pdf", [BUY])
    s = ssi_import.import_pending(db)
    assert s["trades"] == 1 and s["imported_reports"] == 1
    tx = _active(db)[0]
    assert (tx.type, tx.ticker, tx.fees, tx.currency, tx.source) == ("BUY", "VCB", 16080, "VND", "ssi_email")
    assert tx.external_id == "003C178644:2026-11-06:1"
    # 15:00 Vietnam time + row no seconds, stored UTC
    assert tx.effective_at.replace(tzinfo=None) == datetime(2026, 11, 6, 8, 0, 1)
    assert db.query(GmailReport).one().status == "imported"

    # same trade arriving again (e.g. re-sent email) -> nothing new
    fake_reports(db, "b.pdf", [BUY])
    assert ssi_import.import_pending(db)["trades"] == 0
    assert len(_active(db)) == 1


def test_manual_duplicate_is_replaced(db, fake_reports):
    p = Portfolio(name="Main", display_currency="VND")
    db.add(p); db.flush()
    db.add(PortfolioTransaction(portfolio_id=p.id, type="BUY", ticker="VCB", quantity=200,
                                unit_price=53600, currency="VND", source="manual",
                                effective_at=datetime(2026, 11, 7, tzinfo=timezone.utc)))
    db.commit()
    fake_reports(db, "a.pdf", [BUY])
    s = ssi_import.import_pending(db)
    assert s["replaced_manual"] == 1
    act = _active(db)
    assert len(act) == 1 and act[0].source == "ssi_email"


def test_oversell_gets_zero_cost_adjustment(db, fake_reports):
    buy100 = "1 02/01/2024 04/01/2024 Mua MBB 100 19,000 1,900,000 2,850 1,902,850".split()
    fake_reports(db, "a.pdf", [buy100])
    fake_reports(db, "b.pdf", [SELL])
    fake_reports(db, "c.pdf", [SELL_PLAIN])  # 15 dividend shares never bought
    s = ssi_import.import_pending(db)
    assert s["trades"] == 3
    assert s["adjustments"] == [{"ticker": "MBB", "quantity": 15.0, "date": "2024-01-05"}]
    adj = [t for t in _active(db) if t.source == "ssi_adjust"][0]
    assert adj.unit_price == 0 and adj.type == "BUY" and "dividend" in adj.note


def test_bad_report_is_flagged_not_imported(db, fake_reports, monkeypatch):
    rep = fake_reports(db, "a.pdf", [BUY])
    monkeypatch.setattr(ssi_import, "parse_report",
                        lambda path: Report(errors=["row 1: amount mismatch"]))
    s = ssi_import.import_pending(db)
    assert s["trades"] == 0 and s["failed_reports"][0]["errors"] == ["row 1: amount mismatch"]
    assert db.get(GmailReport, rep.id).status == "parse_error"


def test_unrecognized_attachment_is_ignored(db, tmp_path):
    p = tmp_path / "Ket_Qua_Khop_Lenh_CCQ.pdf"
    p.write_bytes(b"%PDF")
    db.add(GmailReport(gm_msgid="ccq", status="downloaded", attachments=[{"filename": p.name, "path": str(p)}]))
    db.commit()
    ssi_import.import_pending(db)
    assert db.query(GmailReport).one().status == "ignored"


def test_daily_import_replaces_exact_day_manual_row_before_nearer_id(db, fake_reports):
    """I1: Monday's pasted row stays; Wednesday's email replaces Wednesday's row,
    even though Monday's has the lower id and is within 3 days."""
    p = Portfolio(name="Main", display_currency="VND")
    db.add(p); db.flush()
    mon = PortfolioTransaction(portfolio_id=p.id, type="BUY", ticker="VCB", quantity=200,
                               unit_price=53600, currency="VND", source="manual",
                               effective_at=datetime(2026, 11, 4, 8, 0, 1, tzinfo=timezone.utc))
    wed = PortfolioTransaction(portfolio_id=p.id, type="BUY", ticker="VCB", quantity=200,
                               unit_price=53600, currency="VND", source="manual",
                               effective_at=datetime(2026, 11, 6, 8, 0, 1, tzinfo=timezone.utc))
    db.add_all([mon, wed]); db.commit()
    fake_reports(db, "a.pdf", [BUY])  # trade date 06/11/2026
    assert ssi_import.import_pending(db)["replaced_manual"] == 1
    assert db.get(PortfolioTransaction, mon.id).status == "active"
    assert db.get(PortfolioTransaction, wed.id).status == "replaced"


def test_daily_import_falls_back_to_nearest_manual_within_3_days(db, fake_reports):
    p = Portfolio(name="Main", display_currency="VND")
    db.add(p); db.flush()
    far = PortfolioTransaction(portfolio_id=p.id, type="BUY", ticker="VCB", quantity=200,
                               unit_price=53600, currency="VND", source="manual",
                               effective_at=datetime(2026, 11, 3, 8, 0, tzinfo=timezone.utc))
    near = PortfolioTransaction(portfolio_id=p.id, type="BUY", ticker="VCB", quantity=200,
                                unit_price=53600, currency="VND", source="manual",
                                effective_at=datetime(2026, 11, 7, 8, 0, tzinfo=timezone.utc))
    db.add_all([far, near]); db.commit()
    fake_reports(db, "a.pdf", [BUY])
    ssi_import.import_pending(db)
    assert db.get(PortfolioTransaction, far.id).status == "active"
    assert db.get(PortfolioTransaction, near.id).status == "replaced"


def test_import_summary_carries_rebuild_job_id(db, fake_reports, monkeypatch):
    monkeypatch.setattr(ssi_import, "_rebuild_async", lambda db, p: "pf_job")
    fake_reports(db, "a.pdf", [BUY])
    assert ssi_import.import_pending(db)["job_id"] == "pf_job"

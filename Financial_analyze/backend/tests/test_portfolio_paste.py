"""Paste SSI order rows into the ledger: preview (no writes) and commit."""
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base, get_db
from app.main import app
from app.models.gmail import GmailReport
from app.models.portfolio import Portfolio, PortfolioTransaction
from app.services import portfolio_paste as paste
from app.services import ssi_import
from app.services.errors import ServiceError
from app.services.ssi_trade_report import Report, _parse_row

BUY = "1 06/11/2026 10/11/2026 Mua VCB 200 53,600 10,720,000 16,080 10,736,080"
BUY2 = "2 06/11/2026 10/11/2026 Mua FPT 100 90,000 9,000,000 13,500 9,013,500"
SELL_VCB = "3 06/11/2026 10/11/2026 Bán VCB 300 54,000 16,200,000 24,300 16,200 16,159,500"
BAD = "4 06/11/2026 10/11/2026 Mua HPG 100 25,000 2,500,000 3,750 9,999,999"
HEADER = "Số tài khoản: 003C178644\n"


class FakeBackground:
    def __init__(self):
        self.tasks = []

    def add_task(self, fn, *args, **kwargs):
        self.tasks.append((fn, args, kwargs))


@pytest.fixture
def p(db):
    port = Portfolio(name="Main", display_currency="VND")
    db.add(port)
    db.commit()
    return port


def _tx(db, p, **kw):
    values = dict(portfolio_id=p.id, type="BUY", ticker="VCB", quantity=200, unit_price=53600,
                  currency="VND", source="manual",
                  effective_at=datetime(2026, 11, 6, 2, 30, tzinfo=timezone.utc))
    values.update(kw)
    tx = PortfolioTransaction(**values)
    db.add(tx)
    db.commit()
    return tx


def _active(db):
    return (db.query(PortfolioTransaction).filter_by(status="active")
            .order_by(PortfolioTransaction.effective_at).all())


# ── preview ────────────────────────────────────────────────────────────

def test_preview_lists_trades_errors_and_writes_nothing(db, p):
    rev = p.ledger_revision
    out = paste.preview(db, HEADER + BUY + "\n" + BUY2 + "\n" + BAD)
    assert out["account"] == "003C178644"
    assert [t["ticker"] for t in out["trades"]] == ["VCB", "FPT"]
    t = out["trades"][0]
    assert t["side"] == "BUY" and t["quantity"] == 200 and t["price"] == 53600
    assert t["fee"] == 16080 and t["amount"] == 10736080 and t["taxes"] == 0
    assert t["duplicate"] is False and t["duplicate_of"] is None
    assert t["key"] and t["key"] != out["trades"][1]["key"]
    assert len(out["errors"]) == 1 and out["errors"][0].startswith("row 4:")
    assert db.query(PortfolioTransaction).count() == 0
    db.refresh(p)
    assert p.ledger_revision == rev


def test_preview_flags_duplicate_of_email_row(db, p):
    tx = _tx(db, p, source="ssi_email", external_id="003C178644:2026-11-06:1", fees=16080,
             effective_at=datetime(2026, 11, 6, 8, 0, 1, tzinfo=timezone.utc))
    out = paste.preview(db, BUY + "\n" + BUY2)
    assert out["trades"][0]["duplicate"] is True
    assert out["trades"][0]["duplicate_of"] == {"id": tx.id, "source": "ssi_email"}
    assert out["trades"][1]["duplicate"] is False


def test_preview_flags_duplicate_of_manual_row_on_same_local_day(db, p):
    # 2026-11-05 23:30 UTC is 2026-11-06 06:30 in Vietnam -> same trade day
    tx = _tx(db, p, effective_at=datetime(2026, 11, 5, 23, 30, tzinfo=timezone.utc))
    out = paste.preview(db, BUY)
    assert out["trades"][0]["duplicate_of"] == {"id": tx.id, "source": "manual"}


def test_preview_ignores_inactive_and_different_trades(db, p):
    _tx(db, p, status="void")
    _tx(db, p, quantity=100)                     # different qty
    _tx(db, p, unit_price=53700)                 # different price
    _tx(db, p, type="SELL", quantity=1)          # different side
    _tx(db, p, effective_at=datetime(2026, 11, 7, 3, 0, tzinfo=timezone.utc))  # other day
    out = paste.preview(db, BUY)
    assert out["trades"][0]["duplicate"] is False


def test_one_ledger_row_matches_only_one_identical_pasted_row(db, p):
    _tx(db, p)
    twin = BUY.replace("1 06/11", "5 06/11", 1)  # same fill again, different row no
    out = paste.preview(db, BUY + "\n" + twin)
    assert [t["duplicate"] for t in out["trades"]] == [True, False]


# ── commit ─────────────────────────────────────────────────────────────

def test_commit_adds_only_selected_rows_as_manual(db, p):
    bg = FakeBackground()
    keys = [t["key"] for t in paste.preview(db, HEADER + BUY + "\n" + BUY2)["trades"]]
    rev = p.ledger_revision
    out = paste.commit(db, bg, HEADER + BUY + "\n" + BUY2, [keys[1]])
    assert out["added"] == 1 and out["skipped"] == [] and out["job_id"]
    [tx] = _active(db)
    assert (tx.type, tx.ticker, tx.source, tx.currency) == ("BUY", "FPT", "manual", "VND")
    assert tx.quantity == 100 and tx.unit_price == 90000 and tx.fees == 13500 and tx.taxes == 0
    assert tx.external_id == f"paste:{keys[1]}"
    assert tx.note == "Pasted SSI order · 003C178644 · row 2"
    # 15:00 Vietnam + row no seconds, stored UTC (same rule as the email import)
    assert tx.effective_at.replace(tzinfo=None) == datetime(2026, 11, 6, 8, 0, 2)
    db.refresh(p)
    assert p.ledger_revision == rev + 1
    assert len(bg.tasks) == 1


def test_commit_sell_carries_taxes_and_no_account_note(db, p):
    _tx(db, p, quantity=300, unit_price=50000,
        effective_at=datetime(2026, 11, 1, 3, 0, tzinfo=timezone.utc))
    keys = [t["key"] for t in paste.preview(db, SELL_VCB)["trades"]]
    out = paste.commit(db, FakeBackground(), SELL_VCB, keys)
    assert out["added"] == 1
    sell = [t for t in _active(db) if t.type == "SELL"][0]
    assert sell.taxes == 16200 and sell.fees == 24300
    assert sell.note == "Pasted SSI order · no account · row 3"


def test_commit_refuses_duplicates(db, p):
    _tx(db, p, source="ssi_email", external_id="x")
    keys = [t["key"] for t in paste.preview(db, BUY + "\n" + BUY2)["trades"]]
    out = paste.commit(db, FakeBackground(), BUY + "\n" + BUY2, keys)
    assert out["added"] == 1
    assert out["skipped"] == [{"key": keys[0], "reason": "already in ledger"}]
    assert len(_active(db)) == 2


def test_commit_all_duplicates_writes_nothing(db, p):
    _tx(db, p)
    rev = p.ledger_revision
    keys = [t["key"] for t in paste.preview(db, BUY)["trades"]]
    out = paste.commit(db, FakeBackground(), BUY, keys)
    assert out["added"] == 0 and out["job_id"] is None
    db.refresh(p)
    assert p.ledger_revision == rev and len(_active(db)) == 1


def test_commit_rejects_unknown_or_empty_keys(db, p):
    with pytest.raises(ServiceError) as e:
        paste.commit(db, FakeBackground(), BUY, ["2026-11-06:9:XXX:BUY:1:1"])
    assert e.value.status_code == 422
    with pytest.raises(ServiceError) as e:
        paste.commit(db, FakeBackground(), BUY, [])
    assert e.value.status_code == 422
    assert db.query(PortfolioTransaction).count() == 0


def test_commit_rejects_oversell_without_writing(db, p):
    keys = [t["key"] for t in paste.preview(db, SELL_VCB)["trades"]]
    rev = p.ledger_revision
    with pytest.raises(ServiceError) as e:
        paste.commit(db, FakeBackground(), SELL_VCB, keys)
    assert e.value.status_code == 422
    assert db.query(PortfolioTransaction).count() == 0
    db.refresh(p)
    assert p.ledger_revision == rev


def test_error_rows_cannot_be_committed(db, p):
    with pytest.raises(ServiceError) as e:
        paste.commit(db, FakeBackground(), BAD, [])
    assert e.value.status_code == 422


def test_later_email_import_replaces_pasted_row(db, p, monkeypatch, tmp_path):
    keys = [t["key"] for t in paste.preview(db, HEADER + BUY)["trades"]]
    paste.commit(db, FakeBackground(), HEADER + BUY, keys)

    path = tmp_path / "TK1786441_a_Ket_Qua_Giao_Dich.PDF"
    path.write_bytes(b"%PDF")
    monkeypatch.setattr(ssi_import, "parse_report",
                        lambda _: Report(account="003C178644", trades=[_parse_row(BUY.split())]))
    monkeypatch.setattr(ssi_import, "_rebuild_async", lambda db, p: None)
    db.add(GmailReport(gm_msgid="m1", status="downloaded",
                       attachments=[{"filename": path.name, "path": str(path)}]))
    db.commit()
    s = ssi_import.import_pending(db)
    assert s["trades"] == 1 and s["replaced_manual"] == 1
    [tx] = _active(db)
    assert tx.source == "ssi_email"


# ── routes ─────────────────────────────────────────────────────────────

@pytest.fixture
def client():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)

    def override():
        s = factory()
        try:
            yield s
        finally:
            s.close()
    app.dependency_overrides[get_db] = override
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_routes_preview_then_commit(client, monkeypatch):
    monkeypatch.setattr(paste.ledger, "schedule_rebuild",
                        lambda db, bg, p: type("J", (), {"id": "job-1"})())
    r = client.post("/api/portfolio/paste/preview", json={"text": BUY2})
    assert r.status_code == 200
    key = r.json()["trades"][0]["key"]
    r = client.post("/api/portfolio/paste/commit", json={"text": BUY2, "keys": [key]})
    assert r.status_code == 200, r.text
    assert r.json() == {"added": 1, "skipped": [], "job_id": "job-1"}
    again = client.post("/api/portfolio/paste/preview", json={"text": BUY2}).json()
    assert again["trades"][0]["duplicate"] is True
    assert client.post("/api/portfolio/paste/preview", json={"text": ""}).status_code == 422


# ── Fix round 1 ──

def test_row_pasted_twice_with_one_in_ledger_adds_nothing(db, p):
    """C1"""
    _tx(db, p, source="ssi_email", external_id="x")
    out = paste.preview(db, BUY + "\n" + BUY)
    assert [t["duplicate"] for t in out["trades"]] == [True, True]
    assert out["trades"][1]["duplicate_reason"] == "repeated in pasted text"
    k = out["trades"][0]["key"]
    res = paste.commit(db, FakeBackground(), BUY + "\n" + BUY, [k])
    assert res["added"] == 0 and len(_active(db)) == 1


def test_row_pasted_twice_with_none_in_ledger_adds_once(db, p):
    out = paste.preview(db, BUY + "\n" + BUY)
    assert [t["duplicate"] for t in out["trades"]] == [False, True]
    assert out["trades"][0]["duplicate_reason"] is None
    k = out["trades"][0]["key"]
    assert paste.commit(db, FakeBackground(), BUY + "\n" + BUY, [k])["added"] == 1
    assert len(_active(db)) == 1


def test_key_includes_account(db, p):
    """M2"""
    k1 = paste.preview(db, HEADER + BUY)["trades"][0]["key"]
    k2 = paste.preview(db, BUY)["trades"][0]["key"]
    assert "003C178644" in k1 and k1 != k2


def test_commit_returns_job_id(db, p):
    """M4"""
    keys = [t["key"] for t in paste.preview(db, BUY2)["trades"]]
    out = paste.commit(db, FakeBackground(), BUY2, keys)
    assert set(out) == {"added", "skipped", "job_id"} and out["job_id"]


def test_similar_trade_in_ledger_is_a_warning_not_a_duplicate(db, p):
    """M3: same day/ticker/side, other qty -> warn, still addable."""
    tx = _tx(db, p, quantity=100)
    t = paste.preview(db, BUY)["trades"][0]
    assert t["duplicate"] is False
    assert t["similar"] == {"id": tx.id, "source": "manual", "quantity": 100.0, "price": 53600.0}
    assert paste.preview(db, BUY2)["trades"][0]["similar"] is None


# ── Fix round 2: durable paste marker, exact-day replacement ──

MON_BUY = "1 02/11/2026 04/11/2026 Mua VCB 200 53,600 10,720,000 16,080 10,736,080"
WED_BUY = "1 04/11/2026 06/11/2026 Mua VCB 200 53,600 10,720,000 16,080 10,736,080"


def _email_import(db, monkeypatch, tmp_path, row):
    path = tmp_path / "TK1786441_w_Ket_Qua_Giao_Dich.PDF"
    path.write_bytes(b"%PDF")
    monkeypatch.setattr(ssi_import, "parse_report",
                        lambda _: Report(account="003C178644", trades=[_parse_row(row.split())]))
    monkeypatch.setattr(ssi_import, "_rebuild_async", lambda db, p: None)
    db.add(GmailReport(gm_msgid="w", status="downloaded",
                       attachments=[{"filename": path.name, "path": str(path)}]))
    db.commit()
    return ssi_import.import_pending(db)


def test_pasted_row_carries_durable_marker(db, p):
    k = paste.preview(db, HEADER + BUY)["trades"][0]["key"]
    paste.commit(db, FakeBackground(), HEADER + BUY, [k])
    [tx] = _active(db)
    assert tx.source == "manual" and tx.external_id == f"paste:{k}"


def test_monday_pasted_row_is_not_replaced_by_wednesday_email(db, p, monkeypatch, tmp_path):
    k = paste.preview(db, HEADER + MON_BUY)["trades"][0]["key"]
    paste.commit(db, FakeBackground(), HEADER + MON_BUY, [k])
    s = _email_import(db, monkeypatch, tmp_path, WED_BUY)
    assert s["trades"] == 1 and s["replaced_manual"] == 0
    act = _active(db)
    assert [(t.source, t.effective_at.day) for t in act] == [("manual", 2), ("ssi_email", 4)]


def test_hand_typed_row_keeps_3_day_rule(db, p, monkeypatch, tmp_path):
    _tx(db, p, effective_at=datetime(2026, 11, 2, 3, 0, tzinfo=timezone.utc))  # no marker
    s = _email_import(db, monkeypatch, tmp_path, WED_BUY)
    assert s["replaced_manual"] == 1
    assert [t.source for t in _active(db)] == ["ssi_email"]


def test_pasted_row_still_replaced_on_exact_day_even_if_note_edited(db, p, monkeypatch, tmp_path):
    k = paste.preview(db, HEADER + WED_BUY)["trades"][0]["key"]
    paste.commit(db, FakeBackground(), HEADER + WED_BUY, [k])
    _active(db)[0].note = "my own note"
    db.commit()
    s = _email_import(db, monkeypatch, tmp_path, WED_BUY)
    assert s["replaced_manual"] == 1 and [t.source for t in _active(db)] == ["ssi_email"]


def test_repaste_after_void_gets_a_fresh_marker(db, p):
    k = paste.preview(db, BUY2)["trades"][0]["key"]
    paste.commit(db, FakeBackground(), BUY2, [k])
    tx = _active(db)[0]
    tx.status = "void"
    db.commit()
    assert paste.commit(db, FakeBackground(), BUY2, [k])["added"] == 1
    assert _active(db)[0].external_id == f"paste:{k}:2"


def test_editing_a_pasted_row_keeps_the_marker(db, p):
    from app.services import portfolio_ledger as ledger
    from app.services.portfolio_schemas import TransactionIn
    k = paste.preview(db, BUY2)["trades"][0]["key"]
    paste.commit(db, FakeBackground(), BUY2, [k])
    old = _active(db)[0]
    payload = TransactionIn(type="BUY", effective_at=old.effective_at, ticker="FPT", quantity=100,
                            unit_price=90000, currency="VND", fees=13500, note="edited",
                            source="manual", external_id=old.external_id)
    ledger.replace_transaction(db, FakeBackground(), old.id, payload)
    [new] = _active(db)
    assert new.external_id == f"paste:{k}" and new.note == "edited"
    assert db.get(PortfolioTransaction, old.id).status == "replaced"

"""DB-level tests of ssi_import.import_statements / import_pending."""
from datetime import date, datetime, timezone
from decimal import Decimal as D

import pytest

from app.models.gmail import GmailReport
from app.models.portfolio import PortfolioTransaction
from app.services import ssi_import
from app.services.ssi_statement import CashEvent, Order, Statement
from app.services.ssi_trade_report import Report, _parse_row

BUY100 = "1 02/01/2024 04/01/2024 Mua MBB 100 19,000 1,900,000 2,850 1,902,850".split()
SELL = "1 04/01/2024 08/01/2024 Bán MBB 100 20,200 2,020,000 3,030 2,020 15 10,000 150,000 7,500 2,007,450".split()
SELL_PLAIN = "2 05/01/2024 09/01/2024 Bán MBB 15 20,000 300,000 450 300 299,250".split()


def ev(day, kind, content="", ticker=None, qty=0, inc=0, dec=0, bal=0):
    return CashEvent(day, kind, content, ticker, D(qty), D(0), D(inc), D(dec), D(bal))


def stmt(frm, to, opening, closing, cash=(), orders=(), errors=()):
    return Statement(account="003C178644", period_from=frm, period_to=to,
                     opening=None if opening is None else D(opening),
                     closing=None if closing is None else D(closing),
                     cash=list(cash), orders=list(orders), errors=list(errors))


@pytest.fixture
def files(monkeypatch, tmp_path):
    statements, reports = {}, {}
    monkeypatch.setattr(ssi_import, "parse_statement", lambda path: statements[str(path)])
    monkeypatch.setattr(ssi_import, "parse_report", lambda path: Report(
        account="003C178644", trades=[_parse_row(r) for r in reports[str(path)]]))
    monkeypatch.setattr(ssi_import, "_rebuild_async", lambda db, p: None)

    def add(db, name, content, sub="1786441"):
        if isinstance(content, Statement):
            fname = f"TK{sub}_{name}_Sao_Ke_Tong_Hop.pdf"
            statements[str(tmp_path / fname)] = content
        else:
            fname = f"TK{sub}_{name}_Ket_Qua_Giao_Dich.PDF"
            reports[str(tmp_path / fname)] = content
        path = tmp_path / fname
        path.write_bytes(b"%PDF")
        rep = GmailReport(gm_msgid=fname, status="downloaded",
                          attachments=[{"filename": fname, "path": str(path)}])
        db.add(rep)
        db.commit()
        return rep
    return add


def _rows(db, **kw):
    return db.query(PortfolioTransaction).filter_by(**kw).all()


OCT = stmt(date(2026, 10, 1), date(2026, 10, 31), 0, 7_876_820, cash=[
    ev(date(2026, 10, 1), "Nộp tiền", "Nap tien", inc=10_000_000, bal=10_000_000),
    ev(date(2026, 10, 30), "Thanh toán phí", "Thu phí lưu ký", dec=4_801, bal=9_995_199),
], orders=[Order(1, date(2026, 10, 2), date(2026, 10, 6), "BUY", "MBB", D(100), D(19300),
                 D(1930000), D(2895), D(0), D(1932895))])


def test_statement_reimport_is_idempotent(db, files):
    files(db, "oct", OCT)
    first = ssi_import.import_pending(db)["statements"]
    assert first["added"] == {"ssi_statement:BUY": 1, "ssi_cash:DEPOSIT": 1, "ssi_cash:FEE": 1}
    files(db, "oct-resent", OCT)
    again = ssi_import.import_pending(db)["statements"]
    assert again["added"] == {} and again["failed_reports"] == []
    assert len(_rows(db, status="active")) == 3


def test_voided_adjustment_is_reactivated_not_duplicated(db, files):
    files(db, "a", [BUY100])
    files(db, "b", [SELL])
    files(db, "c", [SELL_PLAIN])  # 15 shares never bought -> zero-cost adjustment
    ssi_import.import_pending(db)
    assert len(_rows(db, source="ssi_adjust", status="active")) == 1
    # a statement that doesn't explain the 15 shares: placeholder voided and recreated
    files(db, "jan", stmt(date(2024, 1, 1), date(2024, 1, 31), 0, 0))
    out = ssi_import.import_pending(db)["statements"]
    assert out["voided_adjustments"] == 0  # recomputed placeholder reuses the voided row
    adj = _rows(db, source="ssi_adjust")
    assert len(adj) == 1 and adj[0].status == "active" and adj[0].voided_at is None
    assert float(adj[0].quantity) == 15
    # and again on the next poll
    files(db, "feb", stmt(date(2024, 2, 1), date(2024, 2, 29), 0, 0))
    ssi_import.import_pending(db)
    assert len(_rows(db, source="ssi_adjust")) == 1
    assert db.query(GmailReport).filter_by(status="imported").count() == 5


@pytest.mark.parametrize("how", ["void", "replace"])
def test_voided_or_edited_statement_row_is_a_tombstone(db, files, how):
    files(db, "oct", OCT)
    ssi_import.import_pending(db)
    dep = _rows(db, source="ssi_cash", type="DEPOSIT")[0]
    if how == "void":
        dep.status = "void"
    else:  # what PATCH /portfolio/transactions/{id} does
        dep.status = "replaced"
        db.add(PortfolioTransaction(portfolio_id=dep.portfolio_id, type="DEPOSIT", currency="VND",
                                    cash_amount=D(9_000_000), effective_at=dep.effective_at,
                                    source="manual", replaces_transaction_id=dep.id))
    db.commit()
    files(db, "nov", stmt(date(2026, 11, 1), date(2026, 11, 30), 7_876_820, 7_876_820))
    out = ssi_import.import_pending(db)["statements"]
    assert out["failed_reports"] == []
    assert len(_rows(db, source="ssi_cash", type="DEPOSIT")) == 1
    assert not _rows(db, source="ssi_cash", type="DEPOSIT", status="active")


def test_voided_daily_trade_is_not_resurrected_by_statement(db, files):
    buy = "1 02/10/2026 06/10/2026 Mua MBB 100 19,300 1,930,000 2,895 1,932,895".split()
    files(db, "d", [buy])
    ssi_import.import_pending(db)
    t = _rows(db, source="ssi_email")[0]
    t.status = "void"
    db.commit()
    files(db, "oct", OCT)
    ssi_import.import_pending(db)
    assert not _rows(db, source="ssi_statement")


def test_missing_month_inferred_deposit_is_retired_when_statement_arrives(db, files):
    nov = stmt(date(2022, 11, 1), date(2022, 11, 30), 0, 0)
    jan = stmt(date(2023, 1, 1), date(2023, 1, 31), 1_000_000, 1_000_000)
    files(db, "nov", nov)
    files(db, "jan", jan)
    ssi_import.import_pending(db)
    inferred = _rows(db, status="active", type="DEPOSIT")
    assert len(inferred) == 1 and inferred[0].external_id.endswith(":inferred")
    assert inferred[0].cash_amount == 1_000_000

    dec = stmt(date(2022, 12, 1), date(2022, 12, 31), 0, 1_000_000, cash=[
        ev(date(2022, 12, 5), "Nộp tiền", "Nap tien", inc=1_000_000, bal=1_000_000)])
    files(db, "dec", dec)
    ssi_import.import_pending(db)
    deposits = _rows(db, status="active", type="DEPOSIT")
    assert len(deposits) == 1 and not deposits[0].external_id.endswith(":inferred")
    assert sum(d.cash_amount for d in deposits) == 1_000_000
    assert _rows(db, status="void", type="DEPOSIT")[0].external_id.endswith(":inferred")


def test_partially_closed_gap_updates_inferred_amount(db, files):
    files(db, "nov", stmt(date(2022, 11, 1), date(2022, 11, 30), 0, 0))
    files(db, "feb", stmt(date(2023, 2, 1), date(2023, 2, 28), 3_000_000, 3_000_000))
    ssi_import.import_pending(db)
    assert sum(d.cash_amount for d in _rows(db, status="active", type="DEPOSIT")) == 3_000_000
    # December arrives: 1M deposited there; January (2M) still missing
    files(db, "dec", stmt(date(2022, 12, 1), date(2022, 12, 31), 0, 1_000_000, cash=[
        ev(date(2022, 12, 5), "Nộp tiền", "Nap tien", inc=1_000_000, bal=1_000_000)]))
    ssi_import.import_pending(db)
    active = _rows(db, status="active", type="DEPOSIT")
    assert sum(d.cash_amount for d in active) == 3_000_000
    assert sorted(d.external_id.endswith(":inferred") for d in active) == [False, True]


def test_same_gap_start_with_new_amount_is_updated(db, files):
    files(db, "nov", stmt(date(2022, 11, 1), date(2022, 11, 30), 0, 0))
    files(db, "feb", stmt(date(2023, 2, 1), date(2023, 2, 28), 3_000_000, 3_000_000))
    ssi_import.import_pending(db)
    # January arrives with a 2M deposit; December (1M) still missing
    files(db, "jan", stmt(date(2023, 1, 1), date(2023, 1, 31), 1_000_000, 3_000_000, cash=[
        ev(date(2023, 1, 5), "Nộp tiền", "Nap tien", inc=2_000_000, bal=3_000_000)]))
    ssi_import.import_pending(db)
    active = _rows(db, status="active", type="DEPOSIT")
    assert sum(d.cash_amount for d in active) == 3_000_000
    inferred = [d for d in active if d.external_id.endswith(":inferred")]
    assert len(inferred) == 1 and inferred[0].cash_amount == 1_000_000


def test_no_inference_without_both_balances():
    from collections import Counter
    nov = stmt(date(2022, 11, 1), date(2022, 11, 30), 0, None)
    jan = stmt(date(2023, 1, 1), date(2023, 1, 31), 5_000_000, 5_000_000)
    rows, notes = ssi_import.statement_transactions([nov, jan], Counter(), "1786441", [])
    assert not any(r["external_id"].endswith(":inferred") for r in rows)


def test_statement_with_self_check_errors_is_not_imported(db, files):
    bad = stmt(date(2026, 10, 1), date(2026, 10, 31), 0, 10_000_000, cash=[
        ev(date(2026, 10, 1), "Nộp tiền", "Nap tien", inc=10_000_000, bal=10_000_000)],
        errors=["running balance 10 != printed 999 on 2026-10-01 Nộp tiền"])
    rep = files(db, "oct", bad)
    out = ssi_import.import_pending(db)["statements"]
    assert out["added"] == {}
    assert db.get(GmailReport, rep.id).status == "parse_error"
    assert "running balance" in db.get(GmailReport, rep.id).error
    assert out["failed_reports"][0]["errors"][0].startswith("running balance")
    assert not _rows(db)


# ── Fix round 1: statements replace a matching manual (e.g. pasted) row ──

def _manual(db, day, **kw):
    from app.models.portfolio import Portfolio
    p = db.query(Portfolio).first() or Portfolio(name="Main", display_currency="VND")
    db.add(p); db.flush()
    vals = dict(portfolio_id=p.id, type="BUY", ticker="MBB", quantity=100, unit_price=19300,
                currency="VND", source="manual",
                effective_at=datetime(day.year, day.month, day.day, 8, 0, 1, tzinfo=timezone.utc))
    vals.update(kw)
    tx = PortfolioTransaction(**vals)
    db.add(tx); db.commit()
    return tx


def test_statement_replaces_manual_row_of_same_trade(db, files):
    m = _manual(db, date(2026, 10, 2))
    files(db, "oct", OCT)
    s = ssi_import.import_pending(db)["statements"]
    assert s["replaced_manual"] == 1
    trades = [t for t in _rows(db, status="active") if t.type in {"BUY", "SELL"}]
    assert len(trades) == 1 and trades[0].source == "ssi_statement"
    assert f"replaces manual entry #{m.id}" in trades[0].note
    assert db.get(PortfolioTransaction, m.id).status == "replaced"


def test_statement_keeps_manual_row_on_other_day_or_price(db, files):
    _manual(db, date(2026, 10, 3))                       # next day: not the same trade
    _manual(db, date(2026, 10, 2), unit_price=19400)     # other price
    files(db, "oct", OCT)
    s = ssi_import.import_pending(db)["statements"]
    assert s["replaced_manual"] == 0
    assert len([t for t in _rows(db, status="active") if t.source == "manual"]) == 2


# ── Fix round 3: an edited placeholder / inferred deposit is user-owned ──

class _BG:
    def add_task(self, *a, **k):
        pass


def _edit(db, tx, **changes):
    """What PATCH /portfolio/transactions/{id} does (the dialog sends source + external_id back)."""
    from app.services import portfolio_ledger as ledger
    from app.services.portfolio_schemas import TransactionIn
    vals = dict(type=tx.type, effective_at=tx.effective_at, ticker=tx.ticker, quantity=tx.quantity,
                unit_price=tx.unit_price, cash_amount=tx.cash_amount, currency=tx.currency,
                fees=tx.fees, taxes=tx.taxes, note=tx.note, source=tx.source, external_id=tx.external_id)
    vals.update(changes)
    out = ledger.replace_transaction(db, _BG(), tx.id, TransactionIn(**vals))
    return db.get(PortfolioTransaction, out["transaction"]["id"])


def _placeholder_with_user_cost(db, files):
    files(db, "b", [SELL])  # SELL MBB 100 on 04/01/2024, never bought -> BUY 100 @ 0 placeholder
    ssi_import.import_pending(db)
    [adj] = _rows(db, source="ssi_adjust", status="active")
    assert adj.unit_price == 0 and float(adj.quantity) == 100
    return _edit(db, adj, unit_price=D(15000), note="bought in 2019 at Vietcombank Securities")


def _mbb_shares(db):
    rows = [t for t in _rows(db, status="active", ticker="MBB")]
    return sum(D(t.quantity) * (1 if t.type == "BUY" else -1) for t in rows)


def test_statement_keeps_users_cost_on_edited_placeholder(db, files):
    mine = _placeholder_with_user_cost(db, files)
    files(db, "feb", stmt(date(2024, 2, 1), date(2024, 2, 29), 0, 0))  # no MBB buy in it
    ssi_import.import_pending(db)
    [adj] = _rows(db, source="ssi_adjust", status="active")
    assert adj.id == mine.id
    assert adj.unit_price == 15000 and adj.note == "bought in 2019 at Vietcombank Securities"
    assert float(adj.quantity) == 100 and _mbb_shares(db) == 0


def test_real_buy_supersedes_edited_placeholder_without_double_shares(db, files):
    mine = _placeholder_with_user_cost(db, files)
    jan = stmt(date(2024, 1, 1), date(2024, 1, 31), 0, 0, orders=[
        Order(1, date(2024, 1, 2), date(2024, 1, 4), "BUY", "MBB", D(100), D(19000),
              D(1900000), D(2850), D(0), D(1902850)),
        Order(2, date(2024, 1, 4), date(2024, 1, 8), "SELL", "MBB", D(100), D(20200),
              D(2020000), D(3030), D(9520), D(2007450))])
    files(db, "jan", jan)
    ssi_import.import_pending(db)
    assert not _rows(db, source="ssi_adjust", status="active")
    voided = db.get(PortfolioTransaction, mine.id)
    assert voided.status == "void" and voided.unit_price == 15000
    assert "superseded" in voided.note
    assert _mbb_shares(db) == 0
    assert len(_rows(db, status="active", source="ssi_statement", type="BUY")) == 1


def test_edited_inferred_deposit_amount_survives_statement_import(db, files):
    files(db, "nov", stmt(date(2022, 11, 1), date(2022, 11, 30), 0, 0))
    files(db, "jan", stmt(date(2023, 1, 1), date(2023, 1, 31), 1_000_000, 1_000_000))
    ssi_import.import_pending(db)
    [inf] = _rows(db, status="active", type="DEPOSIT")
    mine = _edit(db, inf, cash_amount=D(1_200_000), note="my real December deposit")
    files(db, "feb", stmt(date(2023, 2, 1), date(2023, 2, 28), 1_000_000, 1_000_000))
    out = ssi_import.import_pending(db)["statements"]
    [dep] = _rows(db, status="active", type="DEPOSIT")
    assert dep.id == mine.id and dep.cash_amount == 1_200_000
    assert dep.note == "my real December deposit"
    assert any("edited" in n for n in out["notes"])

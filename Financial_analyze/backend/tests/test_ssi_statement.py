from collections import Counter
from datetime import date
from decimal import Decimal as D

from app.services import ssi_import as si
from app.services.ssi_statement import CashEvent, Order, Statement, _num, _self_check
from app.services.ssi_trade_report import Trade


def ev(day, kind, content="", ticker=None, qty=0, price=0, inc=0, dec=0, bal=0):
    return CashEvent(day, kind, content, ticker, D(qty), D(price), D(inc), D(dec), D(bal))


def stmt(frm, to, opening, closing, cash=(), orders=()):
    return Statement(account="003C178644", period_from=frm, period_to=to, opening=D(opening),
                     closing=D(closing), cash=list(cash), orders=list(orders))


def test_parenthesized_negative_numbers():
    assert _num("(8,300,000)") == D(-8300000) and _num("1,234") == 1234 and _num("-") == 0


def test_self_check_flags_broken_running_balance():
    s = stmt(date(2026, 10, 1), date(2026, 10, 31), 100, 150, cash=[ev(date(2026, 10, 2), "Nộp tiền", inc=50, bal=999)])
    _self_check(s)
    assert any("running balance" in e for e in s.errors)


def test_corporate_actions_cash_and_dedupe():
    oct_ = stmt(date(2026, 10, 1), date(2026, 10, 31), 0, 0, cash=[
        ev(date(2026, 10, 1), "Phân bổ quyền", "Giải tỏa để phân bổ Co phieu thuong, ti le 5:1 về chờ giao dịch", "SSI", qty=684),
        ev(date(2026, 10, 2), "Phân bổ quyền", "Thực hiện THỰC HIỆN QUYỀN : 5 QUYỀN NẮM GIỮ ĐƯỢC MUA 1 CP SSI, GIÁ 15.000", "SSI", qty=520),
        ev(date(2026, 10, 3), "Thanh toán quyền", "mua Thực hiện QUYỀN : 10 QUYỀN NẮM GIỮ ĐƯỢC MUA 1 CP MBB, GIÁ 10.000 - Giá 10.000", dec=900000),
        ev(date(2026, 10, 14), "Cổ tức", "Thanh toán cổ tức TPB 5% 05/10/2026", inc=740000),
        ev(date(2026, 10, 14), "Thuế cổ tức", "Thuế cổ tức TPB tỷ lệ 5% 05/10/2026", dec=37000),
        ev(date(2026, 10, 1), "Nộp tiền", "Nap tien", inc=10000000),
        ev(date(2026, 10, 30), "Thanh toán phí", "Thu phí lưu ký 10.2026", dec=4801),
        ev(date(2026, 10, 30), "Lãi tiền gửi", "Lãi tiền gửi 10.2026", inc=399),
        ev(date(2026, 10, 30), "Thuế lãi tiền gửi", "Thuế lãi tiền gửi 10.2026", dec=20),
    ], orders=[
        Order(1, date(2026, 10, 1), date(2026, 10, 5), "BUY", "CMG", D(100), D(21200), D(2120000), D(3180), D(0), D(2123180)),
        Order(2, date(2026, 10, 2), date(2026, 10, 6), "BUY", "MBB", D(100), D(19300), D(1930000), D(2895), D(0), D(1932895)),
    ])
    daily = Counter({si._trade_key(date(2026, 10, 1), "CMG", "BUY", 100, 21200): 1})
    rows, _ = si.statement_transactions([oct_], daily, "1786441", [])
    by = Counter((r["source"], r["type"]) for r in rows)
    # CMG came from a daily email -> not duplicated; MBB missing -> added from statement
    assert by[("ssi_statement", "BUY")] == 1
    trade = next(r for r in rows if r["source"] == "ssi_statement")
    assert trade["ticker"] == "MBB" and trade["fees"] == 2895
    bonus = next(r for r in rows if r["source"] == "ssi_corporate" and r["unit_price"] == 0)
    assert (bonus["ticker"], bonus["quantity"]) == ("SSI", 684)
    rights = next(r for r in rows if r["source"] == "ssi_corporate" and r["unit_price"] > 0)
    assert (rights["ticker"], rights["quantity"], rights["unit_price"]) == ("MBB", 90, 10000)
    # the rights *delivery* row is not booked again
    assert not any(r.get("ticker") == "SSI" and r.get("quantity") == 520 for r in rows)
    div = next(r for r in rows if r["type"] == "DIVIDEND" and r.get("ticker") == "TPB")
    assert div["cash_amount"] == 740000 and div["taxes"] == 37000
    interest = next(r for r in rows if r["type"] == "DIVIDEND" and r.get("ticker") is None)
    assert interest["cash_amount"] == 399 and interest["taxes"] == 20
    assert by[("ssi_cash", "DEPOSIT")] == 1 and by[("ssi_cash", "FEE")] == 1


def test_missing_month_infers_net_deposit():
    nov = stmt(date(2022, 11, 1), date(2022, 11, 30), 0, 0)
    jan = stmt(date(2023, 1, 1), date(2023, 1, 31), 132703, 132703)
    dec_buy = Trade(no=1, trade_date=date(2022, 12, 12), settle_date=date(2022, 12, 14), side="BUY",
                    ticker="E1VFVN30", quantity=D(100), price=D(18200), value=D(1820000), fee=D(2730),
                    amount=D(1822730))
    rows, notes = si.statement_transactions([nov, jan], Counter(), "1786441", [dec_buy])
    dep = next(r for r in rows if r["external_id"].endswith("inferred"))
    assert dep["type"] == "DEPOSIT" and dep["cash_amount"] == 132703 + 1822730


def test_gap_inference_uses_only_that_subaccounts_trades():
    # an empty sub-account with a missing month must not infer deposits from another account's trades
    nov = stmt(date(2022, 11, 1), date(2022, 11, 30), 0, 0)
    jan = stmt(date(2023, 1, 1), date(2023, 1, 31), 0, 0)
    rows, notes = si.statement_transactions([nov, jan], Counter(), "1786446", [])
    assert rows == [] and notes == []

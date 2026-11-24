"""ssi_trade_report.parse_text: rows pasted from an SSI trade-report email/PDF."""
import unicodedata
from datetime import date

from app.services.ssi_trade_report import parse_text

BUY = "1 06/11/2026 10/11/2026 Mua VCB 200 53,600 10,720,000 16,080 10,736,080"
SELL = ("2 06/11/2026 10/11/2026 Bán MBB 100 20,200 2,020,000 3,030 2,020 "
        "15 10,000 150,000 7,500 2,007,450")
OLD_2023 = "1 03/10/2023 05/10/2023 Mua TPB 200 17,000 3,400,000 5,100 0 10,000 3,405,100"


def test_space_separated_rows_with_header_and_account():
    text = ("THÔNG BÁO KẾT QUẢ GIAO DỊCH\nSố tài khoản: 003C178644  Từ ngày 06/11/2026\n"
            "STT Ngày GD Ngày TT Loại Mã CK KL Giá ...\n" + BUY + "\n" + SELL + "\nTotal 12,740,000\n")
    rep = parse_text(text)
    assert rep.errors == []
    assert rep.account == "003C178644"
    assert [(t.no, t.side, t.ticker) for t in rep.trades] == [(1, "BUY", "VCB"), (2, "SELL", "MBB")]
    assert rep.trades[0].amount == 10736080 and rep.trades[0].settle_date == date(2026, 11, 10)
    assert rep.trades[1].taxes == 9520


def test_tab_separated_and_extra_spaces():
    text = BUY.replace(" ", "\t") + "\n" + SELL.replace(" ", "   \t ")
    rep = parse_text(text)
    assert rep.errors == [] and len(rep.trades) == 2
    assert rep.account is None


def test_rows_split_across_lines_and_glued_together():
    toks = BUY.split()
    wrapped = " ".join(toks[:5]) + "\n" + " ".join(toks[5:8]) + "\n" + " ".join(toks[8:])
    # two rows on one line (copy from a table without newlines)
    rep = parse_text(wrapped + " " + SELL)
    assert rep.errors == []
    assert [t.ticker for t in rep.trades] == ["VCB", "MBB"]
    assert rep.trades[0].quantity == 200 and rep.trades[0].fee == 16080


def test_nfd_decomposed_ban_is_a_sell():
    text = unicodedata.normalize("NFD", SELL)
    assert "Bán" not in text  # really decomposed
    rep = parse_text(text)
    assert rep.errors == [] and rep.trades[0].side == "SELL"


def test_2023_layout():
    rep = parse_text(OLD_2023)
    assert rep.errors == []
    t = rep.trades[0]
    assert t.quantity == 200 and t.amount == 3405100 and t.taxes == 0


def test_row_without_settle_date():
    rep = parse_text("3 06/11/2026 Mua VCB 200 53,600 10,720,000 16,080 10,736,080")
    assert rep.errors == []
    assert rep.trades[0].no == 3 and rep.trades[0].settle_date is None


def test_bad_arithmetic_is_an_error_not_a_trade():
    bad = BUY.replace("10,736,080", "10,746,080")
    rep = parse_text(bad + "\n" + SELL)
    assert [t.ticker for t in rep.trades] == ["MBB"]
    assert len(rep.errors) == 1 and rep.errors[0].startswith("row 1:")
    assert "10,746,080" in rep.errors[0]


def test_dot_thousands_is_not_guessed():
    rep = parse_text("1 06/11/2026 10/11/2026 Mua VCB 200 53.600 10.720.000 16.080 10.736.080")
    assert rep.trades == [] and len(rep.errors) == 1


def test_nothing_recognisable():
    rep = parse_text("hello world 123")
    assert rep.trades == [] and rep.errors == ["no trade rows found"]


# ── Fix round 1 ──

def test_small_dot_grouped_numbers_are_rejected_not_scaled():
    """I2: '9.000' must not become 9 VND."""
    rep = parse_text("1 06/11/2026 10/11/2026 Mua ABC 100 9.000 900.000 1.350 901.350")
    assert rep.trades == []
    assert len(rep.errors) == 1 and rep.errors[0].startswith("row 1:")
    assert "thousands separator" in rep.errors[0] and "9.000" in rep.errors[0]


def test_large_dot_grouped_numbers_are_rejected_with_clear_error():
    rep = parse_text("1 06/11/2026 10/11/2026 Mua VCB 200 53.600 10.720.000 16.080 10.736.080")
    assert rep.trades == [] and "thousands separator" in rep.errors[0]


def test_two_different_accounts_are_refused():
    rep = parse_text("Tài khoản 003C178644\n" + BUY + "\nTài khoản 003C999999\n" + SELL)
    assert rep.trades == []
    assert "003C178644" in rep.errors[0] and "003C999999" in rep.errors[0]


def test_sub_account_of_same_account_is_not_a_conflict():
    rep = parse_text("Tài khoản 003C178644 (TK 003C1786441)\n" + BUY)
    assert rep.errors == [] and rep.account == "003C178644"

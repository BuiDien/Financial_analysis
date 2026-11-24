"""VnstockProvider mappers against frames recorded live on 2026-11-10 (no network)."""
import json
from pathlib import Path

import pandas as pd
import pytest

from app.screener import vnstock_provider as vp
from app.screener.provider import LATEST_KEYS, VN_TZ
from app.screener.ratelimit import RateLimited

FX = Path(__file__).parent / "fixtures" / "screener"
YEAR = 2026


def load(name):
    return json.loads((FX / f"{name}.json").read_text())


def latest_q(rows, field):
    rs = sorted(rows, key=lambda r: (r["year_report"], r["quarter"]))
    return rs[-1][field]


def latest_fy(rows, field):
    rs = sorted((r for r in rows if r["quarter"] == 5), key=lambda r: r["year_report"])
    return rs[-1][field]


# ---- universe -------------------------------------------------------------

def test_map_universe_flags_banks():
    out = {e["symbol"]: e for e in vp.map_universe(load("listing"), load("industries"))}
    assert out["VCB"]["is_bank"] is True
    assert out["VNM"]["is_bank"] is False
    assert out["VCB"]["industry"] == "Ngân hàng"
    assert out["VNM"]["industry"] == "Sản xuất thực phẩm"  # ICB level 3
    assert out["VNM"]["exchange"] == "HOSE"                 # VCI says HSX


def test_map_universe_filters_type_and_exchange():
    listing = load("listing") + [
        {"symbol": "CVNM2601", "exchange": "HSX", "type": "CW"},
        {"symbol": "OLDCO", "exchange": "DELISTED", "type": "STOCK"},
    ]
    out = vp.map_universe(listing, load("industries"))
    syms = [e["symbol"] for e in out]
    assert "CVNM2601" not in syms and "OLDCO" not in syms
    assert {e["exchange"] for e in out} <= {"HOSE", "HNX", "UPCOM"}
    assert syms == sorted(set(syms))
    delisted = {r["symbol"] for r in load("listing") if r["exchange"] == "DELISTED"}
    assert delisted and not (delisted & set(syms))


def test_map_universe_accepts_wide_industry_rows():
    listing = [{"symbol": "AAA", "exchange": "HNX", "type": "STOCK"},
               {"symbol": "BBB", "exchange": "UPCOM", "type": "STOCK"}]
    ind = [{"symbol": "AAA", "icb_name3": None, "icb_name2": "Commercial Banks"},
           {"symbol": "BBB", "industry": "Retail"}]
    out = {e["symbol"]: e for e in vp.map_universe(listing, ind)}
    assert out["AAA"]["industry"] == "Commercial Banks" and out["AAA"]["is_bank"]
    assert out["BBB"]["industry"] == "Retail" and not out["BBB"]["is_bank"]


# ---- ratios ---------------------------------------------------------------

def test_ratio_latest_vnm():
    rows = load("VNM_ratio_summary")
    latest, _ = vp.map_ratio_rows(rows, is_bank=False, current_year=YEAR)
    assert set(latest) == set(LATEST_KEYS)
    assert latest["debt_to_equity"] == pytest.approx(latest_q(rows, "debt_per_equity"))
    assert latest["pe"] == pytest.approx(latest_q(rows, "pe"))
    assert latest["market_cap"] == pytest.approx(latest_q(rows, "market_cap"))
    # quarterly rows hold only that quarter's payout; the yield is the last fiscal year's
    assert latest["dividend_yield"] == pytest.approx(latest_fy(rows, "dividend_yield"))
    assert latest["dividend_yield"] == pytest.approx(0.0764, abs=1e-4)  # fraction, FY2025
    for k in ("npl", "nim", "cost_to_income", "car"):
        assert latest[k] is None


def test_ratio_latest_vhm_uses_borrowings_not_liabilities():
    latest, _ = vp.map_ratio_rows(load("VHM_ratio_summary"), is_bank=False, current_year=YEAR)
    assert latest["debt_to_equity"] == pytest.approx(0.7818, abs=1e-3)


def test_ratio_vhm_dividend_is_fiscal_row_not_newest_quarter():
    rows = load("VHM_ratio_summary")
    latest, _ = vp.map_ratio_rows(rows, is_bank=False, current_year=YEAR)
    # every 2026 quarterly row is 0 (nothing paid yet this year); FY2025 paid 9.9%
    assert latest_q(rows, "dividend_yield") == 0.0
    assert latest["dividend_yield"] == pytest.approx(0.0993, abs=1e-4)
    assert latest["pe"] == pytest.approx(latest_q(rows, "pe"))


def test_ratio_pe_zero_in_newest_row_is_not_backfilled():
    rows = [{"year_report": 2026, "quarter": 2, "pe": 12.0},
            {"year_report": 2026, "quarter": 3, "pe": 0.0}]
    latest, _ = vp.map_ratio_rows(rows, is_bank=False, current_year=YEAR)
    assert latest["pe"] == 0.0


def test_ratio_latest_vcb_bank_fields():
    rows = load("VCB_ratio_summary")
    latest, _ = vp.map_ratio_rows(rows, is_bank=True, current_year=YEAR)
    assert latest["debt_to_equity"] is None
    assert latest["npl"] == pytest.approx(latest_q(rows, "npl"))
    assert latest["nim"] == pytest.approx(latest_q(rows, "net_interest_margin"))
    # VCI reports cir negative (expense sign); stored as a positive fraction
    assert latest["cost_to_income"] == pytest.approx(abs(latest_q(rows, "cir")))
    # CAR is only reported in Q2/Q5 rows; latest carrying row is 2025 Q5
    assert latest["car"] == pytest.approx(0.1156, abs=1e-3)
    assert latest["dividend_yield"] == pytest.approx(latest_fy(rows, "dividend_yield"))


def test_ratio_years_exclude_current_year():
    _, years = vp.map_ratio_rows(load("VNM_ratio_summary"), is_bank=False, current_year=YEAR)
    assert str(YEAR) not in years
    assert sorted(years) == [str(y) for y in range(2018, 2026)]
    q5 = {str(r["year_report"]): r["roe"] for r in load("VNM_ratio_summary") if r["quarter"] == 5}
    assert years["2025"] == pytest.approx(q5["2025"])


def test_ratio_dividend_without_fiscal_row_uses_newest_row():
    rows = [{"year_report": 2026, "quarter": 1, "dividend_yield": 0.01},
            {"year_report": 2026, "quarter": 2, "dividend_yield": 0.02}]
    latest, _ = vp.map_ratio_rows(rows, is_bank=False, current_year=YEAR)
    assert latest["dividend_yield"] == 0.02


def test_ratio_car_all_zero_is_missing():
    # a bank's capital adequacy ratio is never really 0: VCI writes 0 when unreported
    rows = [{"year_report": 2025, "quarter": 5, "car": 0.0},
            {"year_report": 2026, "quarter": 2, "car": 0.0}]
    latest, _ = vp.map_ratio_rows(rows, is_bank=True, current_year=YEAR)
    assert latest["car"] is None


def test_ratio_zero_only_means_real_zero():
    rows = [{"year_report": 2025, "quarter": 5, "dividend_yield": 0.0, "debt_per_equity": 0.0},
            {"year_report": 2026, "quarter": 1, "dividend_yield": 0.0, "debt_per_equity": 0.0}]
    latest, _ = vp.map_ratio_rows(rows, is_bank=False, current_year=YEAR)
    assert latest["dividend_yield"] == 0.0 and latest["debt_to_equity"] == 0.0
    assert latest["pe"] is None


# ---- statements -----------------------------------------------------------

def test_statements_vnm_years():
    out = vp.map_statements(load("VNM_income_year"), load("VNM_cashflow_year"), is_bank=False)
    assert sorted(out) == ["2022", "2023", "2024", "2025"]
    for y in out.values():
        assert y["revenue"] and y["net_profit"] and y["operating_cash_flow"]
    inc = {r["item_id"]: r for r in load("VNM_income_year")}
    assert out["2025"]["revenue"] == inc["net_sales"]["2025"]
    assert out["2025"]["net_profit"] == inc["attributable_to_parent_company"]["2025"]


def test_statements_bank_revenue_none():
    out = vp.map_statements(load("VCB_income_year"), load("VCB_cashflow_year"), is_bank=True)
    assert sorted(out) == ["2022", "2023", "2024", "2025"]
    for y in out.values():
        assert y["revenue"] is None and y["operating_cash_flow"] is None
        assert y["net_profit"] > 0


def test_statements_fall_back_to_item_en():
    inc = [{"item_id": "x1", "item_en": "Net revenue", "2025": 10.0},
           {"item_id": "x2", "item_en": "Profit attributable to parent company", "2025": 2.0}]
    cf = [{"item_id": "x3", "item_en": "Net cash flows from operating activities", "2025": 3.0}]
    out = vp.map_statements(inc, cf, is_bank=False)
    assert out == {"2025": {"revenue": 10.0, "net_profit": 2.0, "operating_cash_flow": 3.0}}


def test_statements_insurer_layout():
    # item_ids recorded live from ABI (insurer) on 2026-11-10
    inc = [{"item_id": "profit_after_tax", "item_en": "Profit after tax", "2025": 254.0},
           {"item_id": "net_profit_attributable_to_shareholders_of_the_group",
            "item_en": "Net profit attributable to shareholders of the group", "2025": 250.0},
           {"item_id": "net_sales_from_insurance_business",
            "item_en": "Net sales from insurance business", "2025": 2452.0}]
    cf = [{"item_id": "net_cash_inflows_outflows_from_operating_activities",
           "item_en": "Net cash inflows/(outflows) from operating activities", "2025": 219.0}]
    out = vp.map_statements(inc, cf, is_bank=False)
    assert out["2025"] == {"revenue": 2452.0, "net_profit": 250.0, "operating_cash_flow": 219.0}


def test_statements_parent_profit_blank_uses_after_tax():
    inc = [{"item_id": "net_sales", "item_en": "Net sales", "2025": 10.0},
           {"item_id": "net_profit_loss_after_tax", "item_en": "Net profit/(loss) after tax",
            "2025": 3.0},
           {"item_id": "attributable_to_parent_company", "item_en": "Attributable to parent company",
            "2025": 0.0}]
    assert vp.map_statements(inc, [], is_bank=False)["2025"]["net_profit"] == 3.0


# ---- bars -----------------------------------------------------------------

def test_map_ohlc_shape_and_full_vnd():
    rows = load("VNM_history")
    bars = vp.map_ohlc(rows, 1000.0, "1D")
    assert len(bars) == len(rows)
    assert set(bars[0]) == {"date", "open", "high", "low", "close", "volume"}
    assert bars[-1]["date"] == "2026-11-10" and bars[-1]["close"] == 57_900.0
    assert [b["date"] for b in bars] == sorted(b["date"] for b in bars)


def test_map_ohlc_index_unit_window_and_timestamps():
    rows = [{"time": pd.Timestamp("2026-11-09 00:00:00"), "open": 1250.5, "high": 1260.0,
             "low": 1249.0, "close": 1255.25, "volume": 1e8},
            {"time": "2026-11-01 09:15:00", "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1},
            {"time": "2026-11-10 09:15:00", "open": 1, "high": float("nan"), "low": 1,
             "close": 1, "volume": 1}]
    bars = vp.map_ohlc(vp._rows(pd.DataFrame(rows)), 1.0, "1D", start="2026-11-05")
    assert bars == [{"date": "2026-11-09 00:00:00", "open": 1250.5, "high": 1260.0,
                     "low": 1249.0, "close": 1255.25, "volume": 1e8}]


def test_map_ohlc_relabels_weekly_and_monthly():
    row = {"time": "2026-11-15 00:00:00", "open": 10, "high": 11, "low": 9, "close": 10, "volume": 5}
    assert vp.map_ohlc([row], 1000.0, "1W")[0]["date"] == "2026-11-09 00:00:00"
    assert vp.map_ohlc([{**row, "time": "2026-11-30"}], 1000.0, "1M")[0]["date"] == "2026-11-01 00:00:00"


# ---- provider wiring (stubbed vnstock, recording limiter) ----------------

_ACTIVE: list = []


class RecordingLimiter:
    def __init__(self):
        self.priorities = []
        self.inside = False
        _ACTIVE.append(self)

    def call(self, fn, *a, priority="interactive", **kw):
        self.priorities.append(priority)
        self.inside = True
        try:
            return fn(*a, **kw)
        finally:
            self.inside = False


# _ACTIVE (above) holds the RecordingLimiter the stubs check against


@pytest.fixture(autouse=True)
def _fixed_now(monkeypatch):
    """fetch_prices windows on 'now'; pin it after the fixtures' last bar."""
    from datetime import datetime
    monkeypatch.setattr(vp, "_now", lambda: datetime(2026, 11, 11, 16, 0, tzinfo=VN_TZ))


@pytest.fixture(autouse=True)
def _clear_active():
    _ACTIVE.clear()
    yield
    _ACTIVE.clear()


def _net():
    """Every stubbed network call asserts it runs inside RecordingLimiter.call."""
    assert _ACTIVE and _ACTIVE[-1].inside, "vnstock call made outside the limiter"


def _stub_vnstock(monkeypatch):
    df = lambda name: pd.DataFrame(load(name))  # noqa: E731

    class Listing:
        def symbols_by_exchange(self):
            _net()
            return df("listing")

        def symbols_by_industries(self):
            _net()
            return df("industries")

    class Company:
        def __init__(self, symbol):
            self.symbol = symbol

        def ratio_summary(self):
            _net()
            return df(f"{self.symbol}_ratio_summary")

    class Finance:
        def __init__(self, symbol, is_bank):
            _net()  # real Finance() does a handshake GET
            self.symbol = symbol

        def income_statement(self, period="year"):
            _net()
            return df(f"{self.symbol}_income_year")

        def cash_flow(self, period="year"):
            _net()
            return df(f"{self.symbol}_cashflow_year")

    class Quote:
        def __init__(self, symbol):
            self.symbol = symbol

        def history(self, start, end, interval):
            _net()
            return df(f"{self.symbol}_history")

    monkeypatch.setattr(vp, "_vnstock", lambda: {
        "Listing": Listing, "Company": Company, "Finance": Finance, "Quote": Quote})


def test_provider_uses_background_priority(monkeypatch):
    _stub_vnstock(monkeypatch)
    lim = RecordingLimiter()
    p = vp.VnstockProvider(limiter=lim, current_year=YEAR)
    uni = {e["symbol"]: e for e in p.list_universe()}
    fin = p.fetch_financials(uni["VNM"])
    bars = p.fetch_prices("VNM", days=120)
    # listing, industries | ratio, Finance(), income, cash flow | history
    assert lim.priorities == ["background"] * 7
    assert p.name == "vnstock"
    assert sorted(fin["years"])[-1] == "2025"
    assert fin["years"]["2025"]["roe"] is not None and fin["years"]["2025"]["revenue"]
    assert fin["years"]["2018"]["revenue"] is None  # ROE-only year
    assert bars and set(bars[0]) == {"date", "close", "volume"}


def test_provider_bank_financials(monkeypatch):
    _stub_vnstock(monkeypatch)
    p = vp.VnstockProvider(limiter=RecordingLimiter(), current_year=YEAR)
    fin = p.fetch_financials({"symbol": "VCB", "exchange": "HOSE", "industry": "Ngân hàng",
                              "is_bank": True})
    assert fin["latest"]["npl"] is not None and fin["latest"]["debt_to_equity"] is None
    assert fin["years"]["2025"]["revenue"] is None and fin["years"]["2025"]["net_profit"] > 0


def test_provider_propagates_rate_limited(monkeypatch):
    _stub_vnstock(monkeypatch)

    class Limited:
        def call(self, fn, *a, priority="interactive", **kw):
            raise RateLimited("cooldown")

    p = vp.VnstockProvider(limiter=Limited(), current_year=YEAR)
    with pytest.raises(RateLimited):
        p.fetch_prices("VNM")


def test_provider_default_limiter_is_shared(monkeypatch):
    from app.screener import ratelimit
    lim = RecordingLimiter()
    monkeypatch.setattr(ratelimit, "vnstock_limiter", lim)
    _stub_vnstock(monkeypatch)
    vp.VnstockProvider(current_year=YEAR).fetch_prices("VNM")
    assert lim.priorities == ["background"]


def test_get_provider_vnstock(monkeypatch):
    from app.config import get_settings
    from app.screener.provider import get_provider
    monkeypatch.setattr(get_settings(), "screener_provider", "vnstock")
    assert isinstance(get_provider(), vp.VnstockProvider)


# ---- empty VCI data must raise, not wipe stored numbers ------------------

def _stub_empty_ratios(monkeypatch, rows):
    _stub_vnstock(monkeypatch)
    real = vp._vnstock()

    class EmptyCompany:
        def __init__(self, symbol):
            pass

        def ratio_summary(self):
            _net()
            return pd.DataFrame(rows)

    monkeypatch.setattr(vp, "_vnstock", lambda: {**real, "Company": EmptyCompany})


def test_provider_empty_ratio_summary_raises(monkeypatch):
    _stub_empty_ratios(monkeypatch, [])
    p = vp.VnstockProvider(limiter=RecordingLimiter(), current_year=YEAR)
    with pytest.raises(vp.ProviderError) as ei:
        p.fetch_financials({"symbol": "VNM", "exchange": "HOSE", "industry": None, "is_bank": False})
    assert not isinstance(ei.value, RateLimited)


def test_provider_all_none_ratios_without_roe_years_raises(monkeypatch):
    _stub_empty_ratios(monkeypatch, [{"year_report": 2026, "quarter": 3, "pe": None}])
    p = vp.VnstockProvider(limiter=RecordingLimiter(), current_year=YEAR)
    with pytest.raises(vp.ProviderError):
        p.fetch_financials({"symbol": "VNM", "exchange": "HOSE", "industry": None, "is_bank": False})


# ---- fiscal-year ratio fields ---------------------------------------------

def test_ratio_years_vnm_fields():
    years = vp.map_ratio_years(load("VNM_ratio_summary"), current_year=YEAR)
    assert str(YEAR) not in years
    y = years["2025"]
    assert y["gross_margin"] == pytest.approx(0.4118, abs=1e-4)
    assert y["receivable_days"] == pytest.approx(27.23, abs=1e-2)
    assert y["inventory_days"] == pytest.approx(61.53, abs=1e-2)
    assert y["shares"] == 2089955445


def test_ratio_years_zero_gross_margin_and_shares_missing():
    rows = [{"year_report": 2025, "quarter": 5, "gross_margin": 0.0, "number_of_shares_mkt_cap": 0,
             "day_sale_outstanding": 0.0, "days_inventory_outstanding": 0.0},
            {"year_report": 2025, "quarter": 3, "gross_margin": 0.3}]
    y = vp.map_ratio_years(rows, current_year=YEAR)
    assert y == {"2025": {"gross_margin": None, "shares": None,
                          "receivable_days": 0.0, "inventory_days": 0.0}}


# ---- board (status flag + foreign room) -----------------------------------

def _board_row(sym, code, cur=None, tot=None, status="X"):
    return {"listing_symbol": sym, "listing_trading_status_code": code,
            "listing_trading_status": status, "match_current_room": cur, "match_total_room": tot}


def test_map_board_flags():
    rows = [_board_row("A", "20", 424422640, 924006547), _board_row("B", "33"),
            _board_row("C", "34"), _board_row("D", 71), _board_row("E", "110"),
            _board_row("F", "130"), _board_row("G", None, 5, 0)]
    out = vp.map_board(rows)
    assert {s: v["flag"] for s, v in out.items()} == {
        "A": None, "B": "warning", "C": "control", "D": "restricted",
        "E": "suspended", "F": None, "G": None}
    assert out["A"]["foreign_room"] == pytest.approx(424422640 / 924006547)
    assert out["B"]["foreign_room"] is None and out["G"]["foreign_room"] is None
    assert out["A"]["status"] == "X"


def test_flat_columns_joins_multiindex():
    df = pd.DataFrame([["FPT", 5]], columns=pd.MultiIndex.from_tuples(
        [("listing", "symbol"), ("match", "current_room")]))
    assert vp._rows(vp._flat_columns(df)) == [{"listing_symbol": "FPT", "match_current_room": 5}]


def test_fixture_board():
    from app.screener.provider import FixtureProvider
    p = FixtureProvider(board={"GOODCO": {"flag": "warning", "status": "s", "foreign_room": 0.1}})
    assert p.fetch_board(["GOODCO"])["GOODCO"]["flag"] == "warning"
    assert FixtureProvider().fetch_board(["GOODCO"]) == {}
    assert ("board", "") in p.calls


# ---- fetch_ohlc / fetch_prices (provider seam for charts, quotes, backtests) --

def test_fetch_ohlc_full_vnd_and_priority(monkeypatch):
    from datetime import date
    _stub_vnstock(monkeypatch)
    lim = RecordingLimiter()
    p = vp.VnstockProvider(limiter=lim, current_year=YEAR)
    bars = p.fetch_ohlc("VNM", date(2026, 11, 1), date(2026, 11, 10), "1d", priority="interactive")
    assert lim.priorities == ["interactive"]
    assert bars[-1]["date"] == "2026-11-10" and bars[-1]["close"] == 57_900.0
    assert all("2026-11-01" <= b["date"] <= "2026-11-10" for b in bars)
    with pytest.raises(ValueError):
        p.fetch_ohlc("VNM", date(2026, 11, 1), date(2026, 11, 10), "2h")


def test_fetch_prices_drops_todays_bar_before_close(monkeypatch):
    from datetime import datetime
    _stub_vnstock(monkeypatch)
    p = vp.VnstockProvider(limiter=RecordingLimiter(), current_year=YEAR)
    monkeypatch.setattr(vp, "_now", lambda: datetime(2026, 11, 10, 10, 30, tzinfo=VN_TZ))
    intraday = p.fetch_prices("VNM")
    assert intraday[-1]["date"] == "2026-11-09" and intraday[-1]["close"] > 1000  # full VND
    monkeypatch.setattr(vp, "_now", lambda: datetime(2026, 11, 10, 15, 5, tzinfo=VN_TZ))
    assert p.fetch_prices("VNM")[-1]["date"] == "2026-11-10"


# ---- company names (news-watch) --------------------------------------------

def test_list_company_names_maps_and_skips_blank(monkeypatch):
    class Listing:
        def all_symbols(self):
            return pd.DataFrame([
                {"symbol": "hpg", "organ_name": "  Công ty Cổ phần Tập đoàn Hòa Phát "},
                {"symbol": "VNM", "organ_name": "Công ty Cổ phần Sữa Việt Nam"},
                {"symbol": "XXX", "organ_name": None},
                {"symbol": None, "organ_name": "Orphan"},
            ])
    monkeypatch.setattr(vp, "_vnstock", lambda: {"Listing": Listing})
    lim = RecordingLimiter()
    names = vp.VnstockProvider(limiter=lim).list_company_names()
    assert names == {"HPG": "Công ty Cổ phần Tập đoàn Hòa Phát",
                     "VNM": "Công ty Cổ phần Sữa Việt Nam"}
    assert lim.priorities == ["background"]

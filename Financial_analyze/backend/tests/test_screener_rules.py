import pytest

from app.screener import rules
from app.screener.rules import CATALOG, RuleConfigError, evaluate_rule, validate_rules


def view(years=None, latest=None, prices="default", stale=False, is_bank=False, industry="Food"):
    if prices == "default":
        prices = {"last_date": "2026-11-09", "close": 88.0, "rsi14": 25.0,
                  "closes_tail": [100, 95, 94, 92, 90, 88], "vol_multiple": 2.0,
                  "avg_value_bn": 10.0}
    return {"symbol": "X", "exchange": "HOSE", "industry": industry, "is_bank": is_bank,
            "financials": {"latest": dict(latest or {}), "years": years or {}},
            "prices": prices, "prices_stale": stale}


def yrs(field, values, first=2022):
    return {str(first + i): {field: v} for i, v in enumerate(values)}


CTX = {"industry_pe": {"Food": 12.0}, "universe_pe": 15.0}


def ev(rid, v, ctx=CTX, **params):
    return evaluate_rule({"id": rid, "on": True, **params}, v, ctx)


def test_roe_uses_weakest_year():
    r = ev("roe_years", view(years=yrs("roe", [0.20, 0.14, 0.25])), x=15, n=3)
    assert r["status"] == "fail" and r["value"] == 14.0 and r["score"] is None


def test_roe_score():
    assert ev("roe_years", view(years=yrs("roe", [0.30] * 3)), x=15, n=3)["score"] == 100
    assert ev("roe_years", view(years=yrs("roe", [0.225] * 3)), x=15, n=3)["score"] == 50


def test_roe_uses_newest_n_and_missing_cases():
    v = view(years=yrs("roe", [0.01, 0.2, 0.2, 0.2]))
    assert ev("roe_years", v, x=15, n=3)["status"] == "pass"
    assert ev("roe_years", view(years=yrs("roe", [0.2, 0.2])), x=15, n=3)["status"] == "missing"
    assert ev("roe_years", view(years=yrs("roe", [0.2, None, 0.2])), x=15, n=3)["status"] == "missing"


def test_growth_cagr():
    r = ev("profit_growth", view(years=yrs("net_profit", [100, 110, 121, 133.1])), x=10, n=3)
    assert r["status"] == "pass" and r["value"] == pytest.approx(10.0, abs=1e-6)


def test_growth_loss_start_fails():
    r = ev("profit_growth", view(years=yrs("net_profit", [-5, 10, 20, 30])), x=10, n=3)
    assert r["status"] == "fail"
    r0 = ev("profit_growth", view(years=yrs("net_profit", [0, 10, 20, 30])), x=10, n=3)
    assert r0["status"] == "fail"


def test_growth_too_few_years_missing():
    assert ev("profit_growth", view(years=yrs("net_profit", [100, 110, 121])), x=10, n=3)["status"] == "missing"


def test_growth_latest_year_lacks_field_missing():
    assert ev("profit_growth", view(years=yrs("net_profit", [100, 110, 121, None])), x=10, n=3)["status"] == "missing"


def test_growth_end_negative_fails():
    assert ev("profit_growth", view(years=yrs("net_profit", [100, 50, 20, -10])), x=10, n=3)["status"] == "fail"


def test_revenue_growth_bank_not_applicable():
    v = view(years=yrs("revenue", [100, 110, 121, 133.1]), is_bank=True)
    assert ev("revenue_growth", v, x=10, n=3) == {"status": "n/a", "value": None, "score": None}


def test_ocf_ratio_and_negative_profit():
    ys = {str(2023 + i): {"operating_cash_flow": o, "net_profit": p}
          for i, (o, p) in enumerate([(80, 100), (90, 100), (100, 100)])}
    r = ev("ocf_to_profit", view(years=ys), x=80, n=3)
    assert r["status"] == "pass" and r["value"] == 90.0
    neg = {str(2023 + i): {"operating_cash_flow": 10, "net_profit": p}
           for i, p in enumerate([-50, -50, 10])}
    assert ev("ocf_to_profit", view(years=neg), x=80, n=3)["status"] == "fail"
    assert ev("ocf_to_profit", view(years=ys), x=80, n=4)["status"] == "missing"


def test_pe_loss_maker_fails():
    assert ev("pe_vs_industry", view(latest={"pe": -3}), x=100)["status"] == "fail"


def test_pe_zero_missing():
    assert ev("pe_vs_industry", view(latest={"pe": 0}), x=100)["status"] == "missing"
    assert ev("pe_vs_industry", view(latest={"pe": None}), x=100)["status"] == "missing"


def test_pe_vs_industry_value():
    r = ev("pe_vs_industry", view(latest={"pe": 9}), x=100)
    assert r["status"] == "pass" and r["value"] == 75.0 and r["score"] == 50


def test_pe_universe_fallback_and_none():
    v = view(latest={"pe": 9}, industry="Other")
    assert ev("pe_vs_industry", v, x=100)["value"] == 60.0
    assert ev("pe_vs_industry", v, {"industry_pe": {}, "universe_pe": None}, x=100)["status"] == "missing"


def test_dividend_zero_fails():
    assert ev("dividend_yield", view(latest={"dividend_yield": 0}), x=5)["status"] == "fail"


def test_debt_zero_passes():
    assert ev("debt_to_equity", view(latest={"debt_to_equity": 0}), x=1.0)["status"] == "pass"


def test_pb_and_market_cap_zero_missing():
    assert ev("pb", view(latest={"pb": 0}), x=2)["status"] == "missing"
    assert ev("market_cap", view(latest={"market_cap": 0}), x=1000)["status"] == "missing"
    assert ev("market_cap", view(latest={"market_cap": 5e12}), x=1000)["value"] == 5000.0


def test_bank_rule_on_nonbank_not_applicable():
    assert ev("bank_npl", view(latest={"npl": 0.01}), x=2)["status"] == "n/a"


def test_bank_rules_values():
    v = view(latest={"npl": 0.01, "nim": 0.04, "cost_to_income": 0.35, "car": 0.12}, is_bank=True)
    assert ev("bank_npl", v, x=2)["value"] == 1.0
    assert ev("bank_nim", v, x=3)["status"] == "pass"
    assert ev("bank_cir", v, x=40)["value"] == 35.0
    assert ev("bank_car", v, x=8)["status"] == "pass"


def test_debt_rule_on_bank_not_applicable():
    assert ev("debt_to_equity", view(latest={"debt_to_equity": 0.5}, is_bank=True), x=1.0)["status"] == "n/a"
    # a non-bank with no debt figure is still missing data
    assert ev("debt_to_equity", view(latest={}), x=1.0)["status"] == "missing"


def test_traded_value_ignores_staleness():
    assert ev("traded_value", view(stale=True), x=5)["status"] == "pass"
    assert ev("traded_value", view(prices=None), x=5)["status"] == "missing"
    p = {"last_date": "d", "close": 1, "rsi14": None, "closes_tail": [], "vol_multiple": None, "avg_value_bn": None}
    assert ev("traded_value", view(prices=p), x=5)["status"] == "missing"


def test_rsi_strict_below():
    def rsi(val):
        p = {"last_date": "d", "close": 1, "rsi14": val, "closes_tail": [], "vol_multiple": None, "avg_value_bn": 1}
        return ev("rsi", view(prices=p), x=30)
    assert rsi(30.0)["status"] == "fail"
    r = rsi(29.9)
    assert r["status"] == "pass" and r["score"] is None


def test_price_drop():
    r = ev("price_drop", view(), x=10, d=5)
    assert r["status"] == "pass" and r["value"] == -12.0 and r["score"] is None
    assert ev("price_drop", view(), x=15, d=5)["status"] == "fail"
    assert ev("price_drop", view(), x=10, d=6)["status"] == "missing"


def test_volume_spike():
    assert ev("volume_spike", view(), x=1.5)["status"] == "pass"
    assert ev("volume_spike", view(), x=2.5)["status"] == "fail"


def test_oversold_stale_or_no_prices_missing():
    for rid, p in (("rsi", {"x": 30}), ("price_drop", {"x": 10, "d": 5}), ("volume_spike", {"x": 1.5})):
        assert ev(rid, view(stale=True), **p)["status"] == "missing"
        assert ev(rid, view(prices=None), **p)["status"] == "missing"


def test_scope():
    bank = view(is_bank=True)
    assert ev("scope", bank, banks="exclude", industries=[])["status"] == "fail"
    assert ev("scope", bank, banks="only", industries=[])["status"] == "pass"
    assert ev("scope", view(), banks="only", industries=[])["status"] == "fail"
    assert ev("scope", view(), banks="any", industries=["Food"])["status"] == "pass"
    assert ev("scope", view(), banks="any", industries=["Steel"])["status"] == "fail"
    assert ev("scope", view(), banks="any", industries=[])["score"] is None


def test_at_most_score_and_zero_threshold_span():
    r = ev("debt_to_equity", view(latest={"debt_to_equity": 0.75}), x=1.0)
    assert r["score"] == 50.0
    r = ev("dividend_yield", view(latest={"dividend_yield": 0.05}), x=0)
    assert r["score"] == 50.0


def test_catalog_shape():
    assert CATALOG["price_drop"]["kind"] == "drop"
    assert CATALOG["rsi"]["stage"] == "oversold" and CATALOG["roe_years"]["stage"] == "good"
    assert CATALOG["scope"]["kind"] == "scope" and CATALOG["bank_npl"]["applies_to"] == "bank"
    assert CATALOG["profit_growth"]["params"]["n"] == {"default": 3, "min": 1, "max": 3, "unit": "years"}


def test_validate_fills_defaults():
    out = validate_rules([{"id": "roe_years"}, {"id": "price_drop", "x": 12}])
    assert out[0] == {"id": "roe_years", "on": True, "x": 15, "n": 3}
    assert out[1] == {"id": "price_drop", "on": True, "x": 12, "d": 5}
    sc = validate_rules([{"id": "scope", "on": False}])[0]
    assert sc == {"id": "scope", "on": False, "banks": "any", "industries": [],
                  "exchanges": [], "flagged": "exclude"}


def test_validate_rejects_n_above_depth():
    with pytest.raises(RuleConfigError, match="profit_growth: n must be between 1 and 3"):
        validate_rules([{"id": "profit_growth", "n": 4}])


@pytest.mark.parametrize("cfg,frag", [
    ({"id": "nope"}, "nope"),
    ({"id": "pb", "x": "2"}, "pb: x"),
    ({"id": "pb", "x": True}, "pb: x"),
    ({"id": "pb", "x": float("nan")}, "pb: x"),
    ({"id": "pb", "x": 0.01}, "pb: x must be between"),
    ({"id": "pb", "on": "yes"}, "pb: on"),
    ({"id": "pb", "bogus": 1}, "pb: unknown"),
    ({"id": "roe_years", "n": 2.5}, "roe_years: n"),
    ({"id": "scope", "banks": "maybe"}, "scope: banks"),
    ({"id": "scope", "industries": "Food"}, "scope: industries"),
    ({"id": "scope", "industries": [1]}, "scope: industries"),
    ({"id": "pb", "banks": "any"}, "pb: unknown"),
    ({}, "id"),
])
def test_validate_rejects_bad(cfg, frag):
    with pytest.raises(RuleConfigError, match=frag):
        validate_rules([cfg])


def test_validate_rejects_duplicate():
    with pytest.raises(RuleConfigError, match="pb"):
        validate_rules([{"id": "pb"}, {"id": "pb"}])


def test_negative_debt_to_equity_fails():
    r = ev("debt_to_equity", view(latest={"debt_to_equity": -3.2}), x=1.0)
    assert r["status"] == "fail" and r["value"] == -3.2 and r["score"] is None


def test_negative_pb_fails():
    r = ev("pb", view(latest={"pb": -0.5}), x=2)
    assert r["status"] == "fail" and r["value"] == -0.5 and r["score"] is None


def test_zero_industry_median_falls_back():
    v = view(latest={"pe": 9}, industry="F")
    r = ev("pe_vs_industry", v, {"industry_pe": {"F": 0.0}, "universe_pe": 15.0}, x=100)
    assert r["status"] == "pass" and r["value"] == 60.0
    r = ev("pe_vs_industry", v, {"industry_pe": {"F": 0.0}, "universe_pe": 0.0}, x=100)
    assert r["status"] == "missing"


def test_pe_loss_maker_reports_ratio_value():
    r = ev("pe_vs_industry", view(latest={"pe": -6}), x=100)
    assert r["status"] == "fail" and r["value"] == -50.0
    r = ev("pe_vs_industry", view(latest={"pe": -6}), {"industry_pe": {}, "universe_pe": None}, x=100)
    assert r["status"] == "fail" and r["value"] is None


def test_traded_value_missing_when_prices_dead():
    v = view(stale=True)
    v["prices_dead"] = True
    assert ev("traded_value", v, x=5)["status"] == "missing"


# ---- VN scope ---------------------------------------------------------------

def sv(**kw):
    v = view(industry=kw.pop("industry", "Food"), is_bank=kw.pop("is_bank", False))
    v.update(kw)
    return v


def test_old_scope_gets_new_defaults():
    sc = validate_rules([{"id": "scope", "banks": "exclude"}])[0]
    assert sc["flagged"] == "exclude" and sc["exchanges"] == []


@pytest.mark.parametrize("cfg,err", [
    ({"id": "scope", "flagged": "maybe"}, "scope: flagged"),
    ({"id": "scope", "exchanges": ["NYSE"]}, "scope: exchanges"),
    ({"id": "scope", "exchanges": "HOSE"}, "scope: exchanges"),
])
def test_scope_new_params_validation(cfg, err):
    with pytest.raises(RuleConfigError, match=err):
        validate_rules([cfg])


def test_in_scope_flagged():
    cfg = validate_rules([{"id": "scope"}])[0]
    assert not rules.in_scope(cfg, sv(board={"flag": "warning"}))
    assert rules.in_scope(cfg, sv(board={"flag": None}))
    assert rules.in_scope(cfg, sv(board=None))          # no status data: keep
    assert rules.in_scope(cfg, sv())                    # no board key at all
    assert rules.in_scope(dict(cfg, flagged="include"), sv(board={"flag": "control"}))


def test_in_scope_exchanges():
    cfg = validate_rules([{"id": "scope", "exchanges": ["HOSE", "HNX"]}])[0]
    assert rules.in_scope(cfg, sv(exchange="HNX"))
    assert not rules.in_scope(cfg, sv(exchange="UPCOM"))


@pytest.mark.parametrize("industry,bank,keep", [
    ("Dịch vụ tài chính", False, False), ("Bảo hiểm phi nhân thọ", False, False),
    ("Bảo hiểm nhân thọ", False, False), ("Quỹ đầu tư", False, False),
    ("Ngân hàng", True, False), ("Sản xuất thực phẩm", False, True), (None, False, True)])
def test_in_scope_no_financials(industry, bank, keep):
    cfg = validate_rules([{"id": "scope", "banks": "no_financials"}])[0]
    assert rules.in_scope(cfg, sv(industry=industry, is_bank=bank)) is keep


# ---- quality-of-earnings rules ---------------------------------------------

def yrs2(**fields):
    n = len(next(iter(fields.values())))
    return {str(2022 + i): {k: v[i] for k, v in fields.items()} for i in range(n)}


def test_profit_growth_min():
    v = view(years=yrs2(net_profit=[100, 110, 105, 130]))
    r = ev("profit_growth_min", v, x=0, n=3)
    assert r["status"] == "fail" and r["value"] == pytest.approx(-4.545455, abs=1e-5)
    assert ev("profit_growth_min", v, x=-5, n=3)["status"] == "pass"
    assert ev("profit_growth_min", v, x=0, n=1)["status"] == "pass"
    assert ev("profit_growth_min", view(years=yrs2(net_profit=[-5, 10, 20, 30])), x=0, n=3)["status"] == "fail"
    assert ev("profit_growth_min", view(years=yrs2(net_profit=[10, 20])), x=0, n=3)["status"] == "missing"


def test_receivable_and_inventory_days_change():
    v = view(years=yrs2(receivable_days=[30, 35, 40, 70], inventory_days=[60, 50, 55, 70]))
    r = ev("receivable_days_change", v, x=15, n=3)
    assert r["status"] == "fail" and r["value"] == 40
    assert ev("inventory_days_change", v, x=30, n=3)["value"] == 10
    assert ev("inventory_days_change", v, x=30, n=3)["status"] == "pass"
    assert ev("receivable_days_change", view(years=yrs2(receivable_days=[None, 1, 2, 3])), x=15, n=3)["status"] == "missing"
    assert ev("receivable_days_change", view(years=yrs2(receivable_days=[1, 2, 3, 4]), is_bank=True), x=15, n=3)["status"] == "n/a"


def test_gross_margin_change_points():
    v = view(years=yrs2(gross_margin=[0.40, 0.38, 0.36, 0.35]))
    r = ev("gross_margin_change", v, x=-2, n=3)
    assert r["status"] == "fail" and r["value"] == pytest.approx(-5.0)
    assert ev("gross_margin_change", v, x=-2, n=1)["status"] == "pass"
    assert ev("gross_margin_change", view(years=yrs2(gross_margin=[0.4, 0.4])), x=-2, n=3)["status"] == "missing"


def test_share_dilution_cagr():
    v = view(years=yrs2(shares=[1000, 1000, 1100, 1331]))
    r = ev("share_dilution", v, x=5, n=3)
    assert r["status"] == "fail" and r["value"] == pytest.approx(10.0)
    assert ev("share_dilution", view(years=yrs2(shares=[1000] * 4)), x=5, n=3)["status"] == "pass"
    assert ev("share_dilution", view(years=yrs2(shares=[1000, 1000])), x=5, n=3)["status"] == "missing"


def test_foreign_room():
    assert ev("foreign_room", sv(board={"foreign_room": 0.3}), x=5)["value"] == 30.0
    assert ev("foreign_room", sv(board={"foreign_room": 0.01}), x=5)["status"] == "fail"
    assert ev("foreign_room", sv(board=None), x=5)["status"] == "missing"


# ---- gaps in the year series (bug: {2019,2023,2024} n=2 read as 2 years) ----

def _gap_years(field, pairs):
    return {str(y): {field: v} for y, v in pairs}


def test_growth_with_year_gap_is_missing_not_inflated_cagr():
    # 2019 -> 2024 is 5 years of ~8%; treated as 2 years it looked like ~21%.
    v = view(years=_gap_years("net_profit", [(2019, 100.0), (2023, 140.0), (2024, 146.9)]))
    assert ev("profit_growth", v, x=10, n=2)["status"] == "missing"
    assert ev("profit_growth", v, x=10, n=1)["status"] == "fail"  # 2023->2024 is consecutive
    rv = view(years=_gap_years("revenue", [(2019, 100.0), (2023, 140.0), (2024, 146.9)]))
    assert ev("revenue_growth", rv, x=10, n=2)["status"] == "missing"


def test_span_rules_with_year_gap_are_missing():
    ys = {"2019": {"receivable_days": 30, "inventory_days": 60, "gross_margin": 0.3, "shares": 100.0},
          "2023": {"receivable_days": 31, "inventory_days": 61, "gross_margin": 0.3, "shares": 100.0},
          "2024": {"receivable_days": 32, "inventory_days": 62, "gross_margin": 0.3, "shares": 100.0}}
    v = view(years=ys)
    for rid in ("receivable_days_change", "inventory_days_change", "gross_margin_change",
                "share_dilution"):
        assert ev(rid, v, x=5, n=2)["status"] == "missing", rid
        assert ev(rid, v, x=5, n=1)["status"] != "missing", rid


def test_growth_min_with_year_gap_is_missing():
    v = view(years=_gap_years("net_profit", [(2019, 100.0), (2023, 110.0), (2024, 120.0)]))
    assert ev("profit_growth_min", v, x=0, n=2)["status"] == "missing"
    assert ev("profit_growth_min", v, x=0, n=1)["status"] == "pass"
